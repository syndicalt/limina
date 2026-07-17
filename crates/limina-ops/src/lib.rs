//! limina-ops - shared `#[op2]` bridge and OpState resource conventions.
//!
//! Phase 0 establishes the patterns every native subsystem (physics now, an
//! eventual native ECS later) marshals through:
//!   * fast numeric ops on the V8 fastcall path,
//!   * zero-copy buffer round-trips that borrow the V8 ArrayBuffer in place,
//!   * structured errors surfaced as catchable JS exceptions,
//!   * host-owned resources held in `OpState`, fetched per call.

use std::collections::HashMap;
use std::io::{BufWriter, Read, Write};
use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use deno_core::{extension, op2, OpState};
use deno_error::JsErrorBox;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE, HOST};
use reqwest::Url;

/// When set (by the `--mcp-stdio` entry point), `op_log` writes to stderr:
/// stdout is the JSON-RPC transport there and any stray write corrupts its
/// framing. Every other mode keeps stdout — gates and exporters scrape it.
static LOG_TO_STDERR: AtomicBool = AtomicBool::new(false);

pub fn route_js_logs_to_stderr() {
    LOG_TO_STDERR.store(true, Ordering::Relaxed);
}

/// String logging op. The `#[string]` arg forces the non-fast path; fine here.
#[op2(fast)]
pub fn op_log(#[string] msg: &str) {
    if LOG_TO_STDERR.load(Ordering::Relaxed) {
        eprintln!("[js] {msg}");
    } else {
        println!("[js] {msg}");
    }
}

/// Fast numeric op (V8 fastcall path): all-scalar args/return. Kept registered:
/// `js/test/p0_2_ops.ts` gates the op-bridge marshalling patterns through the
/// phase-0 demo ops (op_sum/op_buffer_scale/op_fail/op_counter_inc).
#[op2(fast)]
pub fn op_sum(a: u32, b: u32) -> u32 {
    a.wrapping_add(b)
}

/// Zero-copy buffer round-trip: scales each `f32` in place. JS observes the
/// mutation because the slice borrows the `Float32Array` backing store directly
/// (no copy in or out). The borrow is valid only for the duration of the call.
#[op2(fast)]
pub fn op_buffer_scale(#[buffer] data: &mut [f32], factor: f32) {
    for x in data.iter_mut() {
        *x *= factor;
    }
}

/// Error op: returns a structured error that surfaces as a catchable JS
/// exception rather than a raw panic.
#[op2(fast)]
pub fn op_fail(#[string] msg: String) -> Result<(), JsErrorBox> {
    Err(JsErrorBox::generic(msg))
}

/// Host-owned resource held in `OpState`. Demonstrates the fetch-per-call
/// pattern native subsystems use for their long-lived state.
#[derive(Default)]
struct Counter(u32);

#[op2(fast)]
pub fn op_counter_inc(state: &mut OpState) -> u32 {
    if let Some(counter) = state.try_borrow_mut::<Counter>() {
        counter.0 += 1;
        counter.0
    } else {
        state.put(Counter(1));
        1
    }
}

/// Host-configured root for `op_read_asset`. Defaults to `<cwd>/assets`.
struct AssetRoot(std::path::PathBuf);

const MAX_TRACE_CALL_BYTES: usize = 16 * 1024 * 1024;
const MAX_TRACE_FILE_BYTES: u64 = 512 * 1024 * 1024;
/// Cap on concurrently open trace file handles. Appends to more distinct trace
/// names than this evict the least-recently-used writer (flushed, then closed);
/// a later append to an evicted name transparently reopens it in append mode.
const MAX_OPEN_TRACE_WRITERS: usize = 16;
static TRACE_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct TraceWriter {
    writer: BufWriter<std::fs::File>,
    bytes: u64,
    /// Logical clock stamp of the most recent append (LRU eviction key).
    last_used: u64,
}

#[derive(Default)]
struct TraceWriters {
    writers: HashMap<std::path::PathBuf, TraceWriter>,
    /// Monotonic logical clock; bumped per append to stamp `last_used`.
    clock: u64,
}

/// Read a relative asset file as bytes, sandboxed to the asset root. Rejects
/// absolute paths, `..` traversal, and symlink escapes; caps size. Agents only
/// ever name a relative asset id, never a host path.
#[op2]
#[buffer]
pub fn op_read_asset(state: &mut OpState, #[string] rel: String) -> Result<Vec<u8>, JsErrorBox> {
    let root = state
        .try_borrow::<AssetRoot>()
        .map(|r| r.0.clone())
        .ok_or_else(|| JsErrorBox::generic("no asset root configured"))?;
    read_asset_bytes(&root, &rel)
}

/// The sandboxed asset read as a pure function of `(root, rel)`, split out from
/// the `op2` wrapper so the containment + size-cap logic is testable without a
/// V8/`OpState` round-trip. Behaviour is identical to the op body.
fn read_asset_bytes(root: &Path, rel: &str) -> Result<Vec<u8>, JsErrorBox> {
    const MAX_BYTES: u64 = 64 * 1024 * 1024;
    if rel.is_empty() || Path::new(rel).is_absolute() || rel.split(['/', '\\']).any(|c| c == "..") {
        return Err(JsErrorBox::generic(
            "asset id must be a relative path within the asset root",
        ));
    }
    let root_canon = root
        .canonicalize()
        .map_err(|e| JsErrorBox::generic(format!("asset root missing: {e}")))?;
    let candidate = root
        .join(rel)
        .canonicalize()
        .map_err(|e| JsErrorBox::generic(format!("asset not found: {e}")))?;
    if !candidate.starts_with(&root_canon) {
        return Err(JsErrorBox::generic("asset id escapes the asset root"));
    }
    // Open once, then size-check and read through the same handle to shrink the
    // canonicalize->read TOCTOU window: the metadata cap and the bytes both come
    // from this fd, so a path swap after canonicalize cannot slip a different
    // (larger) file between the size check and the read.
    let file = std::fs::File::open(&candidate).map_err(JsErrorBox::from_err)?;
    let meta = file.metadata().map_err(JsErrorBox::from_err)?;
    if meta.len() > MAX_BYTES {
        return Err(JsErrorBox::generic("asset exceeds size cap"));
    }
    // Bound the ACTUAL read, not just the metadata: an append between the size
    // check and the read could otherwise slip past the cap. Take one byte past
    // the limit so an over-cap file is detected and rejected.
    let mut buf = Vec::with_capacity(meta.len() as usize);
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(JsErrorBox::from_err)?;
    if buf.len() as u64 > MAX_BYTES {
        return Err(JsErrorBox::generic("asset exceeds size cap"));
    }
    Ok(buf)
}

/// Resolve a bare trace filename under `<cwd>/traces` (no path separators / `..`).
fn trace_path(name: &str) -> Result<std::path::PathBuf, JsErrorBox> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(JsErrorBox::generic("trace name must be a bare filename"));
    }
    Ok(std::env::current_dir()
        .unwrap_or_default()
        .join("traces")
        .join(name))
}

/// Write an exported trace JSONL to `<cwd>/traces/<name>`.
#[op2(fast)]
pub fn op_write_trace(
    state: &mut OpState,
    #[string] name: String,
    #[string] content: String,
) -> Result<(), JsErrorBox> {
    if content.len() > MAX_TRACE_FILE_BYTES as usize {
        return Err(JsErrorBox::generic("trace write exceeds file size cap"));
    }
    let path = trace_path(&name)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(JsErrorBox::from_err)?;
    }
    if let Some(writers) = state.try_borrow_mut::<TraceWriters>() {
        writers.writers.remove(&path);
    }
    let seq = TRACE_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp = path.with_extension(format!("limina-tmp-{}-{seq}", std::process::id()));
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(content.as_bytes())?;
        file.flush()?;
        std::fs::rename(&temp, &path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result.map_err(JsErrorBox::from_err)
}

/// Append one already-complete trace JSONL segment to `<cwd>/traces/<name>`.
#[op2(fast)]
pub fn op_append_trace(
    state: &mut OpState,
    #[string] name: String,
    #[string] content: String,
) -> Result<(), JsErrorBox> {
    if content.len() > MAX_TRACE_CALL_BYTES {
        return Err(JsErrorBox::generic(
            "trace append exceeds per-call size cap",
        ));
    }
    let path = trace_path(&name)?;
    append_trace_at(state, path, &content)
}

/// The append body over a resolved path, split from the `op2` wrapper so the
/// bounded-writer-map behavior is testable without touching `<cwd>/traces`.
fn append_trace_at(
    state: &mut OpState,
    path: std::path::PathBuf,
    content: &str,
) -> Result<(), JsErrorBox> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(JsErrorBox::from_err)?;
    }
    if state.try_borrow::<TraceWriters>().is_none() {
        state.put(TraceWriters::default());
    }
    let writers = state.borrow_mut::<TraceWriters>();
    writers.clock += 1;
    let now = writers.clock;
    if !writers.writers.contains_key(&path) {
        // Bound the open-handle map: evict the least-recently-used writer before
        // opening another. Every append already flushes, so eviction loses no
        // bytes; the file reopens (append mode) on the next append to that name.
        if writers.writers.len() >= MAX_OPEN_TRACE_WRITERS {
            if let Some(lru) = writers
                .writers
                .iter()
                .min_by_key(|(_, w)| w.last_used)
                .map(|(p, _)| p.clone())
            {
                if let Some(mut evicted) = writers.writers.remove(&lru) {
                    let _ = evicted.writer.flush();
                }
            }
        }
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(JsErrorBox::from_err)?;
        let bytes = file.metadata().map_err(JsErrorBox::from_err)?.len();
        writers.writers.insert(
            path.clone(),
            TraceWriter {
                writer: BufWriter::new(file),
                bytes,
                last_used: now,
            },
        );
    }
    let trace = writers.writers.get_mut(&path).expect("trace writer inserted");
    trace.last_used = now;
    let next_bytes = trace
        .bytes
        .checked_add(content.len() as u64)
        .ok_or_else(|| JsErrorBox::generic("trace file length overflow"))?;
    if next_bytes > MAX_TRACE_FILE_BYTES {
        return Err(JsErrorBox::generic("trace file exceeds size cap"));
    }
    trace
        .writer
        .write_all(content.as_bytes())
        .map_err(JsErrorBox::from_err)?;
    // Flush BufWriter into the OS page cache so a following read sees the append;
    // deliberately no sync_data/fsync on the event loop.
    trace.writer.flush().map_err(JsErrorBox::from_err)?;
    trace.bytes = next_bytes;
    Ok(())
}

/// Read back a trace JSONL from `<cwd>/traces/<name>`.
#[op2]
#[string]
pub fn op_read_trace(state: &mut OpState, #[string] name: String) -> Result<String, JsErrorBox> {
    let path = trace_path(&name)?;
    if let Some(writers) = state.try_borrow_mut::<TraceWriters>() {
        if let Some(trace) = writers.writers.get_mut(&path) {
            trace.writer.flush().map_err(JsErrorBox::from_err)?;
        }
    }
    let file = std::fs::File::open(path).map_err(JsErrorBox::from_err)?;
    let size = file.metadata().map_err(JsErrorBox::from_err)?.len();
    if size > MAX_TRACE_FILE_BYTES {
        return Err(JsErrorBox::generic("trace read exceeds size cap"));
    }
    let mut content = String::with_capacity(size as usize);
    file.take(MAX_TRACE_FILE_BYTES + 1)
        .read_to_string(&mut content)
        .map_err(JsErrorBox::from_err)?;
    if content.len() as u64 > MAX_TRACE_FILE_BYTES {
        return Err(JsErrorBox::generic("trace read exceeds size cap"));
    }
    Ok(content)
}

/// Provider-agnostic HTTP POST (JSON). Async: returns a Promise resolved when the
/// host pumps the event loop. The only HTTP need (LLM providers) goes through here.
const MAX_HTTP_REQUEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_HTTP_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_HTTP_HEADER_COUNT: usize = 24;
const MAX_HTTP_HEADER_NAME_VALUE_BYTES: usize = 4096;

#[op2]
#[string]
pub async fn op_http_post(
    #[string] url: String,
    #[string] body: String,
) -> Result<String, JsErrorBox> {
    http_post_with_headers(url, body, None).await
}

#[op2]
#[string]
pub async fn op_http_post_headers(
    #[string] url: String,
    #[string] body: String,
    #[string] headers_json: String,
) -> Result<String, JsErrorBox> {
    let headers = parse_http_post_headers(&headers_json)?;
    http_post_with_headers(url, body, Some(headers)).await
}

async fn http_post_with_headers(
    url: String,
    body: String,
    headers: Option<HeaderMap>,
) -> Result<String, JsErrorBox> {
    if body.len() > MAX_HTTP_REQUEST_BYTES {
        return Err(JsErrorBox::generic(
            "http post: request body exceeds size cap",
        ));
    }
    let url = validate_http_post_url(&url)?;
    let addrs = resolve_http_post_targets(&url).await?;
    let host = url
        .host_str()
        .ok_or_else(|| JsErrorBox::generic("http post: URL host is required"))?;
    let client = build_http_post_client(host, &addrs)?;
    let headers = headers.unwrap_or_else(default_http_post_headers);
    let mut resp = client
        .post(url)
        .headers(headers)
        .body(body)
        .send()
        .await
        .map_err(|e| JsErrorBox::generic(format!("http post: {e}")))?;
    read_limited_text_response(&mut resp, MAX_HTTP_RESPONSE_BYTES).await
}

fn default_http_post_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers
}

fn parse_http_post_headers(headers_json: &str) -> Result<HeaderMap, JsErrorBox> {
    let parsed: serde_json::Value = serde_json::from_str(headers_json)
        .map_err(|e| JsErrorBox::generic(format!("http post headers: invalid JSON: {e}")))?;
    let object = parsed.as_object().ok_or_else(|| {
        JsErrorBox::generic("http post headers: headers_json must be a JSON object")
    })?;
    if object.len() > MAX_HTTP_HEADER_COUNT {
        return Err(JsErrorBox::generic(format!(
            "http post headers: too many headers (max {MAX_HTTP_HEADER_COUNT})"
        )));
    }

    let mut headers = HeaderMap::new();
    for (name, value) in object {
        let value = value.as_str().ok_or_else(|| {
            JsErrorBox::generic("http post headers: header values must be strings")
        })?;
        if name.len().saturating_add(value.len()) > MAX_HTTP_HEADER_NAME_VALUE_BYTES {
            return Err(JsErrorBox::generic(format!(
                "http post headers: header '{name}' is too large"
            )));
        }
        if !name.is_ascii() || !value.is_ascii() {
            return Err(JsErrorBox::generic(format!(
                "http post headers: header '{name}' must be ASCII"
            )));
        }
        let header_name = HeaderName::from_bytes(name.as_bytes()).map_err(|e| {
            JsErrorBox::generic(format!(
                "http post headers: invalid header name '{name}': {e}"
            ))
        })?;
        if header_name == HOST {
            return Err(JsErrorBox::generic(
                "http post headers: Host header is not allowed",
            ));
        }
        let header_value = HeaderValue::from_str(value).map_err(|e| {
            JsErrorBox::generic(format!(
                "http post headers: invalid header value for '{name}': {e}"
            ))
        })?;
        headers.insert(header_name, header_value);
    }
    if !headers.contains_key(CONTENT_TYPE) {
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    }
    Ok(headers)
}

fn validate_http_post_url(raw: &str) -> Result<Url, JsErrorBox> {
    let url =
        Url::parse(raw).map_err(|e| JsErrorBox::generic(format!("http post: invalid URL: {e}")))?;
    match url.scheme() {
        "http" | "https" => {}
        _ => {
            return Err(JsErrorBox::generic(
                "http post: URL scheme must be http or https",
            ))
        }
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(JsErrorBox::generic(
            "http post: URL credentials are not allowed",
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| JsErrorBox::generic("http post: URL host is required"))?;
    if !is_http_post_host_allowed(host, url.port_or_known_default()) {
        return Err(JsErrorBox::generic(format!(
            "http post: host '{host}' is not allowed"
        )));
    }
    Ok(url)
}

fn is_http_post_host_allowed(host: &str, port: Option<u16>) -> bool {
    let host_lc = host.trim_matches(['[', ']']).to_ascii_lowercase();
    if host_lc == "localhost" {
        return true;
    }
    if let Ok(ip) = host_lc.parse::<IpAddr>() {
        return ip.is_loopback();
    }
    let host_port = port.map(|p| format!("{host_lc}:{p}"));
    resolve_env("LIMINA_HTTP_POST_ALLOW")
        .map(|allow| {
            allow.split(',').any(|entry| {
                let entry = entry.trim().to_ascii_lowercase();
                !entry.is_empty() && (entry == host_lc || Some(entry) == host_port)
            })
        })
        .unwrap_or(false)
}

fn is_http_post_target_ip_allowed(host: &str, ip: &IpAddr) -> bool {
    let host_lc = host.trim_matches(['[', ']']).to_ascii_lowercase();
    let host_is_loopback = host_lc == "localhost"
        || host_lc
            .parse::<IpAddr>()
            .map(|host_ip| match host_ip {
                IpAddr::V4(ip) => ip.is_loopback(),
                IpAddr::V6(ip) => ip
                    .to_ipv4_mapped()
                    .map_or_else(|| ip.is_loopback(), |mapped| mapped.is_loopback()),
            })
            .unwrap_or(false);
    if host_is_loopback {
        return match ip {
            IpAddr::V4(ip) => ip.is_loopback(),
            IpAddr::V6(ip) => ip
                .to_ipv4_mapped()
                .map_or_else(|| ip.is_loopback(), |mapped| mapped.is_loopback()),
        };
    }
    is_public_http_target_ip(ip)
}

fn is_public_http_target_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, _, _] = ip.octets();
            !(ip.is_unspecified()
                || ip.is_loopback()
                || ip.is_private()
                || ip.is_link_local()
                || ip.is_multicast()
                || ip.is_broadcast()
                || ip.is_documentation()
                || a == 0
                || (a == 100 && (64..=127).contains(&b))
                || (a == 192 && b == 0)
                || (a == 198 && (18..=19).contains(&b))
                || a >= 240)
        }
        IpAddr::V6(ip) => {
            if let Some(mapped) = ip.to_ipv4_mapped() {
                return is_public_http_target_ip(&IpAddr::V4(mapped));
            }
            let segments = ip.segments();
            !(ip.is_unspecified()
                || ip.is_loopback()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
                || ip.is_multicast()
                || (segments[0] == 0x2001 && segments[1] == 0x0db8))
        }
    }
}

async fn resolve_http_post_targets(url: &Url) -> Result<Vec<SocketAddr>, JsErrorBox> {
    let host = url
        .host_str()
        .ok_or_else(|| JsErrorBox::generic("http post: URL host is required"))?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| JsErrorBox::generic("http post: URL port is required"))?;
    let host_lc = host.trim_matches(['[', ']']).to_ascii_lowercase();
    let addrs: Vec<SocketAddr> = if let Ok(ip) = host_lc.parse::<IpAddr>() {
        vec![SocketAddr::new(ip, port)]
    } else {
        tokio::net::lookup_host((host, port))
            .await
            .map_err(|e| JsErrorBox::generic(format!("http post: DNS resolution failed: {e}")))?
            .collect()
    };
    if addrs.is_empty() {
        return Err(JsErrorBox::generic("http post: DNS returned no addresses"));
    }
    if let Some(addr) = addrs
        .iter()
        .find(|addr| !is_http_post_target_ip_allowed(host, &addr.ip()))
    {
        return Err(JsErrorBox::generic(format!(
            "http post: resolved address {} for host '{host}' is not allowed",
            addr.ip()
        )));
    }
    Ok(addrs)
}

fn build_http_post_client(host: &str, addrs: &[SocketAddr]) -> Result<reqwest::Client, JsErrorBox> {
    // A bounded client: without timeouts, a half-open peer leaves `op_http_post`'s
    // future pending forever. Pinning `host` to the pre-vetted `addrs` prevents a
    // second DNS lookup from rebinding an allowlisted name to metadata/LAN targets.
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(host, addrs)
        .build()
        .map_err(|e| JsErrorBox::generic(format!("http client: {e}")))
}

async fn read_limited_text_response(
    resp: &mut reqwest::Response,
    max_bytes: usize,
) -> Result<String, JsErrorBox> {
    if let Some(len) = resp.content_length() {
        if len > max_bytes as u64 {
            return Err(JsErrorBox::generic("http body: response exceeds size cap"));
        }
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| JsErrorBox::generic(format!("http body: {e}")))?
    {
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(JsErrorBox::generic("http body: response exceeds size cap"));
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes)
        .map_err(|e| JsErrorBox::generic(format!("http body: non-UTF-8 response: {e}")))
}

/// Async sleep primitive for JS-side bounded orchestration. The embedded
/// runtime intentionally does not expose browser timers.
#[op2]
pub async fn op_sleep_ms(ms: u32) {
    tokio::time::sleep(Duration::from_millis(ms as u64)).await;
}

/// Hex sha256 of a string. Used by the observability layer's integrity chain at
/// export time (off the frame hot path). `#[string]` arg/return is fine here.
#[op2]
#[string]
pub fn op_sha256(#[string] input: &str) -> String {
    sha256_hex(input)
}

/// Read a tightly allowlisted environment variable for host-side configuration.
/// The embedded JS runtime intentionally cannot access `Deno.env`; this op only
/// exposes Limina/Anthropic configuration names, never arbitrary host secrets.
#[op2]
#[string]
pub fn op_read_env(#[string] name: &str) -> String {
    read_allowlisted_env(name)
}

fn read_allowlisted_env(name: &str) -> String {
    if !is_allowed_env_name(name) {
        return String::new();
    }
    resolve_env(name).unwrap_or_default()
}

/// Resolve an env var with the PROCESS environment taking precedence, falling
/// back to a best-effort parse of `<cwd>/.env`. This lets a project `.env` file
/// supply values (e.g. ANTHROPIC_API_KEY, LIMINA_HTTP_POST_ALLOW) without the
/// operator having to export them first — while an explicit export still wins.
fn resolve_env(name: &str) -> Option<String> {
    if let Ok(v) = std::env::var(name) {
        return Some(v);
    }
    let dir = std::env::current_dir().ok()?;
    read_dotenv_value_in(&dir, name)
}

/// Read a single key from `<dir>/.env`. Ignores blank lines, `#` comments, and an
/// optional `export ` prefix; strips one layer of matching surrounding quotes.
/// Returns None if the file is absent/unreadable or the key is not present. Split
/// from `resolve_env` (which supplies the cwd) so the parser is unit-testable
/// without mutating the process working directory.
fn read_dotenv_value_in(dir: &Path, name: &str) -> Option<String> {
    let contents = std::fs::read_to_string(dir.join(".env")).ok()?;
    for raw in contents.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        if let Some((k, v)) = line.split_once('=') {
            if k.trim() == name {
                let v = v.trim();
                let unquoted = v
                    .strip_prefix('"')
                    .and_then(|s| s.strip_suffix('"'))
                    .or_else(|| v.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))
                    .unwrap_or(v);
                return Some(unquoted.to_string());
            }
        }
    }
    None
}

fn is_allowed_env_name(name: &str) -> bool {
    let rest = if let Some(rest) = name.strip_prefix("ANTHROPIC_") {
        rest
    } else if let Some(rest) = name.strip_prefix("LIMINA_") {
        rest
    } else {
        return false;
    };
    !rest.is_empty()
        && rest
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}

/// Pure hex-sha256, split out from the `op2` wrapper so it is directly testable.
fn sha256_hex(input: &str) -> String {
    use sha2::{Digest, Sha256};
    use std::fmt::Write as _;
    let digest = Sha256::digest(input.as_bytes());
    let mut hex = String::with_capacity(64);
    for byte in digest {
        // Write hex straight into the buffer; `write!` to a `String` is
        // infallible, so no per-byte `format!` allocation. Output is identical.
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

#[cfg(test)]
mod tests {
    use super::{
        append_trace_at, is_http_post_host_allowed, is_http_post_target_ip_allowed,
        parse_http_post_headers, read_allowlisted_env, read_asset_bytes, read_dotenv_value_in,
        sha256_hex, validate_http_post_url, TraceWriters, MAX_OPEN_TRACE_WRITERS,
    };

    /// A fresh, unique scratch directory under the OS temp dir. Canonicalizable
    /// (it exists on disk), so it works as a real asset root for `read_asset_bytes`.
    fn temp_root(tag: &str) -> std::path::PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "limina_ops_test_{tag}_{}_{stamp}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// sha256 is deterministic, matches the canonical empty-string vector, and
    /// separates distinct inputs. The op backs the export-time integrity chain,
    /// so a drift here would silently break replay verification.
    #[test]
    fn op_sha256_deterministic_and_known_vector() {
        assert_eq!(
            sha256_hex(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(sha256_hex("limina"), sha256_hex("limina"));
        assert_ne!(sha256_hex("limina"), sha256_hex("Limina"));
    }

    #[test]
    fn op_read_env_allows_only_limina_and_anthropic_uppercase_names() {
        std::env::set_var("ANTHROPIC_TEST_KEY", "allowed-anthropic");
        std::env::set_var("LIMINA_TEST_KEY", "allowed-limina");
        std::env::set_var("SECRET_TEST_KEY", "denied-secret");
        std::env::set_var("ANTHROPIC_test_key", "denied-lowercase");

        assert_eq!(
            read_allowlisted_env("ANTHROPIC_TEST_KEY"),
            "allowed-anthropic"
        );
        assert_eq!(read_allowlisted_env("LIMINA_TEST_KEY"), "allowed-limina");
        assert_eq!(read_allowlisted_env("SECRET_TEST_KEY"), "");
        assert_eq!(read_allowlisted_env("ANTHROPIC_test_key"), "");
        assert_eq!(read_allowlisted_env("ANTHROPIC_"), "");
        assert_eq!(read_allowlisted_env("ANTHROPIC_TEST_KEY/../SECRET"), "");
        assert_eq!(read_allowlisted_env("LIMINA_UNSET_TEST_KEY"), "");

        std::env::remove_var("ANTHROPIC_TEST_KEY");
        std::env::remove_var("LIMINA_TEST_KEY");
        std::env::remove_var("SECRET_TEST_KEY");
        std::env::remove_var("ANTHROPIC_test_key");
    }

    #[test]
    fn read_dotenv_value_parses_keys_comments_quotes_and_export() {
        let dir = temp_root("dotenv");
        std::fs::write(
            dir.join(".env"),
            "# a comment\n\nANTHROPIC_API_KEY=sk-plain\nexport LIMINA_HTTP_POST_ALLOW=api.anthropic.com\nQUOTED=\"quoted value\"\nSINGLE='single'\n",
        )
        .unwrap();
        assert_eq!(
            read_dotenv_value_in(&dir, "ANTHROPIC_API_KEY").as_deref(),
            Some("sk-plain")
        );
        assert_eq!(
            read_dotenv_value_in(&dir, "LIMINA_HTTP_POST_ALLOW").as_deref(),
            Some("api.anthropic.com")
        );
        assert_eq!(
            read_dotenv_value_in(&dir, "QUOTED").as_deref(),
            Some("quoted value")
        );
        assert_eq!(
            read_dotenv_value_in(&dir, "SINGLE").as_deref(),
            Some("single")
        );
        assert_eq!(read_dotenv_value_in(&dir, "MISSING"), None);
        // absent file → None, not a panic.
        assert_eq!(
            read_dotenv_value_in(&temp_root("dotenv-empty"), "ANY"),
            None
        );
    }

    /// A relative file inside the configured root reads back its exact bytes.
    #[test]
    fn op_read_asset_reads_contained_file() {
        let root = temp_root("read");
        std::fs::write(root.join("hello.txt"), b"hi limina").unwrap();
        let bytes = read_asset_bytes(&root, "hello.txt").unwrap();
        assert_eq!(bytes, b"hi limina");
        std::fs::remove_dir_all(&root).ok();
    }

    /// Path containment: `..` traversal and absolute paths are rejected with an
    /// error before any host file is opened — they must never escape the root.
    #[test]
    fn op_read_asset_rejects_escapes() {
        let root = temp_root("escape");
        assert!(read_asset_bytes(&root, "../etc/passwd").is_err());
        assert!(read_asset_bytes(&root, "/etc/passwd").is_err());
        assert!(read_asset_bytes(&root, "a/../../secret").is_err());
        std::fs::remove_dir_all(&root).ok();
    }

    /// Size cap: a file one byte past the limit is rejected rather than read into
    /// memory. The wave-2 fix bounds the actual read (`file.take(MAX_BYTES + 1)`)
    /// in addition to the metadata check; a static over-cap file is caught here
    /// by the metadata guard. (The read-bound branch guards a TOCTOU append that
    /// can't be reproduced deterministically without a live filesystem race.)
    #[test]
    fn op_read_asset_rejects_over_cap_file() {
        let root = temp_root("cap");
        let file = std::fs::File::create(root.join("big.bin")).unwrap();
        // Sparse allocation: one byte past MAX_BYTES (64 MiB) without writing 64 MiB.
        file.set_len(64 * 1024 * 1024 + 1).unwrap();
        drop(file);
        let err = read_asset_bytes(&root, "big.bin").unwrap_err();
        assert!(err.to_string().contains("size cap"), "got: {err}");
        std::fs::remove_dir_all(&root).ok();
    }

    /// The open trace-writer map is bounded: appending to more distinct names
    /// than the cap evicts the LRU handle, and an evicted name keeps appending
    /// correctly (reopen in append mode, byte count re-derived from disk).
    #[test]
    fn trace_writer_map_is_bounded_and_eviction_preserves_appends() {
        let dir = temp_root("trace_lru");
        let mut state = deno_core::OpState::new(None);

        let path_of = |i: usize| dir.join(format!("t{i}.jsonl"));
        for i in 0..MAX_OPEN_TRACE_WRITERS + 3 {
            append_trace_at(&mut state, path_of(i), &format!("line-{i}\n")).unwrap();
        }
        assert!(
            state.borrow::<TraceWriters>().writers.len() <= MAX_OPEN_TRACE_WRITERS,
            "open trace writer map must stay bounded"
        );

        // t0 was evicted (least recently used); appending again must reopen and
        // APPEND, not truncate or double-count.
        append_trace_at(&mut state, path_of(0), "line-0b\n").unwrap();
        let content = std::fs::read_to_string(path_of(0)).unwrap();
        assert_eq!(content, "line-0\nline-0b\n");
        for i in 1..MAX_OPEN_TRACE_WRITERS + 3 {
            assert_eq!(
                std::fs::read_to_string(path_of(i)).unwrap(),
                format!("line-{i}\n"),
                "evicted/live writer {i} lost bytes"
            );
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn op_http_post_url_policy_allows_loopback_only_by_default() {
        assert!(validate_http_post_url("http://localhost:11434/api/chat").is_ok());
        assert!(validate_http_post_url("http://127.0.0.1:11434/api/chat").is_ok());
        assert!(validate_http_post_url("http://[::1]:11434/api/chat").is_ok());
        assert!(validate_http_post_url("http://169.254.169.254/latest/meta-data").is_err());
        assert!(validate_http_post_url("http://example.com/api").is_err());
    }

    #[test]
    fn op_http_post_url_policy_rejects_unsafe_url_shapes() {
        assert!(validate_http_post_url("file:///etc/passwd").is_err());
        assert!(validate_http_post_url("http://user:pass@localhost:11434/api/chat").is_err());
        assert!(validate_http_post_url("http:///missing-host").is_err());
    }

    #[test]
    fn op_http_post_allowlist_accepts_exact_host_or_host_port() {
        assert!(!is_http_post_host_allowed("api.example.test", Some(443)));
        // SAFETY: this test does not run concurrent assertions over the same env var.
        std::env::set_var(
            "LIMINA_HTTP_POST_ALLOW",
            "api.example.test, other.test:8443",
        );
        assert!(is_http_post_host_allowed("api.example.test", Some(443)));
        assert!(is_http_post_host_allowed("other.test", Some(8443)));
        assert!(!is_http_post_host_allowed("other.test", Some(443)));
        std::env::remove_var("LIMINA_HTTP_POST_ALLOW");
    }

    #[test]
    fn op_http_post_rejects_unsafe_resolved_ips_for_allowlisted_hosts() {
        assert!(!is_http_post_target_ip_allowed(
            "api.example.test",
            &"169.254.169.254".parse().unwrap()
        ));
        assert!(!is_http_post_target_ip_allowed(
            "api.example.test",
            &"10.0.0.5".parse().unwrap()
        ));
        assert!(!is_http_post_target_ip_allowed(
            "api.example.test",
            &"127.0.0.1".parse().unwrap()
        ));
        assert!(!is_http_post_target_ip_allowed(
            "api.example.test",
            &"100.64.0.1".parse().unwrap()
        ));
        assert!(!is_http_post_target_ip_allowed(
            "api.example.test",
            &"198.18.0.1".parse().unwrap()
        ));
        for mapped in [
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.5",
            "::ffff:169.254.169.254",
            "::ffff:100.64.0.1",
        ] {
            assert!(
                !is_http_post_target_ip_allowed("api.example.test", &mapped.parse().unwrap()),
                "IPv4-mapped private target must be rejected: {mapped}"
            );
        }
        assert!(is_http_post_target_ip_allowed(
            "localhost",
            &"127.0.0.1".parse().unwrap()
        ));
        assert!(is_http_post_target_ip_allowed(
            "::ffff:127.0.0.1",
            &"::ffff:127.0.0.1".parse().unwrap()
        ));
        assert!(is_http_post_target_ip_allowed(
            "api.example.test",
            &"93.184.216.34".parse().unwrap()
        ));
        assert!(is_http_post_target_ip_allowed(
            "api.example.test",
            &"::ffff:93.184.216.34".parse().unwrap()
        ));
    }

    #[tokio::test]
    async fn op_http_post_resolver_rejects_private_ip_targets() {
        let url = reqwest::Url::parse("http://10.0.0.5/api").unwrap();
        let err = super::resolve_http_post_targets(&url).await.unwrap_err();
        assert!(
            err.to_string().contains("not allowed"),
            "unexpected error: {err}"
        );

        let loopback = reqwest::Url::parse("http://127.0.0.1:11434/api").unwrap();
        let addrs = super::resolve_http_post_targets(&loopback).await.unwrap();
        assert_eq!(
            addrs[0].ip(),
            "127.0.0.1".parse::<std::net::IpAddr>().unwrap()
        );
    }

    #[tokio::test]
    async fn op_http_post_headers_applies_custom_headers_and_default_content_type() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = vec![0_u8; 4096];
            let n = tokio::io::AsyncReadExt::read(&mut socket, &mut buf)
                .await
                .unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            tokio::io::AsyncWriteExt::write_all(
                &mut socket,
                b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok",
            )
            .await
            .unwrap();
            req
        });

        let body = "{\"hello\":true}".to_string();
        let response = super::http_post_with_headers(
            format!("http://{addr}/messages"),
            body.clone(),
            Some(
                parse_http_post_headers(
                    r#"{"x-api-key":"test-key","anthropic-version":"2023-06-01"}"#,
                )
                .unwrap(),
            ),
        )
        .await
        .unwrap();

        let req = server.await.unwrap();
        assert_eq!(response, "ok");
        assert!(req.contains("POST /messages HTTP/1.1"), "{req}");
        assert!(req.contains("x-api-key: test-key"), "{req}");
        assert!(req.contains("anthropic-version: 2023-06-01"), "{req}");
        assert!(req.contains("content-type: application/json"), "{req}");
        assert!(req.ends_with(&body), "{req}");
    }

    #[tokio::test]
    async fn op_http_post_headers_preserves_allowlist_rejection() {
        let err = super::http_post_with_headers(
            "http://example.com/v1/messages".to_string(),
            "{}".to_string(),
            Some(parse_http_post_headers("{}").unwrap()),
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("not allowed"), "got: {err}");
    }

    #[test]
    fn op_http_post_headers_rejects_count_size_and_host_header() {
        let defaulted = parse_http_post_headers(r#"{"x-test":"ok"}"#).unwrap();
        assert_eq!(defaulted.get("content-type").unwrap(), "application/json");
        let overridden =
            parse_http_post_headers(r#"{"content-type":"application/x-ndjson"}"#).unwrap();
        assert_eq!(
            overridden.get("content-type").unwrap(),
            "application/x-ndjson"
        );

        let too_many = format!(
            "{{{}}}",
            (0..25)
                .map(|i| format!(r#""x-{i}":"v""#))
                .collect::<Vec<_>>()
                .join(",")
        );
        assert!(parse_http_post_headers(&too_many)
            .unwrap_err()
            .to_string()
            .contains("too many"));

        let too_large = format!(r#"{{"x-test":"{}"}}"#, "a".repeat(4097));
        assert!(parse_http_post_headers(&too_large)
            .unwrap_err()
            .to_string()
            .contains("too large"));

        assert!(parse_http_post_headers(r#"{"host":"evil.test"}"#)
            .unwrap_err()
            .to_string()
            .contains("Host"));
        assert!(parse_http_post_headers(r#"[]"#)
            .unwrap_err()
            .to_string()
            .contains("object"));
    }
}

extension!(
    limina_ops,
    ops = [
        op_log,
        op_sum,
        op_buffer_scale,
        op_fail,
        op_counter_inc,
        op_read_asset,
        op_http_post,
        op_http_post_headers,
        op_sleep_ms,
        op_sha256,
        op_read_env,
        op_write_trace,
        op_append_trace,
        op_read_trace,
    ],
    state = |state| {
        let root = std::env::var_os("LIMINA_ASSET_ROOT")
            .filter(|value| !value.is_empty())
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_default().join("assets"));
        state.put(AssetRoot(root));
    },
);
