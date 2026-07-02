//! limina-ops - shared `#[op2]` bridge and OpState resource conventions.
//!
//! Phase 0 establishes the patterns every native subsystem (physics now, an
//! eventual native ECS later) marshals through:
//!   * fast numeric ops on the V8 fastcall path,
//!   * zero-copy buffer round-trips that borrow the V8 ArrayBuffer in place,
//!   * structured errors surfaced as catchable JS exceptions,
//!   * host-owned resources held in `OpState`, fetched per call.

use std::io::Write;
use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::time::Duration;

use deno_core::{extension, op2, OpState};
use deno_error::JsErrorBox;
use reqwest::Url;

/// String logging op. The `#[string]` arg forces the non-fast path; fine here.
#[op2(fast)]
pub fn op_log(#[string] msg: &str) {
    println!("[js] {msg}");
}

/// Fast numeric op (V8 fastcall path): all-scalar args/return.
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
    use std::io::Read;
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
pub fn op_write_trace(#[string] name: String, #[string] content: String) -> Result<(), JsErrorBox> {
    let path = trace_path(&name)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(JsErrorBox::from_err)?;
    }
    std::fs::write(&path, content).map_err(JsErrorBox::from_err)
}

/// Append one already-complete trace JSONL segment to `<cwd>/traces/<name>`.
#[op2(fast)]
pub fn op_append_trace(
    #[string] name: String,
    #[string] content: String,
) -> Result<(), JsErrorBox> {
    let path = trace_path(&name)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(JsErrorBox::from_err)?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(JsErrorBox::from_err)?;
    file.write_all(content.as_bytes())
        .map_err(JsErrorBox::from_err)?;
    file.sync_data().map_err(JsErrorBox::from_err)
}

/// Read back a trace JSONL from `<cwd>/traces/<name>`.
#[op2]
#[string]
pub fn op_read_trace(#[string] name: String) -> Result<String, JsErrorBox> {
    std::fs::read_to_string(trace_path(&name)?).map_err(JsErrorBox::from_err)
}

/// Provider-agnostic HTTP POST (JSON). Async: returns a Promise resolved when the
/// host pumps the event loop. The only HTTP need (LLM providers) goes through here.
const MAX_HTTP_REQUEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_HTTP_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

#[op2]
#[string]
pub async fn op_http_post(
    #[string] url: String,
    #[string] body: String,
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
    let mut resp = client
        .post(url)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| JsErrorBox::generic(format!("http post: {e}")))?;
    read_limited_text_response(&mut resp, MAX_HTTP_RESPONSE_BYTES).await
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
    std::env::var("LIMINA_HTTP_POST_ALLOW")
        .ok()
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
            .map(|host_ip| host_ip.is_loopback())
            .unwrap_or(false);
    if host_is_loopback {
        return ip.is_loopback();
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
        is_http_post_host_allowed, is_http_post_target_ip_allowed, read_asset_bytes, sha256_hex,
        validate_http_post_url,
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
        assert!(is_http_post_target_ip_allowed(
            "localhost",
            &"127.0.0.1".parse().unwrap()
        ));
        assert!(is_http_post_target_ip_allowed(
            "api.example.test",
            &"93.184.216.34".parse().unwrap()
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
        op_sleep_ms,
        op_sha256,
        op_write_trace,
        op_append_trace,
        op_read_trace,
    ],
    state = |state| {
        let root = std::env::current_dir().unwrap_or_default().join("assets");
        state.put(AssetRoot(root));
    },
);
