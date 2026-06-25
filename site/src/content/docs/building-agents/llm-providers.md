---
title: "LLM Providers"
description: "One async provider seam — scripted, local Ollama, or a cloud gateway — behind the agent loop."
---

Limina is the substrate, not the brain. The engine owns the world, perception, the skill surface, and the durable log; the *decision* is pluggable. That seam is the **`LLMProvider`** — one small async interface with swappable backends. An agent names a provider in its config; you supply the implementation. Swapping a scripted policy for a local model for a cloud gateway is a config change, not a rewrite of the [player loop](/building-agents/players).

## The interface

A provider takes a decision request and returns *candidate* tool calls. It does not act — the [DecisionSystem](/pillars/agent-ecosystem) validates each candidate against its skill schema before anything is enqueued, so a malformed or hallucinated call is never executed.

```ts
interface DecideRequest {
  systemPrompt: string;
  perception: Perception;   // what the agent currently sees
  tools: MCPTool[];         // the discoverable skill surface, with JSON schemas
  previousResults: unknown[];
}

interface LLMProvider {
  readonly name: string;
  decide(req: DecideRequest): Promise<{
    toolCalls: MCPRequest[];
    usage?: { totalTokens?: number };
  }>;
}
```

Two design choices matter:

- **Single-shot tool selection.** `decide()` is one round trip: perception + tools in, candidate tool calls out. There is no in-provider multi-turn orchestration; the agent loop drives cadence via `decisionIntervalTicks`. (A separate bounded multi-turn path exists for agents that genuinely need several decisions before yielding.)
- **Thinking off the frame loop.** `decide()` returns a `Promise`. The DecisionSystem awaits it *off* the fixed-step path and only enqueues results when it resolves. A slow model never drops a frame — the loop holds ~60 steps/s while a call is in flight.

## ScriptedProvider — deterministic

The test path and demo baseline. A pure function of the request, so behavior is reproducible in CI:

```ts
export class ScriptedProvider implements LLMProvider {
  readonly name = "scripted";
  constructor(private readonly policy: (req: DecideRequest) => MCPRequest[]) {}
  decide(req: DecideRequest) {
    return Promise.resolve({ toolCalls: this.policy(req) });
  }
}
```

Because it is deterministic, it is what the headless suite uses to assert the perception → decision → action chain exactly — no model required.

## OllamaProvider — local

A real round trip to a local Ollama server (`http://localhost:11434/api/chat`) via `op_http_post`. It shapes the request for native tool-calling: each skill becomes a `function` tool (the skill name's dot is encoded as `__`, since function names must match `^[A-Za-z0-9_-]+$`, and decoded back on the way out), with `temperature: 0` for stable selection. The perception is sent as the user message; the model's `tool_calls` are parsed into `MCPRequest`s (with a fallback that reads a `{ name, arguments }` JSON object out of the message content, since smaller models sometimes emit the call as text).

Models used in the demos and tests:

- **`qwen2.5-coder:3b`** — fast local iteration.
- **`qwen2.5:7b`** — stronger tool use; the model the live `forest_conversation` demo drives.

Ollama is slow but free and offline — the live smoke path. Failure is honest: a dead server, non-JSON, or an empty reply is rejected, never fabricated, so a player surfaces "offline" instead of inventing an action.

For free-form dialogue (spoken lines rather than tool calls), there is a parallel `ChatClient` seam — `OllamaChat` against the same `/api/chat` endpoint — which the conversation demos use; the same honest-failure rule applies.

## GatewayProvider — cloud

A cloud OpenAI-compatible gateway over the same transport, for speed or quality when a local model isn't enough:

```ts
export class GatewayProvider implements LLMProvider {
  readonly name = "gateway";
  constructor(private readonly model: string) {}
  decide() {
    return Promise.reject(new Error(`GatewayProvider(${this.model}) not configured`));
  }
}
```

It is the same `LLMProvider` shape — a config swap from local to cloud — and rejects honestly until configured rather than pretending to decide.

## Providers are config swaps; memory is external

| provider | use | determinism |
|---|---|---|
| `ScriptedProvider` | tests, demo baselines | fully deterministic |
| `OllamaProvider` / `OllamaChat` | local smoke, offline dev | non-deterministic |
| `GatewayProvider` | cloud speed/quality | non-deterministic |

Choosing a provider is a one-line change to an agent's `llm.provider` plus an entry in the `ProviderMap`; the agent loop, the skill surface, and the trace are identical across all three.

:::note
**Memory and recall live outside the engine.** The provider is the *brain*; recall is part of the brain too — fed by perception plus read access to the durable [world log](/pillars/observability), with any memory backend (a vector DB, an event store, or none) sitting as an external adapter *behind* the provider. Limina never takes a memory backend as a runtime dependency. External builders bring their own memory over MCP. The engine persists the world well so any memory-builder can be built on top — without the engine owning memory.
:::
