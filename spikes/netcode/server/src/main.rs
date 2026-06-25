//! P4.0c authoritative server process.
//!
//! Owns a small fixed-step deterministic world (mirrors the engine's fixed-step
//! native sim) and the world log (mirrors M1's `WorldRecorder`: each accepted
//! intent is appended as a `skill` command at its landing tick). Clients connect
//! over a raw localhost TCP socket and submit INTENTS; the server is the single
//! authority:
//!
//!   * an intent is permission-checked against the client's grant set, then
//!     queued and applied on the NEXT tick boundary (so the sim stays fixed-step
//!     and replayable -- intents interleave with steps in one total order, the
//!     M1 contract), recorded in the world log, and the resulting authoritative
//!     state delta is broadcast to every client;
//!   * a DIRECT state write from a client has no apply path and is rejected
//!     (printed) -- the authority guarantee;
//!   * clients are VIEWS: they read snapshots/deltas, they never mutate.
//!
//! Run: `netcode-server [--port N] [--addr-file PATH] [--log PATH] [--entities N]`
//! `--port 0` binds an ephemeral port; the resolved `127.0.0.1:PORT` is printed
//! and (if `--addr-file`) written so an orchestrator can hand it to the client.

use std::fs::File;
use std::io::Write as _;
use std::sync::Arc;
use std::time::Duration;

use common::{ClientMsg, EntityState, ServerMsg};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, mpsc, Mutex};

const TICK_HZ: f64 = 60.0;
const DT: f64 = 1.0 / TICK_HZ;
const GRAVITY: f64 = -9.81;
const DAMPING: f64 = 0.98;
const EPS: f64 = 1e-9;

/// Capabilities a connecting client is granted. The spike grants exactly the
/// impulse intent; any other skill (or a direct write) is denied -- the same
/// "explicit grant set, the only path to a mutating capability" rule as the
/// engine's `SkillRegistry.invoke` permission check.
const GRANTS: &[&str] = &["apply_impulse"];

struct Args {
    port: u16,
    addr_file: Option<String>,
    log: Option<String>,
    entities: u32,
}

fn parse_args() -> Args {
    let mut a = Args { port: 0, addr_file: None, log: None, entities: 8 };
    let argv: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i < argv.len() {
        match argv[i].as_str() {
            "--port" => { i += 1; a.port = argv.get(i).and_then(|s| s.parse().ok()).unwrap_or(0); }
            "--addr-file" => { i += 1; a.addr_file = argv.get(i).cloned(); }
            "--log" => { i += 1; a.log = argv.get(i).cloned(); }
            "--entities" => { i += 1; a.entities = argv.get(i).and_then(|s| s.parse().ok()).unwrap_or(8); }
            _ => {}
        }
        i += 1;
    }
    a
}

/// The authoritative world. Fixed-step integrator over a handful of dynamic
/// bodies; `prev` is last tick's state so a delta carries only what changed.
struct World {
    tick: u64,
    entities: Vec<EntityState>,
    prev: Vec<EntityState>,
}

impl World {
    fn new(n: u32) -> Self {
        // All bodies start at rest on the floor (y=0): the world is quiescent
        // (emits no deltas) until an intent perturbs a body. Bodies spread on x so
        // an AoI/interest filter (M5) has spatial structure to key on.
        let mk = |id: u32| EntityState { id, pos: [id as f64, 0.0, 0.0], vel: [0.0; 3] };
        let entities: Vec<EntityState> = (0..n).map(mk).collect();
        let prev = entities.clone();
        World { tick: 0, entities, prev }
    }

    fn snapshot(&self) -> Vec<EntityState> {
        self.entities.clone()
    }

    /// Apply an accepted impulse intent (the authoritative mutation).
    fn apply_impulse(&mut self, entity: u32, arg: [f64; 3]) {
        let e = &mut self.entities[entity as usize];
        e.vel[0] += arg[0];
        e.vel[1] += arg[1];
        e.vel[2] += arg[2];
    }

    /// One fixed-step integration: gravity, semi-implicit Euler, floor at y=0,
    /// linear damping. Deterministic for identical inputs/build.
    fn step(&mut self) {
        for e in &mut self.entities {
            e.vel[1] += GRAVITY * DT;
            for k in 0..3 {
                e.vel[k] *= DAMPING;
                e.pos[k] += e.vel[k] * DT;
            }
            if e.pos[1] < 0.0 {
                e.pos[1] = 0.0;
                if e.vel[1] < 0.0 {
                    e.vel[1] = 0.0;
                }
            }
        }
    }

    /// Entities whose pos/vel changed since the previous tick (the delta set).
    fn changed(&mut self) -> Vec<EntityState> {
        let mut out = Vec::new();
        for (i, e) in self.entities.iter().enumerate() {
            let p = &self.prev[i];
            let moved = (0..3).any(|k| (e.pos[k] - p.pos[k]).abs() > EPS || (e.vel[k] - p.vel[k]).abs() > EPS);
            if moved {
                out.push(e.clone());
            }
        }
        self.prev.clone_from(&self.entities);
        out
    }
}

/// An accepted intent handed from a connection task to the sim task.
struct Accepted {
    id: u64,
    entity: u32,
    arg: [f64; 3],
    from: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = parse_args();
    let n = args.entities;

    let listener = TcpListener::bind(("127.0.0.1", args.port)).await?;
    let addr = listener.local_addr()?;

    // World log: meta header first, then one `skill` command per accepted intent.
    // Mirrors M1's serializeWorldLog (JSONL, ASCII, versioned).
    let mut log: Option<File> = match &args.log {
        Some(path) => {
            let mut f = File::create(path)?;
            let meta = serde_json::json!({
                "kind": "meta", "logVersion": 1, "sessionId": "netcode-server",
                "createdAt": "spike", "commands": 0, "ticks": 0
            });
            writeln!(f, "{meta}")?;
            // seed command (parity with M1: the deterministic PRNG seed, recorded first).
            let seed = serde_json::json!({ "kind": "seed", "seq": 0, "seed": 12345 });
            writeln!(f, "{seed}")?;
            f.flush()?;
            Some(f)
        }
        None => None,
    };

    let world = Arc::new(Mutex::new(World::new(n)));
    let (delta_tx, _) = broadcast::channel::<ServerMsg>(8192);
    let (intent_tx, mut intent_rx) = mpsc::unbounded_channel::<Accepted>();

    // ---- Sim / tick task: the single authoritative writer. -----------------
    {
        let world = world.clone();
        let delta_tx = delta_tx.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs_f64(DT));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let mut seq: u64 = 1;
            loop {
                interval.tick().await;
                let mut w = world.lock().await;
                w.tick += 1;
                let tick = w.tick;

                // Drain intents accepted since the last tick and apply them in
                // arrival order (one total order with the step -- M1's rule).
                let mut caused = Vec::new();
                while let Ok(it) = intent_rx.try_recv() {
                    w.apply_impulse(it.entity, it.arg);
                    caused.push(it.id);
                    if let Some(f) = log.as_mut() {
                        let cmd = serde_json::json!({
                            "kind": "skill", "seq": seq, "tick": tick,
                            "tool": "physics.applyImpulse",
                            "input": { "entity": format!("ent_{}", it.entity), "impulse": it.arg },
                            "actorId": it.from, "sessionId": "netcode", "perms": ["physics.write"],
                        });
                        let _ = writeln!(f, "{cmd}");
                        let _ = f.flush();
                        seq += 1;
                    }
                }

                w.step();
                let changes = w.changed();
                // Broadcast only when something happened (intent landed or motion):
                // the tick that applied an intent always carries it via caused_by.
                if !caused.is_empty() || !changes.is_empty() {
                    let _ = delta_tx.send(ServerMsg::Delta { tick, caused_by: caused, changes });
                }
            }
        });
    }

    // Ready line (machine-readable) + optional addr file, so the orchestrator can
    // synchronize before connecting (matters for `--port 0`).
    println!("netcode-server listening on {addr}");
    std::io::stdout().flush().ok();
    if let Some(path) = &args.addr_file {
        std::fs::write(path, addr.to_string())?;
    }

    // ---- Accept loop: one task per client. ---------------------------------
    loop {
        let (sock, peer) = listener.accept().await?;
        let world = world.clone();
        let delta_tx = delta_tx.clone();
        let intent_tx = intent_tx.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_client(sock, peer.to_string(), world, delta_tx, intent_tx, n).await {
                eprintln!("[server] client {peer} ended: {e}");
            }
        });
    }
}

async fn handle_client(
    sock: TcpStream,
    peer: String,
    world: Arc<Mutex<World>>,
    delta_tx: broadcast::Sender<ServerMsg>,
    intent_tx: mpsc::UnboundedSender<Accepted>,
    n: u32,
) -> anyhow::Result<()> {
    sock.set_nodelay(true).ok();
    let (rd, mut wr) = sock.into_split();
    let mut lines = BufReader::new(rd).lines();
    let mut deltas = delta_tx.subscribe();

    // Send one server message as a JSON line. The connection task is the sole
    // writer to `wr`, so interleaving reads/deltas never corrupt a frame.
    async fn send(wr: &mut tokio::net::tcp::OwnedWriteHalf, msg: &ServerMsg) -> anyhow::Result<()> {
        let mut line = serde_json::to_string(msg)?;
        line.push('\n');
        wr.write_all(line.as_bytes()).await?;
        Ok(())
    }

    loop {
        tokio::select! {
            // Inbound client message.
            maybe = lines.next_line() => {
                let line = match maybe? { Some(l) => l, None => break };
                if line.trim().is_empty() { continue; }
                let msg: ClientMsg = match serde_json::from_str(&line) {
                    Ok(m) => m,
                    Err(e) => { eprintln!("[server] parse error from {peer}: {e}"); continue; }
                };
                match msg {
                    ClientMsg::Hello { client } => {
                        let w = world.lock().await;
                        let welcome = ServerMsg::Welcome {
                            tick: w.tick,
                            grants: GRANTS.iter().map(|s| s.to_string()).collect(),
                            entities: w.snapshot(),
                        };
                        drop(w);
                        eprintln!("[server] client {peer} hello as {client}; granted {GRANTS:?}");
                        send(&mut wr, &welcome).await?;
                    }
                    ClientMsg::Ping { id } => {
                        send(&mut wr, &ServerMsg::Pong { id }).await?;
                    }
                    ClientMsg::Snapshot { id } => {
                        let w = world.lock().await;
                        let snap = ServerMsg::SnapshotResult { id, tick: w.tick, entities: w.snapshot() };
                        drop(w);
                        send(&mut wr, &snap).await?;
                    }
                    ClientMsg::Intent { id, skill, entity, arg } => {
                        // AUTHORITY CHECK 1: capability grant (the SkillRegistry.invoke
                        // permission analog -- the only path to a mutating capability).
                        if !GRANTS.contains(&skill.as_str()) {
                            eprintln!("[server] REJECT intent id={id} from {peer}: missing capability grant: {skill}");
                            send(&mut wr, &ServerMsg::Reject { id, reason: format!("missing capability grant: {skill}") }).await?;
                        } else if entity >= n {
                            send(&mut wr, &ServerMsg::Reject { id, reason: format!("unknown entity: {entity}") }).await?;
                        } else {
                            // Accepted: hand to the sim task; it applies on the next
                            // tick and broadcasts a delta tagged caused_by=[id].
                            let _ = intent_tx.send(Accepted { id, entity, arg, from: peer.clone() });
                        }
                    }
                    ClientMsg::StateWrite { id, entity, pos } => {
                        // AUTHORITY: there is NO code path that applies a client's
                        // direct state write. Clients are views. Always rejected.
                        eprintln!("[server] REJECT state_write id={id} from {peer}: client attempted to set entity {entity} pos={pos:?} directly -- authority denied");
                        send(&mut wr, &ServerMsg::Reject {
                            id,
                            reason: "authority: clients cannot write authoritative state directly; submit an intent".into(),
                        }).await?;
                    }
                }
            }
            // Outbound authoritative delta (broadcast).
            d = deltas.recv() => {
                match d {
                    Ok(msg) => send(&mut wr, &msg).await?,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
    Ok(())
}
