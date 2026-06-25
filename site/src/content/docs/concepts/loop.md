---
title: "The fixed-timestep loop"
description: "Limina's fixed-timestep accumulator at 60 steps/s, render interpolation, determinism and replay, and why agent decisions resolve off the loop."
---

Limina advances the world on a **fixed-timestep loop**. Logic always steps at a fixed `dt`,
decoupled from how often the screen is drawn. This is what makes the simulation deterministic
(and therefore replayable), keeps physics stable, and lets the renderer run as fast as it can
without changing the outcome.

## The accumulator

The Rust host drives the loop with a classic accumulator. Each frame it measures real
elapsed time, adds it to an accumulator, and runs the fixed-step callback as many whole steps
as have "fit" — then renders once with whatever fraction is left over:

```text
FIXED_DT            = 1.0 / 60.0     // 60 fixed steps per second
MAX_STEPS_PER_FRAME = 5              // clamp to avoid a death spiral

accumulator += min(realElapsed, 0.25)        // never integrate a huge stall
while accumulator >= FIXED_DT and sub < MAX_STEPS_PER_FRAME:
    step(FIXED_DT)                            // run the JS fixed-step callback
    accumulator -= FIXED_DT
alpha = accumulator / FIXED_DT                // leftover fraction in [0,1)
frame(alpha)                                  // run the JS render callback once
```

Two safety clamps matter:

- **`MAX_STEPS_PER_FRAME = 5`** caps how many logic steps a single frame may run. If the
  machine falls behind, the loop catches up by at most five steps per frame instead of
  spiraling.
- **`min(realElapsed, 0.25)`** clamps the per-frame delta, so a long stall (a breakpoint, a
  GC pause, a window drag) never injects a giant time jump into the simulation.

The result is exactly **60 logic steps per second**, regardless of render rate.

## Render interpolation

Rendering happens once per frame, and physics/logic almost never land exactly on a frame
boundary. The leftover accumulator fraction is passed to the render callback as
**`alpha` ∈ [0, 1)** — the interpolation factor between the previous and current fixed
states. Demos render with that `alpha` so motion looks smooth even when the display refresh
and the 60 Hz step rate disagree. Logic stays quantized to `FIXED_DT`; only the *picture*
interpolates.

In a demo this is just two callbacks registered with the host:

```ts
ops.op_set_fixed_step_callback((dt) => {
  ops.op_physics_step();      // advance native Rapier at the fixed dt
  // ...sync transforms into the ECS, run agent systems, etc.
});
ops.op_set_frame_callback((alpha) => {
  // render with interpolation factor `alpha`
});
```

## Determinism and replay

Because logic only ever advances in whole `FIXED_DT` increments, a run is a deterministic
sequence of steps. Limina leans on this hard:

- **Replay.** The durable [world log](/concepts/observability) records the ordered stream of
  events; replaying them reproduces the run. Phase 4 verified replay determinism and
  snapshot recovery for durable shared worlds.
- **Snapshot recovery.** The [`EntityTable`](/concepts/ecs-and-world) snapshots its identity
  state — live entries in creation order, the `ent_` allocation counter, and the table
  version — so a restored world issues the *same* next ids and the spatial index's version
  gate behaves exactly as in the original run.
- **Authoritative sync.** The multi-client server owns the fixed-step sim and the world log,
  applies client intents at tick boundaries in one total order, and fans out per-tick deltas
  (authoritative multi-client sync at a p95 of 11 ms).

Determinism is not a nice-to-have here; it is the property that makes the trace a *source of
truth* rather than a log of approximations.

## Why agent decisions resolve off the loop

An [Agent Player](/building-agents/players)'s decision is a (potentially slow, async) call
to a language model. Running that on the frame path would be fatal: a model that takes
hundreds of milliseconds would stall the accumulator and drop frames. So Limina splits the
agent cycle by latency:

- **Perception and action are on-frame and deterministic.** Each tick, perception is built
  (only when a decision is due) and any *already-validated* tool calls in an agent's queue
  are applied.
- **Decision is off-loop.** When a decision is due, the agent fires its provider
  asynchronously and is marked `inFlight`. The fixed step does **not** wait. When the
  provider resolves, its tool calls are validated and **enqueued** as `QueuedAction`s, each
  tagged with the decision id that produced it.
- **The queue is the bridge.** Those queued actions are drained and executed at a tick
  boundary, preserving the perception → decision → action causal chain in the trace.

```text
tick N      : perception built  ──▶  decision fires (async, off-loop) ──┐
tick N..N+k : loop keeps stepping at 60/s, frames keep rendering        │  model thinks
tick N+k    : provider resolves ──▶ validated tool calls enqueued  ◀────┘
tick N+k+1  : queued actions applied at the tick boundary (traced)
```

:::tip[A slow model never drops a frame]
This is the performance-first principle made concrete: agent *thinking* always runs off the
frame loop. A slow model adds latency to a decision — never a dropped frame. The loop runs at
60 steps/s whether the agent answers in 5 ms or 5 seconds.
:::

## Related

- [ECS & the world](/concepts/ecs-and-world) — the SoA state the loop reads and writes.
- [Perception](/concepts/perception) — how perception is batched on the steps where it runs.
- [Observability & the world log](/concepts/observability) — the ordered event stream that
  makes replay possible.
