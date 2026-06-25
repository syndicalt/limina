# P4.0c Netcode Spike -- Report & Recommendation

**De-risking spike for Phase 4a milestone M4 -- "authoritative server + state
sync" -- and the recorded bet *"Netcode model: authoritative server with client
prediction/reconciliation vs lockstep; how fixed-step determinism and agent
decisions map onto state sync."*** Validates the netcode model before interest
management (M5) and scale build on it.

> Status: **resolved**. Two REAL OS processes over a REAL localhost socket: an
> authoritative server that owns a fixed-step world + world log and accepts
> client INTENTS, and a client that submits intents and applies authoritative
> state deltas. Intent->applied->synced round-trip measured over **2000**
> round-trips. Server **authority enforced** -- a client's direct state write and
> an ungranted intent are both **rejected** (printed, not asserted). The model's
> latency is additionally **grounded in the engine's real transport**: the
> unmodified `limina --mcp-ws` binary, driven read-only over a real WebSocket,
> processes a real authoritative mutation (`tools/call` -> `SkillRegistry.invoke`)
> at **p95 0.39 ms**, and rejects a mutation from a read-only session at its real
> permission boundary. This is a SPIKE -- prototype + this report; **nothing is
> wired into engine core**.

**Recommendation: authoritative server + clients-as-views + state deltas (NOT
lockstep).** Fixed-step determinism is used for the *server's* replayable timeline
(the M1 world log) and for replay/recovery (M2/M3), **not** for client lockstep.
Client prediction/reconciliation is an optional per-client polish layer, deferred.

All numbers below are from `spikes/netcode/` (a detached cargo workspace) on the
project hardware (i7-12700H), localhost, **release** binaries. Captured runs:
`results/client.out` (model), `results/server.out` (server-side authority
rejections), `results/server_worldlog.jsonl` (recorded command stream),
`results/engineprobe.out` (real-engine baseline).

---

## 1. The decision: lockstep vs authoritative server

Two classic models, evaluated against limina's actual constraints (Phase 4 pillar
**P4-B**: "an authoritative server owns simulation and policy; clients receive
state sync and submit intent/tool calls rather than mutating world state
directly").

| | **Lockstep / shared command log** | **Authoritative server + state deltas** |
|---|---|---|
| Who simulates | every peer, in perfect deterministic lockstep | the server only; clients are views |
| On the wire | each peer's inputs, applied at an agreed future tick | clients send intents; server sends authoritative state deltas |
| Trust | every peer must be honest + identical build (a cheater/diverger desyncs all) | server is the single authority; clients cannot diverge the world |
| Heterogeneous clients | hard -- a human browser view, an external MCP agent, and the native engine must all run the same sim bit-identically | natural -- a client only needs to render deltas; agents only need perception + intent |
| Late join / AoI | a joiner must replay the whole command log; AoI is awkward (everyone needs all inputs) | a joiner gets a snapshot + deltas; AoI filters the delta stream per client (M5) |
| Fit to limina | the engine's mutation choke point is already server-side (`SkillRegistry.invoke`); the world log is already an authoritative command stream | **direct match**: the server *is* an M1 recorder fronted by a socket |

Lockstep is the wrong model here: limina's clients are deliberately heterogeneous
and partly **untrusted** (external MCP agents, P4-C governance), and the engine
already centralizes every mutation behind one authoritative boundary. **The
authoritative-server model is the one P4-B already describes** -- the spike's job
was to make it concrete, measure it, and prove the authority guarantee holds.

### How fixed-step determinism maps to sync

The M1 world log proved the sim is **bit-identical for identical, ordered inputs**.
The netcode model uses that as follows:

- **Intents are applied at tick boundaries, in one total order** (the spike queues
  an accepted intent and applies it on the next tick, then steps). That is exactly
  M1's contract: skill commands and `step`s interleave in one `seq` order. So the
  *authoritative timeline stays replay-complete* -- the server's stream is an M1
  log (it is literally written as one here: `results/server_worldlog.jsonl`), and
  M2/M3 (snapshot+recovery, durable sink) apply unchanged.
- **Clients do NOT run the sim**, so they need no determinism guarantee. They
  receive **state deltas** (the changed entities' authoritative transforms), not
  commands. Determinism is leveraged server-side (reproducibility, replay,
  recovery) -- never pushed onto clients as a lockstep requirement.
- **Agent decisions** already run async/off the frame loop and apply through
  `SkillRegistry.invoke` (M1 records them as `skill` commands). Over the network
  they become exactly the same thing: an *intent* message. An agent client and a
  human client submit the identical intent verb; the server is agnostic to who
  authored it (attribution is server-bound, see §4).

---

## 2. What was built (two real processes, real socket)

A detached workspace `spikes/netcode/` with four crates:

- **`common`** -- the on-wire contract (newline-delimited JSON over raw TCP, the
  same line-framed JSON discipline as the engine's MCP transport). Authority is
  encoded in the message set: `Intent` is the only mutation path; `StateWrite` (a
  direct authoritative write) has no apply path and is always rejected.
- **`server`** (`netcode-server`) -- the authoritative process: a fixed-step
  (60 Hz) deterministic world of N bodies + the world log. Per accepted intent it
  (a) permission-checks the skill against the client's grant set, (b) queues it,
  (c) applies it on the next tick in arrival order, (d) records it as an M1
  `skill` command at its landing tick, (e) broadcasts the resulting authoritative
  **delta** (only the entities that changed) tagged with the intent ids it carried.
- **`client`** (`netcode-client`) -- a separate process: runs a transport-ping
  probe, the authority probe, and the closed-loop latency benchmark.
- **`engineprobe`** (`netcode-engineprobe`) -- spawns the **unmodified
  `limina --mcp-ws` binary** as a separate OS process and drives it over a real
  `tokio-tungstenite` WebSocket, read-only, to ground the model's latency in the
  engine's actual transport + invoke pipeline and to show the engine's real
  permission boundary. Engine core is **not** modified.

Wire verbs and their engine equivalents:

| Spike message | Engine equivalent | Authoritative? |
|---|---|---|
| `Intent{skill,entity,arg}` | `tools/call` -> `SkillRegistry.invoke` (the mutation choke point) | yes, after permission check, applied at a tick |
| `StateWrite{entity,pos}` | *(none -- deliberately has no engine analog)* | **never** -- always rejected |
| `Snapshot` / `Delta` | state sync (M4) -- the piece the engine does not yet have | read-only views |
| `Ping`/`Pong` | transport keepalive | n/a |

---

## 3. Measured latency

### 3a. The model -- intent -> applied -> synced (`results/client.out`)

Closed-loop: the client sends one intent, waits for the authoritative delta that
carries it (`caused_by` contains the intent id = applied on that tick and synced
back), then sends the next. **2000 round-trips**, 60 Hz server.

| Measurement | p50 | **p95** | p99 | max | mean |
|---|---:|---:|---:|---:|---:|
| **INTENT round-trip (applied+synced)** | 16.54 ms | **17.57 ms** | 17.68 ms | 22.27 ms | 16.67 ms |
| transport rtt only (`Ping`, no sim) | 0.018 ms | **0.054 ms** | 0.140 ms | 0.29 ms | 0.027 ms |

Reading these:

- **p95 17.6 ms is comfortably under the M4 target (p95 <= 50 ms localhost).**
- The round-trip is **almost entirely fixed-step quantization**: the socket itself
  is ~0.05 ms p95, so ~17.5 ms of the 17.6 ms is "wait for the next tick." At
  60 Hz the tick period is 16.67 ms.
- The closed-loop p50 sits near a *full* tick (not half) because the client
  re-sends immediately after receiving a delta -- i.e. just after a tick boundary
  -- so it waits nearly a whole tick for the next one. Open-loop / randomly-phased
  intents average ~half a tick (~8 ms). Either way the bound is the tick period,
  and transport is negligible.

### 3b. The engine baseline -- real `limina --mcp-ws` over a real WebSocket (`results/engineprobe.out`)

A separate process drives the **unmodified engine binary** over a real WebSocket:
`tools/call ecs.updateComponent` is a real authoritative mutation routed through
the full `SkillRegistry.invoke` pipeline (Zod validate -> permission -> handler ->
emit). **1000 round-trips.**

| Measurement | p50 | **p95** | p99 | max | mean |
|---|---:|---:|---:|---:|---:|
| **ENGINE intent round-trip (real WS + invoke)** | 0.154 ms | **0.39 ms** | 0.50 ms | 1.11 ms | 0.196 ms |

This is the key grounding result: **the engine processes a real intent end-to-end
in ~0.4 ms p95 over a real socket.** So the model's 17.6 ms is the *tick cadence*,
not the engine or the transport. Plugging the real engine sim behind the
authoritative-server socket model preserves the latency budget -- the dominant term
(tick quantization) is independent of how heavy the sim is, and the per-intent
processing cost (~0.4 ms) leaves large headroom under both the 50 ms localhost and
150 ms LAN targets (LAN adds the network RTT on top of the same tick term).

---

## 4. Authority -- proven, not asserted

Both the model and the real engine enforce authority; both *print* the rejection.

### 4a. The model server (`results/client.out` + `results/server.out`)

| Probe | Client-observed outcome | Server-printed line | Verdict |
|---|---|---|---|
| (a) **direct state write** `StateWrite{entity 0 -> [999,999,999]}` | `REJECTED: "authority: clients cannot write authoritative state directly; submit an intent"`; follow-up snapshot shows entity 0 still at `[0,0,0]`, `teleported=false` | `[server] REJECT state_write ... client attempted to set entity 0 ... directly -- authority denied` | **contained**: no apply path exists; write had zero effect |
| (b) **ungranted intent** `Intent{skill="teleport"}` | `REJECTED: "missing capability grant: teleport"` | `[server] REJECT intent ... missing capability grant: teleport` | **blocked at the grant boundary** |
| (c) **granted intent** `Intent{skill="apply_impulse"}` | `APPLIED on tick N and synced` | *(accepted -> recorded in world log)* | **OK**: the legitimate path works |

The guarantee is structural: the server is the **only** writer of authoritative
state, and the *only* inbound message that reaches the world is an `Intent` that
first passes the grant check. A client cannot express "set state" in a way the
server will honor -- the `StateWrite` verb exists precisely to attempt the bypass,
and it is rejected every time.

### 4b. The real engine boundary (`results/engineprobe.out`)

Switching the same WebSocket session to the `system.readonly` profile and calling
a mutating skill exercises the engine's **real** permission check inside
`SkillRegistry.invoke`:

```
read-only `ecs.updateComponent` (needs ecs.modify) -> REJECTED: code=-32001 message="missing permission: ecs.modify"
builder    `ecs.updateComponent` (has  ecs.modify) -> APPLIED (control)
```

This confirms the model's grant-check is faithful to the engine: the engine
already rejects an unauthorized mutation at the same choke point the netcode model
funnels every intent through. **Attribution is server-bound** -- the engine binds
`agentId`/`sessionId`/`profile` at `initialize`, not from the tool call (`mcp.ts`),
so a client cannot spoof a higher-privileged identity per intent. M4's wire
protocol must keep this rule.

### World log recorded

Each accepted intent is appended to `results/server_worldlog.jsonl` as an M1
`skill` command at its landing tick (meta + seed header first):

```
{"kind":"meta","logVersion":1,"sessionId":"netcode-server",...}
{"kind":"seed","seed":12345,"seq":0}
{"kind":"skill","seq":1,"tick":6,"tool":"physics.applyImpulse","input":{"entity":"ent_0","impulse":[0,5,0]},"actorId":"127.0.0.1:NNNNN","sessionId":"netcode","perms":["physics.write"]}
...  (2001 skill commands for the 2000+1 accepted intents)
```

The authoritative server is, by construction, an M1 `WorldRecorder` behind a
socket -- so M2/M3 (snapshot, recovery, durable sink) compose with M4 unchanged.

---

## 5. Recommendation for M4 / M5

**Adopt the authoritative-server + clients-as-views + state-delta model.** Concretely:

1. **Server owns sim + world log; clients submit intents, receive deltas.** The
   intent verb is `tools/call` -> `SkillRegistry.invoke` (today's mutation choke
   point); the new pieces M4 must add are (a) **per-client fan-out** (the existing
   `limina --mcp-ws` serves one client at a time -- see §6), (b) a **delta/snapshot
   sync channel** (a `state/snapshot` read + a pushed `state/delta`), and (c) a
   **broadcast** of authoritative deltas after each tick. The spike's `server`
   shows all three (broadcast channel, per-client task, change-set deltas).
2. **Apply intents at tick boundaries, in one total order.** This keeps the
   authoritative timeline an M1 log (replay/recovery intact). Do **not** apply
   sub-tick out of order to shave latency -- it would break determinism for
   marginal gain (transport is already ~0.05 ms; the tick is the cost).
3. **Deltas carry only changed state (O(relevant)).** The spike already does this:
   with 1 of 8 entities perturbed, the landing delta carried **at most 1 changed
   entity per tick**; the 7 quiescent entities never appeared in the stream. This
   is the exact shape **M5** (interest management) extends: the server holds
   authoritative positions, so it filters each client's delta stream by that
   client's area-of-interest. AoI = a per-client subscription/cull on top of the
   already change-set-shaped delta; bandwidth then scales with AoI, not world size
   (M5's acceptance).
4. **Defer client prediction/reconciliation.** For agent clients (decisions off
   the frame loop) it is unnecessary. For interactive human clients, ~1 tick of
   input latency (p95 17.6 ms here) is within feel for most actions; add
   client-side prediction + server reconciliation later as a polish layer for the
   most latency-sensitive interactions, *on top of* the authoritative protocol --
   never as a substitute for server authority.
5. **Keep authority structural.** The wire surface exposes only intent submission
   + reads. There is no "set state" verb. Permission is checked at
   `SkillRegistry.invoke` (proven real, §4b); attribution is bound at session
   admission, never from the per-call payload. P4-C policy slots in at this same
   boundary later.

**Latency budget:** localhost p95 17.6 ms (tick-dominated) vs M4's 50 ms target --
~32 ms of headroom, all of it available to LAN RTT (M4's LAN target is 150 ms).
Lowering the tick period is the only lever that materially moves p95, and trades
against CPU; 60 Hz is comfortable.

---

## 6. Honest caveats / non-claims

- **The existing `limina --mcp-ws` is single-client + no broadcast** (Phase 2:
  "one client at a time; concurrent multi-client fan-out is Phase 3/4"; no delta
  sync). M4 must add per-client fan-out + a state-sync channel + broadcast in
  engine core. The spike demonstrates those pieces in `server`, but **does not**
  add them to the engine (out of scope -- "do not modify engine-core"). This is
  also why the engine baseline runs its authority demo by re-`initialize`-ing one
  connection rather than opening a second.
- **The model's world is a stand-in** for the engine's native sim (the spike may
  not modify engine-core). The engine baseline (§3b) proves the *real* invoke +
  transport path is ~0.4 ms, and the latency is tick-dominated regardless of sim
  weight, so the budget transfers when the real sim sits behind the same socket
  model. The spike does not re-prove M1 determinism (already proven:
  `js/test/p4_worldlog_replay.ts`).
- **Closed-loop measurement** reports p95 ≈ one full tick because the client
  re-sends in phase with the tick boundary. Open-loop/random-phase traffic
  averages ~half a tick. Both are bounded by the tick period; neither is
  transport-bound.
- **Localhost only.** LAN adds the physical RTT on top of the tick term; M4's LAN
  target (150 ms) leaves ample room. Not measured here (no second host).
- **Raw TCP + JSON** in the model (vs the engine's WebSocket+JSON-RPC). The wire
  framing is not the decision under test -- the model is. The engine baseline uses
  the real WebSocket+JSON-RPC transport, so the transport cost is measured on the
  real path too.
- This spike does **not** implement M4/M5 and is **not** wired into engine core.
  It is a prototype + this report.

---

## 7. Reproduce

```bash
cd spikes/netcode
./run.sh                 # 2000 model round-trips + 1000 engine round-trips
./run.sh 5000 2000       # more round-trips

# or by hand:
cargo build --release
./target/release/netcode-server --port 0 --addr-file results/server.addr \
  --log results/server_worldlog.jsonl --entities 8 &
./target/release/netcode-client --addr "$(cat results/server.addr)" --rounds 2000

# engine baseline -- the unmodified binary, read-only (build it first at repo root):
./target/release/netcode-engineprobe \
  --limina ../../target/debug/limina --cwd ../.. --rounds 1000
```

Layout: `common/` (wire contract), `server/` (authoritative server), `client/`
(authority probe + latency benchmark), `engineprobe/` (real-engine WS baseline),
`run.sh` (orchestrator), `results/` (captured runs).
