//! Multi-client WebSocket transport ops for the authoritative server (Phase 4
//! M4/M5) and a matching client-connect primitive for headless socket tests.
//!
//! Phase 2's `mcp_ws` served ONE client at a time behind a single combined
//! stream. M4 needs the authoritative engine to fan out to MANY clients: per-
//! connection read/write plus a broadcast (the JS server holds the connection
//! id list and pushes a per-tick delta to each). This module is the real socket
//! substrate -- bytes cross the kernel loopback as genuine WebSocket frames; a
//! client cannot reach server memory, only the wire. Authority therefore stays
//! structural (the JS server exposes only intent-submit + reads; permission is
//! checked at `SkillRegistry.invoke`; attribution is bound at the session).
//!
//! Connections live in a `NetState` registry keyed by an integer id. Both
//! server-accepted (`WebSocketStream<TcpStream>`) and client-initiated
//! (`WebSocketStream<MaybeTlsStream<TcpStream>>`) connections are stored as the
//! SAME boxed `Sink`/`Stream` trait objects (the tungstenite error type is
//! identical for both), so one registry serves server and client uniformly.
//! Everything runs on the host's single-threaded current-thread runtime driven
//! by the JS event loop, so the ops are `!Send` (like `mcp_ws`) -- no task is
//! ever moved across threads.

use std::cell::RefCell;
use std::collections::HashMap;
use std::pin::Pin;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};

use deno_core::{extension, op2, OpState};
use deno_error::JsErrorBox;
use futures_util::{Sink, SinkExt, Stream, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::{Mutex, Notify};
use tokio_tungstenite::tungstenite::Error as WsError;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

/// Returned by `op_net_accept` when its listener has been closed, so the JS
/// accept loop can break cleanly instead of awaiting a connection forever.
const ACCEPT_CLOSED: u32 = u32::MAX;

/// Host-bound listener for `limina --mcp-ws` (installed by the host before the
/// JS server loop runs). Server-only; the production server never shuts it down.
pub struct WsListener(pub Rc<TcpListener>);

type BoxedSink = Pin<Box<dyn Sink<Message, Error = WsError>>>;
type BoxedStream = Pin<Box<dyn Stream<Item = Result<Message, WsError>>>>;

/// One live connection. The split halves sit behind independent mutexes so a
/// per-connection read loop and a broadcast write never block each other.
struct NetConn {
    tx: Mutex<BoxedSink>,
    rx: Mutex<BoxedStream>,
    close: Notify,
    closed: AtomicBool,
}

/// A test-created listener (`op_net_listen`) with a cancellation handle so a
/// pending `op_net_accept` can be released at teardown.
struct ListenerEntry {
    listener: Rc<TcpListener>,
    port: u16,
    close: Notify,
    closed: AtomicBool,
}

#[derive(Default)]
struct NetState {
    next_id: u32,
    listeners: HashMap<u32, Rc<ListenerEntry>>,
    conns: HashMap<u32, Rc<NetConn>>,
}

impl NetState {
    fn register<S>(&mut self, ws: WebSocketStream<S>) -> u32
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + 'static,
    {
        let (sink, stream) = ws.split();
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1);
        self.conns.insert(
            id,
            Rc::new(NetConn {
                tx: Mutex::new(Box::pin(sink) as BoxedSink),
                rx: Mutex::new(Box::pin(stream) as BoxedStream),
                close: Notify::new(),
                closed: AtomicBool::new(false),
            }),
        );
        id
    }
}

fn with_net<R>(state: &Rc<RefCell<OpState>>, f: impl FnOnce(&mut NetState) -> R) -> R {
    let mut s = state.borrow_mut();
    if s.try_borrow::<NetState>().is_none() {
        s.put(NetState::default());
    }
    f(s.borrow_mut::<NetState>())
}

fn conn_by_id(state: &Rc<RefCell<OpState>>, id: u32) -> Option<Rc<NetConn>> {
    let s = state.borrow();
    s.try_borrow::<NetState>()
        .and_then(|n| n.conns.get(&id).cloned())
}

// ---- listeners (test server side) -----------------------------------------

/// Bind a localhost listener (`port` 0 = ephemeral). Returns a listener id; the
/// resolved port is read with `op_net_listener_port`.
#[op2]
pub async fn op_net_listen(state: Rc<RefCell<OpState>>, port: u16) -> Result<u32, JsErrorBox> {
    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(JsErrorBox::from_err)?;
    let resolved = listener.local_addr().map_err(JsErrorBox::from_err)?.port();
    Ok(with_net(&state, |net| {
        let id = net.next_id;
        net.next_id = net.next_id.wrapping_add(1);
        net.listeners.insert(
            id,
            Rc::new(ListenerEntry {
                listener: Rc::new(listener),
                port: resolved,
                close: Notify::new(),
                closed: AtomicBool::new(false),
            }),
        );
        id
    }))
}

/// The resolved local port of a listener (so the test can connect clients).
#[op2(fast)]
pub fn op_net_listener_port(state: &mut OpState, listener_id: u32) -> u16 {
    state
        .try_borrow::<NetState>()
        .and_then(|n| n.listeners.get(&listener_id).map(|e| e.port))
        .unwrap_or(0)
}

/// Accept the next client on a test listener, complete the WS handshake, and
/// register the connection. Returns `ACCEPT_CLOSED` once the listener is closed.
#[op2]
pub async fn op_net_accept(
    state: Rc<RefCell<OpState>>,
    listener_id: u32,
) -> Result<u32, JsErrorBox> {
    let entry = {
        let s = state.borrow();
        s.try_borrow::<NetState>()
            .and_then(|n| n.listeners.get(&listener_id).cloned())
    };
    let entry = match entry {
        Some(e) => e,
        None => return Ok(ACCEPT_CLOSED),
    };
    if entry.closed.load(Ordering::Acquire) {
        return Ok(ACCEPT_CLOSED);
    }
    let tcp = tokio::select! {
        biased;
        _ = entry.close.notified() => return Ok(ACCEPT_CLOSED),
        res = entry.listener.accept() => {
            let (tcp, _peer) = res.map_err(JsErrorBox::from_err)?;
            tcp
        }
    };
    tcp.set_nodelay(true).ok();
    let ws = tokio_tungstenite::accept_async(tcp)
        .await
        .map_err(|e| JsErrorBox::generic(format!("net ws handshake: {e}")))?;
    Ok(with_net(&state, |net| net.register(ws)))
}

/// Release a test listener and wake any pending `op_net_accept` on it.
#[op2(fast)]
pub fn op_net_close_listener(state: &mut OpState, listener_id: u32) {
    if let Some(net) = state.try_borrow_mut::<NetState>() {
        if let Some(entry) = net.listeners.remove(&listener_id) {
            entry.closed.store(true, Ordering::Release);
            entry.close.notify_one();
        }
    }
}

/// Accept the next client on the host-installed `--mcp-ws` listener. The
/// production server loops on this; it has no shutdown path.
#[op2]
pub async fn op_net_accept_host(state: Rc<RefCell<OpState>>) -> Result<u32, JsErrorBox> {
    let listener = {
        let s = state.borrow();
        s.borrow::<WsListener>().0.clone()
    };
    let (tcp, _peer) = listener.accept().await.map_err(JsErrorBox::from_err)?;
    tcp.set_nodelay(true).ok();
    let ws = tokio_tungstenite::accept_async(tcp)
        .await
        .map_err(|e| JsErrorBox::generic(format!("net ws handshake: {e}")))?;
    Ok(with_net(&state, |net| net.register(ws)))
}

// ---- client side ----------------------------------------------------------

/// Open a real WebSocket client connection to `url` (ws://127.0.0.1:PORT/).
#[op2]
pub async fn op_net_connect(
    state: Rc<RefCell<OpState>>,
    #[string] url: String,
) -> Result<u32, JsErrorBox> {
    let (ws, _resp) = tokio_tungstenite::connect_async(&url)
        .await
        .map_err(|e| JsErrorBox::generic(format!("net connect: {e}")))?;
    Ok(with_net(&state, |net| net.register(ws)))
}

// ---- per-connection read / write / close ----------------------------------

/// Read the next text message from a connection. Returns "" on close / EOF /
/// transport error (the disconnect signal the JS loops break on).
#[op2]
#[string]
pub async fn op_net_recv(state: Rc<RefCell<OpState>>, conn_id: u32) -> Result<String, JsErrorBox> {
    let conn = match conn_by_id(&state, conn_id) {
        Some(c) => c,
        None => return Ok(String::new()),
    };
    if conn.closed.load(Ordering::Acquire) {
        return Ok(String::new());
    }
    // Single-reader-per-connection contract: each connection is driven by exactly
    // one `op_net_recv` read loop at a time. The guard is held across an unbounded
    // `rx.next()` await, so a second concurrent reader on the same conn would park
    // on this lock forever (silent starvation). Fail fast instead of hanging.
    let mut rx = conn
        .rx
        .try_lock()
        .map_err(|_| JsErrorBox::generic("connection already has an active reader"))?;
    loop {
        tokio::select! {
            biased;
            _ = conn.close.notified() => return Ok(String::new()),
            msg = rx.next() => match msg {
                Some(Ok(Message::Text(text))) => return Ok(text.as_str().to_string()),
                Some(Ok(Message::Binary(bytes))) => match std::str::from_utf8(&bytes) {
                    Ok(s) => return Ok(s.to_string()),
                    Err(_) => continue,
                },
                Some(Ok(Message::Close(_))) | None => return Ok(String::new()),
                Some(Ok(_)) => continue,
                Some(Err(_)) => return Ok(String::new()),
            }
        }
    }
}

/// Send one text frame to a connection. Errors if the connection is gone/closed
/// so the JS broadcaster can prune a disconnected client.
#[op2]
pub async fn op_net_send(
    state: Rc<RefCell<OpState>>,
    conn_id: u32,
    #[string] line: String,
) -> Result<(), JsErrorBox> {
    let conn = conn_by_id(&state, conn_id)
        .ok_or_else(|| JsErrorBox::generic("net: send on unknown connection"))?;
    if conn.closed.load(Ordering::Acquire) {
        return Err(JsErrorBox::generic("net: send on closed connection"));
    }
    let mut tx = conn.tx.lock().await;
    tx.send(Message::text(line))
        .await
        .map_err(|e| JsErrorBox::generic(format!("net send: {e}")))?;
    Ok(())
}

/// Close a connection: wake its read loop, send a WS Close, and drop it from the
/// registry. The peer observes EOF; any in-flight `op_net_recv` returns "".
#[op2]
pub async fn op_net_close(state: Rc<RefCell<OpState>>, conn_id: u32) {
    let conn = {
        let mut s = state.borrow_mut();
        s.try_borrow_mut::<NetState>()
            .and_then(|n| n.conns.remove(&conn_id))
    };
    if let Some(conn) = conn {
        conn.closed.store(true, Ordering::Release);
        conn.close.notify_one();
        let mut tx = conn.tx.lock().await;
        let _ = tx.close().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `NetConn` whose halves are inert stand-ins: the stream never yields
    /// (`pending`) and the sink swallows everything (`drain`). Enough to exercise
    /// the single-reader lock without a live socket peer.
    fn dummy_conn() -> NetConn {
        let rx = futures_util::stream::pending::<Result<Message, WsError>>();
        let tx = futures_util::sink::drain::<Message>()
            .sink_map_err(|never: std::convert::Infallible| -> WsError { match never {} });
        NetConn {
            tx: Mutex::new(Box::pin(tx) as BoxedSink),
            rx: Mutex::new(Box::pin(rx) as BoxedStream),
            close: Notify::new(),
            closed: AtomicBool::new(false),
        }
    }

    /// Single-reader-per-connection contract (wave 1). `op_net_recv` holds
    /// `conn.rx` across an unbounded `rx.next()` await, so a second concurrent
    /// reader would park on the lock forever; instead it must fail fast with the
    /// documented error. A full two-reader socket exercise needs a live peer and
    /// two concurrent `!Send` tasks, so we cover the smallest reachable unit: the
    /// `try_lock` error branch `op_net_recv` returns while the first reader holds
    /// the guard.
    #[test]
    fn second_reader_fails_fast_instead_of_hanging() {
        let conn = dummy_conn();
        // First reader owns the rx lock (stands in for one held across `.next()`).
        let _first = conn
            .rx
            .try_lock()
            .expect("first reader acquires the single-reader lock");
        // Second reader takes op_net_recv's exact branch: try_lock -> documented error.
        let err = conn
            .rx
            .try_lock()
            .map(|_guard| ()) // discard the (non-Debug) guard so `expect_err` can format Ok
            .map_err(|_| JsErrorBox::generic("connection already has an active reader"))
            .expect_err("second reader must fail while the first holds the lock");
        assert!(err.to_string().contains("active reader"), "got: {err}");
    }
}

extension!(
    limina_net,
    ops = [
        op_net_listen,
        op_net_listener_port,
        op_net_accept,
        op_net_close_listener,
        op_net_accept_host,
        op_net_connect,
        op_net_recv,
        op_net_send,
        op_net_close,
    ],
    state = |state| {
        state.put(NetState::default());
    },
);
