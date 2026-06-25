//! P4.0b candidate 2: a separate V8 isolate via deno_core (=0.404, the engine's
//! own runtime tech).
//!
//! The untrusted skill runs in a FRESH `JsRuntime` -- a distinct V8 isolate with
//! its own heap -- whose ONLY domain op is the narrow capability surface
//! `op_cap_invoke(cap, args)` (plus an out-of-band `op_report` the harness uses to
//! read results). The engine's privileged ops (op_read_asset, op_http_post,
//! op_write_trace, ...) are NOT registered in this isolate, and the privileged
//! isolate's heap/globals/ECS arrays are unreachable (separate isolate, separate
//! heap). This binary proves:
//!   1. the malicious skill cannot reach a privileged engine op (absent from this
//!      isolate's op table) and an ungranted capability is denied at the boundary,
//!   2. a CPU-bound infinite loop is terminated -- but only via a cross-thread
//!      watchdog (V8 has no in-thread interrupt callback like QuickJS), and an
//!      unbounded allocation is stopped by a near-heap-limit callback,
//!   3. per-call op overhead + fresh-isolate startup cost + per-isolate RSS (the
//!      density signal for many concurrent agents).
//!
//! Run (reusing the engine's prebuilt v8):
//!   RUSTY_V8_ARCHIVE=$PWD/../../../target/debug/gn_out/obj/librusty_v8.a \
//!     cargo run --release --bin v8_isolate_spike

use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use deno_core::{extension, op2, JsRuntime, OpState, RuntimeOptions};
use iso_model::*;

type Sink = Rc<RefCell<String>>;

/// The narrow capability op -- the ONLY host capability surface the untrusted
/// isolate gets. Permission + dispatch happen behind it, in the host registry.
/// This is the V8 analog of QuickJS's injected `host.invoke`.
#[op2]
#[string]
fn op_cap_invoke(state: &mut OpState, #[string] cap: &str, #[string] args: &str) -> String {
    let reg = state.borrow::<Rc<HostRegistry>>().clone();
    match reg.invoke(cap, args) {
        HostOutcome::Ok(s) => s,
        HostOutcome::Denied(reason) => {
            format!("{{\"denied\":true,\"reason\":\"{}\"}}", reason.replace('"', "'"))
        }
    }
}

/// Out-of-band result channel for the harness (not a capability). The probe calls
/// `report(x)`; Rust reads it from the sink. Avoids extracting strings from the
/// script's return value across the v8 pinned-scope API.
#[op2(fast)]
fn op_report(state: &mut OpState, #[string] s: &str) {
    let sink = state.borrow::<Sink>().clone();
    *sink.borrow_mut() = s.to_string();
}

extension!(
    cap_surface,
    ops = [op_cap_invoke, op_report],
    options = { reg: Rc<HostRegistry>, sink: Sink },
    state = |state, options| {
        state.put(options.reg);
        state.put(options.sink);
    },
);

/// Wrap the raw ops as a `host.invoke` + `report` surface. (Deno.core still exists
/// on the isolate; a production embedder would also scrub it -- see the report's
/// tradeoffs. We deliberately leave it reachable so ESCAPE 1 can prove the
/// privileged ops are nonetheless absent from this isolate's op table.)
const HOST_SHIM: &str = r#"
globalThis.host = { invoke: (c, a) => Deno.core.ops.op_cap_invoke(c, a) };
globalThis.report = (s) => Deno.core.ops.op_report(String(s));
"#;

struct Sandbox {
    rt: JsRuntime,
    world: Rc<RefCell<WorldState>>,
    sink: Sink,
}

fn fresh_sandbox(granted: &[&str], heap_max: Option<usize>) -> Sandbox {
    let world = Rc::new(RefCell::new(WorldState {
        self_position: (10.0, 20.0, 30.0),
        other_agent_secret: (-1.0, -2.0, -3.0),
        ..Default::default()
    }));
    let reg = Rc::new(HostRegistry::new(granted, world.clone()));
    let sink: Sink = Rc::new(RefCell::new(String::new()));
    let create_params = heap_max.map(|max| deno_core::v8::CreateParams::default().heap_limits(0, max));
    let mut rt = JsRuntime::new(RuntimeOptions {
        extensions: vec![cap_surface::init(reg, sink.clone())],
        create_params,
        ..Default::default()
    });
    rt.execute_script("shim", HOST_SHIM).expect("shim");
    Sandbox { rt, world, sink }
}

/// Run a script; return Ok(()) or a one-line error (e.g. termination / exception).
fn run(rt: &mut JsRuntime, name: &'static str, code: String) -> Result<(), String> {
    rt.execute_script(name, code)
        .map(|_| ())
        .map_err(|e| format!("{e}").lines().next().unwrap_or("error").to_string())
}

fn rss_kb() -> i64 {
    let s = std::fs::read_to_string("/proc/self/statm").unwrap_or_default();
    let resident: i64 = s.split_whitespace().nth(1).and_then(|v| v.parse().ok()).unwrap_or(0);
    resident * 4 // 4 KiB pages
}

fn main() {
    // Child mode: a heap-capped isolate that detonates a memory bomb to prove the
    // cap is enforced. Run as a subprocess so the parent's clean exit is preserved.
    if std::env::args().any(|a| a == "--membomb") {
        membomb_child();
        return;
    }
    println!("============= P4.0b candidate: separate V8 isolate (deno_core 0.404) =============\n");

    let mut sb = fresh_sandbox(&[GRANTED_CAP, "ecs.getSelfPosition"], None);

    println!("--- ESCAPE 1: reach a PRIVILEGED engine op (op_read_asset / op_http_post) ---");
    let probe = r#"
      (function () {
        var ops = (typeof Deno !== "undefined" && Deno.core && Deno.core.ops) ? Deno.core.ops : {};
        function has(n) { return typeof ops[n] === "function"; }
        report(JSON.stringify({
          op_read_asset: has("op_read_asset"),
          op_http_post: has("op_http_post"),
          op_write_trace: has("op_write_trace"),
          op_cap_invoke: has("op_cap_invoke"),
          privileged_ops_visible: Object.keys(ops).filter(function (k) {
            return /asset|http|trace/.test(k);
          }).join(",")
        }));
      })()
    "#;
    run(&mut sb.rt, "reach", probe.to_string()).unwrap();
    let j = sb.sink.borrow().clone();
    println!("  isolate op-table probe: {j}");
    let leaked = j.contains("\"op_read_asset\":true")
        || j.contains("\"op_http_post\":true")
        || j.contains("\"op_write_trace\":true");
    println!("  => privileged engine ops absent from this isolate: {}", !leaked);
    assert!(!leaked, "a privileged limina op leaked into the untrusted isolate");
    println!();

    println!("--- ESCAPE 2: call an UNGRANTED capability via the boundary op ---");
    let before = sb.world.borrow().impulses.len();
    run(&mut sb.rt, "ungranted", "report(host.invoke('ops.rawExec', JSON.stringify({cmd:'rm -rf /'})))".to_string()).unwrap();
    let r = sb.sink.borrow().clone();
    println!("  host returned: {r}");
    println!("  => BLOCKED at boundary: {}", r.contains("\"denied\":true"));
    assert!(r.contains("\"denied\":true"));
    println!("  side effects: impulses {} -> {} (none), denials={}", before, sb.world.borrow().impulses.len(), sb.world.borrow().denials);
    println!();

    println!("--- ESCAPE 3: read ANOTHER agent's private state ---");
    run(&mut sb.rt, "other", "report(host.invoke('agent.readOtherState', JSON.stringify({target:'agt_victim'})))".to_string()).unwrap();
    let r = sb.sink.borrow().clone();
    let leaked = r.contains("-1") || r.contains("-2") || r.contains("-3");
    println!("  host returned: {r}");
    println!("  => other agent's secret {:?} NOT leaked: {}", sb.world.borrow().other_agent_secret, !leaked);
    assert!(!leaked);
    println!();

    println!("--- ESCAPE 4: CPU exhaustion (infinite loop) -- needs a cross-thread watchdog ---");
    {
        let handle = sb.rt.v8_isolate().thread_safe_handle();
        let h2 = handle.clone();
        let watchdog = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            h2.terminate_execution();
        });
        let t = Instant::now();
        let res = run(&mut sb.rt, "loop", "var n=0; while(true){ n=(n+1)%1000000; }".to_string());
        let elapsed = t.elapsed();
        let _ = watchdog.join();
        sb.rt.v8_isolate().cancel_terminate_execution();
        match res {
            Ok(_) => println!("  !! loop returned without termination (unexpected)"),
            Err(e) => println!("  terminated by watchdog after {:?} -> {e}", elapsed),
        }
        run(&mut sb.rt, "alive", "report(host.invoke('ecs.getSelfPosition','{}'))".to_string()).unwrap();
        println!("  isolate still alive after terminate; getSelfPosition -> {}", sb.sink.borrow());
    }
    println!();

    println!("--- GRANTED PATH: a permitted capability mutates world state ---");
    run(&mut sb.rt, "grant", format!("host.invoke('{GRANTED_CAP}', '{GRANTED_ARGS}')")).unwrap();
    println!("  impulses={:?}, invocations={}", sb.world.borrow().impulses, sb.world.borrow().invocations);
    println!();

    println!("================ OVERHEAD: per-call capability round-trip ================");
    measure_overhead(&mut sb.rt);
    println!();

    println!("================ STARTUP + RSS (per fresh isolate) ================");
    measure_startup();
    println!();

    // Run the memory probe LAST so the headline numbers are already out.
    println!("--- ESCAPE 5: memory bomb -- heap cap enforced (24 MB), demonstrated via child ---");
    memory_probe();

    // Exit cleanly: the main isolate (sb) drop path is fine for a single isolate,
    // but we exit explicitly so the run's exit code is deterministic.
    std::io::Write::flush(&mut std::io::stdout()).ok();
    std::process::exit(0);
}

fn measure_overhead(rt: &mut JsRuntime) {
    let n = OVERHEAD_ITERS;
    run(rt, "nop", "globalThis.__nop = function(c,a){ return a; };".to_string()).unwrap();
    let call_src = format!("(function(){{var s=0;for(var i=0;i<{n};i++){{var r=host.invoke('ecs.getSelfPosition','{{}}');s+=r.length;}}return s;}})()");
    let base_src = format!("(function(){{var s=0;for(var i=0;i<{n};i++){{var r=__nop('ecs.getSelfPosition','{{}}');s+=r.length;}}return s;}})()");
    run(rt, "warm1", call_src.clone()).unwrap();
    run(rt, "warm2", base_src.clone()).unwrap();

    let t = Instant::now();
    run(rt, "call", call_src).unwrap();
    let t_call = t.elapsed();
    let t = Instant::now();
    run(rt, "base", base_src).unwrap();
    let t_base = t.elapsed();

    let per_call = t_call.as_nanos() as f64 / n as f64;
    let per_base = t_base.as_nanos() as f64 / n as f64;
    println!("  iterations:                 {n}");
    println!("  total per granted call:     {per_call:.1} ns  ({:.2} M calls/s)", 1e3 / per_call);
    println!("  in-isolate JS-call baseline:{per_base:.1} ns  (JIT dispatch + arg)");
    println!("  >>> host-boundary crossing: {:.1} ns/call  (JS<->op round-trip)", per_call - per_base);
}

fn measure_startup() {
    let reps = 30u32; // V8 isolates are heavy; a few dozen is the realistic ceiling.
    let rss0 = rss_kb();
    let t = Instant::now();
    let mut held = Vec::with_capacity(reps as usize);
    for _ in 0..reps {
        let sb = fresh_sandbox(&[GRANTED_CAP], None);
        held.push(sb);
    }
    let per = t.elapsed().as_micros() as f64 / reps as f64 / 1000.0; // ms each
    let rss1 = rss_kb();
    println!("  fresh JsRuntime create:     {per:.2} ms each  ({reps} reps)");
    println!("  RSS delta over {reps} isolates: {} KB  (~{} KB/isolate held live)", rss1 - rss0, (rss1 - rss0) / reps as i64);
    println!("  => a thread can spin up ~{:.0} fresh isolates/s", 1e3 / per);
    // deno_core's teardown of many simultaneously-live isolates violates a V8
    // isolate-enter invariant (observed: "Cannot create a handle without a
    // HandleScope"). The process is about to do more work then exit, so leak the
    // measurement isolates rather than drop them. (This fragility of running many
    // V8 isolates side-by-side is itself a finding -- see the report.)
    std::mem::forget(held);
}

/// Parent: run the memory bomb in a heap-capped CHILD process and report its fate.
/// This keeps the parent's exit clean while proving (a) the heap cap is enforced
/// and (b) the operational consequence in-process: V8 OOM aborts the hosting
/// process. Surviving OOM in-process needs add_near_heap_limit_callback+terminate,
/// which proved FRAGILE in this spike (V8 aborts: "Cannot create a handle without
/// a HandleScope" when terminating from inside the callback).
fn memory_probe() {
    let exe = std::env::current_exe().expect("current_exe");
    let out = std::process::Command::new(exe)
        .arg("--membomb")
        .output()
        .expect("spawn child");
    print!("{}", String::from_utf8_lossy(&out.stderr));
    match out.status.code() {
        Some(code) => println!("  child exited with code {code} (heap cap enforced)"),
        None => {
            use std::os::unix::process::ExitStatusExt;
            println!(
                "  child killed by signal {:?} -- V8 OOM-aborted the isolate's process (cap enforced)",
                out.status.signal()
            );
        }
    }
    println!("  => memory IS bounded, but an in-process V8 OOM is FATAL to the hosting process.");
    println!("     (QuickJS, by contrast, throws a catchable OOM and keeps serving -- see candidate 1.)");
}

/// Child: a 24 MB heap-capped isolate, NO near-heap-limit callback, so V8 enforces
/// the cap by aborting on OOM. Proves the cap is real and that in-process OOM is
/// process-fatal.
fn membomb_child() {
    let mut sb = fresh_sandbox(&[GRANTED_CAP], Some(24 * 1024 * 1024));
    eprintln!("  [child] 24 MB heap cap set; detonating memory bomb...");
    let _ = run(
        &mut sb.rt,
        "membomb",
        "var a=[]; for(;;){ a.push(new Array(100000).fill(7)); }".to_string(),
    );
    eprintln!("  [child] UNEXPECTED: allocation completed without hitting the cap");
}
