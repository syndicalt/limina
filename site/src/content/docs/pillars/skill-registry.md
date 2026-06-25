---
title: "Skill / Hook Registry"
description: "The typed, versioned, permissioned path every agent action flows through."
---

Every action an agent takes in Limina — external builder or in-world player — goes through one place: the **Skill Registry**. A skill is a named, versioned, schema-described capability with declared permissions and a handler. The registry is the canonical pipeline: **resolve → Zod-validate → permission/policy → before-hook → handler → after-hook → emit**. The MCP `callTool` surface is a thin wrapper over `registry.invoke()`; nothing reaches the ECS, physics, or renderer without crossing it.

This is the substrate boundary. The engine owns the world and the skill surface; an agent's *brain* lives outside it. See [Skills reference](/skills) for the full catalog of 45 registered skills.

## The SkillDefinition shape

Each skill is a `SkillDefinition` (`js/src/skills/registry.ts`). Input and output are **Zod schemas** — the input schema is what gets compiled to JSON Schema and handed to agents over MCP; the output schema validates the handler's result.

```ts
export type SkillCategory =
  | "scene" | "ecs" | "three" | "physics"
  | "agent" | "system" | "ui" | "social" | "audio";

export interface SkillDefinition<I = unknown, O = unknown> {
  name: string;            // e.g. "scene.createEntity" — also the MCP tool name
  version: string;         // "1.0.0"
  description: string;
  category: SkillCategory;
  input: z.ZodType<I>;     // Zod -> JSON Schema (draft-07) for discovery
  output: z.ZodType<O>;    // validates the handler result
  permissions: string[];   // e.g. ["scene.write"]
  handler(input: I, ctx: ExecutionContext): Promise<O> | O;
  hooks?: {
    before?(input: I, ctx: ExecutionContext): Promise<void> | void;
    after?(result: O, ctx: ExecutionContext): Promise<void> | void;
  };
}
```

The `name` is also the MCP tool name — there is no renaming layer between a skill and the tool an agent calls. `version` and `category` are surfaced by discovery so agents can reason about what they're invoking.

:::note
The original MVP spec in `README.md` sketched `inputSchema`/`outputSchema` as generic JSON Schema. In the shipped engine these are **Zod** schemas (`z.ZodType`); the JSON Schema an agent sees is derived from the Zod input via `z.toJSONSchema(...)`. Zod is the single source of truth for both validation and discovery.
:::

### Hooks

`before` runs after validation and permission checks but before the handler — the place for extra pre-flight assertions. `after` runs once the handler resolves, with the typed result — useful for side-channel logging or post-conditions. Both receive the same `ExecutionContext` as the handler.

## ExecutionContext

The handler and its hooks run against an `ExecutionContext` built by the registry from the caller's `InvokeBase`:

```ts
export interface ExecutionContext {
  agentId: string;
  sessionId: string;
  permissions: ReadonlySet<string>;
  tick: number;                 // the fixed-timestep tick at invocation
  world: WorldContext;          // ECS, transforms, spatial index, scene, camera, ops
  emit(type: string, payload: unknown, causedBy?: string[]): string;
}
```

- **`agentId` / `sessionId`** — who is acting and under which session. For social skills the speaker is host-bound to `ctx.agentId`; a payload cannot spoof identity.
- **`permissions`** — the caller's granted capability set, resolved once as a `Set` for O(1) membership checks.
- **`tick`** — the fixed-step tick, so an action can be correlated to the exact world frame it ran on.
- **`world`** — the read/write surface (`WorldContext`): the bitECS world, transform storage, spatial index, entity table, tags, scene, camera, and engine ops.
- **`emit`** — write an event into the observability trace, optionally linking causal parents (see [Observability](/pillars/observability)).

The registry also carries optional provenance on the `InvokeBase`: `profile` (the caller's permission profile name, recorded for audit) and `pkg` (set when the call originates from a loaded package).

## Registration & discovery

`registerCoreSkills(registry)` wires the full core set at startup by calling each module registrar in order (`registerSceneSkills`, `registerEcsSkills`, `registerThreeSkills`, `registerPhysicsSkills`, `registerAgentSkills`, `registerSystemSkills`, `registerAuditSkills`, `registerUiSkills`, `registerAudioSkills`, `registerSocialSkills`, `registerPackageSkills`). The total is **45 registered skills**.

Agents discover the surface through two no-permission skills:

| skill | input | returns |
|---|---|---|
| `skills.list` | `{}` | `tools`: array of `{ name, description }` |
| `skills.describe` | `{ name }` | `name`, `version`, `category`, `description`, and `input_schema` (JSON Schema) |

`skills.list` mirrors the MCP `listTools` view; `skills.describe` returns a single skill's metadata including its draft-07 input schema. Skills can also be hot-reloaded at runtime via `dev.reload` (unregister + re-register so a later `callTool` runs the new handler), which emits an honest `dev.*.reload.completed`/`.failed` event.

## The permission model

Every skill declares the permission strings it requires. Across the whole surface the permission strings are:

`scene.read`, `scene.write`, `ecs.read`, `ecs.modify`, `physics.read`, `physics.write`, `agent.read`, `agent.write`, `ui.write`, `audio.play`, `social.act`.

A session is created under a named **profile** — a static allow-list resolved to a `Set` for O(1) checks (`resolveProfile(name)`; an unknown profile resolves to the empty set, so it can do nothing).

| profile | granted permissions |
|---|---|
| `builder.readWrite` | `scene.read`, `scene.write`, `ecs.read`, `ecs.modify`, `physics.read`, `physics.write`, `agent.read`, `agent.write`, `ui.write`, `audio.play` |
| `player.limited` | `scene.read`, `ecs.read`, `physics.read`, `physics.write`, `agent.read`, `agent.write` |
| `social.actor` | `scene.read`, `ecs.read`, `physics.read`, `agent.read`, `agent.write`, `social.act`, `audio.play` |
| `system.readonly` | `scene.read`, `ecs.read`, `physics.read`, `agent.read` |

Notes that fall out of the table:

- `social.act` is granted **only** by `social.actor`. It is deliberately absent from `player.limited`, so a non-social agent calling `social.approach` / `social.say` is denied with zero effect.
- `builder.readWrite` does **not** include `social.act`; `social.actor` does **not** include `scene.write` / `ecs.modify` / `physics.write` / `ui.write`.
- `ecs.read` is granted by every profile and is required by `inspector.snapshot`.
- Skills declaring `permissions: []` (`skills.list`, `skills.describe`, `trace.*`, `audit.*`, `package.list`) are callable under any profile.

### Static profiles vs. the dynamic policy engine

There are two enforcement modes, sharing the same boundary.

**Static check (legacy / MVP).** With no policy engine attached, `invoke()` checks each required permission against the caller's set. The first missing permission emits a `security.permission.denied { skill, missing, agentId }` event and returns `forbidden` with message `missing permission: <perm>`.

**Dynamic policy engine (Phase 4b / M7).** With a `PolicyEngine` attached, a profile becomes just one *input* to a contextual decision. The engine evaluates every crossing — at the registry, the sandbox host bridge, session admission, and package load — with deny-overrides, fail-closed ordering (first matching deny wins):

1. session admission revoked → `session.revoked`
2. capability/agent revoked → `revoked`
3. profile does not grant the capability → `profile.denied`
4. quota window exhausted → `quota.exceeded`
5. resource budget exhausted → `budget.calls` / `budget.cpu` / `budget.mem`
6. otherwise → `allow` (`profile.grant`) and commit usage

Beyond profiles, the engine adds **quotas** (deny the N+1th call in a sliding window), **revocation** (revoke a capability mid-session so the next call is denied), and **resource budgets** (a per-session ledger of calls / CPU-ms / memory-bytes, the CPU/mem dimensions tied to the sandbox knobs). Every decision is audited: an allow emits `policy.decision`, a deny emits `policy.denied`, each carrying the rule that fired, a human reason, the salient context, and the live quota/budget snapshot. A permission denial additionally emits `security.permission.denied`. These recorded decisions are exactly what the `audit.explain` / `audit.query` / `audit.usage` skills read back.

:::tip
Want to know *why* an action was allowed or denied? Call `audit.explain { eventId }` — it returns the governing decision (rule, reason, context, quota/budget), the provenance (agent/session/profile/package), and the causal-parent chain, all from the real recorded trace.
:::

## On success

When a call is allowed and the handler resolves, `invoke()` emits `skill.executed { skill, version, input, tick }` (with the policy decision linked via `causedBy` when the engine is attached) and returns `{ success: true, result, metadata }`, where `metadata` carries `executionTimeMs` and the `eventsEmitted` list. Every action is typed, permission-checked, and traced — by construction, because there is no other path.
