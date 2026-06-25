---
title: "ECS & the world"
description: "How Limina stores the world: bitECS, SoA TypedArrays, opaque ent_ ids that are never reused, and native rayon ECS ops."
---

The world's state is an **Entity-Component-System (ECS)** built on
[bitECS](https://github.com/NateTheGreatt/bitECS). Limina chooses data-oriented storage on
purpose: components are **Structure-of-Arrays (SoA) TypedArrays**, which keeps the hot
loops cache-friendly and — crucially — lets native code read and write the same bytes
**zero-copy**. This is the foundation the [renderer](/architecture), physics, and the
[native spatial query](/concepts/perception) all share.

## Components are SoA TypedArrays

Core transform components are plain typed arrays sized to a fixed entity ceiling. Position,
rotation (a quaternion), and scale each store one `Float32Array` per axis:

```ts
export const MAX_ENTITIES = 16384;

export const Position = {
  x: new Float32Array(MAX_ENTITIES),
  y: new Float32Array(MAX_ENTITIES),
  z: new Float32Array(MAX_ENTITIES),
};
export const Rotation = {
  x: new Float32Array(MAX_ENTITIES),
  y: new Float32Array(MAX_ENTITIES),
  z: new Float32Array(MAX_ENTITIES),
  w: new Float32Array(MAX_ENTITIES),
};
export const Scale = {
  x: new Float32Array(MAX_ENTITIES),
  y: new Float32Array(MAX_ENTITIES),
  z: new Float32Array(MAX_ENTITIES),
};
```

An entity is an integer index (`eid`) into these arrays. Because the data is laid out by
field across all entities rather than by entity, iterating "every position" is a linear
sweep over contiguous memory — and a native op can be handed the underlying `ArrayBuffer`
and operate on it in place, with no copy crossing the JS↔Rust boundary.

:::note[Why SoA]
SoA storage is a performance-first decision. It keeps iteration cache-friendly, vectorizes
cleanly, and is the precondition for zero-copy native hot paths. The same `Float32Array`
the physics step writes is the one the spatial query reads and the renderer presents.
:::

`MAX_ENTITIES` is **16384**. Spawning past the ceiling is rejected rather than silently
overflowing — for example `scene.createEntity` despawns the renderable and throws
`entity capacity exceeded (MAX_ENTITIES)` if the new `eid` would exceed the limit.

## Entities and opaque `ent_` ids

Agents and authoring code never touch raw `eid` integers. They work with **opaque string
ids** of the form `ent_<n>`, handed out by the `EntityTable`, which maps those strings to
internal handles (the `eid`, a generation counter, an optional mesh, an optional physics
body id, and any loaded resource metadata).

The contract that makes this safe:

```ts
// `ent_` strings are monotonic and NEVER reused, so a destroyed entity's id
// resolves to `undefined` forever — a recycled bitECS eid can never be reached
// through a stale `ent_`.
```

- **Monotonic.** Each `create` allocates the next `ent_<seq>` and bumps a table version.
- **Never reused.** Destroying an entity removes its mapping; the id is gone for good.
- **Stale-safe.** A bitECS `eid` may be recycled internally, but a stale `ent_` string
  resolves to `undefined` — it can never accidentally address a different entity that later
  reused the same `eid`.

This is what lets agents hold ids across ticks and even across a save/restore: the table can
snapshot its live entries (in creation order) plus its allocation counter and version, and
restore to issue the *same* next ids — so replay and snapshot recovery stay deterministic.

## Components beyond transforms

Beyond the transform SoA, entities carry **named component tags** (e.g. `target`,
`hostile`) tracked per entity, and optional bindings the table holds: a Three.js mesh, a
Rapier body id, and loaded-resource metadata for glTF entities. Tags are how agents mark and
query the world semantically; transforms are how they move it.

## Native rayon ECS ops — `limina-ecs`

The iteration-heavy work JS is slow at is pushed into the native `limina-ecs` crate:
**rayon-parallel ECS ops** that run over the *same* JS-owned SoA buffers. The headline op is
a batched uniform-grid (CSR) radius query used by [perception](/concepts/perception): it is
**bit-identical** to the JS spatial index (which remains the determinism oracle), runs
**4.5–5.4×** faster, and stays **≤2 ms**. Raising `MAX_ENTITIES` to 16384 and wiring this op
into perception is what let the density capstone run 200 agents + 256 dynamic bodies + 2000
entities at a sim-step p95 of 4 ms.

## How `scene.*` and `ecs.*` skills map to it

Agents and authoring code drive the ECS through typed [skills](/skills), not by touching the
arrays directly:

| Skill | What it does to the world |
|-------|---------------------------|
| `scene.createEntity` | Spawns a renderable (box/sphere) at a position, optionally with a dynamic physics body; returns its `ent_` id. Allocates the `eid`, writes the transform SoA, and registers it in the `EntityTable`. |
| `scene.destroyEntity` | Removes the entity, frees its scene object and physics body, and retires its `ent_` id forever. |
| `scene.queryEntities` | Lists entities (optionally by tag and/or within a radius), returning ids, positions, and distances — backed by the spatial index. |
| `ecs.updateComponent` | Sets an entity's `position` `[x,y,z]`, `rotation` quaternion `[x,y,z,w]`, or `scale` `[x,y,z]` — i.e. writes the transform SoA. |
| `ecs.addComponent` / `ecs.removeComponent` | Adds or removes a named component tag (e.g. `target`). |

`scene.*` skills create and query whole entities; `ecs.*` skills mutate components on an
existing entity. Both go through the [skill registry](/pillars/skill-registry), so every
write is typed, permission-checked, and traced into the [world log](/concepts/observability).

## Related

- [The fixed-timestep loop](/concepts/loop) — when the ECS is read and written each tick.
- [Perception](/concepts/perception) — the native batched spatial query in action.
- [Architecture & stack](/architecture) — where `limina-ecs` sits in the stack.
