//! P4.0b candidate 1: QuickJS (rquickjs 0.12, bundled quickjs-ng C source).
//!
//! A fresh QuickJS context exposes ONLY standard ECMAScript globals -- there is
//! no `Deno`, no `Deno.core.ops`, no `process`/`require`, no fs/net. The host
//! injects an explicit `host.invoke(cap, argsJson)` capability surface and
//! NOTHING else. This binary:
//!   1. hosts the malicious skill and shows every escape attempt blocked (the
//!      real outcome is printed, not asserted),
//!   2. measures per-call round-trip overhead of a granted capability call,
//!   3. measures fresh-sandbox startup cost + per-context memory (the density
//!      signal for many concurrent agents).
//!
//! Run: cargo run --release --bin quickjs_spike

use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use iso_model::*;
use rquickjs::{CatchResultExt, Context, Function, Object, Runtime, Value};

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Build a context on `rt` with the `host` capability object wired in, granting
/// exactly the named capabilities. Returns the context + shared world state.
fn make_sandbox(
    rt: &Runtime,
    granted: &[&str],
) -> (Context, Rc<RefCell<WorldState>>) {
    let world = Rc::new(RefCell::new(WorldState {
        self_position: (10.0, 20.0, 30.0),
        other_agent_secret: (-1.0, -2.0, -3.0),
        ..Default::default()
    }));
    let reg = Rc::new(HostRegistry::new(granted, world.clone()));
    let ctx = Context::full(rt).expect("context");
    ctx.with(|ctx| {
        let host = Object::new(ctx.clone()).unwrap();
        let r = reg.clone();
        let invoke = Function::new(ctx.clone(), move |cap: String, args: String| -> String {
            match r.invoke(&cap, &args) {
                HostOutcome::Ok(s) => s,
                HostOutcome::Denied(reason) => {
                    format!("{{\"denied\":true,\"reason\":{}}}", json_escape(&reason))
                }
            }
        })
        .unwrap();
        host.set("invoke", invoke).unwrap();
        ctx.globals().set("host", host).unwrap();
    });
    (ctx, world)
}

/// Eval `code`, returning either the string result or a one-line description of
/// the caught error/exception (so a blocked escape shows its real outcome).
fn eval_report(ctx: &Context, code: &str) -> Result<String, String> {
    ctx.with(|ctx| match ctx.eval::<Value, _>(code).catch(&ctx) {
        Ok(v) => {
            if let Some(s) = v.as_string() {
                Ok(s.to_string().unwrap_or_default())
            } else {
                Ok(format!("{:?}", v.type_of()))
            }
        }
        Err(err) => Err(format!("{err}").lines().next().unwrap_or("error").to_string()),
    })
}

fn main() {
    println!("================ P4.0b candidate: QuickJS (rquickjs 0.12) ================\n");

    // ---- Containment runtime: generous mem cap, no deadline yet. ----
    let rt = Runtime::new().expect("runtime");
    rt.set_memory_limit(64 * 1024 * 1024);
    rt.set_max_stack_size(256 * 1024);
    let (ctx, world) = make_sandbox(&rt, &[GRANTED_CAP, "ecs.getSelfPosition"]);

    println!("--- ESCAPE 1: reach host/engine globals (Deno.core.ops, process, require, ctor-walk) ---");
    match eval_report(&ctx, PROBE_REACH) {
        Ok(json) => {
            println!("  malicious skill's own report of what it could reach:");
            println!("  {json}");
            let reached_host = json.contains("REACHED-HOST")
                || json.contains("\"Deno\":\"object\"")
                || json.contains("\"process\":\"object\"")
                || json.contains("\"Deno_core_ops\":\"object\"");
            println!(
                "  => CONTAINED: {} (no host handle was reachable)",
                !reached_host
            );
            assert!(!reached_host, "QuickJS leaked a host global to untrusted code");
        }
        Err(e) => println!("  probe error: {e}"),
    }
    println!();

    println!("--- ESCAPE 2: call an UNGRANTED privileged capability (ops.rawExec 'rm -rf /') ---");
    let before = world.borrow().impulses.len();
    match eval_report(&ctx, PROBE_UNGRANTED) {
        Ok(r) => {
            println!("  host returned: {r}");
            let denied = r.contains("\"denied\":true");
            println!("  => BLOCKED at the registry boundary: {denied}");
            assert!(denied, "ungranted capability was not denied");
        }
        Err(e) => println!("  threw: {e}"),
    }
    println!(
        "  side effects: impulses {} -> {} (none), denials={}",
        before,
        world.borrow().impulses.len(),
        world.borrow().denials
    );
    println!();

    println!("--- ESCAPE 3: read ANOTHER agent's private state (agent.readOtherState) ---");
    match eval_report(&ctx, PROBE_READ_OTHER) {
        Ok(r) => {
            println!("  host returned: {r}");
            let leaked = r.contains("-1") || r.contains("-2") || r.contains("-3");
            println!(
                "  => other agent's secret {:?} NOT leaked: {}",
                world.borrow().other_agent_secret,
                !leaked
            );
            assert!(!leaked, "cross-agent private state leaked");
        }
        Err(e) => println!("  threw: {e}"),
    }
    println!();

    println!("--- ESCAPE 4: CPU exhaustion (infinite loop) -- interrupt/deadline must halt it ---");
    {
        let deadline = Instant::now() + Duration::from_millis(150);
        rt.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));
        let t = Instant::now();
        let res = eval_report(&ctx, PROBE_INFINITE_LOOP);
        let elapsed = t.elapsed();
        rt.set_interrupt_handler(None);
        match res {
            Ok(_) => println!("  !! loop returned without interrupt (unexpected)"),
            Err(e) => println!("  halted after {:?} -> {e}", elapsed),
        }
        // Prove the host + sandbox survived and can keep serving capabilities.
        let alive = eval_report(&ctx, "host.invoke(\"ecs.getSelfPosition\", \"{}\")");
        println!("  host still alive after halt; getSelfPosition -> {alive:?}");
    }
    println!();

    println!("--- ESCAPE 5: memory bomb (unbounded growth) on a 4 MB-capped runtime ---");
    {
        let rt2 = Runtime::new().expect("runtime2");
        rt2.set_memory_limit(4 * 1024 * 1024);
        let (ctx2, _w2) = make_sandbox(&rt2, &[GRANTED_CAP]);
        match eval_report(&ctx2, PROBE_MEMORY_BOMB) {
            Ok(_) => println!("  !! allocation succeeded unbounded (unexpected)"),
            Err(e) => println!("  aborted by memory cap -> {e}"),
        }
        let alive = eval_report(&ctx2, "1 + 1");
        println!("  host process survived the OOM; fresh eval 1+1 -> {alive:?}");
    }
    println!();

    println!("--- ESCAPE 6: crash attempts (stack overflow + uncaught throw) are isolated ---");
    match eval_report(&ctx, PROBE_STACK_BOMB) {
        Ok(_) => println!("  !! deep recursion returned (unexpected)"),
        Err(e) => println!("  stack overflow contained -> {e}"),
    }
    match eval_report(&ctx, PROBE_THROW) {
        Ok(_) => println!("  !! throw produced a value (unexpected)"),
        Err(e) => println!("  uncaught throw contained -> {e}"),
    }
    let alive = eval_report(&ctx, "host.invoke(\"ecs.getSelfPosition\", \"{}\")");
    println!("  host still alive after both crashes; getSelfPosition -> {alive:?}");
    println!();

    // A granted capability genuinely mutates world state through the boundary.
    println!("--- GRANTED PATH: a permitted capability DOES cross the boundary ---");
    let _ = eval_report(
        &ctx,
        &format!("host.invoke(\"{GRANTED_CAP}\", '{GRANTED_ARGS}')"),
    );
    println!(
        "  after a granted physics.applyImpulse: impulses={:?}, invocations={}",
        world.borrow().impulses,
        world.borrow().invocations
    );
    println!();

    // ---- Overhead: per-call round-trip of a granted capability vs in-sandbox baseline. ----
    println!("================ OVERHEAD: per-call capability round-trip ================");
    measure_overhead(&ctx);
    println!();

    // ---- Startup + per-context footprint: the many-concurrent-agents signal. ----
    println!("================ STARTUP + FOOTPRINT (per fresh sandbox) ================");
    measure_startup();
}

fn measure_overhead(ctx: &Context) {
    let n = OVERHEAD_ITERS;
    ctx.with(|ctx| {
        // Define a pure-JS no-op with the SAME call shape to subtract interpreter
        // dispatch + arg marshaling cost, isolating the host-boundary crossing.
        ctx.eval::<(), _>("globalThis.__nop = function (c, a) { return a; };")
            .catch(&ctx)
            .unwrap();

        let call_src = format!(
            "(function(){{ var s=0; for (var i=0;i<{n};i++) {{ var r=host.invoke(\"ecs.getSelfPosition\",\"{{}}\"); s+=r.length; }} return s; }})()"
        );
        let base_src = format!(
            "(function(){{ var s=0; for (var i=0;i<{n};i++) {{ var r=__nop(\"ecs.getSelfPosition\",\"{{}}\"); s+=r.length; }} return s; }})()"
        );

        // Warm up both paths.
        ctx.eval::<Value, _>(call_src.as_str()).catch(&ctx).unwrap();
        ctx.eval::<Value, _>(base_src.as_str()).catch(&ctx).unwrap();

        let t = Instant::now();
        ctx.eval::<Value, _>(call_src.as_str()).catch(&ctx).unwrap();
        let t_call = t.elapsed();

        let t = Instant::now();
        ctx.eval::<Value, _>(base_src.as_str()).catch(&ctx).unwrap();
        let t_base = t.elapsed();

        let per_call_total = t_call.as_nanos() as f64 / n as f64;
        let per_call_base = t_base.as_nanos() as f64 / n as f64;
        let boundary = per_call_total - per_call_base;
        println!("  iterations:                 {n}");
        println!("  total per granted call:     {per_call_total:.1} ns  ({:.2} M calls/s)", 1e3 / per_call_total);
        println!("  in-sandbox JS-call baseline:{per_call_base:.1} ns  (interpreter dispatch + arg)");
        println!("  >>> host-boundary crossing: {boundary:.1} ns/call  (QuickJS<->Rust round-trip)");
    });
}

fn measure_startup() {
    // Fresh Runtime + Context per sandbox (the per-agent unit). Time many.
    let reps = 2_000u32;
    let t = Instant::now();
    let mut last_mem = 0i64;
    for _ in 0..reps {
        let rt = Runtime::new().unwrap();
        let ctx = Context::full(&rt).unwrap();
        ctx.with(|ctx| {
            ctx.eval::<(), _>("var x = 1;").unwrap();
        });
        last_mem = rt.memory_usage().malloc_size;
    }
    let per = t.elapsed().as_nanos() as f64 / reps as f64 / 1000.0; // us
    println!("  fresh Runtime+Context create: {per:.1} us each  ({reps} reps)");
    println!("  per-context malloc footprint: ~{} KB (a minimal sandbox)", last_mem / 1024);
    println!("  => a single thread can spin up >{:.0}k fresh sandboxes/s", 1e3 / per);
}
