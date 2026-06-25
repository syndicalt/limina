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
use rquickjs::{CatchResultExt, Context, Function, Object, Runtime, Value};

/// Mutable state shared between the injected `host.invoke` closure and the op
/// driving an eval. The closure can ONLY (a) read the injected perception
/// snapshot for a read capability, and (b) append a mutating-capability intent.
/// It never touches the engine directly.
#[derive(Default)]
struct SandboxShared {
    /// The calling agent's own perception view, injected per decision. Read caps
    /// return it verbatim; it NEVER carries another agent's private state.
    perception_json: String,
    /// Capabilities served synchronously as reads (return the perception snapshot).
    read_caps: HashSet<String>,
    /// Recorded MUTATING capability intents `(cap, argsJson)` in call order. The
    /// JS host drains these and drives each through `SkillRegistry.invoke`.
    captured: Vec<(String, String)>,
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
    let read_caps: HashSet<String> = serde_json::from_str(&read_caps_json)
        .map_err(|e| JsErrorBox::generic(format!("invalid read_caps_json: {e}")))?;
    let rt = Runtime::new().map_err(|e| JsErrorBox::generic(format!("quickjs runtime: {e}")))?;
    if mem_limit_bytes > 0.0 {
        rt.set_memory_limit(mem_limit_bytes as usize);
    }
    if max_stack_bytes > 0.0 {
        rt.set_max_stack_size(max_stack_bytes as usize);
    }
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
        let invoke = Function::new(ctx.clone(), move |cap: String, args: String| -> String {
            let mut sh = s.borrow_mut();
            sh.crossings += 1;
            if sh.read_caps.contains(&cap) {
                sh.reads += 1;
                // A read returns the agent's OWN perception snapshot verbatim.
                if sh.perception_json.is_empty() {
                    return "null".to_string();
                }
                return sh.perception_json.clone();
            }
            // A mutating capability is RECORDED as an intent -- never executed
            // here. The privileged JS host drives it through SkillRegistry.invoke.
            sh.captured.push((cap, args));
            "{\"queued\":true}".to_string()
        })?;
        host.set("invoke", invoke)?;
        ctx.globals().set("host", host)?;
        Ok(())
    })
    .map_err(|e| JsErrorBox::generic(format!("inject host surface: {e}")))?;

    let reg = ensure_registry(state);
    reg.next += 1;
    let handle = reg.next;
    reg.sandboxes.insert(handle, Sandbox { rt, ctx, shared });
    Ok(handle)
}

/// Run untrusted JS in sandbox `handle` under a CPU deadline (`deadline_ms`; 0 =
/// none) with `perception_json` injected for read capabilities. Returns a JSON
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
    let reg = ensure_registry(state);
    let sb = reg
        .sandboxes
        .get(&handle)
        .ok_or_else(|| JsErrorBox::generic(format!("unknown sandbox handle: {handle}")))?;

    {
        let mut sh = sb.shared.borrow_mut();
        sh.perception_json = perception_json;
        sh.captured.clear();
        sh.crossings = 0;
        sh.reads = 0;
    }

    if deadline_ms > 0.0 {
        let dl = Instant::now() + Duration::from_millis(deadline_ms as u64);
        sb.rt
            .set_interrupt_handler(Some(Box::new(move || Instant::now() >= dl)));
    }

    let outcome: Result<String, String> =
        sb.ctx.with(
            |ctx| match ctx.eval::<Value, _>(code.as_str()).catch(&ctx) {
                Ok(v) => Ok(if let Some(s) = v.as_string() {
                    s.to_string().unwrap_or_default()
                } else if let Some(i) = v.as_int() {
                    i.to_string()
                } else if let Some(f) = v.as_float() {
                    f.to_string()
                } else if let Some(b) = v.as_bool() {
                    b.to_string()
                } else if v.is_null() {
                    "null".to_string()
                } else if v.is_undefined() {
                    "undefined".to_string()
                } else {
                    format!("{:?}", v.type_of())
                }),
                Err(err) => Err(format!("{err}")
                    .lines()
                    .next()
                    .unwrap_or("error")
                    .to_string()),
            },
        );

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

/// Destroy a sandbox, freeing its QuickJS context. Returns whether one existed.
#[op2(fast)]
pub fn op_sandbox_destroy(state: &mut OpState, handle: u32) -> bool {
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
