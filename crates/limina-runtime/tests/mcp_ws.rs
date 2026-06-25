//! End-to-end test for the `--mcp-ws` WebSocket JSON-RPC transport.
//!
//! This is a REAL socket test: it spawns the actual `limina` binary as a child
//! process in `--mcp-ws` mode, opens a genuine tokio-tungstenite WebSocket
//! client to it, and drives the JSON-RPC handshake/tool calls over the wire.
//! Nothing is mocked or run in-process, so the test fails if the server does
//! not actually accept connections or mishandles a method.

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

/// Grab an ephemeral localhost port, then release it so the child can bind it.
fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    listener.local_addr().expect("local_addr").port()
}

/// Connect a real WebSocket client, retrying briefly while the child boots.
async fn connect(port: u16) -> WsStream {
    let url = format!("ws://127.0.0.1:{port}/");
    for _ in 0..100 {
        match tokio_tungstenite::connect_async(&url).await {
            Ok((ws, _resp)) => return ws,
            Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    }
    panic!("could not establish a WebSocket connection to {url}");
}

/// Send one JSON-RPC request and read the single correlated response back.
async fn send_recv(ws: &mut WsStream, req: serde_json::Value) -> serde_json::Value {
    ws.send(Message::text(req.to_string()))
        .await
        .expect("send request frame");
    loop {
        let msg = timeout(Duration::from_secs(10), ws.next())
            .await
            .expect("response timed out")
            .expect("stream ended without a response")
            .expect("websocket error");
        match msg {
            Message::Text(text) => {
                return serde_json::from_str(text.as_str()).expect("parse JSON-RPC response");
            }
            Message::Binary(bytes) => {
                return serde_json::from_slice(&bytes).expect("parse JSON-RPC response");
            }
            Message::Ping(_) | Message::Pong(_) => continue,
            Message::Close(_) => panic!("server closed the connection unexpectedly"),
            _ => continue,
        }
    }
}

#[tokio::test]
async fn mcp_ws_real_socket_e2e() {
    let port = free_port();

    // Spawn the real binary. CARGO_BIN_EXE_limina is provided by cargo for
    // integration tests and guarantees the binary is built first.
    let mut child = Command::new(env!("CARGO_BIN_EXE_limina"))
        .args(["--mcp-ws", "--port", &port.to_string()])
        .current_dir(env!("CARGO_MANIFEST_DIR").to_string() + "/../..")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn limina --mcp-ws");

    // Synchronize on the host's "listening" line, then keep draining stdout so a
    // full pipe buffer can never block the child.
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

    // ---- Connection 1: builder.readWrite (full read/write profile) ----
    let mut ws = connect(port).await;

    let init = send_recv(
        &mut ws,
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": { "agentId": "agt_ws", "sessionId": "ses_ws", "profile": "builder.readWrite" },
        }),
    )
    .await;
    assert!(init.get("error").is_none(), "initialize errored: {init}");
    assert_eq!(
        init["result"]["session"]["profile"], "builder.readWrite",
        "initialize did not bind the requested profile: {init}"
    );

    let list = send_recv(
        &mut ws,
        serde_json::json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }),
    )
    .await;
    let tools = list["result"]["tools"]
        .as_array()
        .unwrap_or_else(|| panic!("tools/list did not return a tools array: {list}"));
    assert!(!tools.is_empty(), "tools/list returned no tools");

    let create = send_recv(
        &mut ws,
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": { "name": "scene.createEntity", "arguments": { "position": [1, 2, 3] } },
        }),
    )
    .await;
    assert!(
        create.get("error").is_none(),
        "createEntity errored: {create}"
    );
    assert_eq!(
        create["result"]["success"], true,
        "createEntity did not succeed: {create}"
    );
    let entity = create["result"]["result"]["entity"]
        .as_str()
        .unwrap_or_else(|| panic!("createEntity returned no entity id: {create}"));
    assert!(
        !entity.is_empty(),
        "createEntity returned an empty entity id"
    );

    // Drop connection 1 -> server sees EOF and re-accepts the next client.
    drop(ws);

    // ---- Connection 2: player.limited (no scene.write) ----
    let mut ws2 = connect(port).await;

    let init2 = send_recv(
        &mut ws2,
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": { "agentId": "agt_player", "sessionId": "ses_player", "profile": "player.limited" },
        }),
    )
    .await;
    assert!(
        init2.get("error").is_none(),
        "limited initialize errored: {init2}"
    );

    let denied = send_recv(
        &mut ws2,
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": { "name": "scene.createEntity", "arguments": { "position": [0, 0, 0] } },
        }),
    )
    .await;
    assert!(
        denied.get("result").is_none(),
        "permission-denied call should not return a result: {denied}"
    );
    assert_eq!(
        denied["error"]["code"], -32001,
        "permission-denied call did not map to the forbidden JSON-RPC code: {denied}"
    );

    drop(ws2);
    let _ = child.kill().await;
}
