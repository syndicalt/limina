//! P4.0c engine baseline -- reuses the REAL `limina --mcp-ws` binary, read-only.
//!
//! The Rust server+client model (this spike's core) proves the FULL netcode model
//! (authoritative server + broadcast deltas + authority). This probe grounds that
//! model's latency in the engine's ACTUAL transport and shows the engine's REAL
//! authority boundary, by:
//!   * spawning the unmodified `limina --mcp-ws` binary as a separate OS process,
//!   * connecting a real tokio-tungstenite WebSocket client (a second process),
//!   * measuring p95 of a real authoritative-mutation round-trip
//!     (`tools/call ecs.updateComponent` -> applied via `SkillRegistry.invoke`),
//!   * proving the engine rejects a mutation from a read-only session (the real
//!     permission boundary -- "a client's direct state write is rejected").
//!
//! Nothing in engine-core is modified; the binary is used exactly as shipped.
//!
//! Run: `netcode-engineprobe --limina PATH --cwd REPO_ROOT [--rounds N] [--out P]`

use std::process::Stdio;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::Command;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct Args {
    limina: String,
    cwd: String,
    rounds: usize,
    out: Option<String>,
}

fn parse_args() -> Args {
    let mut a = Args { limina: "../../target/debug/limina".into(), cwd: "../..".into(), rounds: 1000, out: None };
    let argv: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i < argv.len() {
        match argv[i].as_str() {
            "--limina" => { i += 1; if let Some(v) = argv.get(i) { a.limina = v.clone(); } }
            "--cwd" => { i += 1; if let Some(v) = argv.get(i) { a.cwd = v.clone(); } }
            "--rounds" => { i += 1; a.rounds = argv.get(i).and_then(|s| s.parse().ok()).unwrap_or(1000); }
            "--out" => { i += 1; a.out = argv.get(i).cloned(); }
            _ => {}
        }
        i += 1;
    }
    a
}

fn free_port() -> u16 {
    let l = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral");
    l.local_addr().expect("local_addr").port()
}

async fn connect(port: u16) -> anyhow::Result<Ws> {
    let url = format!("ws://127.0.0.1:{port}/");
    for _ in 0..200 {
        if let Ok((ws, _)) = tokio_tungstenite::connect_async(&url).await {
            return Ok(ws);
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    anyhow::bail!("could not connect WebSocket to {url}")
}

/// Send one JSON-RPC request and return the correlated response (by id).
async fn send_recv(ws: &mut Ws, req: serde_json::Value) -> anyhow::Result<serde_json::Value> {
    let want = req.get("id").cloned();
    ws.send(Message::text(req.to_string())).await?;
    loop {
        let msg = timeout(Duration::from_secs(10), ws.next())
            .await
            .map_err(|_| anyhow::anyhow!("response timed out"))?
            .ok_or_else(|| anyhow::anyhow!("stream ended"))??;
        if let Message::Text(t) = msg {
            let v: serde_json::Value = serde_json::from_str(&t)?;
            if v.get("id") == want.as_ref() || want.is_none() {
                return Ok(v);
            }
        }
    }
}

fn percentile(sorted: &[u128], q: f64) -> f64 {
    if sorted.is_empty() { return 0.0; }
    let rank = (q * sorted.len() as f64).ceil() as usize;
    sorted[rank.saturating_sub(1).min(sorted.len() - 1)] as f64 / 1e6
}

fn report(label: &str, mut nanos: Vec<u128>) -> String {
    nanos.sort_unstable();
    let n = nanos.len();
    let mean = if n == 0 { 0.0 } else { nanos.iter().sum::<u128>() as f64 / n as f64 / 1e6 };
    format!(
        "{label}: n={n}  p50={:.3}ms  p95={:.3}ms  p99={:.3}ms  max={:.3}ms  mean={mean:.3}ms",
        percentile(&nanos, 0.50), percentile(&nanos, 0.95), percentile(&nanos, 0.99), percentile(&nanos, 1.0),
    )
}

async fn initialize(ws: &mut Ws, agent: &str, profile: &str) -> anyhow::Result<serde_json::Value> {
    send_recv(ws, serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": { "agentId": agent, "sessionId": format!("{agent}-sess"), "profile": profile },
    })).await
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = parse_args();
    let port = free_port();
    let mut report_lines: Vec<String> = Vec::new();
    macro_rules! log { ($($t:tt)*) => {{ let s = format!($($t)*); println!("{s}"); report_lines.push(s); }} }

    log!("=== P4.0c engine baseline: real `limina --mcp-ws` over a real WebSocket ===");
    log!("spawning: {} --mcp-ws --port {port}  (cwd {})", args.limina, args.cwd);

    let mut child = Command::new(&args.limina)
        .args(["--mcp-ws", "--port", &port.to_string()])
        .current_dir(&args.cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()?;

    // Synchronize on the ready line, then keep draining stdout so the pipe never blocks.
    let stdout = child.stdout.take().expect("child stdout");
    let mut lines = BufReader::new(stdout).lines();
    let ready = timeout(Duration::from_secs(30), async {
        while let Some(line) = lines.next_line().await? {
            if line.contains("mcp-ws listening") { return anyhow::Ok(true); }
        }
        anyhow::Ok(false)
    }).await.map_err(|_| anyhow::anyhow!("timed out waiting for server ready"))??;
    anyhow::ensure!(ready, "server exited before becoming ready");
    tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });

    let run = async {
        // ---- Builder session: real authoritative mutations over the wire. ----
        let mut ws = connect(port).await?;
        let init = initialize(&mut ws, "builder", "builder.readWrite").await?;
        log!("initialize -> profile bound: {}", init["result"]["session"]["profile"]);

        // Create a real entity (scene.write) to mutate.
        let create = send_recv(&mut ws, serde_json::json!({
            "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": { "name": "scene.createEntity", "arguments": { "shape": "box", "position": [0,5,0] } },
        })).await?;
        let entity = create["result"]["result"]["entity"].as_str()
            .ok_or_else(|| anyhow::anyhow!("scene.createEntity did not return an entity id: {create}"))?
            .to_string();
        log!("created entity {entity} via scene.createEntity (authoritative mutation)");

        // Latency: real intent (ecs.updateComponent) round-trip over the WS transport.
        let warm = 50usize;
        for i in 0..warm {
            let _ = send_recv(&mut ws, update_req(100 + i as i64, &entity, i as f64)).await?;
        }
        let mut samples = Vec::with_capacity(args.rounds);
        for r in 0..args.rounds {
            let id = 1000 + r as i64;
            let t0 = Instant::now();
            let resp = send_recv(&mut ws, update_req(id, &entity, r as f64)).await?;
            samples.push(t0.elapsed().as_nanos());
            if r == 0 {
                anyhow::ensure!(resp["result"]["success"] == serde_json::json!(true),
                    "ecs.updateComponent did not succeed: {resp}");
            }
        }
        log!("{}", report(&format!("ENGINE intent round-trip (>= {} rounds, real WS+invoke)", args.rounds), samples));

        // ---- Authority: the engine's real permission boundary denies a mutation
        //      from a read-only session. `limina --mcp-ws` serves one client at a
        //      time, so we switch profile by RE-initializing the SAME connection
        //      (the transport rebinds the session on each `initialize`).
        log!("--- engine authority enforcement (real permission boundary) ---");
        let _ = initialize(&mut ws, "viewer", "system.readonly").await?;
        let denied = send_recv(&mut ws, update_req(5000, &entity, 1.0)).await?;
        let is_denied = denied.get("error").is_some();
        let code = denied["error"]["code"].clone();
        let message = denied["error"]["message"].clone();
        log!("AUTHORITY read-only `ecs.updateComponent` (needs ecs.modify) -> {}: code={code} message={message}",
            if is_denied { "REJECTED" } else { "UNEXPECTEDLY ALLOWED" });
        anyhow::ensure!(is_denied, "engine allowed a mutation from a read-only profile -- authority NOT enforced");

        // Re-initialize back to builder: the same call now succeeds (control --
        // authority lets the legitimately-granted path through).
        let _ = initialize(&mut ws, "builder", "builder.readWrite").await?;
        let allowed = send_recv(&mut ws, update_req(5001, &entity, 2.0)).await?;
        log!("AUTHORITY builder `ecs.updateComponent` (has ecs.modify) -> {} (control: legitimate path works)",
            if allowed["result"]["success"] == serde_json::json!(true) { "APPLIED" } else { "FAILED" });

        anyhow::Ok(())
    };

    let result = run.await;
    let _ = child.kill().await;

    if let Some(path) = &args.out {
        let mut f = std::fs::File::create(path)?;
        use std::io::Write as _;
        for l in &report_lines { writeln!(f, "{l}")?; }
        f.flush()?;
    }

    result
}

fn update_req(id: i64, entity: &str, x: f64) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0", "id": id, "method": "tools/call",
        "params": { "name": "ecs.updateComponent", "arguments": {
            "entity": entity, "component": "position", "value": [x, 1.0, 0.0],
        } },
    })
}
