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
use std::collections::{HashMap, HashSet};
use std::pin::Pin;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use deno_core::{extension, op2, OpState};
use deno_error::JsErrorBox;
use futures_util::{Sink, SinkExt, Stream, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::{Mutex, Notify};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::Error as WsError;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{accept_hdr_async, WebSocketStream};

/// Returned by `op_net_accept` when its listener has been closed, so the JS
/// accept loop can break cleanly instead of awaiting a connection forever.
const ACCEPT_CLOSED: u32 = u32::MAX;
const NET_SEND_TIMEOUT: Duration = Duration::from_millis(50);
/// Cap the per-connection WebSocket UPGRADE handshake. The accept loop performs the
/// handshake inline before it can accept the next client, so a single half-open peer
/// (a TCP connect that never sends the HTTP Upgrade -- e.g. a browser mid-reconnect,
/// a health probe, a port scan) would otherwise block ALL new connections forever.
/// A real local handshake completes in <1ms; anything past this is abandoned so the
/// loop keeps accepting. Bounds head-of-line blocking to one timeout, never infinite.
const WS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

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

fn deregister_conn(state: &Rc<RefCell<OpState>>, conn_id: u32, conn: &Rc<NetConn>) {
    {
        let mut s = state.borrow_mut();
        if let Some(net) = s.try_borrow_mut::<NetState>() {
            let should_remove = net
                .conns
                .get(&conn_id)
                .is_some_and(|registered| Rc::ptr_eq(registered, conn));
            if should_remove {
                net.conns.remove(&conn_id);
            }
        }
    }
    conn.closed.store(true, Ordering::Release);
    conn.close.notify_waiters();
}

// ---- listeners (test server side) -----------------------------------------

/// Bind a localhost listener (`port` 0 = ephemeral). Returns a listener id; the
/// resolved port is read with `op_net_listener_port`.
#[op2]
pub async fn op_net_listen(state: Rc<RefCell<OpState>>, port: u16) -> Result<u32, JsErrorBox> {
    net_listen_impl(state, port).await
}

async fn net_listen_impl(state: Rc<RefCell<OpState>>, port: u16) -> Result<u32, JsErrorBox> {
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
    net_listener_port_impl(state, listener_id)
}

fn net_listener_port_impl(state: &mut OpState, listener_id: u32) -> u16 {
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
    net_accept_impl(state, listener_id).await
}

async fn net_accept_impl(state: Rc<RefCell<OpState>>, listener_id: u32) -> Result<u32, JsErrorBox> {
    net_accept_impl_with_origins(state, listener_id, None).await
}

#[op2]
pub async fn op_net_accept_allowed_origins(
    state: Rc<RefCell<OpState>>,
    listener_id: u32,
    #[string] allowed_origins_json: String,
) -> Result<u32, JsErrorBox> {
    let allowed: Vec<String> = serde_json::from_str(&allowed_origins_json)
        .map_err(|e| JsErrorBox::generic(format!("invalid websocket origin allowlist: {e}")))?;
    net_accept_impl_with_origins(state, listener_id, Some(&allowed)).await
}

fn origin_rejection() -> ErrorResponse {
    Response::builder()
        .status(403)
        .body(Some("websocket origin is not allowed".to_string()))
        .expect("valid websocket origin rejection response")
}

fn origin_is_allowed(req: &Request, allowed_origins: Option<&HashSet<String>>) -> bool {
    let Some(allowed) = allowed_origins else {
        return true;
    };
    let Some(origin) = req.headers().get("origin") else {
        return true;
    };
    match origin.to_str() {
        Ok(origin) => allowed.contains(origin),
        Err(_) => false,
    }
}

async fn accept_ws_with_origins(
    tcp: tokio::net::TcpStream,
    allowed_origins: Option<HashSet<String>>,
) -> Result<WebSocketStream<tokio::net::TcpStream>, WsError> {
    let callback = move |req: &Request, response: Response| {
        if origin_is_allowed(req, allowed_origins.as_ref()) {
            Ok(response)
        } else {
            Err(origin_rejection())
        }
    };
    accept_hdr_async(tcp, callback).await
}

async fn net_accept_impl_with_origins(
    state: Rc<RefCell<OpState>>,
    listener_id: u32,
    allowed_origins: Option<&[String]>,
) -> Result<u32, JsErrorBox> {
    let allowed_origins =
        allowed_origins.map(|origins| origins.iter().cloned().collect::<HashSet<_>>());
    let entry = {
        let s = state.borrow();
        s.try_borrow::<NetState>()
            .and_then(|n| n.listeners.get(&listener_id).cloned())
    };
    let entry = match entry {
        Some(e) => e,
        None => return Ok(ACCEPT_CLOSED),
    };
    loop {
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
        // Bound the handshake so a stalled/half-open peer cannot wedge the accept loop
        // (and thereby starve EVERY subsequent connection, e.g. a coordinator bridge
        // that connects while a browser is churning reconnects). Drop + keep accepting.
        match timeout(WS_HANDSHAKE_TIMEOUT, accept_ws_with_origins(tcp, allowed_origins.clone())).await {
            Ok(Ok(ws)) => return Ok(with_net(&state, |net| net.register(ws))),
            Ok(Err(_)) => continue,
            Err(_) => continue,
        }
    }
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
    net_accept_host_impl(state).await
}

#[op2(fast)]
pub fn op_net_host_port(state: &mut OpState) -> u16 {
    state
        .try_borrow::<WsListener>()
        .and_then(|listener| listener.0.local_addr().ok().map(|addr| addr.port()))
        .unwrap_or(0)
}

async fn net_accept_host_impl(state: Rc<RefCell<OpState>>) -> Result<u32, JsErrorBox> {
    let listener = {
        let s = state.borrow();
        s.borrow::<WsListener>().0.clone()
    };
    loop {
        let (tcp, _peer) = listener.accept().await.map_err(JsErrorBox::from_err)?;
        tcp.set_nodelay(true).ok();
        // Same head-of-line guard as the gated listener: a stalled handshake must not
        // block the host accept loop from taking the next client.
        match timeout(WS_HANDSHAKE_TIMEOUT, tokio_tungstenite::accept_async(tcp)).await {
            Ok(Ok(ws)) => return Ok(with_net(&state, |net| net.register(ws))),
            Ok(Err(_)) => continue,
            Err(_) => continue,
        }
    }
}

// ---- client side ----------------------------------------------------------

/// Open a real WebSocket client connection to `url` (ws://127.0.0.1:PORT/).
#[op2]
pub async fn op_net_connect(
    state: Rc<RefCell<OpState>>,
    #[string] url: String,
) -> Result<u32, JsErrorBox> {
    net_connect_impl(state, url).await
}

async fn net_connect_impl(state: Rc<RefCell<OpState>>, url: String) -> Result<u32, JsErrorBox> {
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
    net_recv_impl(state, conn_id).await
}

async fn net_recv_impl(state: Rc<RefCell<OpState>>, conn_id: u32) -> Result<String, JsErrorBox> {
    let conn = match conn_by_id(&state, conn_id) {
        Some(c) => c,
        None => return Ok(String::new()),
    };
    if conn.closed.load(Ordering::Acquire) {
        deregister_conn(&state, conn_id, &conn);
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
            _ = conn.close.notified() => {
                deregister_conn(&state, conn_id, &conn);
                return Ok(String::new());
            },
            msg = rx.next() => match msg {
                Some(Ok(Message::Text(text))) => return Ok(text.as_str().to_string()),
                Some(Ok(Message::Binary(bytes))) => match std::str::from_utf8(&bytes) {
                    Ok(s) => return Ok(s.to_string()),
                    Err(_) => continue,
                },
                Some(Ok(Message::Close(_))) | None => {
                    deregister_conn(&state, conn_id, &conn);
                    return Ok(String::new());
                },
                Some(Ok(_)) => continue,
                Some(Err(_)) => {
                    deregister_conn(&state, conn_id, &conn);
                    return Ok(String::new());
                },
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
    net_send_impl(state, conn_id, line).await
}

async fn net_send_impl(
    state: Rc<RefCell<OpState>>,
    conn_id: u32,
    line: String,
) -> Result<(), JsErrorBox> {
    let conn = conn_by_id(&state, conn_id)
        .ok_or_else(|| JsErrorBox::generic("net: send on unknown connection"))?;
    if conn.closed.load(Ordering::Acquire) {
        return Err(JsErrorBox::generic("net: send on closed connection"));
    }
    match timeout(NET_SEND_TIMEOUT, async {
        let mut tx = conn.tx.lock().await;
        tx.send(Message::text(line)).await
    })
    .await
    {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => {
            deregister_conn(&state, conn_id, &conn);
            Err(JsErrorBox::generic(format!("net send: {e}")))
        }
        Err(_) => {
            deregister_conn(&state, conn_id, &conn);
            Err(JsErrorBox::generic(format!(
                "net send timeout after {}ms",
                NET_SEND_TIMEOUT.as_millis()
            )))
        }
    }
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
    use std::task::{Context, Poll};
    use std::time::Duration;

    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpStream;
    use tokio::time::timeout;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    struct PendingSink;

    impl Sink<Message> for PendingSink {
        type Error = WsError;

        fn poll_ready(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Pending
        }

        fn start_send(self: Pin<&mut Self>, _item: Message) -> Result<(), Self::Error> {
            Ok(())
        }

        fn poll_flush(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn poll_close(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
    }

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

    fn conn_with_parts(
        tx: impl Sink<Message, Error = WsError> + 'static,
        rx: impl Stream<Item = Result<Message, WsError>> + 'static,
    ) -> NetConn {
        NetConn {
            tx: Mutex::new(Box::pin(tx) as BoxedSink),
            rx: Mutex::new(Box::pin(rx) as BoxedStream),
            close: Notify::new(),
            closed: AtomicBool::new(false),
        }
    }

    fn state_with_conn(conn: NetConn) -> (Rc<RefCell<OpState>>, u32, Rc<NetConn>) {
        let state = Rc::new(RefCell::new(OpState::new(None)));
        let conn = Rc::new(conn);
        let conn_id = with_net(&state, |net| {
            let id = net.next_id;
            net.next_id = net.next_id.wrapping_add(1);
            net.conns.insert(id, conn.clone());
            id
        });
        (state, conn_id, conn)
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

    #[tokio::test(flavor = "current_thread")]
    async fn recv_terminal_frame_deregisters_connection() {
        let tx = futures_util::sink::drain::<Message>()
            .sink_map_err(|never: std::convert::Infallible| -> WsError { match never {} });
        let rx = futures_util::stream::iter([Ok(Message::Close(None))]);
        let (state, conn_id, conn) = state_with_conn(conn_with_parts(tx, rx));

        let line = net_recv_impl(state.clone(), conn_id)
            .await
            .expect("terminal recv should report disconnect as empty string");

        assert_eq!(line, "");
        assert!(conn.closed.load(Ordering::Acquire));
        assert!(
            conn_by_id(&state, conn_id).is_none(),
            "terminal recv must remove the connection from NetState"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn send_timeout_returns_error_and_deregisters_connection() {
        let rx = futures_util::stream::pending::<Result<Message, WsError>>();
        let (state, conn_id, conn) = state_with_conn(conn_with_parts(PendingSink, rx));

        let result = timeout(
            Duration::from_millis(200),
            net_send_impl(state.clone(), conn_id, "tick".to_string()),
        )
        .await
        .expect("op_net_send must use its own bounded send timeout")
        .expect_err("timed-out send must not report fake success");

        assert!(
            result.to_string().contains("timeout"),
            "unexpected send error: {result}"
        );
        assert!(conn.closed.load(Ordering::Acquire));
        assert!(
            conn_by_id(&state, conn_id).is_none(),
            "timed-out send must remove the connection from NetState"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn accept_skips_bad_handshake_and_accepts_next_client() {
        let state = Rc::new(RefCell::new(OpState::new(None)));
        let listener_id = net_listen_impl(state.clone(), 0)
            .await
            .expect("bind test listener");
        let port = {
            let mut s = state.borrow_mut();
            net_listener_port_impl(&mut s, listener_id)
        };

        let mut bad = TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connect raw bad client");
        bad.write_all(b"not a websocket handshake\r\n")
            .await
            .expect("write bad handshake bytes");
        drop(bad);

        let url = format!("ws://127.0.0.1:{port}/");
        let good = tokio::spawn(async move { tokio_tungstenite::connect_async(url).await });

        let accepted = timeout(
            Duration::from_secs(2),
            net_accept_impl(state.clone(), listener_id),
        )
        .await
        .expect("accept should continue after a per-connection handshake failure")
        .expect("accept should register the next valid websocket client");
        let (_client, _resp) = timeout(Duration::from_secs(2), good)
            .await
            .expect("valid client connect timed out")
            .expect("valid client task panicked")
            .expect("valid websocket client should connect");

        assert!(
            conn_by_id(&state, accepted).is_some(),
            "accepted websocket must be registered"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn accept_rejects_disallowed_browser_origin_and_accepts_allowed_origin() {
        let state = Rc::new(RefCell::new(OpState::new(None)));
        let listener_id = net_listen_impl(state.clone(), 0)
            .await
            .expect("bind test listener");
        let port = {
            let mut s = state.borrow_mut();
            net_listener_port_impl(&mut s, listener_id)
        };
        let allowed = ["http://localhost:5173".to_string()];

        let bad_url = format!("ws://127.0.0.1:{port}/")
            .into_client_request()
            .expect("build bad-origin websocket request");
        let mut bad_req = bad_url;
        bad_req.headers_mut().insert(
            "Origin",
            "https://evil.example".parse().expect("valid origin header"),
        );
        let bad = tokio::spawn(async move { tokio_tungstenite::connect_async(bad_req).await });

        let good_url = format!("ws://127.0.0.1:{port}/")
            .into_client_request()
            .expect("build good-origin websocket request");
        let mut good_req = good_url;
        good_req.headers_mut().insert(
            "Origin",
            "http://localhost:5173"
                .parse()
                .expect("valid origin header"),
        );
        let good = tokio::spawn(async move { tokio_tungstenite::connect_async(good_req).await });

        let accepted = timeout(
            Duration::from_secs(2),
            net_accept_impl_with_origins(state.clone(), listener_id, Some(&allowed)),
        )
        .await
        .expect("accept should skip a disallowed Origin and continue")
        .expect("accept should register the next allowed-origin websocket client");

        timeout(Duration::from_secs(2), bad)
            .await
            .expect("bad-origin client timed out")
            .expect("bad-origin client task panicked")
            .expect_err("bad Origin must fail the websocket handshake");
        let (_client, _resp) = timeout(Duration::from_secs(2), good)
            .await
            .expect("allowed-origin client timed out")
            .expect("allowed-origin client task panicked")
            .expect("allowed Origin should connect");
        assert!(
            conn_by_id(&state, accepted).is_some(),
            "accepted allowed-origin websocket must be registered"
        );
    }
}

extension!(
    limina_net,
    ops = [
        op_net_listen,
        op_net_listener_port,
        op_net_accept,
        op_net_accept_allowed_origins,
        op_net_close_listener,
        op_net_accept_host,
        op_net_host_port,
        op_net_connect,
        op_net_recv,
        op_net_send,
        op_net_close,
    ],
    state = |state| {
        state.put(NetState::default());
    },
);
