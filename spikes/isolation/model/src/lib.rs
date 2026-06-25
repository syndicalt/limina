//! Shared model for the P4.0b isolation spike.
//!
//! Both candidate sandboxes (QuickJS, separate V8 isolate) face the SAME threat:
//! a deliberately-malicious skill that tries to (1) reach the host/engine globals
//! or ops it was never granted, (2) call an ungranted capability, (3) read another
//! agent's private state, (4) exhaust resources, or (5) crash the host. They also
//! share the SAME capability boundary model below, which mirrors the engine's real
//! choke point `SkillRegistry.invoke`: a serializable `invoke(cap, argsJson)` that
//! permission-checks against an explicit grant set and is the ONLY path to a
//! mutating capability. The grant set is the analog of a permission profile.
//!
//! This is a throwaway prototype. It is NOT wired into engine core.

use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::Rc;

/// Authoritative world state behind the capability boundary. In the real engine
/// this is the ECS TypedArrays + Rapier bodies reached through `WorldContext`.
/// Here it holds (a) impulses a granted skill applied, and (b) OTHER agents'
/// private state that no capability exposes -- the malicious skill must not read
/// it. Untrusted code never gets a handle to this struct; it only ever sees the
/// serialized return value of a granted capability.
#[derive(Default)]
pub struct WorldState {
    /// Impulses recorded by the granted `physics.applyImpulse` capability.
    pub impulses: Vec<(f64, f64, f64)>,
    /// The calling agent's own position (readable via a granted capability).
    pub self_position: (f64, f64, f64),
    /// Another agent's PRIVATE position. No capability returns this; it exists
    /// only to prove cross-agent reads are impossible from the sandbox.
    pub other_agent_secret: (f64, f64, f64),
    /// Count of capability invocations that crossed the boundary (audit analog).
    pub invocations: u64,
    /// Count of denied invocations (the auditable-denial analog).
    pub denials: u64,
}

/// Outcome of a boundary crossing: granted -> serialized JSON result; denied ->
/// a structured reason. Mirrors `MCPResponse` success/error in the real registry.
pub enum HostOutcome {
    Ok(String),
    Denied(String),
}

/// The capability boundary. `granted` is the explicit capability set this skill
/// was given (the permission-profile analog). `invoke` is the ONLY surface the
/// untrusted skill can reach into the host; every crossing is permission-checked
/// and accounted, so a call to an ungranted capability is a real, observable
/// denial -- not a code convention.
pub struct HostRegistry {
    granted: HashSet<String>,
    world: Rc<RefCell<WorldState>>,
}

impl HostRegistry {
    pub fn new(granted: &[&str], world: Rc<RefCell<WorldState>>) -> Self {
        Self {
            granted: granted.iter().map(|s| s.to_string()).collect(),
            world,
        }
    }

    /// The single permission-checked entry point. `cap` names the capability,
    /// `args_json` is the serialized argument payload. Returns serialized JSON on
    /// grant, or a denial. NOTE: even an IMPLEMENTED capability is refused unless
    /// it is in the grant set -- permission first, then dispatch.
    pub fn invoke(&self, cap: &str, args_json: &str) -> HostOutcome {
        if !self.granted.contains(cap) {
            self.world.borrow_mut().denials += 1;
            return HostOutcome::Denied(format!("missing capability grant: {cap}"));
        }
        self.world.borrow_mut().invocations += 1;
        match cap {
            "physics.applyImpulse" => {
                // Parse {x,y,z} without serde to keep the closure light; tolerate
                // the fixed payload the spike sends.
                let (x, y, z) = parse_xyz(args_json);
                self.world.borrow_mut().impulses.push((x, y, z));
                HostOutcome::Ok(format!("{{\"applied\":true,\"x\":{x},\"y\":{y},\"z\":{z}}}"))
            }
            "ecs.getSelfPosition" => {
                let p = self.world.borrow().self_position;
                HostOutcome::Ok(format!("{{\"x\":{},\"y\":{},\"z\":{}}}", p.0, p.1, p.2))
            }
            // A granted-but-unknown capability name still fails closed.
            _ => HostOutcome::Denied(format!("no handler for capability: {cap}")),
        }
    }

    pub fn world(&self) -> Rc<RefCell<WorldState>> {
        self.world.clone()
    }
}

/// Minimal `{"x":N,"y":N,"z":N}` extractor for the spike's fixed payload.
fn parse_xyz(s: &str) -> (f64, f64, f64) {
    let grab = |key: &str| -> f64 {
        if let Some(i) = s.find(key) {
            let rest = &s[i + key.len()..];
            let rest = rest.trim_start_matches([':', ' ', '"']);
            let end = rest
                .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == '+' || c == 'e'))
                .unwrap_or(rest.len());
            rest[..end].parse().unwrap_or(0.0)
        } else {
            0.0
        }
    };
    (grab("\"x\""), grab("\"y\""), grab("\"z\""))
}

// ---------------------------------------------------------------------------
// Malicious skill: the escape probes. Every probe is 7-bit ASCII. Reachability
// probes report what they observed (driven by the host so the BLOCK is shown,
// not asserted); the abort probes are run individually so isolation is visible.
// ---------------------------------------------------------------------------

/// Probes ambient reachability and returns a JSON report of what it could touch.
/// In a contained sandbox every host handle must come back "undefined".
pub const PROBE_REACH: &str = r#"
(function () {
  function probe(fn) {
    try {
      var v = fn();
      if (v === undefined) return "undefined";
      if (v === null) return "null";
      return typeof v;
    } catch (e) {
      return "threw:" + (e && e.message ? e.message : String(e));
    }
  }
  var r = {};
  r.Deno = probe(function () { return (typeof Deno !== "undefined") ? Deno : undefined; });
  r.Deno_core = probe(function () { return (typeof Deno !== "undefined" && Deno.core) ? Deno.core : undefined; });
  r.Deno_core_ops = probe(function () { return (typeof Deno !== "undefined" && Deno.core && Deno.core.ops) ? Deno.core.ops : undefined; });
  r.process = probe(function () { return (typeof process !== "undefined") ? process : undefined; });
  r.require = probe(function () { return (typeof require !== "undefined") ? require : undefined; });
  r.global_node = probe(function () { return (typeof global !== "undefined") ? global : undefined; });
  r.read_file = probe(function () { return (typeof readFile !== "undefined") ? readFile : undefined; });
  r.fetch = probe(function () { return (typeof fetch !== "undefined") ? fetch : undefined; });
  // Constructor-walk escape: reach a Function constructor and build code that
  // tries to read host globals from the real global object.
  r.ctor_escape = (function () {
    try {
      var F = (function () {}).constructor;
      var g = F("return this")();
      if (g && (g.Deno || g.process || g.require)) return "REACHED-HOST";
      return "global-has-no-host";
    } catch (e) {
      return "threw:" + (e && e.message ? e.message : String(e));
    }
  })();
  r.global_names = Object.getOwnPropertyNames(globalThis).sort().join(",");
  return JSON.stringify(r);
})()
"#;

/// Tries to call a capability it was never granted (a privileged op surface).
/// Expected: the host boundary denies it.
pub const PROBE_UNGRANTED: &str = r#"
host.invoke("ops.rawExec", JSON.stringify({ cmd: "rm -rf /" }))
"#;

/// Tries to read another agent's private state. No capability exposes it, so the
/// best the skill can do is ask for a capability that does not exist -> denied.
pub const PROBE_READ_OTHER: &str = r#"
host.invoke("agent.readOtherState", JSON.stringify({ target: "agt_victim" }))
"#;

/// Resource exhaustion: a CPU-bound infinite loop. The sandbox's interrupt/
/// deadline must halt it and the host must survive.
pub const PROBE_INFINITE_LOOP: &str = r#"
var n = 0; while (true) { n = (n + 1) % 1000000; }
"#;

/// Resource exhaustion: unbounded memory growth. The sandbox's memory cap must
/// abort it and the host must survive.
pub const PROBE_MEMORY_BOMB: &str = r#"
var a = []; for (;;) { a.push(new Array(100000).fill(7)); }
"#;

/// Crash attempt: unbounded recursion (stack overflow).
pub const PROBE_STACK_BOMB: &str = r#"
function rec(x) { return rec(x + 1) + 1; } rec(0)
"#;

/// Crash attempt: throw an uncaught error.
pub const PROBE_THROW: &str = r#"
throw new Error("hostile skill detonates");
"#;

/// The benign GRANTED capability call used to measure per-call overhead. A
/// granted skill applies an impulse through the boundary.
pub const GRANTED_CAP: &str = "physics.applyImpulse";
pub const GRANTED_ARGS: &str = "{\"x\":1,\"y\":0,\"z\":0}";

/// Number of round-trips per overhead sample.
pub const OVERHEAD_ITERS: u64 = 200_000;
