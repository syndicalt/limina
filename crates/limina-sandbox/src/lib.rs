//! limina-sandbox - QuickJS isolation substrate for untrusted skill/agent code.
//!
//! Untrusted decision code runs in a per-agent QuickJS `Runtime` + `Context`
//! whose global scope is standard ECMAScript ONLY: there is no `Deno`, no
//! `Deno.core.ops`, no `process`/`require`/`fetch`, no ECS TypedArrays, and no
//! `WorldContext`. The host injects exactly ONE surface, `host.invoke(cap,
//! argsJson)`, and nothing else -- even an `eval`/`Function`-constructor escape
//! only reaches this empty global. (Resolved by the P4.0b spike;
//! `spikes/isolation/REPORT.md`.)
//!
//! Re-entry into the engine is split by capability kind, because the
//! V8 <-> QuickJS boundary is synchronous Rust while the engine's
//! `SkillRegistry.invoke` is async JS in the *other* isolate:
//!   * READ capabilities are served synchronously from a per-decision perception
//!     snapshot the host injects (the agent's own view -- never another agent's
//!     private state);
//!   * MUTATING capabilities are RECORDED as intents `(cap, argsJson)` and
//!     returned to the JS `SandboxedSkillHost`, which drains them and drives each
//!     through the real `SkillRegistry.invoke` under HOST-BOUND attribution.
//!
//! Per-agent budgets are first-class in-thread knobs: `set_memory_limit`
//! (catchable OOM, host survives), a per-decision `set_interrupt_handler`
//! deadline (CPU budget), and `set_max_stack_size`.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::{Duration, Instant};

use deno_core::{extension, op2, OpState};
use deno_error::JsErrorBox;
use rquickjs::{
    CatchResultExt, Context, Ctx, Function, IntoJs, Object, Persistent, Runtime,
    String as QjsString, Value,
};

const MAX_SANDBOX_MEMORY_BYTES: usize = 256 * 1024 * 1024;
const MAX_SANDBOX_STACK_BYTES: usize = 8 * 1024 * 1024;
const MAX_SANDBOX_DEADLINE_MS: f64 = 5_000.0;
const DEFAULT_SANDBOX_MEMORY_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_SANDBOX_STACK_BYTES: usize = 256 * 1024;
const DEFAULT_SANDBOX_DEADLINE_MS: f64 = 50.0;
const MAX_LIVE_SANDBOXES: usize = 256;
const MAX_READ_CAPS_JSON_BYTES: usize = 64 * 1024;
const MAX_READ_CAPS: usize = 256;
const MAX_CAPABILITY_BYTES: usize = 512;
const MAX_CODE_BYTES: usize = 1024 * 1024;
const MAX_PERCEPTION_BYTES: usize = 4 * 1024 * 1024;
const MAX_CALL_ARGS_BYTES: usize = 256 * 1024;
const MAX_BOUNDARY_CROSSINGS: u64 = 1_024;
const MAX_CAPTURED_BYTES: usize = 1024 * 1024;

/// Mutable state shared between the injected `host.invoke` closure and the op
/// driving an eval. The closure can ONLY (a) read the injected perception
/// snapshot for a read capability, and (b) append a mutating-capability intent.
/// It never touches the engine directly.
#[derive(Default)]
struct SandboxShared {
    /// The calling agent's own perception view, injected per decision. Read caps
    /// return it verbatim; it NEVER carries another agent's private state.
    perception_json: String,
    /// The perception payload already materialized as a QuickJS string
    /// (immutable, refcounted). Built once per CHANGED payload at eval time so a
    /// read crossing hands back a refcount bump instead of re-copying up to 4 MB
    /// twice (Rust String clone + QuickJS string build) on every crossing. MUST
    /// be dropped before the owning QuickJS runtime (see `Sandbox::drop`).
    perception_cached: Option<Persistent<QjsString<'static>>>,
    /// Capabilities served synchronously as reads (return the perception snapshot).
    read_caps: HashSet<String>,
    /// Recorded MUTATING capability intents `(cap, argsJson)` in call order. The
    /// JS host drains these and drives each through `SkillRegistry.invoke`.
    captured: Vec<(String, String)>,
    /// Bytes currently retained by `captured`, excluding Vec/String bookkeeping.
    captured_bytes: usize,
    /// Total boundary crossings this eval (reads + mutate-intents) -- audit count.
    crossings: u64,
    /// Crossings served as synchronous reads.
    reads: u64,
}

/// One untrusted agent's isolate: a QuickJS runtime + context plus the shared
/// state its `host.invoke` closure writes through.
struct Sandbox {
    rt: Runtime,
    ctx: Context,
    shared: Rc<RefCell<SandboxShared>>,
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        // A `Persistent` outliving its QuickJS runtime aborts the process on the
        // runtime's drop; release the cached perception string first, while the
        // runtime/context fields are still alive.
        self.shared.borrow_mut().perception_cached = None;
    }
}

/// Return value of the injected `host.invoke`. `Shared` restores the cached
/// QuickJS perception string (a refcount bump — no bytes copied); `Owned`
/// materializes a fresh QuickJS string from a Rust one.
enum InvokeReturn {
    Owned(String),
    Shared(Persistent<QjsString<'static>>),
}

impl<'js> IntoJs<'js> for InvokeReturn {
    fn into_js(self, ctx: &Ctx<'js>) -> rquickjs::Result<Value<'js>> {
        match self {
            InvokeReturn::Owned(s) => s.into_js(ctx),
            InvokeReturn::Shared(p) => p.restore(ctx)?.into_js(ctx),
        }
    }
}

/// Process-wide table of live sandboxes, held in `OpState`. Handles are opaque
/// monotonic `u32`s; the JS layer keeps the agentId -> handle mapping.
#[derive(Default)]
struct SandboxRegistry {
    next: u32,
    sandboxes: HashMap<u32, Sandbox>,
}

fn ensure_registry(state: &mut OpState) -> &mut SandboxRegistry {
    if state.try_borrow::<SandboxRegistry>().is_none() {
        state.put(SandboxRegistry::default());
    }
    state.borrow_mut::<SandboxRegistry>()
}

fn finite_positive(name: &str, value: f64) -> Result<f64, JsErrorBox> {
    if value.is_finite() && value > 0.0 {
        Ok(value)
    } else {
        Err(JsErrorBox::generic(format!(
            "{name} must be finite and > 0"
        )))
    }
}

fn finite_bounded_or_default(
    name: &str,
    value: f64,
    default: f64,
    max: f64,
) -> Result<f64, JsErrorBox> {
    if !value.is_finite() || value < 0.0 {
        return Err(JsErrorBox::generic(format!(
            "{name} must be finite and >= 0"
        )));
    }
    if value == 0.0 {
        return Ok(default);
    }
    finite_bounded_positive(name, value, max)
}

fn finite_bounded_positive(name: &str, value: f64, max: f64) -> Result<f64, JsErrorBox> {
    let value = finite_positive(name, value)?;
    if value <= max {
        Ok(value)
    } else {
        Err(JsErrorBox::generic(format!("{name} must be <= {max}")))
    }
}

fn validate_create_budgets(
    mem_limit_bytes: f64,
    max_stack_bytes: f64,
) -> Result<(usize, usize), JsErrorBox> {
    let mem_limit_bytes = finite_bounded_or_default(
        "mem_limit_bytes",
        mem_limit_bytes,
        DEFAULT_SANDBOX_MEMORY_BYTES as f64,
        MAX_SANDBOX_MEMORY_BYTES as f64,
    )?;
    let max_stack_bytes = finite_bounded_or_default(
        "max_stack_bytes",
        max_stack_bytes,
        DEFAULT_SANDBOX_STACK_BYTES as f64,
        MAX_SANDBOX_STACK_BYTES as f64,
    )?;
    Ok((mem_limit_bytes as usize, max_stack_bytes as usize))
}

fn ensure_registry_capacity(current: usize) -> Result<(), JsErrorBox> {
    if current >= MAX_LIVE_SANDBOXES {
        Err(JsErrorBox::generic(format!(
            "sandbox registry live context cap exceeded ({MAX_LIVE_SANDBOXES})"
        )))
    } else {
        Ok(())
    }
}

fn parse_read_caps(read_caps_json: &str) -> Result<HashSet<String>, JsErrorBox> {
    if read_caps_json.len() > MAX_READ_CAPS_JSON_BYTES {
        return Err(JsErrorBox::generic(format!(
            "read_caps_json exceeds {MAX_READ_CAPS_JSON_BYTES} bytes"
        )));
    }
    let caps: Vec<String> = serde_json::from_str(read_caps_json)
        .map_err(|e| JsErrorBox::generic(format!("invalid read_caps_json: {e}")))?;
    if caps.len() > MAX_READ_CAPS {
        return Err(JsErrorBox::generic(format!(
            "read capability count exceeds {MAX_READ_CAPS}"
        )));
    }
    if caps.iter().any(|cap| cap.len() > MAX_CAPABILITY_BYTES) {
        return Err(JsErrorBox::generic(format!(
            "read capability exceeds {MAX_CAPABILITY_BYTES} bytes"
        )));
    }
    Ok(caps.into_iter().collect())
}

/// Create a fresh QuickJS sandbox for one untrusted agent and return its handle.
/// `mem_limit_bytes` is the per-agent memory budget (a catchable OOM, the host
/// survives), `max_stack_bytes` the stack cap, `read_caps_json` a JSON array of
/// capability names served as synchronous reads. The new context exposes only
/// `host.invoke`.
#[op2(fast)]
pub fn op_sandbox_create(
    state: &mut OpState,
    mem_limit_bytes: f64,
    max_stack_bytes: f64,
    #[string] read_caps_json: String,
) -> Result<u32, JsErrorBox> {
    sandbox_create_impl(state, mem_limit_bytes, max_stack_bytes, &read_caps_json)
}

fn sandbox_create_impl(
    state: &mut OpState,
    mem_limit_bytes: f64,
    max_stack_bytes: f64,
    read_caps_json: &str,
) -> Result<u32, JsErrorBox> {
    let (mem_limit_bytes, max_stack_bytes) =
        validate_create_budgets(mem_limit_bytes, max_stack_bytes)?;
    let read_caps = parse_read_caps(read_caps_json)?;
    {
        let reg = ensure_registry(state);
        ensure_registry_capacity(reg.sandboxes.len())?;
    }
    let rt = Runtime::new().map_err(|e| JsErrorBox::generic(format!("quickjs runtime: {e}")))?;
    rt.set_memory_limit(mem_limit_bytes);
    rt.set_max_stack_size(max_stack_bytes);
    let ctx =
        Context::full(&rt).map_err(|e| JsErrorBox::generic(format!("quickjs context: {e}")))?;
    let shared = Rc::new(RefCell::new(SandboxShared {
        read_caps,
        ..Default::default()
    }));

    // Inject ONLY host.invoke. No Deno, no ops, no ECS arrays, no WorldContext.
    let s = shared.clone();
    ctx.with(|ctx| -> rquickjs::Result<()> {
        let host = Object::new(ctx.clone())?;
        let invoke = Function::new(
            ctx.clone(),
            move |cap: String, args: String| -> rquickjs::Result<InvokeReturn> {
                let mut sh = s.borrow_mut();
                if sh.crossings >= MAX_BOUNDARY_CROSSINGS {
                    return Err(rquickjs::Error::new_from_js_message(
                        "host.invoke",
                        "result",
                        format!("boundary crossing limit exceeded ({MAX_BOUNDARY_CROSSINGS})"),
                    ));
                }
                sh.crossings += 1;
                if cap.len() > MAX_CAPABILITY_BYTES {
                    return Err(rquickjs::Error::new_from_js_message(
                        "host.invoke",
                        "result",
                        format!("capability exceeds {MAX_CAPABILITY_BYTES} bytes"),
                    ));
                }
                if sh.read_caps.contains(&cap) {
                    sh.reads += 1;
                    // A read returns the agent's OWN perception snapshot verbatim
                    // — via the QuickJS string cached at eval time when present,
                    // so the crossing copies no payload bytes.
                    if sh.perception_json.is_empty() {
                        return Ok(InvokeReturn::Owned("null".to_string()));
                    }
                    if let Some(cached) = sh.perception_cached.as_ref() {
                        return Ok(InvokeReturn::Shared(cached.clone()));
                    }
                    return Ok(InvokeReturn::Owned(sh.perception_json.clone()));
                }
                if args.len() > MAX_CALL_ARGS_BYTES {
                    return Err(rquickjs::Error::new_from_js_message(
                        "host.invoke",
                        "result",
                        format!("call arguments exceed {MAX_CALL_ARGS_BYTES} bytes"),
                    ));
                }
                let call_bytes = cap.len() + args.len();
                let new_total = sh.captured_bytes.checked_add(call_bytes).ok_or_else(|| {
                    rquickjs::Error::new_from_js_message(
                        "host.invoke",
                        "result",
                        "captured call byte count overflow",
                    )
                })?;
                if new_total > MAX_CAPTURED_BYTES {
                    return Err(rquickjs::Error::new_from_js_message(
                        "host.invoke",
                        "result",
                        format!("captured calls exceed {MAX_CAPTURED_BYTES} bytes"),
                    ));
                }
                // A mutating capability is RECORDED as an intent -- never executed
                // here. The privileged JS host drives it through SkillRegistry.invoke.
                sh.captured_bytes = new_total;
                sh.captured.push((cap, args));
                Ok(InvokeReturn::Owned("{\"queued\":true}".to_string()))
            },
        )?;
        host.set("invoke", invoke)?;
        ctx.globals().set("host", host)?;
        Ok(())
    })
    .map_err(|e| JsErrorBox::generic(format!("inject host surface: {e}")))?;

    let reg = ensure_registry(state);
    reg.next = reg
        .next
        .checked_add(1)
        .ok_or_else(|| JsErrorBox::generic("sandbox handle id overflow"))?;
    let handle = reg.next;
    reg.sandboxes.insert(handle, Sandbox { rt, ctx, shared });
    Ok(handle)
}

/// Run untrusted JS in sandbox `handle` under an effective nonzero CPU deadline
/// (`0` selects the safe host default) with `perception_json` injected for read
/// capabilities. Returns a JSON
/// envelope `{ ok, value?, error?, calls:[{cap,args}], crossings, reads }`.
/// `calls` are the recorded MUTATING intents for the JS host to drive through the
/// registry; the untrusted code NEVER reaches the registry itself. A runaway
/// loop, OOM, stack overflow, or uncaught throw surfaces as `ok:false` with the
/// real error and leaves the sandbox alive and reusable.
#[op2]
#[string]
pub fn op_sandbox_eval(
    state: &mut OpState,
    handle: u32,
    #[string] code: String,
    #[string] perception_json: String,
    deadline_ms: f64,
) -> Result<String, JsErrorBox> {
    sandbox_eval_impl(state, handle, code, perception_json, deadline_ms)
}

fn sandbox_eval_impl(
    state: &mut OpState,
    handle: u32,
    code: String,
    perception_json: String,
    deadline_ms: f64,
) -> Result<String, JsErrorBox> {
    let deadline_ms = finite_bounded_or_default(
        "deadline_ms",
        deadline_ms,
        DEFAULT_SANDBOX_DEADLINE_MS,
        MAX_SANDBOX_DEADLINE_MS,
    )?;
    if code.len() > MAX_CODE_BYTES {
        return Err(JsErrorBox::generic(format!(
            "sandbox code exceeds {MAX_CODE_BYTES} bytes"
        )));
    }
    if perception_json.len() > MAX_PERCEPTION_BYTES {
        return Err(JsErrorBox::generic(format!(
            "sandbox perception exceeds {MAX_PERCEPTION_BYTES} bytes"
        )));
    }
    let reg = ensure_registry(state);
    let sb = reg
        .sandboxes
        .get(&handle)
        .ok_or_else(|| JsErrorBox::generic(format!("unknown sandbox handle: {handle}")))?;

    {
        let mut sh = sb.shared.borrow_mut();
        // The cached QuickJS string stays valid across evals of an UNCHANGED
        // payload; only a changed payload forces a re-materialization below.
        if sh.perception_json != perception_json {
            sh.perception_json = perception_json;
            sh.perception_cached = None;
        }
        sh.captured.clear();
        sh.captured_bytes = 0;
        sh.crossings = 0;
        sh.reads = 0;
    }

    let dl = Instant::now() + Duration::from_millis(deadline_ms as u64);
    sb.rt
        .set_interrupt_handler(Some(Box::new(move || Instant::now() >= dl)));

    let outcome: Result<String, String> = sb.ctx.with(|ctx| {
        {
            // Materialize the perception payload into QuickJS ONCE per changed
            // payload; each read crossing then returns this string by refcount.
            // A failed build (e.g. sandbox memory budget) is non-fatal: reads
            // fall back to cloning the Rust string per crossing.
            let mut sh = sb.shared.borrow_mut();
            if sh.perception_cached.is_none() && !sh.perception_json.is_empty() {
                if let Ok(js) = QjsString::from_str(ctx.clone(), &sh.perception_json) {
                    sh.perception_cached = Some(Persistent::save(&ctx, js));
                }
            }
        }
        match ctx.eval::<Value, _>(code.as_str()).catch(&ctx) {
                Ok(v) => value_to_envelope_string(&ctx, v).map_err(|err| {
                    format!("{err}")
                        .lines()
                        .next()
                        .unwrap_or("error")
                        .to_string()
                }),
                Err(err) => Err(format!("{err}")
                    .lines()
                    .next()
                    .unwrap_or("error")
                    .to_string()),
        }
    });

    sb.rt.set_interrupt_handler(None);

    let sh = sb.shared.borrow();
    let calls: Vec<serde_json::Value> = sh
        .captured
        .iter()
        .map(|(cap, args)| serde_json::json!({ "cap": cap, "args": args }))
        .collect();
    let envelope = match outcome {
        Ok(value) => serde_json::json!({
            "ok": true, "value": value, "calls": calls,
            "crossings": sh.crossings, "reads": sh.reads,
        }),
        Err(error) => serde_json::json!({
            "ok": false, "error": error, "calls": calls,
            "crossings": sh.crossings, "reads": sh.reads,
        }),
    };
    Ok(envelope.to_string())
}

fn value_to_envelope_string<'js>(ctx: &Ctx<'js>, v: Value<'js>) -> rquickjs::Result<String> {
    if let Some(s) = v.as_string() {
        Ok(s.to_string().unwrap_or_default())
    } else if let Some(i) = v.as_int() {
        Ok(i.to_string())
    } else if let Some(f) = v.as_float() {
        Ok(f.to_string())
    } else if let Some(b) = v.as_bool() {
        Ok(b.to_string())
    } else if v.is_null() {
        Ok("null".to_string())
    } else if v.is_undefined() {
        Ok("undefined".to_string())
    } else if let Some(json) = ctx.json_stringify(v.clone())? {
        Ok(json.to_string().unwrap_or_default())
    } else {
        Ok(format!("{:?}", v.type_of()))
    }
}

/// Destroy a sandbox, freeing its QuickJS context. Returns whether one existed.
#[op2(fast)]
pub fn op_sandbox_destroy(state: &mut OpState, handle: u32) -> bool {
    sandbox_destroy_impl(state, handle)
}

fn sandbox_destroy_impl(state: &mut OpState, handle: u32) -> bool {
    match state.try_borrow_mut::<SandboxRegistry>() {
        Some(reg) => reg.sandboxes.remove(&handle).is_some(),
        None => false,
    }
}

/// Number of live sandboxes (lets the JS layer prove teardown).
#[op2(fast)]
pub fn op_sandbox_count(state: &mut OpState) -> u32 {
    match state.try_borrow::<SandboxRegistry>() {
        Some(reg) => reg.sandboxes.len() as u32,
        None => 0,
    }
}

extension!(
    limina_sandbox,
    ops = [
        op_sandbox_create,
        op_sandbox_eval,
        op_sandbox_destroy,
        op_sandbox_count,
    ],
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_create_rejects_absurd_native_budgets() {
        assert!(validate_create_budgets(MAX_SANDBOX_MEMORY_BYTES as f64 + 1.0, 256.0).is_err());
        assert!(validate_create_budgets(
            16.0 * 1024.0 * 1024.0,
            MAX_SANDBOX_STACK_BYTES as f64 + 1.0
        )
        .is_err());
        assert!(validate_create_budgets(64.0 * 1024.0 * 1024.0, 256.0 * 1024.0).is_ok());
    }

    #[test]
    fn sandbox_eval_rejects_absurd_deadlines() {
        assert!(finite_bounded_positive(
            "deadline_ms",
            MAX_SANDBOX_DEADLINE_MS + 1.0,
            MAX_SANDBOX_DEADLINE_MS
        )
        .is_err());
        assert!(finite_bounded_positive("deadline_ms", 1_000.0, MAX_SANDBOX_DEADLINE_MS).is_ok());
        assert_eq!(
            finite_bounded_or_default(
                "deadline_ms",
                0.0,
                DEFAULT_SANDBOX_DEADLINE_MS,
                MAX_SANDBOX_DEADLINE_MS,
            )
            .unwrap(),
            DEFAULT_SANDBOX_DEADLINE_MS
        );
    }

    #[test]
    fn sandbox_registry_rejects_unbounded_live_context_growth() {
        assert!(ensure_registry_capacity(MAX_LIVE_SANDBOXES - 1).is_ok());
        assert!(ensure_registry_capacity(MAX_LIVE_SANDBOXES).is_err());
    }

    #[test]
    fn sandbox_create_supplies_effective_nonzero_budgets() {
        assert_eq!(
            validate_create_budgets(0.0, 0.0).unwrap(),
            (DEFAULT_SANDBOX_MEMORY_BYTES, DEFAULT_SANDBOX_STACK_BYTES)
        );
    }

    #[test]
    fn sandbox_read_cap_metadata_is_bounded() {
        let too_many = serde_json::to_string(&vec!["read"; MAX_READ_CAPS + 1]).unwrap();
        assert!(parse_read_caps(&too_many).is_err());
        let too_long = serde_json::to_string(&vec!["x".repeat(MAX_CAPABILITY_BYTES + 1)]).unwrap();
        assert!(parse_read_caps(&too_long).is_err());
    }

    #[test]
    fn sandbox_eval_bounds_host_side_capture_allocations() {
        let mut state = OpState::new(None);
        let handle = sandbox_create_impl(&mut state, 16.0 * 1024.0 * 1024.0, 256.0 * 1024.0, "[]")
            .expect("create bounded sandbox");

        assert!(sandbox_eval_impl(
            &mut state,
            handle,
            " ".repeat(MAX_CODE_BYTES + 1),
            "null".to_string(),
            1_000.0,
        )
        .unwrap_err()
        .to_string()
        .contains("code exceeds"));
        assert!(sandbox_eval_impl(
            &mut state,
            handle,
            "null".to_string(),
            " ".repeat(MAX_PERCEPTION_BYTES + 1),
            1_000.0,
        )
        .unwrap_err()
        .to_string()
        .contains("perception exceeds"));

        let oversized_args = "x".repeat(MAX_CALL_ARGS_BYTES + 1);
        let code = format!("host.invoke('mutate', '{}')", oversized_args);
        let envelope = sandbox_eval_impl(&mut state, handle, code, "null".to_string(), 1_000.0)
            .expect("resource rejection is contained in the envelope");
        let parsed: serde_json::Value = serde_json::from_str(&envelope).unwrap();
        assert_eq!(parsed["ok"], false);
        assert_eq!(parsed["calls"].as_array().unwrap().len(), 0);

        let oversized_cap = "x".repeat(MAX_CAPABILITY_BYTES + 1);
        let envelope = sandbox_eval_impl(
            &mut state,
            handle,
            format!("host.invoke('{oversized_cap}', '{{}}')"),
            "null".to_string(),
            1_000.0,
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&envelope).unwrap();
        assert_eq!(parsed["ok"], false);
        assert_eq!(parsed["calls"].as_array().unwrap().len(), 0);

        let aggregate_code =
            "const args = 'x'.repeat(200000); for (let i = 0; i < 6; i++) host.invoke('mutate', args)";
        let envelope = sandbox_eval_impl(
            &mut state,
            handle,
            aggregate_code.to_string(),
            "null".to_string(),
            1_000.0,
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&envelope).unwrap();
        assert_eq!(parsed["ok"], false);
        assert_eq!(parsed["calls"].as_array().unwrap().len(), 5);
    }

    /// Read crossings must return the injected perception verbatim through the
    /// cached QuickJS string: same payload across evals keeps the cache, a
    /// changed payload rebuilds it, and an empty payload still reads "null".
    #[test]
    fn read_caps_serve_perception_via_cached_payload() {
        let mut state = OpState::new(None);
        let handle = sandbox_create_impl(
            &mut state,
            16.0 * 1024.0 * 1024.0,
            256.0 * 1024.0,
            r#"["read"]"#,
        )
        .expect("create sandbox with read cap");
        let code = "host.invoke('read', '{}') === host.invoke('read', '{}') \
                    ? host.invoke('read', '{}') : 'MISMATCH'";

        let envelope = sandbox_eval_impl(
            &mut state,
            handle,
            code.to_string(),
            r#"{"x":42}"#.to_string(),
            1_000.0,
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&envelope).unwrap();
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["value"], r#"{"x":42}"#);
        assert_eq!(parsed["reads"], 3);
        {
            let reg = state.borrow::<SandboxRegistry>();
            let sb = reg.sandboxes.get(&handle).unwrap();
            assert!(
                sb.shared.borrow().perception_cached.is_some(),
                "non-empty payload must be materialized once into QuickJS"
            );
        }

        // A CHANGED payload must invalidate the cache and serve the new bytes.
        let envelope = sandbox_eval_impl(
            &mut state,
            handle,
            "host.invoke('read', '{}')".to_string(),
            r#"{"x":43}"#.to_string(),
            1_000.0,
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&envelope).unwrap();
        assert_eq!(parsed["value"], r#"{"x":43}"#);

        // Empty perception keeps returning the literal "null" string.
        let envelope = sandbox_eval_impl(
            &mut state,
            handle,
            "host.invoke('read', '{}')".to_string(),
            String::new(),
            1_000.0,
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&envelope).unwrap();
        assert_eq!(parsed["value"], "null");

        // Destroy while a Persistent is cached: must not abort (drop-order guard).
        sandbox_eval_impl(
            &mut state,
            handle,
            "1".to_string(),
            r#"{"x":44}"#.to_string(),
            1_000.0,
        )
        .unwrap();
        assert!(sandbox_destroy_impl(&mut state, handle));
    }

    #[test]
    fn sandbox_eval_bounds_total_boundary_crossings() {
        let mut state = OpState::new(None);
        let handle = sandbox_create_impl(
            &mut state,
            16.0 * 1024.0 * 1024.0,
            256.0 * 1024.0,
            r#"["read"]"#,
        )
        .expect("create bounded sandbox");
        let code = format!(
            "for (let i = 0; i < {}; i++) host.invoke('read', '{{}}')",
            MAX_BOUNDARY_CROSSINGS + 1
        );
        let envelope =
            sandbox_eval_impl(&mut state, handle, code, "null".to_string(), 1_000.0).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&envelope).unwrap();
        assert_eq!(parsed["ok"], false);
        assert_eq!(parsed["crossings"], MAX_BOUNDARY_CROSSINGS);
        assert_eq!(parsed["reads"], MAX_BOUNDARY_CROSSINGS);
    }
}
