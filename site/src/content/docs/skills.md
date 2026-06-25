---
title: "Skills reference"
description: "Every built-in Limina skill — the agent-facing SDK surface — grouped by domain."
---

Limina ships **45 typed skills**: the complete set of actions an agent can take in the world. Each skill is **versioned**, declares the **permissions** it needs, and validates its input against a [Zod](https://zod.dev) schema. Every skill maps **1:1 to an MCP tool** whose name is the skill name — so this page is also the MCP tool list.

:::tip[For agents]
The same catalog is available as machine-readable JSON at [`/agents/skills.json`](/agents/skills.json) (names, permissions, and JSON-Schema inputs). See [the MCP interface](/pillars/mcp-interface) for the wire contract and [the registry](/pillars/skill-registry) for the skill model.
:::

## Permission profiles

A session is opened under a profile; the engine enforces the profile's allow-list before any handler runs. A skill with no declared permission is callable under any profile.

| Profile | Grants |
|---------|--------|
| `builder.readWrite` | `scene.read` `scene.write` `ecs.read` `ecs.modify` `physics.read` `physics.write` `agent.read` `agent.write` `ui.write` `audio.play` |
| `player.limited` | `scene.read` `ecs.read` `physics.read` `physics.write` `agent.read` `agent.write` |
| `social.actor` | `scene.read` `ecs.read` `physics.read` `agent.read` `agent.write` `social.act` `audio.play` |
| `system.readonly` | `scene.read` `ecs.read` `physics.read` `agent.read` |

All permission strings: `scene.read`, `scene.write`, `ecs.read`, `ecs.modify`, `physics.read`, `physics.write`, `agent.read`, `agent.write`, `ui.write`, `audio.play`, `social.act`.

## Scene & world

Create, destroy, and query renderable entities.

| Skill | Description | Permissions | Input | Output |
|---|---|---|---|---|
| `scene.createEntity` | Create a renderable entity (box or sphere) at a position, optionally with a dynamic physics body. Returns its entity id. | `scene.write` | `shape`, `collider`, `size`, `color`, `position`, `dynamic`, `static`, `friction`, `restitution` | `entity` |
| `scene.destroyEntity` | Destroy an entity and free its scene object and physics body. | `scene.write` | `entity` | `removed` |
| `scene.queryEntities` | List entities, optionally filtered by tag and/or within a radius of a point. Returns ids, positions, distances. | `scene.read` | `near`, `radius`, `tag` | `entities` |

## ECS components

Read and mutate component data on entities.

| Skill | Description | Permissions | Input | Output |
|---|---|---|---|---|
| `ecs.updateComponent` | Set an entity's position [x,y,z], rotation quaternion [x,y,z,w], or scale [x,y,z]. | `ecs.modify` | `entity`, `component`, `value` | `ok` |
| `ecs.addComponent` | Tag an entity with a named component (e.g. 'target', 'hostile'). | `ecs.modify` | `entity`, `component` | `ok` |
| `ecs.removeComponent` | Remove a named component tag from an entity. | `ecs.modify` | `entity`, `component` | `ok` |

## Rendering · Three.js

Transforms, PBR materials, lighting, and glTF.

| Skill | Description | Permissions | Input | Output |
|---|---|---|---|---|
| `three.setTransform` | Set an entity's position, rotation (Euler radians), and/or scale. | `scene.write` | `entity`, `position`, `rotationEuler`, `scale` | `ok` |
| `three.setMaterial` | Update an entity's PBR material (color, roughness, metalness) and/or shadow participation (castShadow/receiveShadow). Applies across all meshes of a glTF entity. | `scene.write` | `entity`, `color`, `roughness`, `metalness`, `castShadow`, `receiveShadow` | `ok` |
| `three.setLighting` | Set scene lighting: one ambient + one directional light, optionally casting real shadow maps. | `scene.write` | `ambientColor`, `ambientIntensity`, `directionalColor`, `directionalIntensity`, `direction`, `castShadow`, `shadowMapSize`, `shadowCameraExtent`, `shadowCameraNear`, `shadowCameraFar`, `shadowBias` | `ok` |
| `three.loadGLTF` | Load a glTF/glb model from a sandboxed asset id and add it to the scene at a position. | `scene.write` | `assetId`, `position` | `entity`, `resource` |

## Physics · Rapier

Impulses, raycasts, and collision events from native Rapier.

| Skill | Description | Permissions | Input | Output |
|---|---|---|---|---|
| `physics.applyImpulse` | Apply an impulse [x,y,z] to an entity's dynamic body (wakes it). | `physics.write` | `entity`, `impulse` | `ok` |
| `physics.raycast` | Cast a ray from origin along direction; returns the first hit (distance, point, entity). | `physics.read` | `origin`, `direction`, `maxDistance` | `hit`, `distance`, `point`, `entity` |
| `physics.collisionEvents` | Drain physics collision start/stop events, mapped to entity ids where available. | `physics.read` | — | `events` |

## Agent / meta

Perception and custom event signals for agents.

| Skill | Description | Permissions | Input | Output |
|---|---|---|---|---|
| `agent.emitEvent` | Emit a custom event into the observability trace (inter-agent or system signal). Emitted as agent.signal.<type>. | `agent.write` | `type`, `payload` | `eventId` |
| `agent.getPerception` | Get the calling agent's current perception (nearby entities + recent events). | `agent.read` | — | `perception` |

## System & introspection

Discover skills, tail the trace, snapshot the world, hot-reload.

| Skill | Description | Permissions | Input | Output |
|---|---|---|---|---|
| `skills.list` | List all available skills (names + descriptions). | _none_ | — | `tools` |
| `skills.describe` | Describe a skill: version, category, and JSON-Schema input. | _none_ | `name` | `name`, `version`, `category`, `description`, `input_schema` |
| `trace.tail` | Tail trace events with cursor pagination and optional actor/type filters. | _none_ | `afterSeq`, `limit`, `actorId`, `type` | `events`, `nextAfterSeq` |
| `trace.explainEvent` | Explain a trace event with resolved causal parents and children. | _none_ | `eventId` | `event`, `parents`, `children` |
| `trace.export` | Flush the durable trace history to a sandboxed trace JSONL file. | _none_ | `name` | `name`, `events`, `bytes` |
| `inspector.snapshot` | Return a bounded, paginated snapshot of world, entities, agents, skills, permissions, resources, and trace metadata. | `scene.read` `ecs.read` `physics.read` `agent.read` | `afterEntity`, `limit` | `page`, `world`, `entities`, `agents`, `skills`, `permissions`, `resources`, `trace` |
| `dev.reload` | Live-reload a skill (registry unregister+re-register so a later callTool runs the new handler) or re-run a registered scene builder; emits an honest dev.*.reload.completed/.failed trace event listing what was invalidated. Targets that genuinely cannot reload fail honestly instead of pretending success. | `scene.read` | `target`, `name`, `reason` | `ok`, `target`, `invalidated`, `reason` |

## Audit & policy

Query the recorded policy decisions and resource usage.

| Skill | Description | Permissions | Input | Output |
|---|---|---|---|---|
| `audit.explain` | Answer 'why was action X allowed/denied': the governing policy decision (rule + reason + context + quota/budget), the provenance (agent/session/profile/package), and the causal-parent chain — all from the real recorded trace. | _none_ | `eventId` | `eventId`, `eventType`, `found`, `decision`, `provenance`, `causalTrace` |
| `audit.query` | Query recorded policy decisions: filter by allow/deny, cap, rule, agent, session, or package (package provenance). Returns matching decision events plus an allow/deny + by-rule + by-cap summary. | _none_ | `decision`, `cap`, `rule`, `agentId`, `sessionId`, `package`, `limit` | `summary`, `decisions` |
| `audit.usage` | Resource usage from recorded decisions: allowed/denied call counts per session+cap, plus the latest quota and budget snapshots seen for each session — derived from the real policy events. | _none_ | `sessionId` | `perSessionCap`, `quotas`, `budgets` |

## In-world UI & text

Speech bubbles, labels, callouts, and screen HUD panels.

| Skill | Description | Permissions | Input | Output |
|---|---|---|---|---|
| `ui.panel` | Author a styled UI container (kind = label/textBox/speechBubble/thoughtBubble/callout/hudPanel) with a full Zod style object, world/screen anchor, optional tail/leader and lifecycle (fade/typewriter/ttl/queue/feed). Returns an opaque handle. | `ui.write` | `kind`, `anchor`, `style`, `text`, `title`, `lines`, `maxWidth`, `width`, `maxLines`, `pixelScale`, `tail`, `leader`, `lifecycle` | `handle` |
| `ui.label` | Place a billboard label (minimal chrome) tracking an entity or world point. | `ui.write` | `anchor`, `style`, `text`, `title`, `lines`, `maxWidth`, `width`, `maxLines`, `pixelScale`, `tail`, `leader`, `lifecycle` | `handle` |
| `ui.textBox` | Place a titled text box (header bar + wrapped body) at a world or screen anchor. | `ui.write` | `anchor`, `style`, `text`, `title`, `lines`, `maxWidth`, `width`, `maxLines`, `pixelScale`, `tail`, `leader`, `lifecycle` | `handle` |
| `ui.speechBubble` | Place a speech bubble with a directional tail aimed at the speaker (entity/point). | `ui.write` | `anchor`, `style`, `text`, `title`, `lines`, `maxWidth`, `width`, `maxLines`, `pixelScale`, `tail`, `leader`, `lifecycle` | `handle` |
| `ui.thoughtBubble` | Place a thought bubble with trailing puffs leading back to the thinker. | `ui.write` | `anchor`, `style`, `text`, `title`, `lines`, `maxWidth`, `width`, `maxLines`, `pixelScale`, `tail`, `leader`, `lifecycle` | `handle` |
| `ui.callout` | Place an annotation box with a leader line to a target point. | `ui.write` | `anchor`, `style`, `text`, `title`, `lines`, `maxWidth`, `width`, `maxLines`, `pixelScale`, `tail`, `leader`, `lifecycle` | `handle` |
| `ui.hudPanel` | Place a screen-anchored HUD/overlay panel (corner-pinned, DPI-aware, over the scene). | `ui.write` | `anchor`, `style`, `text`, `title`, `lines`, `maxWidth`, `width`, `maxLines`, `pixelScale`, `tail`, `leader`, `lifecycle` | `handle` |
| `ui.update` | Update a live container by handle: change its text, title, body lines, and/or restyle it (re-composites). Returns whether the handle existed and re-composited. | `ui.write` | `handle`, `text`, `title`, `style`, `lines` | `ok`, `changed` |
| `ui.remove` | Remove a live container by handle: detach its mesh from the scene and dispose its GPU resources. | `ui.write` | `handle` | `removed` |

## Spatial audio

Synthesized SFX, ambience, positional sound, and TTS.

| Skill | Description | Permissions | Input | Output |
|---|---|---|---|---|
| `audio.play` | Play a one-shot synthesized SFX blip (sine + envelope) on a bus (master/sfx/ambience/voice). Returns an opaque handle. | `audio.play` | `freq`, `secs`, `bus`, `volume` | `handle` |
| `audio.ambient` | Start a looping synthesized ambience bed on a bus (default ambience). Returns an opaque handle. | `audio.play` | `bus`, `volume` | `handle` |
| `audio.playAt` | Play a one-shot POSITIONAL synthesized SFX at a world position; 3D-panned + attenuated relative to the camera listener. Optional maxDistance cutoff. Returns an opaque handle. | `audio.play` | `freq`, `secs`, `position`, `bus`, `volume`, `maxDistance` | `handle` |
| `audio.speak` | Speak a line of text aloud at a world position via a pluggable local TTS voice (voice bus, positional). FIRE-AND-FORGET: returns immediately; synthesis runs off-thread and never blocks the frame. Returns an opaque handle. | `audio.play` | `text`, `position`, `volume` | `handle` |
| `audio.stop` | Stop a playing sound by handle. | `audio.play` | `handle` | `ok` |
| `audio.setVolume` | Set a playing sound's volume (0..1) by handle. | `audio.play` | `handle`, `volume` | `ok` |
| `audio.setBusVolume` | Set a mixer bus volume (master/sfx/ambience/voice), re-gaining all live sounds on it. | `audio.play` | `bus`, `volume` | `ok` |

## Embodied social

Walk toward targets and speak as the calling agent.

| Skill | Description | Permissions | Input | Output |
|---|---|---|---|---|
| `social.approach` | Walk the calling agent toward a target (an agent id, an entity id, or a world point). Sets the move target the locomotion system pursues; emits social.approached. | `social.act` | `target`, `talkDistance` | `approaching`, `target` |
| `social.say` | Speak a line as the calling agent: emits social.said (actorId = the host-bound caller) and shows a real speech bubble anchored above the speaker's humanoid (per-speaker queue). | `social.act` | `text`, `actorId` | `said`, `speaker`, `handle` |

## Packages

List and load versioned, attested capability packages.

| Skill | Description | Permissions | Input | Output |
|---|---|---|---|---|
| `package.list` | List installed packages with their manifest provenance: ref (name@version), kind, declared capabilities, engine-compat range, content hash, and whether the package is attested. | _none_ | `name` | `packages` |
| `package.load` | Load an installed package (by name@version ref) under a profile: validates the manifest, checks engine-compat (out-of-bounds rejected), gates declared-vs-granted capabilities via the policy engine (over-claim denied), and loads the untrusted entry into the M6 sandbox. Returns the load decision + provenance event id. | `agent.write` | `ref`, `agentId`, `sessionId`, `profile` | `ok`, `ref`, `agentId`, `rule`, `rejectReason`, `reason`, `loadEventId` |

---

Input field types, defaults, and full JSON Schema for every skill live in [`/agents/skills.json`](/agents/skills.json). To call these over the wire, see [Agent Builders](/building-agents/builders).
