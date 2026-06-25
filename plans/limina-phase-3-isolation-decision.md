# Limina Phase 3 Isolation Decision Record

Date: 2026-06-23

Status: accepted for the current Phase 3 foundation slice; revisit before enabling third-party code or plugin distribution.

## Decision

Phase 3 keeps all agent-executed behavior on two controlled surfaces:

- **External builders:** JSON-RPC MCP sessions bound during `initialize` to an engine-owned `{ agentId, sessionId, profile }`. Tool calls ignore caller-supplied spoofed context and flow through `SkillRegistry.invoke`.
- **In-world players:** data-only `AgentRecord` values scheduled by `AgentScheduler`. They choose candidate tool calls through a provider seam, but validated execution still flows through the registry, permission profiles, trace hooks, and finite queue/action budgets.

Phase 3 does **not** adopt QuickJS, separate V8 isolates, worker-based third-party JS execution, or any other arbitrary-code sandbox yet.

Arbitrary third-party code is not allowed to touch `Deno.core.ops`, exported ECS component arrays, `WorldContext`, `EntityTable`, or the privileged skill registry directly. The current runtime has no membrane that could make those objects safe against hostile code. `Deno.core.ops` is an ambient privileged host API, ECS arrays are mutable canonical state, and `WorldContext` contains authority-bearing handles to scene, physics, entities, tags, and agents.

## Measured Current Path

Command:

```bash
/usr/bin/time -v target/debug/limina js/test/p3_acceptance_runner.ts
```

Test-derived acceptance data from that run:

| Measurement | Value |
| --- | ---: |
| Bound MCP builder sessions | 6 |
| MCP-created builder entities | 24 |
| In-world Agent Players | 48 |
| Total entities inspected | 72 |
| Scheduler decisions sampled | 216 |
| Executed player skill events | 420 |
| Backpressure events | 1080 |
| Queue drops | 216 |
| p95 frame-step time | 25 ms |
| p95 provider decision time | 4 ms |
| p95 aggregate queue depth | 36 |
| p95 MCP call-boundary time | 3 ms |
| Process elapsed wall time | 0.54 s |
| Maximum resident set size | 139,360 KB |

The acceptance runner uses `StdioMcpTransport` in-process as a deterministic stdio-equivalent JSON-RPC path. The separate host `--mcp-stdio` smoke remains responsible for the OS stdin/stdout transport boundary.

## Why No Sandbox Substrate Yet

QuickJS, V8 isolates, subprocesses, and workers all remain candidate substrates, but adopting one now would be premature without the missing threat model and API membrane:

- The allowed API surface for untrusted code is not yet reduced to a serializable capability set.
- The ECS ownership model remains JS-owned TypedArrays with a deterministic facade and mutation queue; direct array access would bypass ordering and traceability.
- Native ops are not partitioned into safe, per-session capabilities.
- The acceptance runner already proves the current production-safe path for many agents: data-only players plus bound MCP tool calls with finite budgets and traceable denials/drops.

The next isolation milestone is to prototype a sandbox around a narrow capability object, measure startup/RSS/call-boundary overhead against this decision record, and reject any substrate that cannot prevent access to `Deno.core.ops`, mutable ECS arrays, or privileged `WorldContext` handles.

## Honest Non-Claims

- Textured glTF is implemented for sandboxed/data assets via the asset-only web shim and verified by `p3_textured_gltf` plus `p3_textured_gltf_window`; arbitrary network glTF loading is not claimed.
- Crash-safe append-on-emit trace persistence is implemented and verified for restart hydration and torn final-line recovery; high-frequency production tracing may still need batching or segment tuning.
- This decision does not make arbitrary third-party JS, package ecosystems, or marketplace plugins safe.
