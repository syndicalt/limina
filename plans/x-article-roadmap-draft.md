# X article — draft (high-level roadmap)

> Draft for review. Not posted. Long-form X **article** (Version A, selected), extended with
> implementation detail and a fuller roadmap. Tone: plain and direct. Shipped things are stated
> as shipped; roadmap things are stated as roadmap. All numbers are from the repo.

---

**Title: Limina — the agent-native engine for the web**

Game engines were built for humans holding a mouse. Limina is built for a different author: an agent.

In Limina you don't build a world by clicking around an editor. You build it by calling skills — `scene.createEntity`, `physics.applyImpulse`, `audio.speak` — and an AI agent can call them just as easily as a person can. Each skill has a typed input, a permission check, and a recorded result. The engine runs the world; the agent decides what happens in it.

A human-first engine can't really add this later, because it changes what the engine *is*, not just what it can do.

## What's running today (0.1.0)

Limina is one native binary. A Rust host embeds V8 (through deno_core), renders with Three.js on WebGPU, runs native Rapier 0.33 for physics, and stores entities in bitECS. The whole thing ticks on a fixed 1/60-second step, which is what makes a session reproducible. The heavy parts live in their own Rust crates — rendering, physics, ECS, audio, and a sandbox — so the engine can do real work without stalling the frame.

A few pieces are worth calling out, because they're already built and verified, not planned:

**Skills are the whole API.** There are nine namespaces today — `scene`, `ecs`, `physics`, `three`, `agent`, `system`, `ui`, `social`, and `audio` — covering things like spawning and destroying entities, applying impulses, raycasting, setting PBR materials, loading glTF, drawing speech bubbles, playing positional sound, and walking up to someone to talk. Every call is validated against a schema, checked against the caller's permissions, run through before/after hooks, and recorded as an event. The events are hash-chained and linked to whatever caused them, so any action can be traced back to its origin.

**Agents connect from outside.** A scripted agent can run in-process, but external agents connect over MCP — JSON-RPC over stdio or a WebSocket. The loop is simple and the same for everyone: an agent reads its perception (the entities near it and the recent events it can see), asks for the list of available skills, and a model — a local Ollama instance or a gateway — picks one to call. The call goes through the same validated, permissioned path as everything else.

**The world is deterministic and recorded.** As a session runs, Limina writes a log: the random seed, the physics commands, and every skill call with the tick it happened on. Random numbers come from a seeded generator, not the system clock. Native Rapier produces the same result for the same inputs on the same build. Replay the log and you rebuild the exact same world — and crucially, replay re-runs the *recorded* skill calls, it never re-asks the model. There are snapshots too, so you can restore a world mid-stream instead of replaying from the start.

**It already scales and performs.** A density test runs 200 agents, 256 moving physics bodies, and 2,000 entities at a 95th-percentile simulation step of 4 ms (the budget was 8). The ECS can hold 16,384 entities, and its spatial queries run in a parallel Rust path that's 4.5–5.4× faster than the JavaScript version and byte-for-byte identical to it. Worlds can be shared across clients with an authoritative server at a p95 sync of about 11 ms. One optimization pass took a demo from 9.4 to 74 fps; a crowd flythrough with positional chatter runs at 102.

**Untrusted code is contained.** Third-party skill code runs in QuickJS sandboxes that expose nothing but standard JavaScript. A policy engine handles quotas, budgets, and revocation with an audit trail, and packages are versioned with a manifest, attestation, and content-hash provenance.

**It can talk and be heard.** Agents put text, speech, and thought bubbles in the scene, billboarded and styled, and audio runs on its own thread with a four-bus mixer and distance attenuation. Text-to-speech is fire-and-forget so it never freezes the frame. In one capstone, agents hold a real (non-scripted) Ollama conversation in speech bubbles and speak it aloud over an ambient bed.

## Author once, run anywhere

Because a world is fully described by its seed, its command log, and its snapshots, the log is effectively the project file — a readable stream of commands, not a multi-gigabyte native build. That has a practical payoff: putting a world in a browser tab, or on a phone, doesn't mean recompiling a native game. It means running the same log on that platform.

We checked this against the actual codebase. The parts that already port cleanly to a browser tab: the ECS, the skill layer, the world log and its replay, and the Three.js WebGPU renderer (which falls back to WebGL2 where WebGPU isn't ready). The parts that need a swap: the GPU surface, the physics (native Rapier becomes the WebAssembly build of Rapier), and the on-disk log (becomes IndexedDB). The one genuinely hard problem is making physics match exactly across the native and WebAssembly builds — and there's a snapshot-based fallback for when it doesn't. The browser runtime is on the roadmap, not finished, but whether it can work is no longer an open question.

## What's next

Roughly in priority order, and honest about what's built versus planned:

**Run anywhere, for real.** The browser/WebGPU runtime is specced but not yet built — it's the one Phase 4 milestone we deliberately left open. Finishing it is the next big step, and mobile rides the same runtime since iOS and Android already ship WebGPU.

**An editor you can watch.** Today the agent's reasoning is a JSONL trace. Next is rendering that trace — the perception, the decision, the action — as something you can actually look at, with inspector panels and a way for a person to review and approve agent edits in place. The trace and inspector skills it builds on already exist.

**A real ecosystem.** The hard mechanics already ship: versioned packages, signing, attestation, provenance. What's missing is the social half — a public registry and a contribution process so other people can publish skills.

**Longer agent turns.** Right now an agent picks one skill per decision. Next is streaming responses for long-running work and multi-step tool use within a single turn. The MCP contract was designed to allow this without breaking.

**Better memory, kept outside the engine.** Limina has no built-in memory and no "brain," on purpose. Richer recall — vector stores, logging bridges — plugs in behind a provider seam, never as something the engine itself depends on. The engine owns the world; it never owns the model.

**Generated worlds.** Further out: infinite, deterministic terrain and climate that an agent can sketch and a model fills in, streamed in off the frame loop as just another skill. It's gated behind a spike, because a learned generator has to prove its latency and its cross-device determinism before it earns a place.

We want Limina to be for the web what Unity and Unreal are for native — built around agents from the start, and cheap to ship anywhere because a world is just a log you can replay.

Build worlds by talking to an agent. Run them anywhere. That's Limina.

*(Engine is WebGPU, MIT/AGPL, performance-first, and deliberately not a "brain" — memory and intelligence stay external behind clean seams. The engine owns the world, never the model.)*

---

## Notes for the author (delete before posting)

- Every number here is copied from the repo: 200 agents @ p95 4 ms (budget 8), MAX_ENTITIES 16384, spatial op 4.5–5.4×, sync p95 ~11 ms, 9.4→74 fps, 102 fps crowd flythrough. Sources are in `plans/ROADMAP.md` and the phase plans. Don't round them up.
- Browser/mobile is stated as roadmap + feasibility-confirmed, never as shipped. The browser runtime is the open milestone M10.
- "WebGPU," not "WebGL" — the engine is on the modern API. "for the web" reads fine on its own if you'd rather not name the API in the hook.
- The Unity/Unreal line compares ambition, not a claim to replace them.
- This is long for a single X post — it reads as an X *article*. If you want a short teaser to point at it, say so and I'll cut one in the same voice.
