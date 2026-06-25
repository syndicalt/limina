# Limina — Phase 2 Plan: Open World

> **Status:** ✅ COMPLETE (2026-06-23) · M1–M8 implemented & verified. Interactive physics (sphere/capsule + static colliders, friction/restitution, pos+quat transform readback, real-manifold collision events carrying contact point + normal), uniform-grid spatial index, durable + crash-safe EventLoom trace sink + replay, **stdio and WebSocket** JSON-RPC MCP transports, bounded multi-turn orchestration, and a billiards demo. `cargo build` + `cargo clippy --workspace` clean; 25/25 headless tests + the WebSocket real-socket e2e green.
> **Parent roadmap:** `plans/ROADMAP.md`
> **Builds on:** `plans/limina-phase-1-agent-core/plan.md` (✅ complete)
> **Source spec:** `README.md` · **Principle:** performance-first (agent thinking stays off the frame loop)

Open the doors and deepen the world: let **real external LLM agents** connect over the wire,
give the world **interactive physics** (collisions worth reacting to), let agents reason in
**multiple turns**, and make traces **durable**. Phase 1 proved the loop in-process; Phase 2
makes limina something an outside agent can actually inhabit.

## Outcome

An external agent process (e.g. Claude or a local Ollama runner) speaks **MCP over a real
transport** to a running limina instance, discovers tools, and — across **multiple
plan→act→observe turns** with tool-result feedback — builds a scene and drives an in-world
player through a **physically interactive** world (balls roll and collide, bodies bounce off
static walls, collisions raise events agents can react to). Every action is permission-checked
and **persisted** to a durable EventLoom-shaped trace that can be **reloaded and replayed**.
The capstone is a **billiards** scene (today impossible — needs sphere colliders + rolling) and
an **external-agent session** end-to-end.

## Pillars

### P2-A — External MCP transport
Today MCP is in-process (`js/src/mcp/mcp.ts` over the registry). Phase 2 exposes the same
`initialize`/`listTools`/`callTool` surface over a **real transport** so external processes
connect. **stdio JSON-RPC 2.0 first** (the standard MCP transport; needs the `io-std`+`io-util`
`tokio` features added — current workspace has only `net` — but **no new crate**), **WebSocket
second** (remote/browser agents; adds `tokio-tungstenite`). A session handshake binds an external
agent to a permission profile before any `callTool`.

**Where it runs (load-bearing, per the Phase 1 event-loop lesson):** the transport primarily
targets a **headless "server" run mode** (no render loop → no contention). When an external agent
drives a *windowed* instance, transport I/O lives on a dedicated reader thread (or tokio task)
and inbound `callTool`s are **marshalled onto the agent/action queue** — executed off the frame
path, never inline in `render()`. This reuses the off-loop pattern that Phase 1 already relies on
(a slow agent never stalls the frame; cf. the player-demo pipeline-starvation fix).

### P2-B — Multi-turn agent orchestration
Phase 1 decisions are single-shot tool selection. Phase 2 adds a **bounded plan→act→observe
loop**: the provider proposes tool calls, the action system executes them, the **results +
fresh perception feed the next decision**, until the agent signals done or hits a **step/time/
token budget**. Stays async, off the frame loop; budgets keep it safe and fast.

### P2-C — Interactive physics world
Make the world worth acting in (and unblock billiards). Native Rapier already detects/resolves
collisions; Phase 2 exposes the missing pieces:
- **Sphere + capsule colliders** (today every dynamic body is a box — `crates/limina-physics` only has `op_physics_add_box`). Balls must be spheres to roll.
- **Transform readback with rotation** — `op_physics_body_pos` writes position only; add a `pos+quat` (7-float) readback so `renderSyncSystem` shows rolling/spin (it already reads a `Rotation` quaternion that nothing currently writes).
- **Static box colliders** (cushions/walls) — `op_physics_add_box` is dynamic-only; only `op_physics_add_ground` is static.
- **Material params** — friction/restitution on the add ops (rolling resistance + elastic bounce).
- **Collision events** — swap the `&()` event handler in `PhysicsWorld::step` for a Rapier `ChannelEventCollector`; drain `CollisionEvent::Started/Stopped` after each step; expose via an op + a skill + the observability bus so agents can subscribe.
- **Spatial index** — replace the O(agents×entities) perception scan (`js/src/agents/systems.ts:buildPerception`) with a uniform grid (or reuse Rapier's broad-phase BVH) for nearby-entity queries.

### P2-D — Durable observability
Phase 1's `LiminaTracer` is in-memory + JSON export. Phase 2 makes traces **durable**: stream
the EventLoom-shaped envelope to a per-session `.jsonl` on disk (segment/rotate to bound the
hot path), and add a **replay loader** that reconstructs the trace tree + verifies the sha256
chain from disk. Optional follow-on: a **Zaxy EventLoom bridge** via its append API.

## Hard-to-reverse decisions (lock before building)

| Decision | Choice | Why it's hard to reverse |
|---|---|---|
| MCP wire transport | **stdio JSON-RPC 2.0 first**, WebSocket second | External agents integrate against the on-wire contract; changing framing/handshake later breaks every client |
| Tool-call wire shape | Reuse Phase 1 `MCPRequest`/`MCPResponse` as JSON-RPC params/results | Same surface in-process and over-the-wire → no dual contract |
| Collision-event envelope | `{ a, b, phase: "started"\|"stopped", point?, normal? }` on the bus + `physics.collisionEvents` skill | Agents subscribe against this shape; it becomes part of the traced event vocabulary |
| Physics body descriptor | Extend `scene.createEntity` input: `collider: "box"\|"sphere"\|"capsule"`, `static: bool`, `friction?`, `restitution?` | Skill input schema is an ABI for every builder agent |
| Transform readback | `op_physics_body_transform(id, out[7])` = pos(3)+quat(4), zero-copy | Buffer layout is a contract with `renderSyncSystem` |
| Durable trace format | limina's **own** EventLoom-shaped `.jsonl` (already the in-memory shape), genesis `previousHash:null`, sha256 chain | Persistence + replay + any future Zaxy bridge read this format |
| Multi-turn driver | **Bounded** loop (step cap + time/token budget), off-loop | Budget semantics shape provider contracts and safety guarantees |
| Transport runtime placement | Headless **server mode** by default; windowed transport marshals inbound `callTool`s onto the action queue (off the frame path) | If wrong, external agents can stall render — reverses the Phase 1 off-loop guarantee that every demo depends on |

## Build sequence

Ordered so each milestone is demoable and de-risks the next. World-richness first (pure local,
high-confidence, unblocks billiards), then persistence, then the external surface, then multi-turn.

- [x] **M1 — Physics richness.** `op_physics_add_sphere`/`add_capsule`, `op_physics_add_static_box`, friction/restitution params, `op_physics_body_transform` (pos+quat); `renderSyncSystem` drives rotation; wire `scene.createEntity` collider/material options. *Accept: a sphere rolls and rests; a body bounces off a static wall; rotation is visible.*
- [x] **M2 — Collision events.** `ChannelEventCollector` in `step`, drain per step, `op_physics_drain_collisions` + `physics.collisionEvents` skill + `physics.collision` bus events. Records carry contact **point + normal** from the narrow-phase manifold. *Accept: two balls colliding emit a Started event with both body ids, traced.*
- [x] **M3 — Spatial index.** Uniform-grid nearby-entity query behind `buildPerception` + `scene.queryEntities`. *Accept: perception cost is O(neighbors), not O(all); results match brute force.*
- [x] **M4 — Durable trace sink + replay.** Stream EventLoom JSONL to disk (segmented), replay loader reconstructs tree + verifies chain. *Accept: a session persists; reload reconstructs the causal tree and the chain verifies.*
- [x] **M5 — stdio MCP transport.** JSON-RPC 2.0 server on stdio: `initialize` (profile handshake) → `listTools` → `callTool` → result/notification; maps to the existing registry. *Accept: an external process drives `scene.*` over stdio and sees permission denials.*
- [x] **M6 — Multi-turn orchestration.** Plan→act→observe loop with tool-result + perception feedback, step/time/token budget, off-loop. *Accept: an agent completes a 2+ step goal with each step traced as caused by the prior.*
- [x] **M7 — WebSocket transport.** Same JSON-RPC surface over WS (`tokio-tungstenite`) for remote agents, via `--mcp-ws [--port N]`; transport renamed to a wire-agnostic `JsonRpcTransport` (stdio alias kept). *Accept: an agent connects over WS from another process and runs the M5 flow.*
- [x] **M8 — Demos + acceptance.** Billiards demo (`js/src/demos/billiards.ts` + headless `billiards_physics` test); external-agent over stdio/WS; durable-trace + replay.

**Separable into 2a/2b (sequencing safety valve).** M1–M4 (interactive world + persistence) are
pure-local, high-confidence, and unblock the **billiards** demo on their own; M5–M8 (external
transport + multi-turn) are the outward-facing half. If Phase 2 runs long, ship **2a = M1–M4**
first (billiards + durable replay), then **2b = M5–M8** (external agents + multi-turn). They share
no hard-to-reverse contract that forces co-delivery — only the in-process MCP surface, which is
already done.

## Scope guards / non-goals (Phase 2)

Still **desktop-native, single instance** (no multiplayer/shared worlds — Phase 4). Still
**one V8 isolate** (no QuickJS per-agent sandboxes — Phase 3). Permissions stay **profile-based
allow-lists** (no dynamic policy engine — Phase 4). No new visual fidelity work (textured glTF,
shadows — Phase 3). Multi-turn is **bounded single-agent** orchestration, not multi-agent
negotiation. WebSocket transport is unauthenticated localhost-only in Phase 2 (auth → Phase 4).

## Open questions / decisions (recommended defaults)

1. **stdio vs WebSocket first?** — *Rec:* stdio (standard MCP, zero new deps, easiest to test with a local agent). WS follows in M7.
2. **Collision event delivery?** — *Rec:* drain into the observability bus + a pollable `physics.collisionEvents` skill (consistent with the off-loop agent model). Alt: synchronous JS callback (re-introduces frame-path work).
3. **Spatial index structure?** — *Rec:* uniform grid for perception (simple, cache-friendly, fast for roughly-uniform scenes). Alt: reuse Rapier broad-phase BVH (one structure, but couples perception to physics colliders).
4. **Persistence: own JSONL vs Zaxy bridge now?** — *Rec:* own segmented JSONL now (we already emit the shape); Zaxy bridge as an optional follow-on once the on-disk format is exercised.
5. **Multi-turn budget unit?** — *Rec:* step cap **and** wall-time budget (model-agnostic); token budget only when a provider reports usage. Alt: open-ended until "done" (unsafe/slow).
6. **External agent identity → profile?** — *Rec:* the `initialize` handshake names a profile from the static allow-list (builder/player); dynamic per-agent policy is Phase 4.

## Acceptance demos

- **Billiards** (now buildable): sphere balls roll, collide, and bounce off cushions with
  friction damping — the demo we explicitly could not build before M1–M2.
- **External agent session:** a separate process speaks MCP over stdio, lists tools, and across
  multiple turns builds a scene and drives a player using tool-result + perception feedback —
  fully permission-checked, traced, and persisted.
- **Replay:** reload a persisted session's JSONL, reconstruct the causal tree, and verify the
  integrity chain off disk.

## De-risking spikes (lead with these)

- **P2.0a** — stdio JSON-RPC round-trip: add `tokio` `io-std`+`io-util` features, then a tiny
  external script `initialize`s and `listTools` against the host before wiring the full registry
  surface (the external contract is the biggest new unknown).
- **P2.0b** — `ChannelEventCollector` integration: confirm draining `CollisionEvent`s after
  `step` on this rapier3d 0.33 build before designing the event op/skill.
