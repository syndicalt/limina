---
title: "Skills reference"
description: "Every built-in Limina skill — the agent-facing SDK surface — grouped by domain."
---

Limina ships **192 typed skills**: the complete set of actions an agent can take in the world. Each skill is **versioned**, declares the **permissions** it needs, and validates its input against a [Zod](https://zod.dev) schema. Every skill maps **1:1 to an MCP tool** whose name is the skill name — so this page is also the MCP tool list.

:::tip[For agents]
The same catalog is available as machine-readable JSON at [`/agents/skills.json`](/agents/skills.json) (names, permissions, and JSON-Schema inputs). See [the MCP interface](/pillars/mcp-interface) for the wire contract and [the registry](/pillars/skill-registry) for the skill model.
:::

## Permission profiles

A session is opened under a profile; the engine enforces the profile's allow-list before any handler runs. A skill with no declared permission is callable under any profile.

| Profile | Grants |
|---------|--------|
| `builder.readWrite` | `scene.read` `scene.write` `ecs.read` `ecs.modify` `physics.read` `physics.write` `agent.read` `agent.write` `ui.write` `audio.play` `terrain.read` `terrain.generate` `player.read` `player.write` `player.configure` `camera.write` `animation.read` `animation.write` `interaction.read` `interaction.write` `interaction.configure` `inventory.read` `inventory.write` `inventory.configure` `item.configure` `game.write` `game.configure` `trigger.configure` `event.read` `event.write` `quest.read` `quest.write` `quest.configure` `stats.read` `stats.write` `stats.configure` `damage.write` `status.read` `status.write` `combat.write` `behavior.read` `behavior.write` `behavior.configure` `dialogue.read` `dialogue.write` `dialogue.configure` `nav.read` `nav.write` `nav.configure` `vfx.write` `checkpoint.read` `checkpoint.write` `save.write` `progression.read` `progression.write` `progression.configure` `world.read` `world.write` |
| `player.full` | `scene.read` `ecs.read` `physics.read` `physics.write` `agent.read` `terrain.read` `player.read` `player.write` `player.configure` `camera.write` `animation.read` `interaction.read` `interaction.write` `inventory.read` `dialogue.read` |
| `player.limited` | `scene.read` `ecs.read` `physics.read` `physics.write` `agent.read` `agent.write` `terrain.read` `player.read` `player.write` `camera.write` `interaction.read` `interaction.write` `inventory.read` `inventory.write` `game.write` `quest.read` `stats.read` `status.read` `behavior.read` `dialogue.read` `dialogue.write` `nav.read` `nav.write` `checkpoint.read` `checkpoint.write` `progression.read` `world.read` |
| `npc.agent` | `scene.read` `ecs.read` `physics.read` `agent.read` `agent.write` `social.act` `audio.play` `behavior.read` `behavior.write` `dialogue.read` `dialogue.write` `dialogue.configure` `nav.read` `nav.write` `stats.read` `stats.write` `stats.configure` `damage.write` `status.read` `status.write` `combat.write` `animation.read` `animation.write` `inventory.read` `interaction.read` |
| `game.author` | `game.write` `game.configure` `quest.read` `quest.write` `quest.configure` `trigger.configure` `event.read` `event.write` `stats.configure` `scene.read` `ecs.read` `physics.read` `agent.read` |
| `combat.writer` | `combat.write` `damage.write` `status.read` `status.write` `stats.read` `stats.write` `scene.read` `ecs.read` `physics.read` |
| `vfx.writer` | `vfx.write` `animation.write` `scene.read` `ecs.read` |
| `world.author` | `world.write` `checkpoint.read` `checkpoint.write` `save.write` `scene.read` `ecs.read` `physics.read` |
| `terrain.author` | `scene.read` `scene.write` `ecs.read` `ecs.modify` `physics.read` `physics.write` `terrain.read` `terrain.generate` |
| `social.actor` | `scene.read` `ecs.read` `physics.read` `agent.read` `agent.write` `social.act` `audio.play` |
| `system.readonly` | `scene.read` `ecs.read` `physics.read` `agent.read` `trace.read` |
| `builder.review` | `scene.read` `scene.write` `ecs.read` `ecs.modify` `physics.read` `physics.write` `agent.read` `agent.write` `ui.write` `audio.play` |
| `reviewer` | `scene.read` `ecs.read` `physics.read` `agent.read` `approval.review` `trace.read` |
| `reviewer.coordinator` | `orchestrate` `approval.review` `scene.read` `ecs.read` `physics.read` `agent.read` `trace.read` |

All permission strings: `agent.read`, `agent.write`, `animation.read`, `animation.write`, `approval.review`, `audio.play`, `behavior.configure`, `behavior.read`, `behavior.write`, `camera.write`, `checkpoint.read`, `checkpoint.write`, `combat.write`, `damage.write`, `dialogue.configure`, `dialogue.read`, `dialogue.write`, `ecs.modify`, `ecs.read`, `event.read`, `event.write`, `game.configure`, `game.write`, `interaction.configure`, `interaction.read`, `interaction.write`, `inventory.configure`, `inventory.read`, `inventory.write`, `item.configure`, `nav.configure`, `nav.read`, `nav.write`, `physics.read`, `physics.write`, `player.configure`, `player.read`, `player.write`, `progression.configure`, `progression.read`, `progression.write`, `quest.configure`, `quest.read`, `quest.write`, `save.write`, `scene.read`, `scene.write`, `social.act`, `stats.configure`, `stats.read`, `stats.write`, `status.read`, `status.write`, `terrain.generate`, `terrain.read`, `trace.read`, `trigger.configure`, `ui.write`, `vfx.write`, `world.read`, `world.write`.

## Scene, terrain & world

Create entities, place and scatter assets, author materials, generate terrain, and drive world dynamics (time, weather, water).

| Skill | Description | Permissions | Input | Output |
|---|---|---|---|---|
| `asset.place` | Place a curated glTF asset BY ID at a transform. Resolves the id through the content-addressed asset registry, loads it via the shared glTF pipeline, and spawns an entity. The world log records the REQUEST (assetId + transform + committed content hash); the bytes ride the registry/export package. Returns the entity id + content hash. | `scene.write` | `assetId`, `position`, `rotation?`, `scale?`, `material?`, `hash?` | `entity`, `hash`, `resource` |
| `asset.scatter` | Scatter curated glTF assets BY ID across an ALREADY-GENERATED region (by regionId) under an agent-set ScatterConfig (palette + density + elevation/slope/climate rules). Bound to the region's seed/lod + applied tiles, so placements sit on the visible, exported surface. Deterministic + replay-safe: the world log records the regionId + ScatterConfig REQUEST (+ pinned asset hashes), NEVER the instance transforms, which replay recomputes over the SAME baked/cached tiles. Mounts one InstancedMesh per asset mesh. Returns the placement count + pinned hashes. | `scene.write` | `regionId`, `config`, `assetHashes?` | `regionId`, `instances`, `mounted`, `assetHashes`, `placements` |
| `material.import` | Import a CC0 texture pack (albedo + optional normal + roughness images, BY content-addressed id) as a NAMED PBR material usable by scene.createEntity / three.setMaterial. Resolves + decodes the images through the content-addressed asset registry (bytes ride the export's assets.jsonl); the world log records only the import REQUEST (name + ids + committed hashes), never bytes. Optionally TRIPLANAR so the pack never UV-stretches on arbitrary primitives. Returns the name + pinned hashes. | `scene.write` | `name`, `albedo`, `normal?`, `roughness?`, `triplanar`, `scale`, `normalStrength`, `sharpness`, `metalness`, `baseRoughness`, `color?`, `hashes?` | `name`, `maps`, `hashes` |
| `render.enablePost` | Build the RENDER-ONLY post-processing pipeline (real depth+normal pre-pass → GTAO contact AO → highlight bloom → gentle HDR grade) on the live renderer/scene/camera and store it on world.post for the render loop to drive (post.render() in place of renderer.render). Returns the resolved preset + which stages are wired. STATIC/CINEMATIC-ONLY + OPT-IN: on this WebGPU windowed backend the composite does not reliably present a fresh frame per camera move, so use it for screenshots/fixed-camera shots (drive the bare renderer.render path for live navigation). Render-only: never touches the sim/log/replay. | `scene.write` | `ao?`, `bloom?`, `grade?` | `enabled`, `ao`, `bloom`, `grade`, `depth`, `normal`, `preset` |
| `scene.createEntity` | Create a renderable entity (box or sphere) at a position, optionally with a dynamic physics body. The `material` field accepts a palette name (optionally upgraded to procedural-PBR via `pbr: true`) or an imported texture-pack material name (material.import). Returns its entity id. | `scene.write` | `shape`, `collider?`, `size`, `material?`, `pbr`, `color`, `position`, `dynamic`, `static`, `friction`, `restitution` | `entity` |
| `scene.destroyEntity` | Destroy an entity and free its scene object and physics body. | `scene.write` | `entity` | `removed` |
| `scene.queryEntities` | List entities, optionally filtered by tag and/or within a radius of a point. Returns ids, positions, distances. | `scene.read` | `near?`, `radius?`, `tag?` | `entities` |
| `terrain.sampleClimate` | Deterministic per-coordinate climate (tempC, precipMm, biome) for agent perception. Pass the region's terrain hints to read the per-type biome. | `terrain.read` | `seed`, `x`, `z`, `hints?` | `tempC`, `precipMm`, `biome` |
| `terrain.sampleHeight` | O(1) deterministic surface-elevation query at a world (x,z) for a seed/lod (snapping/placement). Returns world Y. | `terrain.read` | `seed`, `x`, `z`, `lod` | `y` |
| `world.addWater` | Add a RENDER-ONLY water surface (a large plane) at a sea-level Y so beaches/lakes/oceans read as water. Cosmetic only: no physics body, no collider, no ECS entity — it never affects the deterministic sim or replay. The world log records the REQUEST (level/size/color, and an optional region for true depth-aware shading); replay rebuilds the same surface from the logged request. | `scene.write` | `level`, `size`, `color`, `region?` | `level`, `size`, `color` |
| `world.generateRegion` | Generate a rectangular region of terrain: build the heightfield COLLIDERS from a deterministic source AND (by default) the VISIBLE procedural-PBR terrain mesh per tile, so the region renders a textured landscape out of the box. High-cost; streams tiles, emitting terrain.tile.ready per tile. Returns a region handle + the surveyed relief/seaLevel. The world log records this REQUEST; the tile bytes ride the cache/export; the visible meshes are RENDER-ONLY (rebuilt from the same tiles on replay). Opt out of the mesh with render:false (colliders/data only); tune the look with `surface`. | `terrain.generate` | `seed`, `bounds`, `lod`, `type?`, `hints?`, `render`, `surface?` | `regionId`, `tiles`, `bodies`, `keys`, `meshes`, `relief?`, `seaLevel?` |
| `world.getSpawn` | Get the default spawn position for players. | `world.read` | `meta?` | `position` |
| `world.populateBiome` | Scatter a terrain TYPE's biome content (trees/rocks/grass/cacti/palms, biome- and elevation-gated) over an ALREADY-GENERATED region (by regionId), via the deterministic asset.scatter seam. Surveys the region's relief with the hints it was generated with, resolves the type's content layers, and drives asset.scatter per layer. Deterministic + replay-safe: the world log records THIS request; the nested asset.scatter calls are recomputed on replay (no double-record). Returns the placement count + per-layer summary. | `scene.write` | `regionId`, `type?`, `waterLevel?`, `waterMargin?`, `seed?` | `regionId`, `type`, `instances`, `relief`, `layers` |
| `world.setSpawn` | Set the default spawn position for players. | `world.write` | `position`, `meta?` | `ok` |
| `world.setTime` | Set the world's time of day. Affects lighting, skybox, and ambient audio. | `world.write` | `time`, `transitionMs`, `meta?` | `ok` |
| `world.setTimeScale` | Set the simulation time scale. 0 pauses the world, 1 is normal speed. | `world.write` | `scale`, `meta?` | `ok` |
| `world.setWeather` | Set the active weather with intensity. Supports clear, rain, snow, fog, storm, or custom types. | `world.write` | `weather`, `intensity`, `config?`, `meta?` | `ok` |
| `world.streamFollow` | Stream terrain tiles in a square window around an anchor (agent/camera): generate+apply tiles entering the window, remove tiles leaving a keep-margin. Returns the loaded/removed tile keys. Off-loop in production; synchronous here. | `terrain.generate` | `regionId`, `anchor`, `radius` | `regionId`, `loaded`, `removed`, `active` |

## ECS components

Read and mutate component data on entities.

| Skill | Description | Permissions | Input | Output |
|---|---|---|---|---|
| `ecs.addComponent` | Tag an entity with a named component (e.g. 'target', 'hostile'). | `ecs.modify` | `entity`, `component` | `ok` |
| `ecs.removeComponent` | Remove a named component tag from an entity. | `ecs.modify` | `entity`, `component` | `ok` |
| `ecs.updateComponent` | Set an entity's position [x,y,z], rotation quaternion [x,y,z,w], or scale [x,y,z]. | `ecs.modify` | `entity`, `component`, `value` | `ok` |

## Rendering · Three.js

Transforms, PBR materials, lighting, glTF, and visual effects.

| Skill | Description | Permissions | Input | Output |
|---|---|---|---|---|
| `three.loadGLTF` | Load a glTF/glb model from a sandboxed asset id and add it to the scene at a position. | `scene.write` | `assetId`, `position` | `entity`, `resource` |
| `three.setLighting` | Set scene lighting: one ambient + one directional light, optionally casting real shadow maps. | `scene.write` | `ambientColor`, `ambientIntensity`, `directionalColor`, `directionalIntensity`, `direction`, `castShadow`, `shadowMapSize`, `shadowCameraExtent`, `shadowCameraNear`, `shadowCameraFar`, `shadowBias` | `ok` |
| `three.setMaterial` | Update an entity's PBR material (color, roughness, metalness) and/or shadow participation (castShadow/receiveShadow), across all meshes of a glTF entity. `material` accepts a palette name (optionally procedural-PBR via `pbr: true`) or an imported texture-pack material name (material.import); a PBR/imported material REPLACES the mesh material. | `scene.write` | `entity`, `material?`, `pbr`, `color?`, `roughness?`, `metalness?`, `castShadow?`, `receiveShadow?` | `ok` |
| `three.setTransform` | Set an entity's position, rotation (Euler radians), and/or scale. | `scene.write` | `entity`, `position?`, `rotationEuler?`, `scale?` | `ok` |
| `vfx.atPosition` | Spawn a one-shot particle burst at a world position (explosion, spark, puff, etc.). Spawns REAL particles immediately; the system self-frees once they drain. | `vfx.write` | `position`, `color`, `size`, `lifetime`, `count`, `speed`, `config?`, `meta?` | `ok`, `vfxId` |
| `vfx.attach` | Attach a particle system to an entity. The emitter follows the entity's transform each update (trail, aura, weapon effect), offset by `offset`. | `vfx.write` | `vfxId`, `entity`, `offset`, `meta?` | `ok` |
| `vfx.create` | Create a CPU particle system with full configuration (emitter, lifetime, color, size, velocity, gravity, shape, blend mode). Builds a THREE.Points object on the scene; particles are simulated by the per-frame VFX update. Returns vfx id. | `vfx.write` | `config`, `meta?` | `vfxId` |
| `vfx.destroy` | Destroy a particle system: remove its THREE.Points from the scene and free its geometry/material. | `vfx.write` | `vfxId`, `meta?` | `ok` |
| `vfx.play` | Start emitting particles from a particle system. | `vfx.write` | `vfxId`, `meta?` | `ok` |
| `vfx.stop` | Stop emitting; existing particles age out (a natural fade) instead of vanishing. | `vfx.write` | `vfxId`, `meta?` | `ok` |

## Physics · Rapier

Impulses, raycasts, and collision events from native Rapier.

| Skill | Description | Permissions | Input | Output |
|---|---|---|---|---|
| `physics.applyImpulse` | Apply an impulse [x,y,z] to an entity's dynamic body (wakes it). | `physics.write` | `entity`, `impulse` | `ok` |
| `physics.collisionEvents` | Drain physics collision start/stop events, mapped to entity ids where available. | `physics.read` | — | `events` |
| `physics.raycast` | Cast a ray from origin along direction; returns the first hit (distance, point, entity). | `physics.read` | `origin`, `direction`, `maxDistance` | `hit`, `distance?`, `point?`, `entity?` |

## Player & camera

Player input and movement, character controllers, and camera rigs.

| Skill | Description | Permissions | Input | Output |
|---|---|---|---|---|
| `camera.cut` | Instantly cut the camera to a new position and/or look-at target (cinematic transitions). | `camera.write` | `position?`, `target?`, `meta?` | `ok` |
| `camera.firstPerson` | Set camera to first-person mode on an entity (head position + look rotation from camera.look). | `camera.write` | `target`, `headHeight`, `config?`, `meta?` | `ok` |
| `camera.follow` | Attach a camera to follow an entity with configurable distance, pitch, smoothness, and collision avoidance. Driven by the real third-person orbit rig. | `camera.write` | `target`, `distance`, `pitch`, `smoothness`, `collisionCheck`, `config?`, `meta?` | `ok` |
| `camera.look` | Apply a look rotation (radians) to the active camera. Use with input look axes for mouse/touch control. | `camera.write` | `pitchDelta`, `yawDelta`, `meta?` | `ok` |
| `camera.setFOV` | Set the camera's field of view (applied on the next update). | `camera.write` | `fov`, `transitionMs`, `meta?` | `ok` |
| `camera.shake` | Trigger a camera shake with configurable amplitude, duration (seconds), frequency, and fade. The shake envelope decays deterministically over its duration as update(dt) is pumped. | `camera.write` | `amplitude`, `duration`, `frequency`, `fade`, `meta?` | `ok` |
| `camera.thirdPerson` | Set camera to third-person orbit mode (real ThirdPersonCamera rig) with configurable distance, initial pitch, and pitch/zoom limits. | `camera.write` | `target`, `distance`, `pitch`, `minPitch`, `maxPitch`, `minDistance`, `maxDistance`, `config?`, `meta?` | `ok` |
| `camera.topDown` | Set camera to top-down/isometric view with configurable angle and zoom. | `camera.write` | `target`, `distance`, `angle`, `config?`, `meta?` | `ok` |
| `input.action` | Query whether a bound action is currently active (pressed/held). Reflects the latest native poll or input.set injection. | `player.read` | `name`, `meta?` | `active` |
| `input.axis` | Query a continuous axis value (e.g. moveX, moveY, lookX, lookY). Range is typically -1 to 1. | `player.read` | `name`, `meta?` | `value` |
| `input.bind` | Bind an action or axis name to input sources (keyboard keys, mouse buttons, gamepad axes). Query its state with input.action / input.axis; drive it from the native device (host poll) or inject it with input.set. | `player.configure` | `name`, `sources`, `type`, `meta?` | `ok` |
| `input.set` | Inject the current state of a bound action (boolean) or axis (number) — scripted/agent-driven input. The host's per-frame native poll sets the same names from a real device. | `player.configure` | `name`, `value`, `meta?` | `ok` |
| `player.crouch` | Toggle crouch for a player entity. While on, player.move scales the move input down (a real, slower move) and the reported character height drops to the crouch height. | `player.write` | `entity`, `crouching`, `meta?` | `crouching`, `height` |
| `player.jump` | Trigger a jump on the player's character controller — only takes effect when grounded. Sets the controller's upward velocity (fed through move_character + gravity), NOT a force impulse (a kinematic body ignores impulses). Advances one fixed step; returns whether it jumped + the new position. | `player.write` | `entity`, `meta?` | `jumped`, `grounded`, `newPosition` |
| `player.move` | Advance a player's character controller ONE fixed step from an input command (forward/strafe axes rotated by yaw), resolving collisions, slopes, autostep, snap-to-ground, and gravity. Sprint (player.sprint) raises the speed; crouch (player.crouch) lowers it. Returns the corrected position + grounded. | `player.write` | `entity`, `forward`, `strafe`, `yaw`, `run`, `jump`, `meta?` | `moved`, `grounded`, `newPosition` |
| `player.spawn` | Spawn a kinematic character-controller capsule (Rapier: grounded detection, slope limit, autostep, snap-to-ground, plus controller-integrated gravity + jump) at a position, register it as an entity, and return its entity id + body id. Drive it with player.move / player.jump. | `player.write` | `position`, `halfHeight`, `radius`, `walkSpeed`, `runSpeed`, `gravity`, `jumpSpeed`, `crouchSpeedScale`, `meta?` | `entity`, `bodyId`, `position`, `grounded` |
| `player.sprint` | Toggle sprint for a player entity. While on, player.move runs the controller at run speed (a real, faster move) instead of walk speed. | `player.write` | `entity`, `sprinting`, `meta?` | `sprinting` |

## Animation

Load, play, blend, and drive skeletal animation and emotes.

| Skill | Description | Permissions | Input | Output |
|---|---|---|---|---|
| `animation.blend` | Blend two or more clips with weights (for locomotion: idle/walk/run). Weights are normalized across the set. | `animation.write` | `entity`, `clips`, `meta?` | `ok` |
| `animation.createStateMachine` | Define an animation state machine for an entity: states (clips), conditional transitions, and animator parameters. Starts in the default state. | `animation.write` | `entity`, `name`, `defaultState`, `states`, `transitions`, `parameters`, `meta?` | `ok` |
| `animation.emote` | Play a one-shot emote/expressive animation (wave, point, nod) on a high-priority layer. Fails cleanly (ok:false) when the entity has no glTF object. | `animation.write` | `entity`, `clipId`, `blendDuration`, `meta?` | `ok` |
| `animation.getClipInfo` | Get the current clip id, time, duration, weight, and layer for an entity's running actions (read from the live AnimationActions). | `animation.read` | `entity`, `meta?` | `clips` |
| `animation.load` | Register an animation clip for use. With only metadata it registers a track-less clip the mixer will run; rigged clips come from the entity's glTF (resolved by name at play time) or a programmatic THREE.AnimationClip. | `animation.read` | `id`, `name`, `duration`, `loop`, `frameRate`, `assetId?`, `meta?` | `ok`, `clipId` |
| `animation.play` | Play an animation clip on an entity's mixer with layer, weight, speed, and loop. Fails cleanly (ok:false) when the entity has no glTF object. | `animation.write` | `entity`, `clipId`, `layer`, `weight`, `speed`, `loop`, `fadeDuration`, `meta?` | `ok` |
| `animation.setParam` | Set an animator parameter (bool, float, int, trigger) to drive state-machine transitions (evaluated on update). | `animation.write` | `entity`, `name`, `value`, `meta?` | `ok` |
| `animation.stop` | Stop an animation on an entity (all layers or a specific layer) with optional fade-out. | `animation.write` | `entity`, `layer?`, `fadeOutMs`, `meta?` | `ok` |
| `animation.transition` | Force a state transition in an entity's animation state machine (crossfades to the target state's clip). | `animation.write` | `entity`, `state`, `meta?` | `ok` |

## Interaction & inventory

Interactables, pickups, items, and inventory.

| Skill | Description | Permissions | Input | Output |
|---|---|---|---|---|
| `interaction.close` | Close an open container entity. | `interaction.write` | `entity`, `meta?` | `ok` |
| `interaction.drop` | Drop an item from inventory into the world at the actor's position (or a specified position). Removes it from inventory and spawns a real world item entity, returning its id. | `interaction.write` | `actorEntity`, `itemId`, `slot?`, `position?`, `quantity`, `meta?` | `ok`, `itemEntity?` |
| `interaction.interact` | Perform an interaction with a target entity. Triggers the entity's registered interaction handler. Stamps the interaction tick from the sim tick (replay-deterministic). | `interaction.write` | `entity`, `actorEntity?`, `data?`, `meta?` | `ok`, `result?` |
| `interaction.open` | Open a container entity. Plays open animation/state, enables container interaction. | `interaction.write` | `entity`, `meta?` | `ok` |
| `interaction.pickup` | Pick up an item entity into an inventory slot. Destroys the world item entity. Requires an inventory on the actor. | `interaction.write` | `itemEntity`, `actorEntity`, `slot?`, `meta?` | `ok`, `slot?` |
| `interaction.query` | Query interactable entities within range of a position (or the actor entity), sorted by distance. Uses the world spatial index over real entity transforms. Pure read — emits nothing. | `interaction.read` | `position?`, `actorEntity?`, `maxRange`, `meta?` | `interactables` |
| `interaction.register` | Register an entity as interactable with a prompt, max range, and type. Interactions trigger the entity's handler. | `interaction.configure` | `entity`, `prompt`, `maxRange`, `type`, `action?`, `config?`, `meta?` | `ok` |
| `interaction.toggle` | Toggle an interactable entity between two states (on/off, open/closed, locked/unlocked). | `interaction.write` | `entity`, `meta?` | `ok`, `state` |
| `interaction.use` | Use/consume an item from inventory (eat food, drink potion, use key on door). Consumes the item from the actor's inventory; fails honestly if the actor lacks it. | `interaction.write` | `actorEntity`, `itemId`, `targetEntity?`, `quantity`, `data?`, `meta?` | `ok`, `result?` |
| `inventory.add` | Add an item to an inventory by definition id. Stacks with existing items if stackable; rejects items whose category is not allowed by the inventory's type restrictions (reason: 'type-restricted'). | `inventory.write` | `entity`, `itemId`, `quantity`, `slot?`, `meta?` | `ok`, `slot?`, `reason?` |
| `inventory.count` | Count how many of a specific item are in an inventory (sums across all slots). Pure read. | `inventory.read` | `entity`, `itemId`, `meta?` | `count` |
| `inventory.create` | Create an inventory on an entity with a slot capacity and optional type restrictions. | `inventory.configure` | `entity`, `capacity`, `typeRestrictions?`, `meta?` | `ok` |
| `inventory.has` | Check if an inventory contains a specific item (returns boolean). Pure read. | `inventory.read` | `entity`, `itemId`, `meta?` | `has` |
| `inventory.list` | List all items in an inventory with slot positions and quantities, plus the equipped items by equipment slot. Pure read. | `inventory.read` | `entity`, `meta?` | `items`, `equipment` |
| `inventory.remove` | Remove an item from an inventory by slot index or item id. | `inventory.write` | `entity`, `itemId`, `slot?`, `quantity`, `meta?` | `ok` |
| `inventory.transfer` | Transfer items between two inventories (entity-to-entity). Honours the destination's type restrictions and rolls back if the destination cannot take the items (true no-op on failure). | `inventory.write` | `fromEntity`, `toEntity`, `itemId`, `quantity`, `meta?` | `ok` |
| `item.define` | Define an item type with name, description, stackability, weight, category, usage behavior, and custom config data. | `item.configure` | `id`, `name`, `description`, `icon?`, `stackable`, `maxStack`, `weight`, `category`, `usageBehavior?`, `config?`, `meta?` | `ok` |
| `item.equip` | Equip an item from the inventory into a named equipment slot (moves one unit out of the inventory slots into the equipment slot). | `inventory.write` | `entity`, `itemId`, `equipmentSlot`, `meta?` | `ok` |
| `item.unequip` | Unequip the item in a named equipment slot back into the inventory (rolls back if there is no free inventory slot). | `inventory.write` | `entity`, `equipmentSlot`, `meta?` | `ok` |

## Combat, stats & status

Stats, damage, status effects, and combat.

| Skill | Description | Permissions | Input | Output |
|---|---|---|---|---|
| `combat.defend` | Enter a defensive stance that reduces incoming damage on subsequent damage.apply until it expires. Duration is in seconds, converted to a deterministic tick-expiry window (ctx.tick + duration·60). | `combat.write` | `entity`, `duration`, `damageReduction`, `reflectChance`, `meta?` | `ok`, `expiresTick` |
| `combat.melee` | Perform a melee attack from an entity toward an explicit target. If targetEntity is omitted, no auto-target is performed and hit:false is returned. Crit (optional config.critChance) is derived deterministically from tick+ids (no RNG). | `combat.write` | `attackerEntity`, `targetEntity?`, `damage`, `knockback`, `range`, `config?`, `meta?` | `hit`, `damage?`, `killed?`, `crit?` |
| `combat.ranged` | Fire a ranged attack from an entity. IMPLEMENTATION: an honest IMMEDIATE HIT toward targetEntity via the same damage path as melee (no separate projectile entity); when only a direction is given there is no target to resolve, so it fires into space (hit:false). Crit (optional config.critChance) is deterministic from tick+ids. | `combat.write` | `attackerEntity`, `targetEntity?`, `direction?`, `damage`, `speed`, `config?`, `meta?` | `fired`, `hit`, `damage?`, `killed?`, `crit?` |
| `damage.apply` | Apply damage to an entity. Respects the defense stat and any active defend stance. Returns damage dealt, remaining HP, and whether target was killed. Fires the target's onZero action on the killing blow. | `damage.write` | `targetEntity`, `amount`, `type`, `attackerEntity?`, `config?`, `meta?` | `damage`, `remaining`, `killed` |
| `damage.heal` | Apply healing to an entity (restores HP). Returns the ACTUAL clamped amount healed and the remaining HP. | `damage.write` | `targetEntity`, `amount`, `meta?` | `healed`, `remaining` |
| `stats.create` | Create a stat block on an entity with named stats (HP, stamina, mana, strength, defense, etc.). Each stat has a value, max, and min. | `stats.configure` | `entity`, `stats`, `meta?` | `ok` |
| `stats.get` | Get the current value, max, and min of a stat on an entity. | `stats.read` | `entity`, `statName`, `meta?` | `value`, `maxValue`, `minValue` |
| `stats.modify` | Modify a stat (add, subtract). Clamps to min/max by default. Fires the stat's onZero action if the change drops it to zero. | `stats.write` | `entity`, `statName`, `delta`, `clamp`, `meta?` | `value` |
| `stats.onZero` | Attach a data-driven action to execute when a stat reaches zero (death, depletion, etc.). Stored on the stat block and fired (as stats.onZero.fired) when damage/modify drops the stat to zero. | `stats.configure` | `entity`, `statName`, `action`, `meta?` | `ok` |
| `status.apply` | Apply a status effect to an entity (poison, stun, slow, buff, shield, etc.) with duration and magnitude. | `status.write` | `targetEntity`, `type`, `duration`, `magnitude`, `tickInterval?`, `onApply?`, `onRemove?`, `onTick?`, `config?`, `meta?` | `effectId` |
| `status.list` | List active status effects on an entity. | `status.read` | `targetEntity`, `meta?` | `effects` |
| `status.remove` | Remove a status effect from an entity by effect id. | `status.write` | `targetEntity`, `effectId`, `meta?` | `ok` |

## NPC behavior & dialogue

Behavior trees, dialogue, and navigation/pathfinding for NPCs.

| Skill | Description | Permissions | Input | Output |
|---|---|---|---|---|
| `behavior.assign` | Assign a behavior profile to an NPC entity. | `behavior.write` | `entity`, `profileId`, `meta?` | `ok` |
| `behavior.define` | Define a behavior profile: routines, reactions to events/triggers, and goals for an NPC type. Fully data-driven — agents define arbitrary behavior structures. | `behavior.configure` | `id`, `name`, `routines`, `reactions`, `goals`, `config?`, `meta?` | `ok` |
| `behavior.onEvent` | Attach a behavior reaction to a game event or trigger (on player nearby → approach, on damage → flee). The reaction descriptor is stored on the entity so the decision provider can query and fire it. | `behavior.configure` | `entity`, `trigger`, `action`, `priority`, `cooldown?`, `meta?` | `ok` |
| `behavior.setGoal` | Set an active goal for an NPC (patrol, follow, flee, guard, interact). | `behavior.write` | `entity`, `type`, `target?`, `position?`, `priority`, `config?`, `meta?` | `ok`, `goalId` |
| `dialogue.choose` | Make a choice in an active dialogue. Advances the tree to the next node. | `dialogue.write` | `speaker`, `listener`, `choiceIndex`, `meta?` | `ok`, `node?` |
| `dialogue.define` | Define a dialogue tree: nodes with text, choices, conditions, and effects. Fully data-driven — agents author arbitrary dialogue structures. | `dialogue.configure` | `id`, `name`, `startNode`, `nodes`, `config?`, `meta?` | `ok` |
| `dialogue.end` | End an active dialogue between two entities. | `dialogue.write` | `speaker`, `listener`, `meta?` | `ok` |
| `dialogue.get` | Get the current state of an active dialogue (current node, available choices, history). | `dialogue.read` | `speaker`, `listener`, `meta?` | `currentNode?`, `history` |
| `dialogue.npcSay` | Have an NPC speak a line. Extends social.say with optional dialogue context and mood. | `social.act` | `speaker`, `text`, `mood?`, `dialogueContext?`, `meta?` | `ok` |
| `dialogue.setMood` | Set the mood/tone for an NPC's dialogue. Affects voice, animation, and bubble styling. | `dialogue.write` | `speaker`, `mood`, `meta?` | `ok` |
| `dialogue.start` | Start a dialogue between two entities using a defined dialogue tree. Shows dialogue UI. | `dialogue.write` | `treeId`, `speaker`, `listener`, `meta?` | `ok`, `currentNode?` |
| `navmesh.build` | Build a WALKABLE GRID navmesh over a world-XZ region: rasterise obstacle AABBs / explicit blocked cells / a sampled height field (slope+elevation gating) into a cell grid that findPath/isReachable A* over. CPU grid baseline (no GPU/Rust) — deterministic and replay-safe; upgradeable to a polygon navmesh later. Returns the grid dimensions and walkable/blocked cell counts. | `nav.configure` | `bounds`, `cellSize`, `diagonal`, `agentRadius`, `obstacles?`, `blockedCells?`, `heightField?`, `meta?` | `ok`, `cols`, `rows`, `walkable`, `blocked` |
| `navmesh.findPath` | Find a path between two world positions with deterministic A* over the grid navmesh. Returns the waypoint list (endpoints exact, interior = walkable cell centres) and whether the goal is reachable. Empty path when there is no grid or no route — NO straight-line cheat. | `nav.read` | `from`, `to`, `meta?` | `path`, `reachable` |
| `navmesh.isReachable` | Check (via real A* existence) whether a target is reachable from an entity's current position (body/tracked) or an explicit `from`. Returns false when there is no grid, an endpoint is blocked, or the cells are disconnected. | `nav.read` | `entity?`, `from?`, `to`, `meta?` | `reachable` |
| `navmesh.moveTo` | Advance an entity ONE deterministic step (speed·dt) along an A* path toward a target. Drives op_physics_move_character (kinematic CCT) when the entity has a character body; otherwise steps the ECS transform directly. (Re)plans via A* when the target cell changes. Deterministic — fixed dt (default 1/60), no wall-clock — so a replayed move sequence reaches the identical position. Fails cleanly (ok:false) when there is no grid or no route. | `nav.write` | `entity`, `target`, `speed?`, `dt?`, `from?`, `meta?` | `ok`, `arrived`, `position?`, `remaining?` |
| `navmesh.setSpeed` | Set an entity's movement speed (world units/second) for subsequent navmesh.moveTo steps. | `nav.write` | `entity`, `speed`, `meta?` | `ok` |
| `npc.memorize` | Record a memory/fact for an NPC (saw player at X, heard sound at Y, likes/dislikes Z). | `behavior.write` | `entity`, `key`, `value`, `source?`, `meta?` | `ok` |
| `npc.recall` | Query an NPC's memories (for dialogue or behavior decisions). | `behavior.read` | `entity`, `key?`, `meta?` | `memories` |
| `npc.setAttitude` | Set an NPC's attitude toward another entity (friendly, neutral, hostile). Affects dialogue and behavior. | `behavior.write` | `entity`, `towardEntity`, `attitude`, `meta?` | `ok` |
| `npc.setRoutine` | Set a daily/hourly routine for an NPC (time-based position and activity schedule). | `behavior.write` | `entity`, `routineId`, `meta?` | `ok` |

## Game systems

Game state and rules, quests, triggers and events, and progression.

| Skill | Description | Permissions | Input | Output |
|---|---|---|---|---|
| `event.emit` | Emit a named game event with arbitrary payload. DISPATCHES to every registered listener for that event, returning the matched listeners' action descriptors + a fired count. The bus is the WHEN; the host drives the returned descriptors via the agent's other skills (the WHAT). | `event.write` | `eventName`, `payload`, `meta?` | `ok`, `fired`, `dispatched` |
| `event.listen` | Register a listener for a named game event, storing an action descriptor to dispatch when it fires. Returns a listener handle; use event.remove to unregister. | `event.read` | `eventName`, `action`, `meta?` | `listenerId` |
| `event.remove` | Remove a previously registered event listener. | `event.read` | `listenerId`, `meta?` | `ok` |
| `game.condition` | Define and/or evaluate a named condition (a SAFE boolean expression over game flags/counters/variables — no eval). Fires its onTrue event on the rising edge. | `game.configure` | `name`, `action`, `expression?`, `onTrue?`, `meta?` | `ok`, `value`, `fired` |
| `game.counter` | Get, set, increment, or decrement a named game counter. | `game.write` | `name`, `action`, `value?`, `meta?` | `value` |
| `game.flag` | Get or set a boolean game flag (shorthand for commonly-checked conditions: bossDefeated, doorUnlocked, etc.). | `game.write` | `name`, `value?`, `meta?` | `value` |
| `game.lose` | Trigger the lose condition. Ends the game session with a failure state. | `game.write` | `meta?` | `ok` |
| `game.restart` | Restart the current game session (reset game state to running, clearing run progress). Full world reset requires scene reload. | `game.write` | `meta?` | `ok` |
| `game.state` | Get or set a named game state variable (string, number, bool, or JSON object). | `game.write` | `action`, `name`, `value?`, `meta?` | `value` |
| `game.timer` | Start, pause, resume, query, or TICK named game timers. `tick` advances all timers by an explicit dt (deterministic — no wall-clock) and fires each completed timer's onComplete event. Supports countdown and countup. | `game.write` | `name?`, `action`, `duration?`, `direction`, `dt?`, `onComplete?`, `meta?` | `ok`, `remaining`, `completed` |
| `game.win` | Trigger the win condition. Ends the game session with a victory state. | `game.write` | `meta?` | `ok` |
| `progression.allocate` | Allocate a progression point to a node in a skill tree. Enforces prerequisites and skill-point cost — a blocked allocation returns ok:false (no fake success). | `progression.write` | `entity`, `treeId`, `nodeId`, `meta?` | `ok` |
| `progression.isUnlocked` | Check if an ability, area, item, or skill is unlocked for an entity. Pure read — does not emit. | `progression.read` | `entity`, `id`, `meta?` | `unlocked` |
| `progression.level` | Get an entity's current level and XP progress (computed from the XP curve). Pure read — does not emit. | `progression.read` | `entity`, `meta?` | `level`, `xp`, `xpToNext` |
| `progression.onLevelUp` | Attach a data-driven action to execute when an entity levels up. The action is STORED and re-fired by progression.xp on every subsequent level gain. | `progression.configure` | `entity`, `action`, `meta?` | `ok` |
| `progression.skillTree` | Define a skill/ability tree with prerequisites, costs, max levels, and effects. Fully data-driven. | `progression.configure` | `id`, `name`, `nodes`, `config?`, `meta?` | `ok` |
| `progression.unlock` | Unlock an ability, area, item, or skill for an entity. | `progression.write` | `entity`, `id`, `meta?` | `ok`, `newlyUnlocked` |
| `progression.xp` | Grant XP to an entity. Auto-levels up when the XP threshold is reached and FIRES any attached onLevelUp actions (one progression.levelUp event per level gained). | `progression.write` | `entity`, `amount`, `meta?` | `leveledUp`, `newLevel`, `xp`, `xpToNext`, `levelUps` |
| `quest.accept` | Accept an offered quest (moves it from available to active). | `quest.write` | `entity`, `questId`, `meta?` | `ok` |
| `quest.complete` | Mark an active quest complete (only when its objectives are satisfied, or with force). Stamps completedTick from the current tick and records/emits its rewards and follow-up quests. | `quest.write` | `entity`, `questId`, `force`, `meta?` | `ok`, `rewards`, `followUpQuests` |
| `quest.decline` | Decline an offered quest (removes it from the quest log). | `quest.write` | `entity`, `questId`, `meta?` | `ok` |
| `quest.define` | Define a quest with name, description, objectives, prerequisites, rewards, and follow-up quests. Objectives support custom types via config. | `quest.configure` | `id`, `name`, `description`, `prerequisites`, `objectives`, `rewards`, `followUpQuests`, `config?`, `meta?` | `ok` |
| `quest.fail` | Mark a quest as failed. | `quest.write` | `entity`, `questId`, `meta?` | `ok` |
| `quest.list` | List quests for an entity (active, completed, failed, available), optionally filtered by status. | `quest.read` | `entity`, `status?`, `meta?` | `quests` |
| `quest.offer` | Offer a quest to a player entity. Quest appears in their quest log as available. | `quest.write` | `entity`, `questId`, `meta?` | `ok` |
| `quest.track` | Set a quest as tracked — shows its objectives on the HUD. Untracks all other quests for the entity. | `quest.write` | `entity`, `questId`, `meta?` | `ok` |
| `quest.update` | Update progress on a quest objective. Marks the objective complete at its required count and auto-completes the quest when all objectives are satisfied (stamping completedTick from the current tick). Surfaces rewards/follow-up quests when the quest completes. | `quest.write` | `entity`, `questId`, `objectiveId`, `progress`, `meta?` | `ok`, `completed`, `questCompleted`, `rewards`, `followUpQuests` |
| `trigger.create` | Create a trigger zone (box or sphere) at a position with configurable size. Returns the trigger id for attaching phase actions (onEnter/onExit/onStay). | `trigger.configure` | `shape`, `center`, `size`, `config?`, `meta?` | `triggerId` |
| `trigger.onEnter` | Attach a data-driven action descriptor to fire when an entity ENTERS a trigger zone. The descriptor (emit/setState/spawn/destroy/audio/animation/custom) is the agent-authored WHAT; the trigger pump returns it for the host to drive — it is not executed here. | `trigger.configure` | `triggerId`, `action`, `meta?` | `ok` |
| `trigger.onExit` | Attach an action descriptor to fire when an entity EXITS a trigger zone (returned by the trigger pump for the host to drive). | `trigger.configure` | `triggerId`, `action`, `meta?` | `ok` |
| `trigger.onStay` | Attach an action descriptor to fire each tick an entity STAYS inside a trigger zone (returned by the trigger pump for the host to drive). | `trigger.configure` | `triggerId`, `action`, `meta?` | `ok` |
| `trigger.remove` | Remove a trigger zone and all its attached phase actions. | `trigger.configure` | `triggerId`, `meta?` | `ok` |

## Save & checkpoints

Save, load, and checkpoint world state.

| Skill | Description | Permissions | Input | Output |
|---|---|---|---|---|
| `checkpoint.create` | Create a named checkpoint of the CURRENT world state: every live entity's ECS transform (Position/Rotation/Scale, + body transform when body-bound), the entity-table identity, and the supplied serializable gameState. Restored by checkpoint.load. Does NOT capture native physics body internals or render meshes. | `checkpoint.write` | `name`, `includeGameState`, `includeEntityPositions`, `gameState?`, `meta?` | `ok`, `name`, `entityCount` |
| `checkpoint.delete` | Delete a named checkpoint. | `checkpoint.write` | `name`, `meta?` | `ok` |
| `checkpoint.list` | List available checkpoints for the current session (name, tick, captured entity count). | `checkpoint.read` | `meta?` | `checkpoints` |
| `checkpoint.load` | Restore a named checkpoint: re-issue the entity-table identity, write every captured entity transform back into the world, and return the stored gameState for the caller to re-apply. Native physics bodies, meshes, and closure-bound managers are NOT restored (re-derive those by replaying their authoring skills). | `checkpoint.write` | `name`, `meta?` | `ok`, `checkpoint?`, `gameState?` |
| `save.export` | Export the current world as a save file into a named slot. LOG-FACADE mode (when a recorder is wired): serializes the recorded command stream into a portable export package (the durable world log). SNAPSHOT mode (default): serializes the real world snapshot (entity transforms + identity + gameState). Deterministic — derives its timestamp from the tick, so two exports at the same tick over the same state are byte-identical. | `save.write` | `name`, `gameState?`, `metadata?`, `meta?` | `ok`, `name`, `bytes`, `mode` |
| `save.import` | Import a save file and reconstruct world state. SNAPSHOT saves are restored directly into the world (entity identity + transforms + gameState). LOG saves are loadExport-verified (content hashes) and, when replay factories are wired, replayed into a fresh world via the engine's replayCommands harness; otherwise the verified command count is surfaced for the caller to replay. | `save.write` | `data`, `meta?` | `ok`, `mode?`, `entities?`, `commands?`, `gameState?` |
| `save.slot` | Manage named save slots (persistent across sessions): create/load/delete/list slots holding the real serialized save data produced by save.export. | `save.write` | `action`, `name?`, `data?`, `metadata?`, `meta?` | `ok`, `slots?`, `data?` |

## In-world UI, audio & social

Speech bubbles, labels, HUD panels, spatial audio and TTS, and embodied social acts.

| Skill | Description | Permissions | Input | Output |
|---|---|---|---|---|
| `audio.ambient` | Start a looping synthesized ambience bed on a bus (default ambience). Returns an opaque handle. | `audio.play` | `bus?`, `volume?` | `handle` |
| `audio.play` | Play a one-shot synthesized SFX blip (sine + envelope) on a bus (master/sfx/ambience/voice). Returns an opaque handle. | `audio.play` | `freq`, `secs`, `bus?`, `volume?` | `handle` |
| `audio.playAt` | Play a one-shot POSITIONAL synthesized SFX at a world position; 3D-panned + attenuated relative to the camera listener. Optional maxDistance cutoff. Returns an opaque handle. | `audio.play` | `freq`, `secs`, `position`, `bus?`, `volume?`, `maxDistance?` | `handle` |
| `audio.playBGM` | Schedule background music for the audio backend (looping, volume independent of the SFX bus). Stores the current-track config; the backend consumes it to play. Returns ok:false if the track id is not registered. | `audio.play` | `trackId`, `volume`, `loop`, `config?`, `meta?` | `ok` |
| `audio.playSFX` | Schedule a named sound effect from the SFX library for the audio backend. Returns a DETERMINISTIC handle (derived from the call tick + a monotone sequence) the backend uses to track/stop the instance; replay recomputes the same handle. | `audio.play` | `name`, `position?`, `volume`, `config?`, `meta?` | `ok`, `handle` |
| `audio.setBGM` | Schedule a crossfade from the current BGM to a new track over a duration. Stores the new current-track config; the backend consumes it to crossfade. Returns ok:false if the track id is not registered. | `audio.play` | `trackId`, `duration`, `volume`, `meta?` | `ok` |
| `audio.setBusVolume` | Set a mixer bus volume (master/sfx/ambience/voice), re-gaining all live sounds on it. | `audio.play` | `bus`, `volume` | `ok` |
| `audio.setReverb` | Register a reverb zone (configurable size, decay, damping) for an area. Stores the zone in the reverb manager; the audio backend applies it when the listener is inside. Returns a deterministic zone id. | `audio.play` | `position`, `radius`, `size`, `decay`, `damping`, `meta?` | `zoneId` |
| `audio.setVolume` | Set a playing sound's volume (0..1) by handle. | `audio.play` | `handle`, `volume` | `ok` |
| `audio.speak` | Speak a line of text aloud at a world position via a pluggable local TTS voice (voice bus, positional). FIRE-AND-FORGET: returns immediately; synthesis runs off-thread and never blocks the frame. Returns an opaque handle. | `audio.play` | `text`, `position`, `volume?` | `handle` |
| `audio.stop` | Stop a playing sound by handle. | `audio.play` | `handle` | `ok` |
| `audio.stopBGM` | Schedule a stop/fade-out of the current background music. Clears the stored current-track config; the backend consumes the event to fade out. | `audio.play` | `fadeMs`, `meta?` | `ok` |
| `social.approach` | Walk the calling agent toward a target (an agent id, an entity id, or a world point). Sets the move target the locomotion system pursues; emits social.approached. | `social.act` | `target`, `talkDistance?` | `approaching`, `target` |
| `social.say` | Speak a line as the calling agent: emits social.said (actorId = the host-bound caller) and shows a real speech bubble anchored above the speaker's humanoid (per-speaker queue). | `social.act` | `text`, `actorId?` | `said`, `speaker`, `handle` |
| `ui.callout` | Place an annotation box with a leader line to a target point. | `ui.write` | `anchor`, `style?`, `text?`, `title?`, `lines?`, `maxWidth?`, `width?`, `maxLines?`, `pixelScale?`, `tail?`, `leader?`, `lifecycle?` | `handle` |
| `ui.hudPanel` | Place a screen-anchored HUD/overlay panel (corner-pinned, DPI-aware, over the scene). | `ui.write` | `anchor`, `style?`, `text?`, `title?`, `lines?`, `maxWidth?`, `width?`, `maxLines?`, `pixelScale?`, `tail?`, `leader?`, `lifecycle?` | `handle` |
| `ui.label` | Place a billboard label (minimal chrome) tracking an entity or world point. | `ui.write` | `anchor`, `style?`, `text?`, `title?`, `lines?`, `maxWidth?`, `width?`, `maxLines?`, `pixelScale?`, `tail?`, `leader?`, `lifecycle?` | `handle` |
| `ui.panel` | Author a styled UI container (kind = label/textBox/speechBubble/thoughtBubble/callout/hudPanel) with a full Zod style object, world/screen anchor, optional tail/leader and lifecycle (fade/typewriter/ttl/queue/feed). Returns an opaque handle. | `ui.write` | `kind`, `anchor`, `style?`, `text?`, `title?`, `lines?`, `maxWidth?`, `width?`, `maxLines?`, `pixelScale?`, `tail?`, `leader?`, `lifecycle?` | `handle` |
| `ui.remove` | Remove a live container by handle: detach its mesh from the scene and dispose its GPU resources. | `ui.write` | `handle` | `removed` |
| `ui.speechBubble` | Place a speech bubble with a directional tail aimed at the speaker (entity/point). | `ui.write` | `anchor`, `style?`, `text?`, `title?`, `lines?`, `maxWidth?`, `width?`, `maxLines?`, `pixelScale?`, `tail?`, `leader?`, `lifecycle?` | `handle` |
| `ui.textBox` | Place a titled text box (header bar + wrapped body) at a world or screen anchor. | `ui.write` | `anchor`, `style?`, `text?`, `title?`, `lines?`, `maxWidth?`, `width?`, `maxLines?`, `pixelScale?`, `tail?`, `leader?`, `lifecycle?` | `handle` |
| `ui.thoughtBubble` | Place a thought bubble with trailing puffs leading back to the thinker. | `ui.write` | `anchor`, `style?`, `text?`, `title?`, `lines?`, `maxWidth?`, `width?`, `maxLines?`, `pixelScale?`, `tail?`, `leader?`, `lifecycle?` | `handle` |
| `ui.update` | Update a live container by handle: change its text, title, body lines, and/or restyle it (re-composites). Returns whether the handle existed and re-composited. | `ui.write` | `handle`, `text?`, `title?`, `style?`, `lines?` | `ok`, `changed` |

## Agent / meta

Perception and custom event signals for agents.

| Skill | Description | Permissions | Input | Output |
|---|---|---|---|---|
| `agent.emitEvent` | Emit a custom event into the observability trace (inter-agent or system signal). | `agent.write` | `type`, `payload` | `eventId` |
| `agent.getPerception` | Get the calling agent's current perception (nearby entities + recent events). | `agent.read` | — | `perception` |

## System, packages & audit

Discover skills, tail the trace, snapshot the world, hot-reload, review approvals, audit policy, and load capability packages.

| Skill | Description | Permissions | Input | Output |
|---|---|---|---|---|
| `approval.deny` | Reject a held agent action by id; it is dropped and never applied. | `approval.review` | `approvalId`, `reason?` | `resolved`, `error` |
| `approval.grant` | Approve a held agent action by id; it is applied now and its outcome returned. | `approval.review` | `approvalId` | `resolved`, `applied`, `error` |
| `approval.list` | List agent actions currently held for human approval (id, skill, proposed input, agent). | `approval.review` | — | `pending` |
| `audit.explain` | Answer 'why was action X allowed/denied': the governing policy decision (rule + reason + context + quota/budget), the provenance (agent/session/profile/package), and the causal-parent chain — all from the real recorded trace. | _none_ | `eventId` | `eventId`, `eventType`, `found`, `decision`, `provenance`, `causalTrace` |
| `audit.query` | Query recorded policy decisions: filter by allow/deny, cap, rule, agent, session, or package (package provenance). Returns matching decision events plus an allow/deny + by-rule + by-cap summary. | _none_ | `decision`, `cap?`, `rule?`, `agentId?`, `sessionId?`, `package?`, `limit` | `summary`, `decisions` |
| `audit.usage` | Resource usage from recorded decisions: allowed/denied call counts per session+cap, plus the latest quota and budget snapshots seen for each session — derived from the real policy events. | _none_ | `sessionId?` | `perSessionCap`, `quotas`, `budgets` |
| `dev.reload` | Live-reload a skill (registry unregister+re-register so a later callTool runs the new handler) or re-run a registered scene builder; emits an honest dev.*.reload.completed/.failed trace event listing what was invalidated. Targets that genuinely cannot reload fail honestly instead of pretending success. | `scene.read` | `target`, `name?`, `reason?` | `ok`, `target`, `invalidated`, `reason?` |
| `inspector.snapshot` | Return a bounded, paginated snapshot of world, entities, agents, skills, permissions, resources, and trace metadata. | `scene.read` `ecs.read` `physics.read` `agent.read` | `afterEntity?`, `limit` | `page`, `world`, `entities`, `agents`, `skills`, `permissions`, `resources`, `trace` |
| `package.list` | List installed packages with their manifest provenance: ref (name@version), kind, declared capabilities, engine-compat range, content hash, and whether the package is attested. | _none_ | `name?` | `packages` |
| `package.load` | Load an installed package (by name@version ref) under a profile: validates the manifest, checks engine-compat (out-of-bounds rejected), gates declared-vs-granted capabilities via the policy engine (over-claim denied), and loads the untrusted entry into the M6 sandbox. Returns the load decision + provenance event id. | `agent.write` | `ref`, `agentId`, `sessionId`, `profile` | `ok`, `ref`, `agentId`, `rule`, `rejectReason`, `reason`, `loadEventId` |
| `skills.browse` | Browse the AUTHORIZED skills in a specific category — progressive discovery of a large catalog. | _none_ | `category`, `limit?` | `tools` |
| `skills.describe` | Describe a skill: version, category, and JSON-Schema input. | _none_ | `name` | `name`, `version`, `category`, `description`, `input_schema` |
| `skills.list` | List the skills the caller is authorized to invoke (names + descriptions). `mode:"bootstrap"` returns only the small CORE surface an agent starts with (discover the rest via skills.search/browse); `mode:"full"` (default) lists everything authorized. | _none_ | `mode?` | `tools` |
| `skills.search` | Search the AUTHORIZED skills by name/description (+ optional category) — browse a large catalog instead of listing everything. | _none_ | `query`, `category?`, `limit?` | `matches` |
| `trace.explainEvent` | Explain a trace event with resolved causal parents and children. | `trace.read` | `eventId` | `event`, `parents`, `children` |
| `trace.export` | Flush the durable trace history to a sandboxed trace JSONL file. | `trace.read` | `name` | `name`, `events`, `bytes` |
| `trace.tail` | Tail trace events with cursor pagination and optional actor/type filters. | `trace.read` | `afterSeq?`, `limit?`, `actorId?`, `type?` | `events`, `nextAfterSeq` |

---

Input field types, defaults, and full JSON Schema for every skill live in [`/agents/skills.json`](/agents/skills.json). To call these over the wire, see [Agent Builders](/building-agents/builders).
