# P4.0b Isolation Spike — Report & Recommendation

**De-risking spike for Phase 4b (governed ecosystem) milestone M6 — "untrusted
skill/agent code runs OUTSIDE the privileged engine isolate."** Resolves the
recorded bet *"QuickJS vs additional V8 isolates vs workers vs another sandbox."*

> Status: **resolved**. Two candidates prototyped and run; both **contain** a
> deliberately-malicious skill (proven by blocked escapes, not assertions);
> per-call overhead and per-sandbox density measured. **Recommendation: QuickJS
> (rquickjs) for the untrusted-agent sandbox**, with the main/render isolate
> staying deno_core V8. This is a SPIKE — prototype + report only; nothing is
> wired into engine core.

All numbers below are from `spikes/isolation/` (a detached cargo workspace) on the
project hardware (i7-12700H). Candidate binaries are **release**; the engine
baseline is the existing **debug** `./target/debug/limina`. Captured runs:
`results/quickjs.txt`, `results/v8.txt`, `results/baseline.txt`.

---

## 1. Constraint & threat model

The engine is a **single deno_core V8 isolate**; Three.js per-frame work needs
JIT-class throughput on that **main** isolate (Phase 3). So untrusted-agent
sandboxes are **separate from the render/main path** — agent decisions already run
async, off the frame loop, applied via the action queue. A sandbox therefore does
NOT need JIT-class throughput; it needs **containment + density** (many concurrent
agents) + **cheap, auditable capability crossings**.

The threat model is inherited verbatim from the Phase-3 isolation decision record
(`plans/limina-phase-3-isolation-decision.md`): untrusted code MUST NOT reach
`Deno.core.ops`, exported ECS component arrays, `WorldContext`, `EntityTable`, or
the privileged skill registry; it must reach the host **only** through a reduced,
**serializable capability set**. The spike models that boundary with
`HostRegistry::invoke(cap, argsJson)` (`model/src/lib.rs`) — the analog of the
engine's real choke point `SkillRegistry.invoke`: permission-checked against an
explicit grant set, the ONLY path to a mutating capability, every crossing
accounted (invocations / denials = the audit analog).

The malicious skill (`model/src/lib.rs`, 7-bit ASCII probes) attempts six escapes:
1. reach host/engine globals (`Deno.core.ops`, `process`, `require`, `fetch`, and a
   `Function`-constructor walk to the real global),
2. call an **ungranted** privileged capability (`ops.rawExec "rm -rf /"`),
3. read **another agent's** private state (`agent.readOtherState`),
4. CPU exhaustion (infinite loop),
5. memory exhaustion (unbounded allocation),
6. crash the host (stack overflow + uncaught throw).

---

## 2. Candidates evaluated

| # | Candidate | Built? | Contains all 6 escapes? |
|---|---|---|---|
| 1 | **QuickJS** via `rquickjs` 0.12 (bundled quickjs-ng C) | yes | **yes** |
| 2 | **Separate V8 isolate** via a fresh `deno_core` 0.404 `JsRuntime` | yes | **yes**, except in-process OOM is process-fatal (see §4) |
| 3 | OS worker / subprocess | analyzed, not built | n/a — see §6 |

Candidate 2 reused the engine's prebuilt v8 archive
(`RUSTY_V8_ARCHIVE=…/target/debug/gn_out/obj/librusty_v8.a`) so it did not rebuild
v8 from source. Candidate 3 (separate OS process per agent) was not prototyped:
its per-call cost is an IPC/serialization round-trip (microseconds–milliseconds,
1000×+ the in-process crossings measured here) and it is really the netcode model
(P4.0c), not an in-engine sandbox. It is the *fallback* only if same-process
isolation is ruled insufficient (e.g. a Spectre-class requirement — see §7).

---

## 3. Containment — proven, not asserted

Both candidates block every escape. The malicious skill's **own observed output**
is printed by the harness; the host survives each abort and keeps serving.

### Candidate 1 — QuickJS (`results/quickjs.txt`)

| Escape | Observed outcome | Verdict |
|---|---|---|
| 1. host globals | `{"Deno":"undefined","Deno_core_ops":"undefined","process":"undefined","require":"undefined","fetch":"undefined","ctor_escape":"global-has-no-host", …}` — global names are standard ECMAScript only | **contained**: no host handle exists in the context |
| 2. ungranted cap | host returns `{"denied":true,"reason":"missing capability grant: ops.rawExec"}`; impulses 0→0; denials=1 | **blocked at boundary**, no side effect |
| 3. read other agent | `{"denied":true,"reason":"missing capability grant: agent.readOtherState"}`; secret `(-1,-2,-3)` not leaked | **blocked** |
| 4. infinite loop | halted after ~150 ms by the interrupt/deadline handler → `Error: interrupted`; `getSelfPosition` still works afterward | **bounded; host alive** |
| 5. memory bomb | `Error: out of memory` at a 4 MB `set_memory_limit`; fresh `1+1` still evaluates | **bounded; host alive** (catchable!) |
| 6. crashes | stack overflow → `Maximum call stack size exceeded`; throw → caught; host still serves | **isolated** |

Containment mechanism: a fresh QuickJS context exposes **only** standard
ECMAScript globals. There is no ambient `Deno`, no op table, no fs/net. The host
injects exactly one object, `host.invoke`, and nothing else is reachable — even an
`eval`/`Function`-constructor escape only reaches the QuickJS global, which has no
host capabilities. ECS arrays / `WorldContext` are never passed in, so they cannot
be touched.

### Candidate 2 — separate V8 isolate (`results/v8.txt`)

| Escape | Observed outcome | Verdict |
|---|---|---|
| 1. privileged ops | isolate op-table probe: `{"op_read_asset":false,"op_http_post":false,"op_write_trace":false,"op_cap_invoke":true,"privileged_ops_visible":""}` | **contained**: the engine's privileged ops are absent from this isolate |
| 2. ungranted cap | `{"denied":true,"reason":"missing capability grant: ops.rawExec"}`; impulses 0→0; denials=1 | **blocked at boundary** |
| 3. read other agent | denied; secret not leaked (it lives in a different isolate's heap anyway) | **blocked** |
| 4. infinite loop | terminated after ~150 ms by a **cross-thread watchdog** (`IsolateHandle::terminate_execution`) → `Uncaught Error: execution terminated`; isolate alive afterward | **bounded; host alive** — but needs a watchdog thread |
| 5. memory bomb | child isolate with a 24 MB heap cap: V8 `Reached heap limit`, child **killed (SIGTRAP)**; parent survives | **bounded, BUT in-process OOM is process-fatal** |
| 6. crashes | covered by the termination/exception paths (4) | isolated |

Containment mechanism: the untrusted skill runs in a **distinct V8 isolate** whose
op table contains only the narrow capability op (`op_cap_invoke`) — the engine's
privileged ops are simply not registered there, and a separate isolate shares no
heap/globals with the privileged one. NOTE: `Deno.core` itself still exists on the
isolate (deno_core always installs it, plus its built-in core ops); a production
embedder would also scrub `Deno` from the untrusted global. The spike deliberately
leaves it reachable to **prove** the privileged limina ops are nonetheless absent.

**Key operational gap (proven):** with a heap limit and no callback, a V8 OOM
**aborts the hosting process** (`Fatal JavaScript out of memory`). Surviving OOM
in-process requires `add_near_heap_limit_callback` + `terminate_execution`, and
that path proved **fragile** in this spike — terminating from inside the callback
aborted V8 with `Cannot create a handle without a HandleScope`. We also observed
that **dropping many simultaneously-live isolates** aborts the same way (V8
isolate-enter invariant), so a long-lived "pool of N untrusted isolates" needs
careful lifecycle management. QuickJS has neither problem: its OOM is a catchable
JS exception and the context keeps serving.

---

## 4. Overhead — measured

Per-call = a granted capability round-trip
(`host.invoke("ecs.getSelfPosition","{}")`, a string-in/string-out crossing),
measured over 200k iterations and corrected by an in-sandbox no-op baseline of the
same call shape. 3 samples each; machine under concurrent load (±~15%).

| Measurement | QuickJS (release) | Separate V8 isolate (release) | In-isolate engine op (debug) |
|---|---:|---:|---:|
| in-sandbox JS call, no crossing | ~53 ns (interpreter) | ~5 ns (JIT) | — |
| **host-boundary crossing / call** | **~372–419 ns** | **~328–351 ns** | — |
| total per granted capability call | ~430–480 ns | ~360 ns | — |
| throughput | ~2.1 M calls/s | ~2.8 M calls/s | — |
| `op_sum` (numeric fast-API op) | — | — | ~49–52 ns/call |

Reading these:

- **Per-call cost is essentially a wash between the two sandboxes** (~390 ns vs
  ~340 ns). The crossing is dominated by **two-string marshaling + the
  registry lookup + JSON result**, not by the engine. Choosing QuickJS costs
  almost nothing per call.
- The `op_sum` floor (~50 ns, debug) is a numeric fast-API op with no string
  marshaling; it is the no-sandbox dispatch floor. A release engine would be
  lower. The realistic in-isolate cost of a *string-marshaled* capability call is
  the V8-candidate's own number (~340 ns) — i.e. **a separate V8 isolate adds ~0
  per-call tax over calling the same op in the main isolate.** The "sandbox tax"
  is in startup/memory, not per-call.
- **Implication for many concurrent agents:** agents act off the frame loop at
  most a handful of capability calls per decision. At ~390 ns/crossing, even
  thousands of agents issuing tens of calls/tick add well under a millisecond of
  aggregate boundary cost per tick. **Per-call overhead does not constrain agent
  count for either candidate.** Density does (next section).

---

## 5. Density — the deciding axis

| Measurement | QuickJS | Separate V8 isolate | Ratio |
|---|---:|---:|---:|
| fresh-sandbox **startup** | **~190 µs** | ~6.1 ms | **~32× faster** |
| **memory** per sandbox | **~108 KB** | ~2.6 MB | **~24× lighter** |
| sandboxes creatable / sec / thread | ~5,000 | ~160 | ~31× |
| sandboxes per 1 GB (sandbox memory only) | **~9,500** | ~390 | ~24× |
| CPU-budget enforcement | in-thread interrupt callback (no extra thread) | cross-thread watchdog per isolate (`terminate_execution`) | QuickJS simpler |
| memory-budget enforcement | `set_memory_limit` → catchable OOM, host survives | heap cap → **process-fatal** OOM in-process (fragile callback to survive) | QuickJS safer |
| minimal capability surface | empty global; inject only `host.invoke` | `Deno.core` + built-in core ops present; must scrub `Deno` | QuickJS cleaner |

For a platform hosting **many concurrent agents** (P4-B/P4-C), QuickJS is decisive:
1000 untrusted agents ≈ **~108 MB** of QuickJS contexts vs **~2.6 GB** of V8
isolates, with 32× cheaper spin-up (agents can be created/torn down per session
cheaply) and **resource budgets (M7) that are first-class, in-thread knobs**
(interrupt deadline = per-decision CPU budget; memory limit = per-agent memory
budget) instead of per-isolate watchdog threads and process-fatal OOM.

---

## 6. Recommendation

**Adopt QuickJS (`rquickjs`) as the untrusted skill/agent sandbox for M6.** Keep
the engine's main/render isolate as deno_core V8 (JIT for Three.js per-frame
work). Untrusted agents/skills each get a QuickJS context exposing only an
injected, serializable capability surface that funnels every mutating call through
the existing `SkillRegistry.invoke` boundary.

Rationale, grounded in the measurements above:
- **Containment is equivalent** (both block all six escapes), so containment does
  not pick a winner.
- **Per-call overhead is equivalent** (~340–390 ns), so latency does not pick a
  winner.
- **Density and resource-bounding pick QuickJS decisively**: ~24× lighter, ~32×
  faster to start, catchable OOM (host survives), in-thread CPU/memory budgets,
  and the cleanest possible capability surface (an empty global, exactly matching
  the decision record's "reduce the allowed API surface to a serializable
  capability set"). V8-isolate-per-agent additionally carries process-fatal
  in-process OOM and multi-isolate lifecycle fragility (both observed here).
- The constraint is honored: untrusted code never needs JIT (it's off the render
  path); the JIT-class main isolate is untouched.

Reject **separate-V8-isolate-per-agent** as the primary mechanism (heavy, OOM-
fatal in-process). Reject **subprocess/worker-per-agent** as the primary mechanism
(IPC per call is ~1000× the in-process crossing). Hold subprocess/VM isolation in
reserve **only** if a side-channel (Spectre-class) threat enters scope (§7).

### Integration sketch for M6 (not built here)

A new out-of-engine-core host module, `SandboxedSkillHost`:
- **One QuickJS `Runtime` + `Context` per untrusted agent/skill**, configured with
  `set_memory_limit` (per-agent memory budget), `set_interrupt_handler` with a
  per-decision deadline (CPU budget), and `set_max_stack_size`.
- Inject a single `host.invoke(cap, argsJson)` whose Rust closure calls into the
  **existing** `SkillRegistry.invoke`, carrying the agent's engine-bound
  `{ agentId, sessionId, permissions }` (never caller-supplied — same rule as the
  MCP path today). Capabilities and results cross as **serialized JSON**: a
  feature for governance (auditable, schema-checkable), not just a convenience.
- The untrusted context **never** receives `Deno.core.ops`, ECS TypedArrays, or
  `WorldContext` handles — only `host.invoke`. This is the M6 acceptance: a
  malicious skill cannot touch the privileged isolate's globals/ops; every
  mutating call crosses the registry boundary; the crossing emits a `LiminaTracer`
  event (reuse `invoke`'s existing `emit`) for the M8 audit trail.
- Decisions stay async/off the frame loop (today's `actionSystem` model); the
  ~390 ns crossing + the skill's own interpreter-speed logic are negligible at
  agent cadence, and rendering keeps full V8 JIT on the main isolate.
- **M7 maps cleanly:** quotas/budgets/revocation become the QuickJS knobs above
  plus the grant-set passed to `invoke`; a revoked capability simply leaves the
  grant set → the next crossing is a real, audited denial (exactly the spike's
  ESCAPE 2 path).

---

## 7. Honest caveats / non-claims

- **QuickJS is interpreter-speed (no JIT).** Fine for agent decision logic
  (control flow, tool selection); untrusted code must never be on the render/
  numeric hot path (it isn't — that's the main isolate). This is a feature given
  the constraint, not a regression.
- **Same-process isolation does not defend against speculative side-channels
  (Spectre-class).** Neither QuickJS nor a same-process V8 isolate does. If that
  threat is in scope, the answer is process- or VM-level isolation (the held-in-
  reserve subprocess option), at its IPC cost. Out of scope for M6's stated threat
  model ("reach engine internals/ops beyond its grant").
- **New build dependency:** `rquickjs` bundles the quickjs-ng C source (builds
  offline once fetched; compiled cleanly here in ~12 s). Acceptable and small.
- **Marshaling is JSON strings in this spike.** A production bridge could use a
  faster typed value path, but JSON keeps the capability surface serializable and
  auditable; the ~390 ns measured already includes it.
- **The engine baseline (`op_sum` ~50 ns) is a debug build**, hence an upper bound
  on in-isolate dispatch; it is not the bottleneck in any case.
- This spike does **not** implement M6/M7/M8 and is **not** wired into engine
  core. It is a prototype + this report.

---

## 8. Reproduce

```bash
cd spikes/isolation

# Candidate 1 — QuickJS (no v8 needed):
cargo run --release -p quickjs-candidate

# Candidate 2 — separate V8 isolate (reuse the engine's prebuilt v8 archive):
RUSTY_V8_ARCHIVE="$(cd ../.. && pwd)/target/debug/gn_out/obj/librusty_v8.a" \
  cargo run --release -p v8-candidate

# In-isolate baseline — the existing engine binary, read-only:
cd ../.. && ./target/debug/limina spikes/isolation/baseline.ts
```

Layout: `model/` (shared capability boundary + malicious-skill probes),
`quickjs/` (candidate 1), `v8/` (candidate 2), `baseline.ts` (in-isolate
baseline), `results/` (captured runs).
