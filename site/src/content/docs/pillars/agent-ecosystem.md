---
title: "Agent Ecosystem"
description: "AgentComponent, the perception/decision/action systems, and the scheduler that runs them at scale."
---

Limina runs two kinds of LLM agents as first-class citizens of the same ECS world: external **Agent Builders** that construct scenes over MCP, and in-world **Agent Players** that perceive, decide, and act autonomously on the fixed-timestep loop. Both share the same safety, observability, and skill infrastructure — a builder can even create or modify player agents. This page covers the in-engine machinery; for hands-on guides see [Building agents → Builders](/building-agents/builders) and [→ Players](/building-agents/players).

## The agent record

An agent is a JS-side record (strings and LLM config aren't SoA-friendly); a player optionally inhabits an `ent_` entity in the world:

```ts
interface AgentRecord {
  id: string;                  // agt_
  type: "builder" | "player";
  entityId?: string;           // the ent_ a player inhabits
  perceptionRadius: number;    // default 15
  decisionIntervalTicks: number; // default 30
  profile: string;             // permission profile name
  sessionId: string;
  llm: { provider: string; model: string; systemPrompt: string };
  // runtime state
  perception?: Perception;
  inFlight: boolean;           // a decision is currently running off-loop
  lastDecisionTick: number;
  queue: QueuedAction[];       // validated tool calls awaiting execution
}
```

The decision provider is named, not hard-wired (`llm.provider`) — Scripted for tests, Ollama for local, a gateway for cloud. The engine owns the *world* and the *perception*; the *brain* (the provider) is pluggable. See [LLM providers](/building-agents/llm-providers).

## The four systems

The agent systems run under the fixed-timestep scheduler. Perception and Action are on-frame and deterministic; Decision fires the slow, async provider **off** the frame path and only enqueues results when it resolves.

```text
PerceptionSystem ──▶ DecisionSystem ──▶ action queue ──▶ ActionSystem ──▶ world state
   (on-frame)        (off-loop, async)    (validated)     (on-frame)          │
        ▲                                              registry.invoke        │
        │                                                                     ▼
        └───────────────── ObservabilitySystem ◀──(traces every step)── ──────┘
```

- **PerceptionSystem** — populates each agent's `Perception` (self position, nearby entities, recent events) *only when a decision is due*, to avoid an O(agents × entities) pass every tick. At scale it serves every due agent's spatial query with a single native batched grid build + radius query (the `op_ecs_spatial_query_batch` op), byte-identical to the per-agent JS oracle.

  ```ts
  interface Perception {
    selfId: string;
    selfEntity?: string;
    position?: [number, number, number];
    nearby: { id: string; position: [number, number, number]; distance: number }[];
    recentEvents: { type: string }[];
    tick: number;
  }
  ```

- **DecisionSystem** — for a due agent, calls the provider's `decide()` **asynchronously, off the frame loop**, then validates each returned tool call against its skill schema before enqueuing it. A malformed or hallucinated call is rejected (`agent.toolcall.rejected`) and never executed. Only one decision is in flight per agent at a time; a slow model never drops a frame.

- **ActionSystem** — drains validated actions from the queue and routes them through `registry.invoke()`, so a player's action gets the exact same permission/policy/trace path as a builder's MCP call. Each queued action carries the `decisionId` that produced it, preserving the perception → decision → action causal chain.

- **ObservabilitySystem** — listens to the relevant events and maintains the traces (see [Observability](/pillars/observability)).

## Off-loop decisions via the action queue

The key to running LLM agents in a real-time loop is the seam between *thinking* and *acting*. Thinking is slow and async; acting must be deterministic and on-frame. The action queue is that seam:

1. A decision is due (`tick - lastDecisionTick >= decisionIntervalTicks`).
2. The provider is invoked off-loop; the agent is marked `inFlight`.
3. When it resolves, the candidate tool calls are schema-validated and pushed onto `queue`.
4. The ActionSystem drains them on subsequent ticks through the registry.

Because step 2 never blocks the loop, the fixed-step rate holds (~60 steps/s) even while a slow local model is mid-thought.

## The scheduler: budgets and density

The `AgentScheduler` enforces fairness and a frame budget so many agents share one loop without any single agent starving the others. Budgets exist at two levels:

```ts
interface AgentBudget {
  weight: number;
  maxQueueDepth: number;
  maxToolCallsPerDecision: number;
  maxActionsPerTick: number;
  decisionTimeoutMs: number;
}

interface SchedulerBudget {
  maxDecisionStartsPerTick: number;
  maxGlobalActionsPerTick: number;
  defaultAgentBudget: AgentBudget;
  agents?: Record<string, Partial<AgentBudget>>;  // per-agent overrides
}
```

The scheduler caps how many decisions start per tick and how many actions execute globally per tick, tracks a per-agent deficit for weighted-fair ordering, and bounds each agent's queue depth, tool calls per decision, and decision timeout. A decision that overruns `decisionTimeoutMs` is timed out by generation, so a stuck provider can't hold a slot forever.

This is what makes density possible. The Phase 3 capstone runs **200 agents + 256 dynamic physics bodies + 2000 entities at sim-step p95 4 ms** (≤ 8 ms budget) over ≥300 ticks at 60 steps/s — every agent fully perceiving, deciding, and acting, every action traced. The `numbers_party` demo puts ~200 instanced "number-people" through exactly this pipeline live.

## Builders vs. players

| | Agent Builder | Agent Player |
|---|---|---|
| location | external, over MCP | in-world, inhabits an entity |
| typical profile | `builder.readWrite` | `player.limited` / `social.actor` |
| driven by | external agent's own loop | engine DecisionSystem |
| decision trigger | the builder sends `callTool` | due by `decisionIntervalTicks` |
| transport | stdio / WebSocket MCP | in-process `callToolInternal` |

Both flow through the same skill registry, the same permission model, and the same trace. The difference is only *who drives the loop* — the safety and observability are identical, by design.
