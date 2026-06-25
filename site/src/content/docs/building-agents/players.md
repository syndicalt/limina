---
title: "Building Agent Players"
description: "Spawn an in-world autonomous agent that perceives, decides, and acts on the fixed loop."
---

An **Agent Player** lives inside the world. Unlike a [builder](/building-agents/builders), which drives the engine from outside over MCP, a player inhabits an entity and is driven *by* the engine: the scheduler runs its perceive → decide → act loop every few ticks, off the frame path, and routes its chosen actions through the same permission-checked, traced skill pipeline. You give it a body, a permission profile, and an [LLM provider](/building-agents/llm-providers); the engine does the rest.

## Register an agent

A player is an `AgentRecord` added to the `AgentRegistry`. The minimum is an id, a body to inhabit, a profile, a session, and an LLM config naming a provider:

```ts
const agents = new AgentRegistry();

agents.add({
  id: "agt_player",
  type: "player",
  entityId: player,                 // the ent_ this agent inhabits
  perceptionRadius: 100,            // how far it can see (default 15)
  decisionIntervalTicks: 20,        // decide every 20 ticks (default 30)
  profile: "player.limited",        // its permission grants
  sessionId: "ses_player",
  llm: { provider: "scripted", model: "", systemPrompt: "pursue the nearest entity" },
});
```

`perceptionRadius` and `decisionIntervalTicks` tune how much the agent sees and how often it thinks — the levers that, together with the [scheduler](/pillars/agent-ecosystem) budgets, let many players share one loop.

## The perceive → decide → act loop

The engine runs three systems for the agent each frame; decisions go off-loop so a slow model never drops a frame.

```text
 perceive  ──▶  decide  ──(validated tool calls)──▶  action queue  ──▶  act
 nearby         provider.decide()                                       registry.invoke()
 entities       (async · off the frame loop)
 + events
```

1. **Perceive.** When a decision is due, the PerceptionSystem fills the agent's `Perception` — its self position, the `nearby` entities within `perceptionRadius` (served by the native batched spatial query), and recent events. See [Perception](/concepts/perception).
2. **Decide.** The DecisionSystem calls `provider.decide({ systemPrompt, perception, tools, previousResults })` asynchronously. Every returned tool call is validated against its skill schema before it is queued — a malformed or hallucinated call is rejected (`agent.toolcall.rejected`) and never runs.
3. **Act.** The ActionSystem drains validated calls through `registry.invoke()`, so a player's action gets the exact same permission/policy/trace path as a builder's MCP call, tagged with the `decisionId` that produced it.

## Attaching an LLM provider

The provider is a swap, not a rewrite — the agent names it; you supply the implementation in a `ProviderMap`. The deterministic `ScriptedProvider` is the test path and the demo baseline:

```ts
const scripted = new ScriptedProvider((req: DecideRequest): MCPRequest[] => {
  const target = req.perception.nearby[0];
  if (!target || !req.perception.position || !req.perception.selfEntity) return [];
  const s = req.perception.position;
  const d = [target.position[0] - s[0], 0, target.position[2] - s[2]];
  const len = Math.hypot(d[0], d[1], d[2]) || 1;
  return [{
    tool: "physics.applyImpulse",
    input: { entity: req.perception.selfEntity, impulse: [d[0] / len * 1.2, 0, d[2] / len * 1.2] },
  }];
});
const providers: ProviderMap = { scripted };
```

Swap `scripted` for an `OllamaProvider` (local) or a gateway (cloud) and the loop is unchanged — same perception in, same validated tool calls out. See [LLM providers](/building-agents/llm-providers) for the full seam.

## Acting through skills

A player acts only through the skill surface — it has exactly the capabilities its profile grants. Common player actions:

| skill | profile that grants it | what it does |
|---|---|---|
| `physics.applyImpulse` | `player.limited` (`physics.write`) | push the agent's dynamic body — locomotion via physics |
| `social.approach` | `social.actor` (`social.act`) | walk toward an agent, entity, or world point |
| `social.say` | `social.actor` (`social.act`) | speak a line — emits `social.said` and shows a real speech bubble above the speaker |

Speaker identity for social skills is **host-bound to `ctx.agentId`** — a payload cannot spoof who is talking. Note that `social.act` is *not* in `player.limited`; a conversational agent runs under `social.actor`, while a purely physical pursuer runs under `player.limited` (and a `social.*` call from it is denied with zero effect).

## Two reference demos

**`player.ts`** (windowed) — an autonomous player runs perception → decision → action in the fixed loop, pursuing the nearest target via physics impulses, with a `ScriptedProvider`. Decisions are off-loop, so frame rate is unaffected.

```bash
./target/release/limina --window --frames 600 js/src/demos/player.ts
```

**`forest_conversation.ts`** (windowed) — an agent-controlled humanoid walks up to two NPCs and holds a real, non-deterministic conversation driven by a local Ollama model (`qwen2.5:7b`), rendered as real speech bubbles, with a live agent-ops HUD. Nothing is canned: run it twice and the dialogue differs. If Ollama is unreachable it shows an honest "LLM offline / waiting" and never fabricates a line. Decisions and LLM calls run off the frame loop, so render never blocks on the slow model.

```bash
./target/release/limina --window --frames 9000 js/src/demos/forest_conversation.ts
```

Both demos route every action through the same registry, permission model, and trace as an external builder — the only difference is that the engine, not an outside loop, drives the decision cadence.
