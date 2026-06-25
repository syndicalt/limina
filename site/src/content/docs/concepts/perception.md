---
title: "Perception"
description: "What a Limina agent perceives: a typed view of nearby entities, transforms, and recent events, built by a native batched CSR spatial query."
---

Perception is how an agent *sees* the world. In Limina it is a **typed, bounded snapshot** —
the entities near the agent, their positions and distances, and a tail of recent events —
assembled fresh when the agent is due to decide. It is the input to the
[decision step](/building-agents/players), and it is computed by a native, parallel spatial
query so it stays cheap even with hundreds of agents.

## What an agent perceives

An agent's perception is a small, well-typed envelope:

```ts
interface PerceivedEntity {
  id: string;                          // the ent_ id of a nearby entity
  position: [number, number, number];
  distance: number;                    // from the agent, sorted ascending
}

interface Perception {
  selfId: string;                      // the agent's own id
  selfEntity?: string;                 // the ent_ it inhabits, if any
  position?: [number, number, number]; // the agent's own world position
  nearby: PerceivedEntity[];           // entities within perceptionRadius
  recentEvents: { type: string }[];    // a tail of recent event types
  tick: number;                        // the tick this snapshot was built
}
```

So an agent sees, within a radius around itself: which entities are nearby, where they are,
how far away, and what has recently happened — nothing more. It is a **view**, not the whole
world: perception is bounded by the agent's `perceptionRadius` (default 15), which keeps both
the data and the cost local.

Perception is only rebuilt when the agent is actually due to decide (an agent decides every
`decisionIntervalTicks`, default 30), not every tick — building it for every agent every
tick would be `O(agents × entities)` of wasted work.

## The native batched CSR spatial query

The expensive part of perception is "find the entities near me." With many agents and many
entities, doing that per-agent in JS does not scale. Limina batches it into a single native
op in the [`limina-ecs`](/concepts/ecs-and-world) crate.

Each step where decisions are due, the perception system gathers every due agent's self
position, perception radius, and self `eid` into one packed query buffer, then calls a single
native op that runs a **rayon-parallel uniform-grid (CSR) radius query** over the ECS SoA
buffers and returns each agent's nearby list. The results are then assembled into the
`Perception` envelope above.

Two properties make this safe to depend on:

- **Bit-identical to the JS oracle.** The native op uses the **same f64 distance math and the
  same insertion-order tiebreak** as the JS spatial index, which remains the *determinism
  oracle*. The native path and the JS fallback path produce byte-identical perception, so the
  acceleration never changes behavior.
- **A clean fallback.** Agents with no resolvable self position — or every agent when no
  spatial index exists — fall back to the per-agent JS grid query. The envelope is assembled
  in one place so both paths match exactly.

Measured against the JS oracle, the native query is **4.5–5.4× faster** and stays **≤2 ms**.
Together with raising `MAX_ENTITIES` to 16384, this is what let the density capstone run
**200 agents perceiving against 2000 entities + 256 dynamic bodies at a sim-step p95 of
4 ms** (well under the 8 ms budget), over ≥300 ticks at 60 steps/s.

```text
due agents ─▶ pack [selfX, selfY, selfZ, radius, selfEid] × N
           ─▶ op_ecs_spatial_query_batch  (rayon, CSR uniform grid, ≤2 ms)
           ─▶ per-agent nearby lists  ─▶  assemble Perception envelopes
```

## The `agent.getPerception` skill

An agent reads its own current perception through a [skill](/skills), like everything else:

| Skill | Permission | Returns |
|-------|------------|---------|
| `agent.getPerception` | `agent.read` | The calling agent's current perception (nearby entities + recent events), or `null` if there is no lookup. |

Because it is a normal skill invocation, the read is typed and permission-gated. Perception
is wired into the [decision provider](/building-agents/llm-providers) as well: when a
decision fires, the agent's current `Perception` is handed to the provider alongside the
available tools — and that decision is traced as caused by the
`agent.perception.updated` event, preserving the **perception → decision → action** causal
chain in the [world log](/concepts/observability).

:::note[Perception feeds the brain; it is not the brain]
Limina supplies perception and read access to the durable log. *Recall* — turning that into
memory — is part of the agent's pluggable brain, behind the provider. The engine is the
substrate, not the brain. See [LLM providers](/building-agents/llm-providers).
:::

## Related

- [The fixed-timestep loop](/concepts/loop) — perception runs on-frame; decisions run off it.
- [ECS & the world](/concepts/ecs-and-world) — the SoA buffers the spatial query reads.
- [Agent Players](/building-agents/players) — the full perceive → decide → act cycle.
