//! P4 / M4 end-to-end over the REAL `limina --mcp-ws` BINARY with TWO genuinely
//! external WebSocket clients (separate OS process server, separate connections).
//!
//! This complements the headless `js/test/p4_authoritative_sync.ts` (which stands
//! up the same AuthoritativeServer over real loopback sockets in one process): it
//! proves the SHIPPED binary fans out to MULTIPLE simultaneous clients and runs
//! the state-sync channel. Client A mutates the authoritative world via an intent
//! (tools/call); client B -- a DIFFERENT connection that subscribed -- receives
//! the authoritative delta carrying A's mutation. A direct state-write is rejected
//! (no set-state verb on the wire). Nothing is mocked or in-process.

use std::process::Stdio;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::Command;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    listener.local_addr().expect("local_addr").port()
}

async fn connect(port: u16) -> WsStream {
    let url = format!("ws://127.0.0.1:{port}/");
    for _ in 0..100 {
        if let Ok((ws, _resp)) = tokio_tungstenite::connect_async(&url).await {
            return ws;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("could not establish a WebSocket connection to {url}");
}

async fn send(ws: &mut WsStream, req: serde_json::Value) {
    ws.send(Message::text(req.to_string()))
        .await
        .expect("send request frame");
}

/// Read frames until one satisfies `pred` (skips control frames + non-matching
/// notifications/responses). Fails the test on timeout.
async fn read_until<F: Fn(&serde_json::Value) -> bool>(
    ws: &mut WsStream,
    pred: F,
) -> serde_json::Value {
    loop {
        let msg = timeout(Duration::from_secs(15), ws.next())
            .await
            .expect("frame timed out")
            .expect("stream ended")
            .expect("websocket error");
        match msg {
            Message::Text(text) => {
                let value: serde_json::Value =
                    serde_json::from_str(text.as_str()).expect("parse JSON");
                if pred(&value) {
                    return value;
                }
            }
            Message::Binary(bytes) => {
                let value: serde_json::Value = serde_json::from_slice(&bytes).expect("parse JSON");
                if pred(&value) {
                    return value;
                }
            }
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
            Message::Close(_) => panic!("server closed the connection unexpectedly"),
        }
    }
}

fn id_is(value: &serde_json::Value, id: i64) -> bool {
    value.get("id").and_then(|v| v.as_i64()) == Some(id)
}

#[tokio::test]
async fn p4_multi_client_sync_real_binary() {
    let port = free_port();

    let mut child = Command::new(env!("CARGO_BIN_EXE_limina"))
        .args(["--mcp-ws", "--port", &port.to_string()])
        .current_dir(env!("CARGO_MANIFEST_DIR").to_string() + "/../..")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn limina --mcp-ws");

    let stdout = child.stdout.take().expect("child stdout");
    let mut lines = BufReader::new(stdout).lines();
    timeout(Duration::from_secs(60), async {
        while let Some(line) = lines.next_line().await.expect("read child stdout") {
            if line.contains("mcp-ws listening") {
                return;
            }
        }
        panic!("child exited before reporting it was listening");
    })
    .await
    .expect("server did not report listening in time");
    tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });

    // Two SIMULTANEOUS real clients on the one authoritative world.
    let mut a = connect(port).await; // mutator (human / builder)
    let mut b = connect(port).await; // observer (external agent)

    // A initializes as a builder; B as a limited player.
    send(
        &mut a,
        serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize",
        "params":{"agentId":"agt_a","sessionId":"ses_a","profile":"builder.readWrite"}}),
    )
    .await;
    let init_a = read_until(&mut a, |v| id_is(v, 1)).await;
    assert!(
        init_a.get("error").is_none(),
        "A initialize errored: {init_a}"
    );

    send(
        &mut b,
        serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize",
        "params":{"agentId":"agt_b","sessionId":"ses_b","profile":"player.limited"}}),
    )
    .await;
    let init_b = read_until(&mut b, |v| id_is(v, 1)).await;
    assert!(
        init_b.get("error").is_none(),
        "B initialize errored: {init_b}"
    );

    // B subscribes to the state-sync stream (opt-in). The server pushes a snapshot
    // then per-tick deltas; the subscribe ack is id-correlated.
    send(
        &mut b,
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"state/subscribe","params":{}}),
    )
    .await;
    let sub_b = read_until(&mut b, |v| id_is(v, 2)).await;
    assert!(sub_b.get("error").is_none(), "B subscribe errored: {sub_b}");

    // A creates an entity (an intent applied at the next tick boundary), then
    // moves it to a unique position.
    send(
        &mut a,
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/call",
        "params":{"name":"scene.createEntity","arguments":{"position":[1,2,3]}}}),
    )
    .await;
    let created = read_until(&mut a, |v| id_is(v, 2)).await;
    assert!(
        created.get("error").is_none(),
        "createEntity errored: {created}"
    );
    let entity = created["result"]["result"]["entity"]
        .as_str()
        .unwrap_or_else(|| panic!("createEntity returned no entity id: {created}"))
        .to_string();

    send(&mut a, serde_json::json!({"jsonrpc":"2.0","id":3,"method":"tools/call",
        "params":{"name":"ecs.updateComponent","arguments":{"entity":entity,"component":"position","value":[7,7,7]}}})).await;
    let updated = read_until(&mut a, |v| id_is(v, 3)).await;
    assert!(
        updated.get("error").is_none(),
        "updateComponent errored: {updated}"
    );

    // B must observe A's mutation on its delta stream: a state/delta whose changes
    // carry `entity` at x == 7. This is the cross-client sync over the real binary.
    let delta = read_until(&mut b, |v| {
        if v.get("method").and_then(|m| m.as_str()) != Some("state/delta") {
            return false;
        }
        let changes = match v["params"]["changes"].as_array() {
            Some(c) => c,
            None => return false,
        };
        changes.iter().any(|e| {
            e.get("id").and_then(|i| i.as_str()) == Some(entity.as_str())
                && e["pos"][0].as_f64() == Some(7.0)
        })
    })
    .await;
    assert_eq!(
        delta["method"], "state/delta",
        "B did not receive A's mutation as a delta: {delta}"
    );

    // AUTHORITY: a direct state-write verb does not exist on the wire -> rejected.
    send(
        &mut a,
        serde_json::json!({"jsonrpc":"2.0","id":4,"method":"state/set",
        "params":{"entity":entity,"pos":[999,999,999]}}),
    )
    .await;
    let denied = read_until(&mut a, |v| id_is(v, 4)).await;
    assert!(
        denied.get("result").is_none(),
        "a direct state-write must not succeed: {denied}"
    );
    assert_eq!(
        denied["error"]["code"], -32601,
        "direct state-write was not method-not-found: {denied}"
    );

    let _ = child.kill().await;
}
