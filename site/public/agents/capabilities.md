# Limina capability catalog

Engine version: 0.1.0+769bc2d
Generated: 2026-07-12T07:26:47.772Z
Generated from: the live skill registry (`js/src/skills/*` via `tools/dump-skills.ts`) — this file cannot drift from the engine because it is built from the same registry the binary boots.
Regenerate: `node tools/dump-skills.mjs` (requires `cargo build --release` first).

235 skills across 31 categories. Each skill is a typed, permissioned, recorded mutation invoked via `SkillRegistry.invoke` and maps 1:1 to an MCP tool of the same name. Full JSON Schema (draft-07) for every input/output lives in the sibling `skills.json`.

Permission profiles:

- `builder.readWrite`: `authoring.read` `authoring.write` `scene.read` `scene.write` `ecs.read` `ecs.modify` `physics.read` `physics.write` `agent.read` `agent.write` `ui.write` `audio.play` `terrain.read` `terrain.generate` `player.read` `player.write` `player.configure` `camera.write` `animation.read` `animation.write` `interaction.read` `interaction.write` `interaction.configure` `inventory.read` `inventory.write` `inventory.configure` `item.configure` `game.write` `game.configure` `trigger.configure` `event.read` `event.write` `quest.read` `quest.write` `quest.configure` `stats.read` `stats.write` `stats.configure` `damage.write` `status.read` `status.write` `combat.write` `behavior.read` `behavior.write` `behavior.configure` `dialogue.read` `dialogue.write` `dialogue.configure` `nav.read` `nav.write` `nav.configure` `vfx.write` `checkpoint.read` `checkpoint.write` `save.write` `progression.read` `progression.write` `progression.configure` `world.read` `world.write` `design.read` `design.write` `catalog.read`
- `player.full`: `scene.read` `ecs.read` `physics.read` `physics.write` `agent.read` `terrain.read` `player.read` `player.write` `player.configure` `camera.write` `animation.read` `interaction.read` `interaction.write` `inventory.read` `dialogue.read`
- `player.limited`: `scene.read` `ecs.read` `physics.read` `physics.write` `agent.read` `agent.write` `terrain.read` `player.read` `player.write` `camera.write` `interaction.read` `interaction.write` `inventory.read` `inventory.write` `game.write` `quest.read` `stats.read` `status.read` `behavior.read` `dialogue.read` `dialogue.write` `nav.read` `nav.write` `checkpoint.read` `checkpoint.write` `progression.read` `world.read`
- `npc.agent`: `scene.read` `ecs.read` `physics.read` `agent.read` `agent.write` `social.act` `audio.play` `behavior.read` `behavior.write` `dialogue.read` `dialogue.write` `dialogue.configure` `nav.read` `nav.write` `stats.read` `stats.write` `stats.configure` `damage.write` `status.read` `status.write` `combat.write` `animation.read` `animation.write` `inventory.read` `interaction.read`
- `game.author`: `game.write` `game.configure` `design.read` `design.write` `quest.read` `quest.write` `quest.configure` `trigger.configure` `event.read` `event.write` `stats.configure` `scene.read` `ecs.read` `physics.read` `agent.read`
- `combat.writer`: `combat.write` `damage.write` `status.read` `status.write` `stats.read` `stats.write` `scene.read` `ecs.read` `physics.read`
- `vfx.writer`: `vfx.write` `animation.write` `scene.read` `ecs.read`
- `world.author`: `world.write` `checkpoint.read` `checkpoint.write` `design.read` `design.write` `save.write` `scene.read` `ecs.read` `physics.read`
- `terrain.author`: `authoring.read` `authoring.write` `scene.read` `scene.write` `ecs.read` `ecs.modify` `physics.read` `physics.write` `terrain.read` `terrain.generate`
- `social.actor`: `scene.read` `ecs.read` `physics.read` `agent.read` `agent.write` `social.act` `audio.play`
- `system.readonly`: `scene.read` `ecs.read` `physics.read` `agent.read` `trace.read` `design.read` `runtime.derived.read`
- `system.admin`: `system.admin` `scene.read` `ecs.read` `physics.read` `agent.read` `trace.read` `design.read`
- `system.derived-build`: `authoring.read` `authoring.write`
- `builder.review`: `authoring.read` `authoring.write` `scene.read` `scene.write` `ecs.read` `ecs.modify` `physics.read` `physics.write` `agent.read` `agent.write` `ui.write` `audio.play` `design.read` `design.write` `catalog.read`
- `reviewer`: `authoring.read` `scene.read` `ecs.read` `physics.read` `agent.read` `approval.review` `trace.read` `design.read` `catalog.read` `runtime.derived.read`
- `reviewer.coordinator`: `orchestrate` `approval.review` `scene.read` `ecs.read` `physics.read` `agent.read` `trace.read`

---

## agent (6)

### `agent.emitEvent` (v1.0.0)

Emit a custom event into the observability trace (inter-agent or system signal).

- Permissions: `agent.write`
- Priority: `standard`
- Input: `type: string`, `payload: object={}`
- Output: `eventId: string`

### `agent.getPerception` (v1.0.0)

Get the calling agent's current perception (nearby entities + recent events).

- Permissions: `agent.read`
- Priority: `standard`
- Input: _none_
- Output: `perception: any`

### `director.configure` (v1.0.0)

Configure the AI director's pacing model (build/fade rates, sustain/rest durations, peak/rest levels, pressure damping) and reset its state. Deterministic, tick-driven.

- Permissions: `agent.write`
- Priority: `standard`
- Input: `buildRate?: number>0,<=1`, `fadeRate?: number>0,<=1`, `sustainTicks?: integer>=0,<=100000`, `restTicks?: integer>=0,<=100000`, `peakLevel?: number>0,<=1`, `restLevel?: number>=0,<=1`, `pressureDamping?: number>=0,<=1`, `meta?: object`
- Output: `ok: boolean`, `config: {buildRate,fadeRate,sustainTicks,restTicks,peakLevel,restLevel,pressureDamping}`

### `director.start` (v1.0.0)

Start (or restart) the AI director from a fresh build_up. The host pumps director tick(simTick, pressure) each step and dispatches the returned directives.

- Permissions: `agent.write`
- Priority: `standard`
- Input: `meta?: object`
- Output: `ok: boolean`

### `director.status` (v1.0.0)

Read the director's current phase, tension, and ticks left in the phase. Pure read.

- Permissions: `agent.read`
- Priority: `standard`
- Input: _none_
- Output: `running: boolean`, `phase?: enum(build_up|sustain|fade|rest)`, `tension?: number`, `phaseTicksLeft?: number`

### `director.stop` (v1.0.0)

Stop the AI director (no-op if not running).

- Permissions: `agent.write`
- Priority: `standard`
- Input: `meta?: object`
- Output: `ok: boolean`, `wasRunning: boolean`


## animation (11)

### `animation.authorClip` (v1.0.0)

Author a procedural animation clip from keyframe tracks (property → {t,value} keys, step/linear). Sample it with animation.sampleClip; the host applies the values. Deterministic + replay-safe.

- Permissions: `animation.write`
- Priority: `standard`
- Input: `id: string`, `duration: number>0,<=100000`, `loop: boolean=false`, `tracks: {property,interp,keys}[]`, `meta?: object`
- Output: `ok: boolean`, `tracks: number`, `keys: number`

### `animation.blend` (v1.0.0)

Blend two or more clips with weights (for locomotion: idle/walk/run). Weights are normalized across the set.

- Permissions: `animation.write`
- Priority: `standard`
- Input: `entity: string`, `clips: {clipId,weight,speed,layer}[]`, `meta?: object`
- Output: `ok: boolean`

### `animation.createStateMachine` (v1.0.0)

Define an animation state machine for an entity: states (clips), conditional transitions, and animator parameters. Starts in the default state.

- Permissions: `animation.write`
- Priority: `standard`
- Input: `entity: string`, `name: string`, `defaultState: string`, `states: {name,clipId,speed,layer}[]`, `transitions: {from,to,conditions,duration}[]=[]`, `parameters: {name,type,defaultValue}[]=[]`, `meta?: object`
- Output: `ok: boolean`

### `animation.emote` (v1.0.0)

Play a one-shot emote/expressive animation (wave, point, nod) on a high-priority layer. Fails cleanly (ok:false) when the entity has no glTF object.

- Permissions: `animation.write`
- Priority: `standard`
- Input: `entity: string`, `clipId: string`, `blendDuration: number>=0=0.1`, `meta?: object`
- Output: `ok: boolean`

### `animation.getClipInfo` (v1.0.0)

Get the current clip id, time, duration, weight, and layer for an entity's running actions (read from the live AnimationActions).

- Permissions: `animation.read`
- Priority: `standard`
- Input: `entity: string`, `meta?: object`
- Output: `clips: {clipId,time,duration,weight,layer}[]`

### `animation.load` (v1.0.0)

Register an animation clip for use. With only metadata it registers a track-less clip the mixer will run; rigged clips come from the entity's glTF (resolved by name at play time) or a programmatic THREE.AnimationClip.

- Permissions: `animation.read`
- Priority: `standard`
- Input: `id: string`, `name: string`, `duration: number>0`, `loop: boolean=false`, `frameRate: number>0=30`, `assetId?: string`, `meta?: object`
- Output: `ok: boolean`, `clipId: string`

### `animation.play` (v1.0.0)

Play an animation clip on an entity's mixer with layer, weight, speed, and loop. Fails cleanly (ok:false) when the entity has no glTF object.

- Permissions: `animation.write`
- Priority: `standard`
- Input: `entity: string`, `clipId: string`, `layer: integer>=-9007199254740991,<=9007199254740991=0`, `weight: number>=0,<=1=1`, `speed: number=1`, `loop: boolean=true`, `fadeDuration: number>=0=0`, `meta?: object`
- Output: `ok: boolean`

### `animation.sampleClip` (v1.0.0)

Sample an authored clip at time t — returns each track's interpolated value (looped/clamped per the clip). Pure read; the host applies the values to entities.

- Permissions: `animation.read`
- Priority: `standard`
- Input: `id: string`, `t: number`
- Output: `found: boolean`, `values?: object`

### `animation.setParam` (v1.0.0)

Set an animator parameter (bool, float, int, trigger) to drive state-machine transitions (evaluated on update).

- Permissions: `animation.write`
- Priority: `standard`
- Input: `entity: string`, `name: string`, `value: number|boolean`, `meta?: object`
- Output: `ok: boolean`

### `animation.stop` (v1.0.0)

Stop an animation on an entity (all layers or a specific layer) with optional fade-out.

- Permissions: `animation.write`
- Priority: `standard`
- Input: `entity: string`, `layer?: integer>=-9007199254740991,<=9007199254740991`, `fadeOutMs: number>=0=0`, `meta?: object`
- Output: `ok: boolean`

### `animation.transition` (v1.0.0)

Force a state transition in an entity's animation state machine (crossfades to the target state's clip).

- Permissions: `animation.write`
- Priority: `standard`
- Input: `entity: string`, `state: string`, `meta?: object`
- Output: `ok: boolean`


## audio (12)

### `audio.ambient` (v1.0.0)

Start a looping synthesized ambience bed on a bus (default ambience). Returns an opaque handle.

- Permissions: `audio.play`
- Priority: `standard`
- Input: `bus?: enum(master|sfx|ambience|voice)`, `volume?: number>=0,<=1`
- Output: `handle: string`

### `audio.play` (v1.0.0)

Play a one-shot synthesized SFX blip (sine + envelope) on a bus (master/sfx/ambience/voice). Returns an opaque handle.

- Permissions: `audio.play`
- Priority: `standard`
- Input: `freq: number>0`, `secs: number>0,<=10`, `bus?: enum(master|sfx|ambience|voice)`, `volume?: number>=0,<=1`
- Output: `handle: string`

### `audio.playAt` (v1.0.0)

Play a one-shot POSITIONAL synthesized SFX at a world position; 3D-panned + attenuated relative to the camera listener. Optional maxDistance cutoff. Returns an opaque handle.

- Permissions: `audio.play`
- Priority: `standard`
- Input: `freq: number>0`, `secs: number>0,<=10`, `position: [number,number,number]`, `bus?: enum(master|sfx|ambience|voice)`, `volume?: number>=0,<=1`, `maxDistance?: number>=0`
- Output: `handle: string`

### `audio.playBGM` (v1.0.0)

Schedule background music for the audio backend (looping, volume independent of the SFX bus). Stores the current-track config; the backend consumes it to play. Returns ok:false if the track id is not registered.

- Permissions: `audio.play`
- Priority: `standard`
- Input: `trackId: string`, `volume: number>=0,<=1=0.5`, `loop: boolean=true`, `config?: object`, `meta?: object`
- Output: `ok: boolean`

### `audio.playSFX` (v1.0.0)

Schedule a named sound effect from the SFX library for the audio backend. Returns a DETERMINISTIC handle (derived from the call tick + a monotone sequence) the backend uses to track/stop the instance; replay recomputes the same handle.

- Permissions: `audio.play`
- Priority: `standard`
- Input: `name: string`, `position?: [number,number,number]`, `volume: number>=0,<=1=0.8`, `config?: object`, `meta?: object`
- Output: `ok: boolean`, `handle: string`

### `audio.setBGM` (v1.0.0)

Schedule a crossfade from the current BGM to a new track over a duration. Stores the new current-track config; the backend consumes it to crossfade. Returns ok:false if the track id is not registered.

- Permissions: `audio.play`
- Priority: `standard`
- Input: `trackId: string`, `duration: number>0=1`, `volume: number>=0,<=1=0.5`, `meta?: object`
- Output: `ok: boolean`

### `audio.setBusVolume` (v1.0.0)

Set a mixer bus volume (master/sfx/ambience/voice), re-gaining all live sounds on it.

- Permissions: `audio.play`
- Priority: `standard`
- Input: `bus: enum(master|sfx|ambience|voice)`, `volume: number>=0,<=1`
- Output: `ok: boolean`

### `audio.setReverb` (v1.0.0)

Register a reverb zone (configurable size, decay, damping) for an area. Stores the zone in the reverb manager; the audio backend applies it when the listener is inside. Returns a deterministic zone id.

- Permissions: `audio.play`
- Priority: `standard`
- Input: `position: [number,number,number]`, `radius: number>0`, `size: number>0=1`, `decay: number>0=1`, `damping: number>=0,<=1=0.5`, `meta?: object`
- Output: `zoneId: string`

### `audio.setVolume` (v1.0.0)

Set a playing sound's volume (0..1) by handle.

- Permissions: `audio.play`
- Priority: `standard`
- Input: `handle: string`, `volume: number>=0,<=1`
- Output: `ok: boolean`

### `audio.speak` (v1.0.0)

Speak a line of text aloud at a world position via a pluggable local TTS voice (voice bus, positional). FIRE-AND-FORGET: returns immediately; synthesis runs off-thread and never blocks the frame. Returns an opaque handle.

- Permissions: `audio.play`
- Priority: `standard`
- Input: `text: string`, `position: [number,number,number]`, `volume?: number>=0,<=1`
- Output: `handle: string`

### `audio.stop` (v1.0.0)

Stop a playing sound by handle.

- Permissions: `audio.play`
- Priority: `standard`
- Input: `handle: string`
- Output: `ok: boolean`

### `audio.stopBGM` (v1.0.0)

Schedule a stop/fade-out of the current background music. Clears the stored current-track config; the backend consumes the event to fade out.

- Permissions: `audio.play`
- Priority: `standard`
- Input: `fadeMs: number>=0=500`, `meta?: object`
- Output: `ok: boolean`


## behavior (8)

### `behavior.assign` (v1.0.0)

Assign a behavior profile to an NPC entity.

- Permissions: `behavior.write`
- Priority: `standard`
- Input: `entity: string`, `profileId: string`, `meta?: object`
- Output: `ok: boolean`

### `behavior.define` (v1.0.0)

Define a behavior profile: routines, reactions to events/triggers, and goals for an NPC type. Fully data-driven — agents define arbitrary behavior structures.

- Permissions: `behavior.configure`
- Priority: `standard`
- Input: `id: string`, `name: string`, `routines: {id,name,schedule,config}[]=[]`, `reactions: {trigger,action,priority,cooldown,config}[]=[]`, `goals: {id,type,target,position,priority,config}[]=[]`, `config?: object`, `meta?: object`
- Output: `ok: boolean`

### `behavior.onEvent` (v1.0.0)

Attach a behavior reaction to a game event or trigger (on player nearby → approach, on damage → flee). The reaction descriptor is stored on the entity so the decision provider can query and fire it.

- Permissions: `behavior.configure`
- Priority: `standard`
- Input: `entity: string`, `trigger: string`, `action: {type,data}`, `priority: integer>=-9007199254740991,<=9007199254740991=0`, `cooldown?: number>0`, `meta?: object`
- Output: `ok: boolean`

### `behavior.setGoal` (v1.0.0)

Set an active goal for an NPC (patrol, follow, flee, guard, interact).

- Permissions: `behavior.write`
- Priority: `standard`
- Input: `entity: string`, `type: enum(patrol|follow|flee|guard|interact|custom)`, `target?: string`, `position?: [number,number,number]`, `priority: integer>=-9007199254740991,<=9007199254740991=0`, `config?: object`, `meta?: object`
- Output: `ok: boolean`, `goalId: string`

### `npc.memorize` (v1.0.0)

Record a memory/fact for an NPC (saw player at X, heard sound at Y, likes/dislikes Z).

- Permissions: `behavior.write`
- Priority: `standard`
- Input: `entity: string`, `key: string`, `value: any`, `source?: string`, `meta?: object`
- Output: `ok: boolean`

### `npc.recall` (v1.0.0)

Query an NPC's memories (for dialogue or behavior decisions).

- Permissions: `behavior.read`
- Priority: `standard`
- Input: `entity: string`, `key?: string`, `meta?: object`
- Output: `memories: {key,value,tick,source}[]`

### `npc.setAttitude` (v1.0.0)

Set an NPC's attitude toward another entity (friendly, neutral, hostile). Affects dialogue and behavior.

- Permissions: `behavior.write`
- Priority: `standard`
- Input: `entity: string`, `towardEntity: string`, `attitude: enum(friendly|neutral|hostile)`, `meta?: object`
- Output: `ok: boolean`

### `npc.setRoutine` (v1.0.0)

Set a daily/hourly routine for an NPC (time-based position and activity schedule).

- Permissions: `behavior.write`
- Priority: `standard`
- Input: `entity: string`, `routineId: string`, `meta?: object`
- Output: `ok: boolean`


## camera (8)

### `camera.cut` (v1.0.0)

Instantly cut the camera to a new position and/or look-at target (cinematic transitions).

- Permissions: `camera.write`
- Priority: `standard`
- Input: `position?: [number,number,number]`, `target?: [number,number,number]`, `meta?: object`
- Output: `ok: boolean`

### `camera.firstPerson` (v1.0.0)

Set camera to first-person mode on an entity (head position + look rotation from camera.look).

- Permissions: `camera.write`
- Priority: `standard`
- Input: `target: string`, `headHeight: number>0=1.6`, `config?: object`, `meta?: object`
- Output: `ok: boolean`

### `camera.follow` (v1.0.0)

Attach a camera to follow an entity with configurable distance, pitch, smoothness, and collision avoidance. Driven by the real third-person orbit rig.

- Permissions: `camera.write`
- Priority: `standard`
- Input: `target: string`, `distance: number>0,<=100=5`, `pitch: number>=-1.5,<=1.5=0.4`, `smoothness: number>=0,<=1=0.08`, `collisionCheck: boolean=true`, `config?: object`, `meta?: object`
- Output: `ok: boolean`

### `camera.look` (v1.0.0)

Apply a look rotation (radians) to the active camera. Use with input look axes for mouse/touch control.

- Permissions: `camera.write`
- Priority: `standard`
- Input: `pitchDelta: number=0`, `yawDelta: number=0`, `meta?: object`
- Output: `ok: boolean`

### `camera.setFOV` (v1.0.0)

Set the camera's field of view (applied on the next update).

- Permissions: `camera.write`
- Priority: `standard`
- Input: `fov: number>=10,<=120`, `transitionMs: number>=0,<=2000=0`, `meta?: object`
- Output: `ok: boolean`

### `camera.shake` (v1.0.0)

Trigger a camera shake with configurable amplitude, duration (seconds), frequency, and fade. The shake envelope decays deterministically over its duration as update(dt) is pumped.

- Permissions: `camera.write`
- Priority: `standard`
- Input: `amplitude: number>0=0.1`, `duration: number>0,<=5=0.3`, `frequency: number>0=30`, `fade: boolean=true`, `meta?: object`
- Output: `ok: boolean`

### `camera.thirdPerson` (v1.0.0)

Set camera to third-person orbit mode (real ThirdPersonCamera rig) with configurable distance, initial pitch, and pitch/zoom limits.

- Permissions: `camera.write`
- Priority: `standard`
- Input: `target: string`, `distance: number>0,<=100=5`, `pitch: number>=-1.5,<=1.5=0.4`, `minPitch: number=-1.4`, `maxPitch: number=1.4`, `minDistance: number>0=1`, `maxDistance: number>0=20`, `config?: object`, `meta?: object`
- Output: `ok: boolean`

### `camera.topDown` (v1.0.0)

Set camera to top-down/isometric view with configurable angle and zoom.

- Permissions: `camera.write`
- Priority: `standard`
- Input: `target: string`, `distance: number>0,<=100=10`, `angle: number>=0.1,<=1.5=0.785`, `config?: object`, `meta?: object`
- Output: `ok: boolean`


## combat (6)

### `ability.cast` (v1.0.0)

Attempt to cast an ability: gated by cooldown (from the sim tick) and resource cost. On success stamps the cooldown and spends the resource; on failure returns ok:false with a reason (on cooldown / insufficient resource / unknown). The host performs the effect.

- Permissions: `combat.write`
- Priority: `standard`
- Input: `entity: string`, `id: string`, `meta?: object`
- Output: `ok: boolean`, `reason?: string`, `cooldownRemaining?: number`, `spent?: number`

### `ability.define` (v1.0.0)

Define an ability with a cooldown and an optional resource cost (a stat the cast spends). What the ability DOES is dispatched by the host on a successful cast.

- Permissions: `combat.write`
- Priority: `standard`
- Input: `id: string`, `cooldownTicks: integer>=0,<=1000000`, `resourceStat?: string`, `cost?: number>=0`, `meta?: object`
- Output: `ok: boolean`

### `ability.status` (v1.0.0)

Read whether an ability is defined, off cooldown (ready), and how many ticks remain on its cooldown for an entity, at the current sim tick. Pure read.

- Permissions: `stats.read`
- Priority: `standard`
- Input: `entity: string`, `id: string`
- Output: `defined: boolean`, `ready: boolean`, `cooldownRemaining: number`

### `combat.defend` (v1.0.0)

Enter a defensive stance that reduces incoming damage on subsequent damage.apply until it expires. Duration is in seconds, converted to a deterministic tick-expiry window (ctx.tick + duration·60).

- Permissions: `combat.write`
- Priority: `standard`
- Input: `entity: string`, `duration: number>0=1`, `damageReduction: number>=0,<=1=0.5`, `reflectChance: number>=0,<=1=0`, `meta?: object`
- Output: `ok: boolean`, `expiresTick: number`

### `combat.melee` (v1.0.0)

Perform a melee attack from an entity toward an explicit target. If targetEntity is omitted, no auto-target is performed and hit:false is returned. Crit (optional config.critChance) is derived deterministically from tick+ids (no RNG).

- Permissions: `combat.write`
- Priority: `standard`
- Input: `attackerEntity: string`, `targetEntity?: string`, `damage: number>0`, `knockback: number>=0=0`, `range: number>0=2`, `config?: object`, `meta?: object`
- Output: `hit: boolean`, `damage?: number`, `killed?: boolean`, `crit?: boolean`

### `combat.ranged` (v1.0.0)

Fire a ranged attack from an entity. IMPLEMENTATION: an honest IMMEDIATE HIT toward targetEntity via the same damage path as melee (no separate projectile entity); when only a direction is given there is no target to resolve, so it fires into space (hit:false). Crit (optional config.critChance) is deterministic from tick+ids.

- Permissions: `combat.write`
- Priority: `standard`
- Input: `attackerEntity: string`, `targetEntity?: string`, `direction?: [number,number,number]`, `damage: number>0`, `speed: number>0=20`, `config?: object`, `meta?: object`
- Output: `fired: boolean`, `hit: boolean`, `damage?: number`, `killed?: boolean`, `crit?: boolean`


## damage (2)

### `damage.apply` (v1.0.0)

Apply damage to an entity. Respects the defense stat and any active defend stance. Returns damage dealt, remaining HP, and whether target was killed. Fires the target's onZero action on the killing blow.

- Permissions: `damage.write`
- Priority: `standard`
- Input: `targetEntity: string`, `amount: number>0`, `type: enum(physical|magic|fire|ice|lightning|poison|custom)="physical"`, `attackerEntity?: string`, `config?: object`, `meta?: object`
- Output: `damage: number`, `remaining: number`, `killed: boolean`

### `damage.heal` (v1.0.0)

Apply healing to an entity (restores HP). Returns the ACTUAL clamped amount healed and the remaining HP.

- Permissions: `damage.write`
- Priority: `standard`
- Input: `targetEntity: string`, `amount: number>0`, `meta?: object`
- Output: `healed: number`, `remaining: number`


## design (3)

### `design.get` (v1.0.0)

Read a first-class design artifact from the world without recording a mutation.

- Permissions: `design.read`
- Priority: `standard`
- Input: `artifact: enum(gds|artDirection|worldBible|cast|storyboard)`
- Output: `artifact: enum(gds|artDirection|worldBible|cast|storyboard)`, `value: any`

### `design.patch` (v1.0.0)

Deep-merge a patch into a design artifact, then revalidate and store the canonical value.

- Permissions: `design.write`
- Priority: `standard`
- Input: `artifact: enum(gds|artDirection|worldBible|cast|storyboard)`, `patch: object`
- Output: `artifact: enum(gds|artDirection|worldBible|cast|storyboard)`, `value: any`

### `design.set` (v1.0.0)

Set a first-class design artifact on the world after schema validation and canonicalization.

- Permissions: `design.write`
- Priority: `standard`
- Input: `artifact: enum(gds|artDirection|worldBible|cast|storyboard)`, `value: any`
- Output: `artifact: enum(gds|artDirection|worldBible|cast|storyboard)`, `value: any`


## dialogue (7)

### `dialogue.choose` (v1.0.0)

Make a choice in an active dialogue. Advances the tree to the next node.

- Permissions: `dialogue.write`
- Priority: `standard`
- Input: `speaker: string`, `listener: string`, `choiceIndex: integer>=0,<=9007199254740991`, `meta?: object`
- Output: `ok: boolean`, `node?: {id,text,choices}`

### `dialogue.define` (v1.0.0)

Define a dialogue tree: nodes with text, choices, conditions, and effects. Fully data-driven — agents author arbitrary dialogue structures.

- Permissions: `dialogue.configure`
- Priority: `standard`
- Input: `id: string`, `name: string`, `startNode: string`, `nodes: {id,text,speaker,mood,choices,effects,config}[]`, `config?: object`, `meta?: object`
- Output: `ok: boolean`

### `dialogue.end` (v1.0.0)

End an active dialogue between two entities.

- Permissions: `dialogue.write`
- Priority: `standard`
- Input: `speaker: string`, `listener: string`, `meta?: object`
- Output: `ok: boolean`

### `dialogue.get` (v1.0.0)

Get the current state of an active dialogue (current node, available choices, history).

- Permissions: `dialogue.read`
- Priority: `standard`
- Input: `speaker: string`, `listener: string`, `meta?: object`
- Output: `currentNode?: {id,text,choices}`, `history: {nodeId,choiceIndex}[]`

### `dialogue.npcSay` (v1.0.0)

Have an NPC speak a line. Extends social.say with optional dialogue context and mood.

- Permissions: `social.act`
- Priority: `standard`
- Input: `speaker: string`, `text: string`, `mood?: string`, `dialogueContext?: string`, `meta?: object`
- Output: `ok: boolean`

### `dialogue.setMood` (v1.0.0)

Set the mood/tone for an NPC's dialogue. Affects voice, animation, and bubble styling.

- Permissions: `dialogue.write`
- Priority: `standard`
- Input: `speaker: string`, `mood: string`, `meta?: object`
- Output: `ok: boolean`

### `dialogue.start` (v1.0.0)

Start a dialogue between two entities using a defined dialogue tree. Shows dialogue UI.

- Permissions: `dialogue.write`
- Priority: `core`
- Input: `treeId: string`, `speaker: string`, `listener: string`, `meta?: object`
- Output: `ok: boolean`, `currentNode?: {id,text,choices}`


## ecs (5)

### `behavior.set` (v1.0.0)

Attach a declarative BehaviorSpec (idle / patrol / wander / script) to an entity as first-class world state. It lands on the entity (like three.setMaterial), so it survives on a mesh-less / asset-backed entity and rides a self-sufficient snapshot. Behaviour is a whole value — this REPLACES any prior behaviour. Runtime execution (the NPC actually moving) is a later phase; this records the intent.

- Permissions: `scene.write`
- Priority: `standard`
- Input: `entity: string`, `behavior: {version,kind}|{version,kind,waypoints,speed,loop}|{version,kind,radius,speed}|{version,kind,ref,params}`
- Output: `entity: string`, `ok: boolean`, `kind: string`

### `ecs.addComponent` (v1.0.0)

Tag an entity with a named component (e.g. 'target', 'hostile').

- Permissions: `ecs.modify`
- Priority: `standard`
- Input: `entity: string`, `component: string`
- Output: `ok: boolean`

### `ecs.removeComponent` (v1.0.0)

Remove a named component tag from an entity.

- Permissions: `ecs.modify`
- Priority: `standard`
- Input: `entity: string`, `component: string`
- Output: `ok: boolean`

### `ecs.updateComponent` (v1.0.0)

Set an entity's position [x,y,z], rotation quaternion [x,y,z,w], or scale [x,y,z]. (To move/reposition an existing entity, scene.moveEntity is the friendlier tool.)

- Permissions: `ecs.modify`
- Priority: `core`
- Input: `entity: string`, `component: enum(position|rotation|scale)`, `value: number[]`
- Output: `ok: boolean`

### `event.define` (v1.0.0)

Register a world-level declarative EventSpec {trigger, action} (e.g. onTick/onEnterRegion/onInteract → emit/setBehavior/spawn). Stored in the world's event registry and carried by a self-sufficient snapshot; recorded through invoke so a replay rebuilds the same events. This is the FORMAT + registration; firing the events at runtime is a later phase.

- Permissions: `scene.write`
- Priority: `standard`
- Input: `event: {version,trigger,action}`
- Output: `id: string`


## event (3)

### `event.emit` (v1.0.0)

Emit a named game event with arbitrary payload. DISPATCHES to every registered listener for that event, returning the matched listeners' action descriptors + a fired count. The bus is the WHEN; the host drives the returned descriptors via the agent's other skills (the WHAT).

- Permissions: `event.write`
- Priority: `standard`
- Input: `eventName: string`, `payload: object={}`, `meta?: object`
- Output: `ok: boolean`, `fired: integer>=-9007199254740991,<=9007199254740991`, `dispatched: {listenerId,eventName,action}[]`

### `event.listen` (v1.0.0)

Register a listener for a named game event, storing an action descriptor to dispatch when it fires. Returns a listener handle; use event.remove to unregister.

- Permissions: `event.read`
- Priority: `standard`
- Input: `eventName: string`, `action: {type,target,data}`, `meta?: object`
- Output: `listenerId: string`

### `event.remove` (v1.0.0)

Remove a previously registered event listener.

- Permissions: `event.read`
- Priority: `standard`
- Input: `listenerId: string`, `meta?: object`
- Output: `ok: boolean`


## game (12)

### `cutscene.define` (v1.0.0)

Author a scripted timeline as keyframes ({atTick, action}). The host pumps it and dispatches each fired action through its other skills. Deterministic (tick-driven).

- Permissions: `game.configure`
- Priority: `standard`
- Input: `id: string`, `keyframes: {atTick,action}[]`, `loop: boolean=false`, `meta?: object`
- Output: `ok: boolean`, `keyframes: number`, `durationTicks: number`

### `cutscene.play` (v1.0.0)

Start playing a defined cutscene, anchoring its timeline at startTick (default: the current sim tick). Supersedes any in-progress playback. On failure returns ok:false with a reason.

- Permissions: `game.write`
- Priority: `standard`
- Input: `id: string`, `startTick?: integer>=0,<=9007199254740991`, `meta?: object`
- Output: `ok: boolean`, `reason?: string`

### `cutscene.status` (v1.0.0)

Read the current cutscene playback state (playing, id, progress). Pure read.

- Permissions: `scene.read`
- Priority: `standard`
- Input: _none_
- Output: `playing: boolean`, `id?: string`, `startTick?: number`, `firedThrough?: number`, `total?: number`, `loop?: boolean`

### `cutscene.stop` (v1.0.0)

Stop the active cutscene playback (no-op if none is playing).

- Permissions: `game.write`
- Priority: `standard`
- Input: `meta?: object`
- Output: `ok: boolean`, `wasPlaying: boolean`

### `game.condition` (v1.0.0)

Define and/or evaluate a named condition (a SAFE boolean expression over game flags/counters/variables — no eval). Fires its onTrue event on the rising edge.

- Permissions: `game.configure`
- Priority: `standard`
- Input: `name: string`, `action: enum(define|evaluate)="define"`, `expression?: string`, `onTrue?: string`, `meta?: object`
- Output: `ok: boolean`, `value: boolean`, `fired: boolean`

### `game.counter` (v1.0.0)

Get, set, increment, or decrement a named game counter.

- Permissions: `game.write`
- Priority: `standard`
- Input: `name: string`, `action: enum(get|set|increment|decrement)="get"`, `value?: integer>=-9007199254740991,<=9007199254740991`, `meta?: object`
- Output: `value: number`

### `game.flag` (v1.0.0)

Get or set a boolean game flag (shorthand for commonly-checked conditions: bossDefeated, doorUnlocked, etc.).

- Permissions: `game.write`
- Priority: `standard`
- Input: `name: string`, `value?: boolean`, `meta?: object`
- Output: `value: boolean`

### `game.lose` (v1.0.0)

Trigger the lose condition. Ends the game session with a failure state.

- Permissions: `game.write`
- Priority: `standard`
- Input: `meta?: object`
- Output: `ok: boolean`

### `game.restart` (v1.0.0)

Restart the current game session (reset game state to running, clearing run progress). Full world reset requires scene reload.

- Permissions: `game.write`
- Priority: `standard`
- Input: `meta?: object`
- Output: `ok: boolean`

### `game.state` (v1.0.0)

Get or set a named game state variable (string, number, bool, or JSON object).

- Permissions: `game.write`
- Priority: `standard`
- Input: `action: enum(get|set)="get"`, `name: string`, `value?: string|number|boolean|object`, `meta?: object`
- Output: `value: any`

### `game.timer` (v1.0.0)

Start, pause, resume, query, or TICK named game timers. `tick` advances all timers by an explicit dt (deterministic — no wall-clock) and fires each completed timer's onComplete event. Supports countdown and countup.

- Permissions: `game.write`
- Priority: `standard`
- Input: `name?: string`, `action: enum(start|pause|resume|get|tick)="start"`, `duration?: number>0`, `direction: enum(countdown|countup)="countdown"`, `dt?: number>=0`, `onComplete?: string`, `meta?: object`
- Output: `ok: boolean`, `remaining: number`, `completed: string[]`

### `game.win` (v1.0.0)

Trigger the win condition. Ends the game session with a victory state.

- Permissions: `game.write`
- Priority: `standard`
- Input: `meta?: object`
- Output: `ok: boolean`


## interaction (9)

### `interaction.close` (v1.0.0)

Close an open container entity.

- Permissions: `interaction.write`
- Priority: `standard`
- Input: `entity: string`, `meta?: object`
- Output: `ok: boolean`

### `interaction.drop` (v1.0.0)

Drop an item from inventory into the world at the actor's position (or a specified position). Removes it from inventory and spawns a real world item entity, returning its id. On failure returns ok:false with a `reason`.

- Permissions: `interaction.write`
- Priority: `standard`
- Input: `actorEntity: string`, `itemId: string`, `slot?: integer>=0,<=9007199254740991`, `position?: [number,number,number]`, `quantity: integer>=1,<=9007199254740991=1`, `meta?: object`
- Output: `ok: boolean`, `itemEntity?: string`, `reason?: string`

### `interaction.interact` (v1.0.0)

Perform an interaction with a target entity. Triggers the entity's registered interaction handler. Stamps the interaction tick from the sim tick (replay-deterministic).

- Permissions: `interaction.write`
- Priority: `core`
- Input: `entity: string`, `actorEntity?: string`, `data?: object`, `meta?: object`
- Output: `ok: boolean`, `result?: object`

### `interaction.open` (v1.0.0)

Open a container entity. Plays open animation/state, enables container interaction.

- Permissions: `interaction.write`
- Priority: `standard`
- Input: `entity: string`, `meta?: object`
- Output: `ok: boolean`

### `interaction.pickup` (v1.0.0)

Pick up an item entity into an inventory slot. Destroys the world item entity. Requires an inventory on the actor. On failure returns ok:false with a `reason` the caller can act on.

- Permissions: `interaction.write`
- Priority: `standard`
- Input: `itemEntity: string`, `actorEntity: string`, `slot?: integer>=0,<=9007199254740991`, `meta?: object`
- Output: `ok: boolean`, `slot?: number`, `reason?: string`

### `interaction.query` (v1.0.0)

Query interactable entities within range of a position (or the actor entity), sorted by distance. Uses the world spatial index over real entity transforms. Pure read — emits nothing.

- Permissions: `interaction.read`
- Priority: `standard`
- Input: `position?: [number,number,number]`, `actorEntity?: string`, `maxRange: number>0=5`, `meta?: object`
- Output: `interactables: {entity,prompt,type,distance}[]`

### `interaction.register` (v1.0.0)

Register an entity as interactable with a prompt, max range, and type. Interactions trigger the entity's handler.

- Permissions: `interaction.configure`
- Priority: `standard`
- Input: `entity: string`, `prompt: string`, `maxRange: number>0=3`, `type: enum(pickup|use|talk|open|toggle|custom)="custom"`, `action?: string`, `config?: object`, `meta?: object`
- Output: `ok: boolean`

### `interaction.toggle` (v1.0.0)

Toggle an interactable entity between two states (on/off, open/closed, locked/unlocked).

- Permissions: `interaction.write`
- Priority: `standard`
- Input: `entity: string`, `meta?: object`
- Output: `ok: boolean`, `state: object`

### `interaction.use` (v1.0.0)

Use/consume an item from inventory (eat food, drink potion, use key on door). Consumes the item from the actor's inventory; fails honestly if the actor lacks it.

- Permissions: `interaction.write`
- Priority: `standard`
- Input: `actorEntity: string`, `itemId: string`, `targetEntity?: string`, `quantity: integer>=1,<=9007199254740991=1`, `data?: object`, `meta?: object`
- Output: `ok: boolean`, `result?: object`, `reason?: string`


## inventory (10)

### `inventory.add` (v1.0.0)

Add an item to an inventory by definition id. Stacks with existing items if stackable; rejects items whose category is not allowed by the inventory's type restrictions (reason: 'type-restricted').

- Permissions: `inventory.write`
- Priority: `core`
- Input: `entity: string`, `itemId: string`, `quantity: integer>=1,<=9007199254740991=1`, `slot?: integer>=0,<=9007199254740991`, `meta?: object`
- Output: `ok: boolean`, `slot?: number`, `reason?: string`

### `inventory.count` (v1.0.0)

Count how many of a specific item are in an inventory (sums across all slots). Pure read.

- Permissions: `inventory.read`
- Priority: `standard`
- Input: `entity: string`, `itemId: string`, `meta?: object`
- Output: `count: number`

### `inventory.create` (v1.0.0)

Create an inventory on an entity with a slot capacity and optional type restrictions.

- Permissions: `inventory.configure`
- Priority: `standard`
- Input: `entity: string`, `capacity: integer>=1,<=200=20`, `typeRestrictions?: string[]`, `meta?: object`
- Output: `ok: boolean`

### `inventory.has` (v1.0.0)

Check if an inventory contains a specific item (returns boolean). Pure read.

- Permissions: `inventory.read`
- Priority: `standard`
- Input: `entity: string`, `itemId: string`, `meta?: object`
- Output: `has: boolean`

### `inventory.list` (v1.0.0)

List all items in an inventory with slot positions and quantities, plus the equipped items by equipment slot. Pure read.

- Permissions: `inventory.read`
- Priority: `standard`
- Input: `entity: string`, `meta?: object`
- Output: `items: {itemId,quantity,slot,equipped}[]`, `equipment: {equipmentSlot,itemId,quantity}[]`

### `inventory.remove` (v1.0.0)

Remove an item from an inventory by slot index or item id.

- Permissions: `inventory.write`
- Priority: `standard`
- Input: `entity: string`, `itemId: string`, `slot?: integer>=0,<=9007199254740991`, `quantity: integer>=1,<=9007199254740991=1`, `meta?: object`
- Output: `ok: boolean`

### `inventory.transfer` (v1.0.0)

Transfer items between two inventories (entity-to-entity). Honours the destination's type restrictions and rolls back if the destination cannot take the items (true no-op on failure).

- Permissions: `inventory.write`
- Priority: `standard`
- Input: `fromEntity: string`, `toEntity: string`, `itemId: string`, `quantity: integer>=1,<=9007199254740991=1`, `meta?: object`
- Output: `ok: boolean`

### `item.define` (v1.0.0)

Define an item type with name, description, stackability, weight, category, usage behavior, and custom config data.

- Permissions: `item.configure`
- Priority: `standard`
- Input: `id: string`, `name: string`, `description: string=""`, `icon?: string`, `stackable: boolean=true`, `maxStack: integer>=1,<=9007199254740991=99`, `weight: number>=0=1`, `category: string="general"`, `usageBehavior?: string`, `config?: object`, `meta?: object`
- Output: `ok: boolean`

### `item.equip` (v1.0.0)

Equip an item from the inventory into a named equipment slot (moves one unit out of the inventory slots into the equipment slot).

- Permissions: `inventory.write`
- Priority: `standard`
- Input: `entity: string`, `itemId: string`, `equipmentSlot: string`, `meta?: object`
- Output: `ok: boolean`

### `item.unequip` (v1.0.0)

Unequip the item in a named equipment slot back into the inventory (rolls back if there is no free inventory slot).

- Permissions: `inventory.write`
- Priority: `standard`
- Input: `entity: string`, `equipmentSlot: string`, `meta?: object`
- Output: `ok: boolean`


## nav (7)

### `gazetteer.load` (v1.0.0)

Load the named-place index (gazetteer) from a compiled WorldMap asset so npc.goToPlace can resolve place ids to world positions. Reads the asset with the synchronous sandboxed op_read_asset (same as terrain.create) — never async I/O. REPLACES any previously-loaded gazetteer. A map with no gazetteer loads an empty index (count 0). Recorded + replay-safe: replay re-reads the same committed asset.

- Permissions: `nav.configure`
- Priority: `standard`
- Input: `mapAssetId: string`, `meta?: object`
- Output: `ok: boolean`, `count: integer>=-9007199254740991,<=9007199254740991`

### `navmesh.build` (v1.0.0)

Build a WALKABLE GRID navmesh over a world-XZ region: rasterise obstacle AABBs / explicit blocked cells / a sampled height field (slope+elevation gating) into a cell grid that findPath/isReachable A* over. CPU grid baseline (no GPU/Rust) — deterministic and replay-safe; upgradeable to a polygon navmesh later. Returns the grid dimensions and walkable/blocked cell counts.

- Permissions: `nav.configure`
- Priority: `standard`
- Input: `bounds: {minX,minZ,maxX,maxZ}`, `cellSize: number>0`, `diagonal: boolean=false`, `agentRadius: number>=0=0`, `obstacles?: {minX,minZ,maxX,maxZ}[]`, `blockedCells?: [integer>=-9007199254740991,<=9007199254740991,integer>=-9007199254740991,<=9007199254740991][]`, `heightField?: {heights,maxSlope,minY,maxY}`, `meta?: object`
- Output: `ok: boolean`, `cols: integer>=-9007199254740991,<=9007199254740991`, `rows: integer>=-9007199254740991,<=9007199254740991`, `walkable: integer>=-9007199254740991,<=9007199254740991`, `blocked: integer>=-9007199254740991,<=9007199254740991`

### `navmesh.findPath` (v1.0.0)

Find a path between two world positions with deterministic A* over the grid navmesh. Returns the waypoint list (endpoints exact, interior = walkable cell centres) and whether the goal is reachable. Empty path when there is no grid or no route — NO straight-line cheat.

- Permissions: `nav.read`
- Priority: `standard`
- Input: `from: [number,number,number]`, `to: [number,number,number]`, `meta?: object`
- Output: `path: [number,number,number][]`, `reachable: boolean`

### `navmesh.isReachable` (v1.0.0)

Check (via real A* existence) whether a target is reachable from an entity's current position (body/tracked) or an explicit `from`. Returns false when there is no grid, an endpoint is blocked, or the cells are disconnected.

- Permissions: `nav.read`
- Priority: `standard`
- Input: `entity?: string`, `from?: [number,number,number]`, `to: [number,number,number]`, `meta?: object`
- Output: `reachable: boolean`

### `navmesh.moveTo` (v1.0.0)

Advance an entity ONE deterministic step (speed·dt) along an A* path toward a target. Drives op_physics_move_character (kinematic CCT) when the entity has a character body; otherwise steps the ECS transform directly. (Re)plans via A* when the target cell changes. Deterministic — fixed dt (default 1/60), no wall-clock — so a replayed move sequence reaches the identical position. Fails cleanly (ok:false) when there is no grid or no route.

- Permissions: `nav.write`
- Priority: `standard`
- Input: `entity: string`, `target: [number,number,number]`, `speed?: number>0`, `dt?: number>0`, `from?: [number,number,number]`, `meta?: object`
- Output: `ok: boolean`, `arrived: boolean`, `position?: [number,number,number]`, `remaining?: number`

### `navmesh.setSpeed` (v1.0.0)

Set an entity's movement speed (world units/second) for subsequent navmesh.moveTo steps.

- Permissions: `nav.write`
- Priority: `standard`
- Input: `entity: string`, `speed: number>0`, `meta?: object`
- Output: `ok: boolean`

### `npc.goToPlace` (v1.0.0)

Advance an entity ONE deterministic navmesh step toward a NAMED place (resolved via the loaded gazetteer) instead of raw coordinates. Delegates to navmesh.moveTo (real A* / CCT) — the caller loops until `arrived`. The target keeps the entity's own height (the gazetteer is 2D), so movement is horizontal. Returns resolved:false (ok:false) when the place id is unknown or the gazetteer is not loaded.

- Permissions: `nav.write`
- Priority: `core`
- Input: `entity: string`, `placeId: string`, `speed?: number>0`, `dt?: number>0`, `from?: [number,number,number]`, `meta?: object`
- Output: `ok: boolean`, `arrived: boolean`, `resolved: boolean`, `placeId: string`, `position?: [number,number,number]`, `remaining?: number`, `target?: [number,number,number]`


## physics (3)

### `physics.applyImpulse` (v1.0.0)

Apply an impulse [x,y,z] to an entity's dynamic body (wakes it).

- Permissions: `physics.write`
- Priority: `standard`
- Input: `entity: string`, `impulse: [number,number,number]`
- Output: `ok: boolean`

### `physics.collisionEvents` (v1.0.0)

Drain physics collision start/stop events, mapped to entity ids where available.

- Permissions: `physics.read`
- Priority: `standard`
- Input: _none_
- Output: `events: {started,bodyA,bodyB,entityA,entityB,point,normal}[]`, `dropped: integer>=0,<=9007199254740991`

### `physics.raycast` (v1.0.0)

Cast a ray from origin along direction; returns the first hit (distance, point, entity).

- Permissions: `physics.read`
- Priority: `standard`
- Input: `origin: [number,number,number]`, `direction: [number,number,number]`, `maxDistance: number>0=1000`
- Output: `hit: boolean`, `distance?: number`, `point?: [number,number,number]`, `entity?: string`


## player (9)

### `input.action` (v1.0.0)

Query whether a bound action is currently active (pressed/held). Reflects the latest native poll or input.set injection.

- Permissions: `player.read`
- Priority: `standard`
- Input: `name: string`, `meta?: object`
- Output: `active: boolean`

### `input.axis` (v1.0.0)

Query a continuous axis value (e.g. moveX, moveY, lookX, lookY). Range is typically -1 to 1.

- Permissions: `player.read`
- Priority: `standard`
- Input: `name: string`, `meta?: object`
- Output: `value: number`

### `input.bind` (v1.0.0)

Bind an action or axis name to input sources (keyboard keys, mouse buttons, gamepad axes). Query its state with input.action / input.axis; drive it from the native device (host poll) or inject it with input.set.

- Permissions: `player.configure`
- Priority: `standard`
- Input: `name: string`, `sources: string[]`, `type: enum(action|axis)="action"`, `meta?: object`
- Output: `ok: boolean`

### `input.set` (v1.0.0)

Inject the current state of a bound action (boolean) or axis (number) — scripted/agent-driven input. The host's per-frame native poll sets the same names from a real device.

- Permissions: `player.configure`
- Priority: `standard`
- Input: `name: string`, `value: boolean|number`, `meta?: object`
- Output: `ok: boolean`

### `player.crouch` (v1.0.0)

Toggle crouch for a player entity. While on, player.move scales the move input down (a real, slower move) and the reported character height drops to the crouch height.

- Permissions: `player.write`
- Priority: `standard`
- Input: `entity: string`, `crouching: boolean=true`, `meta?: object`
- Output: `crouching: boolean`, `height: number`

### `player.jump` (v1.0.0)

Apply the player's vertical action for one fixed step: jump when grounded or accelerate toward the surface while swimming. Uses controller velocity, not a force impulse (kinematic bodies ignore impulses).

- Permissions: `player.write`
- Priority: `core`
- Input: `entity: string`, `meta?: object`
- Output: `jumped: boolean`, `grounded: boolean`, `newPosition: [number,number,number]`, `swimming: boolean`, `submerged: boolean`, `waterMode: enum(dry|wading|swimming)`

### `player.move` (v1.0.0)

Advance a player's character controller ONE fixed step from an input command (forward/strafe axes rotated by yaw), resolving ground or swim movement. Sprint raises ground speed but is ignored while swimming; crouch lowers horizontal input. Returns position, grounded, and water state.

- Permissions: `player.write`
- Priority: `core`
- Input: `entity: string`, `forward: number>=-1,<=1=0`, `strafe: number>=-1,<=1=0`, `yaw: number=0`, `run: boolean=false`, `jump: boolean=false`, `meta?: object`
- Output: `moved: boolean`, `grounded: boolean`, `newPosition: [number,number,number]`, `swimming: boolean`, `submerged: boolean`, `waterMode: enum(dry|wading|swimming)`

### `player.spawn` (v1.0.0)

Spawn a kinematic character-controller capsule (Rapier: grounded detection, slope limit, autostep, snap-to-ground, plus controller-integrated gravity + jump) at a position, register it as an entity, and return its entity id + body id. Drive it with player.move / player.jump.

- Permissions: `player.write`
- Priority: `standard`
- Input: `position: [number,number,number]`, `halfHeight: number>0=0.6`, `radius: number>0=0.3`, `walkSpeed: number>0=3`, `runSpeed: number>0=6`, `gravity: number>0=22`, `jumpSpeed: number>0=8`, `swimSpeed: number=3`, `buoyancyGain: number=18`, `waterDrag: number=6`, `maxSwimVerticalSpeed: number=4`, `crouchSpeedScale: number>0,<=1=0.5`, `meta?: object`
- Output: `entity: string`, `bodyId: number`, `position: [number,number,number]`, `grounded: boolean`, `swimming: boolean`, `submerged: boolean`, `waterMode: enum(dry|wading|swimming)`

### `player.sprint` (v1.0.0)

Toggle sprint for a player entity. While on, ground movement uses run speed instead of walk speed; swimming deliberately ignores it.

- Permissions: `player.write`
- Priority: `standard`
- Input: `entity: string`, `sprinting: boolean=true`, `meta?: object`
- Output: `sprinting: boolean`


## progression (7)

### `progression.allocate` (v1.0.0)

Allocate a progression point to a node in a skill tree. Enforces prerequisites and skill-point cost — a blocked allocation returns ok:false (no fake success).

- Permissions: `progression.write`
- Priority: `standard`
- Input: `entity: string`, `treeId: string`, `nodeId: string`, `meta?: object`
- Output: `ok: boolean`

### `progression.isUnlocked` (v1.0.0)

Check if an ability, area, item, or skill is unlocked for an entity. Pure read — does not emit.

- Permissions: `progression.read`
- Priority: `standard`
- Input: `entity: string`, `id: string`, `meta?: object`
- Output: `unlocked: boolean`

### `progression.level` (v1.0.0)

Get an entity's current level and XP progress (computed from the XP curve). Pure read — does not emit.

- Permissions: `progression.read`
- Priority: `standard`
- Input: `entity: string`, `meta?: object`
- Output: `level: number`, `xp: number`, `xpToNext: number`

### `progression.onLevelUp` (v1.0.0)

Attach a data-driven action to execute when an entity levels up. The action is STORED and re-fired by progression.xp on every subsequent level gain.

- Permissions: `progression.configure`
- Priority: `standard`
- Input: `entity: string`, `action: {type,data}`, `meta?: object`
- Output: `ok: boolean`

### `progression.skillTree` (v1.0.0)

Define a skill/ability tree with prerequisites, costs, max levels, and effects. Fully data-driven.

- Permissions: `progression.configure`
- Priority: `standard`
- Input: `id: string`, `name: string`, `nodes: {id,name,description,prerequisites,cost,maxLevel,effects,config}[]`, `config?: object`, `meta?: object`
- Output: `ok: boolean`

### `progression.unlock` (v1.0.0)

Unlock an ability, area, item, or skill for an entity.

- Permissions: `progression.write`
- Priority: `standard`
- Input: `entity: string`, `id: string`, `meta?: object`
- Output: `ok: boolean`, `newlyUnlocked: boolean`

### `progression.xp` (v1.0.0)

Grant XP to an entity. Auto-levels up when the XP threshold is reached and FIRES any attached onLevelUp actions (one progression.levelUp event per level gained).

- Permissions: `progression.write`
- Priority: `standard`
- Input: `entity: string`, `amount: integer>=1,<=9007199254740991`, `meta?: object`
- Output: `leveledUp: boolean`, `newLevel: number`, `xp: number`, `xpToNext: number`, `levelUps: {level,actions}[]`


## quest (9)

### `quest.accept` (v1.0.0)

Accept an offered quest (moves it from available to active).

- Permissions: `quest.write`
- Priority: `standard`
- Input: `entity: string`, `questId: string`, `meta?: object`
- Output: `ok: boolean`

### `quest.complete` (v1.0.0)

Mark an active quest complete (only when its objectives are satisfied, or with force). Stamps completedTick from the current tick and records/emits its rewards and follow-up quests.

- Permissions: `quest.write`
- Priority: `standard`
- Input: `entity: string`, `questId: string`, `force: boolean=false`, `meta?: object`
- Output: `ok: boolean`, `rewards: object`, `followUpQuests: string[]`

### `quest.decline` (v1.0.0)

Decline an offered quest (removes it from the quest log).

- Permissions: `quest.write`
- Priority: `standard`
- Input: `entity: string`, `questId: string`, `meta?: object`
- Output: `ok: boolean`

### `quest.define` (v1.0.0)

Define a quest with name, description, objectives, prerequisites, rewards, and follow-up quests. Objectives support custom types via config.

- Permissions: `quest.configure`
- Priority: `standard`
- Input: `id: string`, `name: string`, `description: string=""`, `prerequisites: string[]=[]`, `objectives: {id,type,description,target,required,config}[]`, `rewards: object={}`, `followUpQuests: string[]=[]`, `config?: object`, `meta?: object`
- Output: `ok: boolean`

### `quest.fail` (v1.0.0)

Mark a quest as failed.

- Permissions: `quest.write`
- Priority: `standard`
- Input: `entity: string`, `questId: string`, `meta?: object`
- Output: `ok: boolean`

### `quest.list` (v1.0.0)

List quests for an entity (active, completed, failed, available), optionally filtered by status.

- Permissions: `quest.read`
- Priority: `standard`
- Input: `entity: string`, `status?: enum(available|active|completed|failed)`, `meta?: object`
- Output: `quests: {questId,status,objectives,tracked,offeredTick,acceptedTick,completedTick,failedTick}[]`

### `quest.offer` (v1.0.0)

Offer a quest to a player entity. Quest appears in their quest log as available.

- Permissions: `quest.write`
- Priority: `standard`
- Input: `entity: string`, `questId: string`, `meta?: object`
- Output: `ok: boolean`

### `quest.track` (v1.0.0)

Set a quest as tracked — shows its objectives on the HUD. Untracks all other quests for the entity.

- Permissions: `quest.write`
- Priority: `standard`
- Input: `entity: string`, `questId: string`, `meta?: object`
- Output: `ok: boolean`

### `quest.update` (v1.0.0)

Update progress on a quest objective. Marks the objective complete at its required count and auto-completes the quest when all objectives are satisfied (stamping completedTick from the current tick). Surfaces rewards/follow-up quests when the quest completes.

- Permissions: `quest.write`
- Priority: `standard`
- Input: `entity: string`, `questId: string`, `objectiveId: string`, `progress: integer>=0,<=9007199254740991`, `meta?: object`
- Output: `ok: boolean`, `completed: boolean`, `questCompleted: boolean`, `rewards: object`, `followUpQuests: string[]`


## save (7)

### `checkpoint.create` (v1.0.0)

Create a named checkpoint of the CURRENT world state: every live entity's ECS transform (Position/Rotation/Scale, + body transform when body-bound), the entity-table identity, and the supplied serializable gameState. Restored by checkpoint.load. Does NOT capture native physics body internals or render meshes.

- Permissions: `checkpoint.write`
- Priority: `standard`
- Input: `name: string`, `includeGameState: boolean=true`, `includeEntityPositions: boolean=true`, `gameState?: object`, `meta?: object`
- Output: `ok: boolean`, `name: string`, `entityCount: number`

### `checkpoint.delete` (v1.0.0)

Delete a named checkpoint.

- Permissions: `checkpoint.write`
- Priority: `standard`
- Input: `name: string`, `meta?: object`
- Output: `ok: boolean`

### `checkpoint.list` (v1.0.0)

List available checkpoints for the current session (name, tick, captured entity count).

- Permissions: `checkpoint.read`
- Priority: `standard`
- Input: `meta?: object`
- Output: `checkpoints: {name,tick,entityCount}[]`

### `checkpoint.load` (v1.0.0)

Restore a named checkpoint: re-issue the entity-table identity, write every captured entity transform back into the world, and return the stored gameState for the caller to re-apply. Native physics bodies, meshes, and closure-bound managers are NOT restored (re-derive those by replaying their authoring skills).

- Permissions: `checkpoint.write`
- Priority: `standard`
- Input: `name: string`, `meta?: object`
- Output: `ok: boolean`, `checkpoint?: {name,tick,entityCount}`, `gameState?: object`

### `save.export` (v1.0.0)

Export the current world as a save file into a named slot. LOG-FACADE mode (when a recorder is wired): serializes the recorded command stream into a portable export package (the durable world log). SNAPSHOT mode (default): serializes the real world snapshot (entity transforms + identity + gameState). Deterministic — derives its timestamp from the tick, so two exports at the same tick over the same state are byte-identical.

- Permissions: `save.write`
- Priority: `standard`
- Input: `name: string`, `gameState?: object`, `metadata?: object`, `meta?: object`
- Output: `ok: boolean`, `name: string`, `bytes: number`, `mode: enum(log|snapshot)`

### `save.import` (v1.0.0)

Import a save file and reconstruct world state. SNAPSHOT saves are restored directly into the world (entity identity + transforms + gameState). LOG saves are loadExport-verified (content hashes) and, when replay factories are wired, replayed into a fresh world via the engine's replayCommands harness; otherwise the verified command count is surfaced for the caller to replay.

- Permissions: `save.write`
- Priority: `standard`
- Input: `data: string`, `meta?: object`
- Output: `ok: boolean`, `mode?: enum(log|snapshot)`, `entities?: number`, `commands?: number`, `gameState?: object`

### `save.slot` (v1.0.0)

Manage named save slots (persistent across sessions): create/load/delete/list slots holding the real serialized save data produced by save.export.

- Permissions: `save.write`
- Priority: `standard`
- Input: `action: enum(create|load|delete|list)="list"`, `name?: string`, `data?: string`, `metadata?: object`, `meta?: object`
- Output: `ok: boolean`, `slots?: {name,gameTick,metadata}[]`, `data?: string`


## scene (12)

### `architecture.building` (v2.0.0)

Procedurally raise an enterable building (relief timber-frame walls, plaster infill, plinth, slate gable roof, a doorway with a stoop) as real collidable entities parented under one building-root. Kit-backed + Design-Direction-materialed; deterministic + replay-safe. Compose repeatedly to build settlements.

- Permissions: `scene.write`
- Priority: `standard`
- Input: `position: [number,number,number]=[0,0,0]`, `width: number>0,<=200=8`, `depth: number>0,<=200=6`, `height: number>0,<=80=3.2`, `rotation: number=0`, `wallThickness: number>0,<=5=0.25`, `doorWidth: number>0,<=50=1.4`, `doorHeight: number>0,<=70=2.2`, `withRoof: boolean=true`, `roofStyle: enum(gable|flat)="gable"`, `roofPitch: number>0,<=40=2.2`, `roofOverhang: number>=0,<=5=0.35`, `seed?: number`, `meta?: object`
- Output: `entities: string[]`, `parts: {kind,entity,position,size}[]`, `bounds: {min,max}`, `entityCount: number`, `root: string`

### `building.assemble` (v1.0.0)

Raise a kit-composed building (relief timber-frame walls, sills/lintels, plinth, gable roof) from a declarative recipe as real collidable entities parented under one building-root. Deterministic + replay-safe; on-brief materials from the active Design Direction. Openings are genuine voids. Re-invoke to STAMP the same building elsewhere.

- Permissions: `scene.write`
- Priority: `standard`
- Input: `position: [number,number,number]=[0,0,0]`, `width: number>0,<=200=8`, `depth: number>0,<=200=6`, `height: number>0,<=80=3.2`, `wallThickness?: number>0,<=5`, `openings?: {wall,kind,offset,width,height,sill}[]`, `roof?: {type,pitch,overhang,cover,bargeboards}|null`, `rotation?: number`, `plinth?: boolean`, `construction?: enum(timber-frame-daub|stone-base-timber-upper|cut-stone|cob|log)`, `baseCourse?: number>=0,<=40`, `baseRole?: enum(stone|wood|foliage|ground|water|metal|accent|trim|skin|sky|slate)`, `seed?: number`
- Output: `root: string`, `entities: string[]`, `entityCount: number`, `bounds: {min,max}`

### `scene.createEntity` (v1.0.0)

Create a renderable entity (box, sphere, cylinder, cone, plane, capsule, or torus) at a position, optionally with a dynamic physics body. The `material` field accepts a palette name (optionally upgraded to procedural-PBR via `pbr: true`) or an imported texture-pack material name (material.import). Returns its entity id.

- Permissions: `scene.write`
- Priority: `core`
- Input: `shape: enum(box|sphere|cylinder|cone|plane|capsule|torus)="box"`, `collider?: enum(box|sphere|capsule)`, `size: number>0,<=50=1`, `material?: string`, `pbr: boolean=false`, `color: integer>=0,<=16777215=16777215`, `position: [number,number,number]=[0,0,0]`, `dynamic: boolean=false`, `static: boolean=false`, `friction: number>=0,<=10=0.5`, `restitution: number>=0,<=2=0`, `parent?: string`, `tags?: string[]`
- Output: `entity: string`

### `scene.createMesh` (v1.0.0)

Create a renderable entity from a DECLARATIVE geometry spec — any parameterized primitive (box/sphere/cylinder/cone/plane/capsule/torus) or an `extrude` spec (a 2D profile [[x,y],...] swept to a depth) — so custom shapes are reachable with no shape-specific skill. Sets position/rotation/scale and material (palette name, optionally PBR, or an imported material); a sound axis-aligned box collider is derived from the geometry. Optional `seed` deterministically varies the geometry (per-vertex jitter) so a prefab can be stamped with per-instance variation. Deterministic + recorded. Returns its entity id.

- Permissions: `scene.write`
- Priority: `standard`
- Input: `geometry: {version,kind,width,height,depth}|{version,kind,radius,widthSegments,heightSegments}|{version,kind,radiusTop,radiusBottom,height,radialSegments}|{version,kind,radius,height,radialSegments}|{version,kind,width,height,widthSegments,heightSegments}|{version,kind,radius,length,capSegments,radialSegments}|{version,kind,radius,tube,radialSegments,tubularSegments}|{version,kind,profile,depth,steps}`, `position: [number,number,number]=[0,0,0]`, `yaw?: number`, `rotation?: [number,number,number,number]`, `scale?: number>0|[number>0,number>0,number>0]`, `material?: string`, `pbr: boolean=false`, `color: integer>=0,<=16777215=16777215`, `seed?: integer>=-9007199254740991,<=9007199254740991`, `parent?: string`, `tags?: string[]`
- Output: `entity: string`

### `scene.destroyEntity` (v1.0.0)

Destroy an entity and free its scene object and physics body.

- Permissions: `scene.write`
- Priority: `standard`
- Input: `entity: string`
- Output: `removed: boolean`

### `scene.duplicate` (v1.0.0)

Duplicate an entity (and its subtree) at an offset from the source, preserving the source's orientation/scale plus an optional extra yaw. A convenience over scene.group + scene.instantiateGroup. Recorded + replay-safe. Returns the copy's root + all created entity ids.

- Permissions: `scene.write`
- Priority: `standard`
- Input: `entity: string`, `offset: [number,number,number]=[0,0,0]`, `yaw: number=0`, `seed?: integer>=-9007199254740991,<=9007199254740991`
- Output: `root: string`, `entities: string[]`

### `scene.group` (v1.0.0)

Capture an entity's subtree (its scene-hierarchy descendants) as a NAMED, reusable prefab recipe: each node's create-command + its transform relative to the root. scene.instantiateGroup then stamps the recipe many times. Recorded so replay rebuilds the recipe. Returns the recipe.

- Permissions: `scene.write`
- Priority: `standard`
- Input: `root: string`, `name: string`
- Output: `name: string`, `nodeCount: number`, `recipe: {version,name,nodes}`

### `scene.inspect` (v1.0.0)

Summarize the whole scene for an agent to reason about: entity count, world AABB (min/max/center/size), a global tag census, and a small position sample. Pure read — the perception substrate for self-checking an authored world.

- Permissions: `scene.read`
- Priority: `standard`
- Input: `tag?: string`, `sampleSize: integer>=0,<=64=8`
- Output: `entityCount: number`, `bounds: {min,max}|null`, `center: [number,number,number]|null`, `size: [number,number,number]|null`, `tagCounts: object`, `sample: {entity,position}[]`

### `scene.instantiateGroup` (v1.0.0)

Stamp a named prefab recipe (from scene.group) at a position/yaw/scale, re-creating its whole subtree wired with the same parenting. An optional `seed` reseeds seed-bearing parts so each instance varies (deterministic: same recipe+transform+seed → identical entities). Recorded + replay-safe. Returns the fresh root + all created entity ids.

- Permissions: `scene.write`
- Priority: `standard`
- Input: `name: string`, `position: [number,number,number]=[0,0,0]`, `yaw: number=0`, `scale?: number>0|[number>0,number>0,number>0]`, `seed?: integer>=-9007199254740991,<=9007199254740991`
- Output: `root: string`, `entities: string[]`

### `scene.moveEntity` (v1.0.0)

Move / re-orient / rescale an EXISTING entity: set its position [x,y,z] (absolute, or relative:true for an offset), turn it (yaw radians about +Y, or a full rotation quaternion), and/or rescale it (uniform number or [x,y,z]). This is how you reposition entities after creating them.

- Permissions: `ecs.modify`
- Priority: `core`
- Input: `entity: string`, `position?: [number,number,number]`, `relative: boolean=false`, `yaw?: number`, `rotation?: [number,number,number,number]`, `scale?: number>0|[number>0,number>0,number>0]`
- Output: `entity: string`, `position: [number,number,number]`

### `scene.queryEntities` (v1.0.0)

List entities, optionally filtered by tag and/or within a radius of a point. Returns ids, positions, distances.

- Permissions: `scene.read`
- Priority: `standard`
- Input: `near?: [number,number,number]`, `radius?: number>0`, `tag?: string`
- Output: `entities: {entity,position,distance}[]`

### `scene.reparent` (v1.0.0)

Set or clear an entity's scene-hierarchy parent. keepWorldTransform (default true) keeps the child in place; parent=null unparents to the world root. Moving a parent later propagates to its children.

- Permissions: `scene.write`
- Priority: `standard`
- Input: `entity: string`, `parent?: string|null`, `keepWorldTransform: boolean=true`
- Output: `ok: boolean`


## social (2)

### `social.approach` (v1.0.0)

Walk the calling agent toward a target (an agent id, an entity id, or a world point). Sets the move target the locomotion system pursues; emits social.approached.

- Permissions: `social.act`
- Priority: `standard`
- Input: `target: string|[number,number,number]`, `talkDistance?: number>0,<=50`
- Output: `approaching: boolean`, `target: string|[number,number,number]`

### `social.say` (v1.0.0)

Speak a line as the calling agent: emits social.said (actorId = the host-bound caller) and shows a real speech bubble anchored above the speaker's humanoid (per-speaker queue).

- Permissions: `social.act`
- Priority: `core`
- Input: `text: string`, `actorId?: string`
- Output: `said: boolean`, `speaker: string`, `handle: string`


## stats (4)

### `stats.create` (v1.0.0)

Create a stat block on an entity with named stats (HP, stamina, mana, strength, defense, etc.). Each stat has a value, max, and min.

- Permissions: `stats.configure`
- Priority: `standard`
- Input: `entity: string`, `stats: {name,value,maxValue,minValue,config}[]`, `meta?: object`
- Output: `ok: boolean`

### `stats.get` (v1.0.0)

Get the current value, max, and min of a stat on an entity.

- Permissions: `stats.read`
- Priority: `standard`
- Input: `entity: string`, `statName: string`, `meta?: object`
- Output: `value: number`, `maxValue: number`, `minValue: number`

### `stats.modify` (v1.0.0)

Modify a stat (add, subtract). Clamps to min/max by default. Fires the stat's onZero action if the change drops it to zero.

- Permissions: `stats.write`
- Priority: `standard`
- Input: `entity: string`, `statName: string`, `delta: number`, `clamp: boolean=true`, `meta?: object`
- Output: `value: number`

### `stats.onZero` (v1.0.0)

Attach a data-driven action to execute when a stat reaches zero (death, depletion, etc.). Stored on the stat block and fired (as stats.onZero.fired) when damage/modify drops the stat to zero.

- Permissions: `stats.configure`
- Priority: `standard`
- Input: `entity: string`, `statName: string`, `action: {type,target,data}`, `meta?: object`
- Output: `ok: boolean`


## status (3)

### `status.apply` (v1.0.0)

Apply a status effect to an entity (poison, stun, slow, buff, shield, etc.) with duration and magnitude.

- Permissions: `status.write`
- Priority: `standard`
- Input: `targetEntity: string`, `type: enum(poison|stun|slow|burn|freeze|buff|shield|custom)`, `duration: number>0`, `magnitude: number=1`, `tickInterval?: number>0`, `onApply?: string`, `onRemove?: string`, `onTick?: string`, `config?: object`, `meta?: object`
- Output: `effectId: string`

### `status.list` (v1.0.0)

List active status effects on an entity.

- Permissions: `status.read`
- Priority: `standard`
- Input: `targetEntity: string`, `meta?: object`
- Output: `effects: {id,type,duration,elapsed,magnitude}[]`

### `status.remove` (v1.0.0)

Remove a status effect from an entity by effect id.

- Permissions: `status.write`
- Priority: `standard`
- Input: `targetEntity: string`, `effectId: string`, `meta?: object`
- Output: `ok: boolean`


## system (17)

### `approval.deny` (v1.0.0)

Reject a held agent action by id; it is dropped and never applied.

- Permissions: `approval.review`
- Priority: `standard`
- Input: `approvalId: string`, `reason?: string`
- Output: `resolved: boolean`, `error: string|null`

### `approval.grant` (v1.0.0)

Approve a held agent action by id; it is applied now and its outcome returned.

- Permissions: `approval.review`
- Priority: `standard`
- Input: `approvalId: string`
- Output: `resolved: boolean`, `applied: boolean`, `error: string|null`

### `approval.list` (v1.0.0)

List agent actions currently held for human approval (id, skill, proposed input, agent).

- Permissions: `approval.review`
- Priority: `standard`
- Input: _none_
- Output: `pending: {approvalId,skill,agentId,profile,tick,input}[]`

### `audit.explain` (v1.0.0)

Answer 'why was action X allowed/denied': the governing policy decision (rule + reason + context + quota/budget), the provenance (agent/session/profile/package), and the causal-parent chain — all from the real recorded trace.

- Permissions: `trace.read`
- Priority: `standard`
- Input: `eventId: string`
- Output: `eventId: string`, `eventType: string`, `found: boolean`, `decision: {eventId,allow,rule,reason,boundary,context,quota,budget}|null`, `provenance: {agentId,sessionId,profile,package}`, `causalTrace: {parents,ancestry}`

### `audit.query` (v1.0.0)

Query recorded policy decisions: filter by allow/deny, cap, rule, agent, session, or package (package provenance). Returns matching decision events plus an allow/deny + by-rule + by-cap summary.

- Permissions: `trace.read`
- Priority: `standard`
- Input: `decision: enum(allow|deny|all)="all"`, `cap?: string`, `rule?: string`, `agentId?: string`, `sessionId?: string`, `package?: string`, `limit: integer>=0,<=2000=200`
- Output: `summary: {total,allowed,denied,byRule,byCap,packages}`, `decisions: {eventId,allow,rule,reason,boundary,cap,agentId,sessionId,profile,package,tick}[]`

### `audit.usage` (v1.0.0)

Resource usage from recorded decisions: allowed/denied call counts per session+cap, plus the latest quota and budget snapshots seen for each session — derived from the real policy events.

- Permissions: `trace.read`
- Priority: `standard`
- Input: `sessionId?: string`
- Output: `perSessionCap: {sessionId,cap,allowed,denied}[]`, `quotas: {sessionId,quota}[]`, `budgets: {sessionId,budget}[]`

### `dev.reload` (v2.0.0)

Live-reload a skill (registry unregister+re-register so a later callTool runs the new handler) or re-run a registered scene builder; emits an honest dev.*.reload.completed/.failed trace event listing what was invalidated. Targets that genuinely cannot reload fail honestly instead of pretending success.

- Permissions: `system.admin`
- Priority: `standard`
- Input: `target: enum(skill|scene|data)`, `name?: string`, `reason?: string`
- Output: `ok: boolean`, `target: enum(skill|scene|data)`, `invalidated: string[]`, `reason?: string`

### `inspector.snapshot` (v1.0.0)

Return a bounded, paginated snapshot of world, entities, agents, skills, permissions, resources, and trace metadata.

- Permissions: `scene.read` `ecs.read` `physics.read` `agent.read`
- Priority: `standard`
- Input: `afterEntity?: string`, `entityVersion?: integer>=0,<=9007199254740991`, `limit: integer>=0,<=500=100`, `includeResources: boolean=true`, `includeSkills: boolean=true`
- Output: `page: {limit,totalEntities,nextAfterEntity,entityVersion}`, `world: any`, `entities: {entity,eid,generation,parent,transform,tags,physics,resource,origin,material}[]`, `agents: any[]`, `skills: {name,version,category,permissions}[]`, `permissions: {caller,profiles}`, `resources: {counts,loaded}`, `trace: {threadId,eventCount,actors,recent}`

### `package.list` (v1.0.0)

List installed packages with their manifest provenance: ref (name@version), kind, declared capabilities, engine-compat range, content hash, and whether the package is attested.

- Permissions: _none_
- Priority: `standard`
- Input: `name?: string`
- Output: `packages: {ref,name,version,kind,declaredCapabilities,engineCompat,contentHash,attested}[]`

### `package.load` (v1.0.0)

Load an installed package (by name@version ref) under a profile: validates the manifest, checks engine-compat (out-of-bounds rejected), gates declared-vs-granted capabilities via the policy engine (over-claim denied), and loads the untrusted entry into the M6 sandbox. Returns the load decision + provenance event id.

- Permissions: `agent.write`
- Priority: `standard`
- Input: `ref: string`, `agentId: string`, `sessionId: string`, `profile: string`
- Output: `ok: boolean`, `ref: string`, `agentId: string|null`, `rule: string|null`, `rejectReason: string|null`, `reason: string|null`, `loadEventId: string|null`

### `skills.browse` (v1.0.0)

Browse the AUTHORIZED skills in a specific category — progressive discovery of a large catalog.

- Permissions: _none_
- Priority: `core`
- Input: `category: string`, `limit?: integer>=1,<=100`
- Output: `tools: {name,description,category}[]`

### `skills.describe` (v1.0.0)

Describe a skill: version, category, and JSON-Schema input.

- Permissions: _none_
- Priority: `standard`
- Input: `name: string`
- Output: `name: string`, `version: string`, `category: string`, `description: string`, `input_schema: any`

### `skills.list` (v1.0.0)

List the skills the caller is authorized to invoke (names + descriptions). `mode:"bootstrap"` returns only the small CORE surface an agent starts with (discover the rest via skills.search/browse); `mode:"full"` (default) lists everything authorized.

- Permissions: _none_
- Priority: `standard`
- Input: `mode?: enum(bootstrap|full)`
- Output: `tools: {name,description,category,priority}[]`

### `skills.search` (v1.0.0)

Search the AUTHORIZED skills by name/description (+ optional category) — browse a large catalog instead of listing everything.

- Permissions: _none_
- Priority: `core`
- Input: `query: string`, `category?: string`, `limit?: integer>=1,<=100`
- Output: `matches: {name,description,category}[]`

### `trace.explainEvent` (v1.0.0)

Explain a trace event with resolved causal parents and children.

- Permissions: `trace.read`
- Priority: `standard`
- Input: `eventId: string`
- Output: `event: {id,type,actorId,threadId,parentEventId,causedBy,timestamp,payload,integrity}`, `parents: {id,type,actorId,threadId,parentEventId,causedBy,timestamp,payload,integrity}[]`, `children: {id,type,actorId,threadId,parentEventId,causedBy,timestamp,payload,integrity}[]`

### `trace.export` (v1.0.0)

Flush the durable trace history to a sandboxed trace JSONL file.

- Permissions: `trace.read`
- Priority: `standard`
- Input: `name: string`
- Output: `name: string`, `events: integer>=-9007199254740991,<=9007199254740991`, `bytes: integer>=-9007199254740991,<=9007199254740991`

### `trace.tail` (v1.0.0)

Tail trace events with cursor pagination and optional actor/type filters.

- Permissions: `trace.read`
- Priority: `standard`
- Input: `afterSeq?: integer>=-1,<=9007199254740991`, `limit?: integer>=0,<=1000`, `actorId?: string`, `type?: string`
- Output: `events: {id,type,actorId,threadId,parentEventId,causedBy,timestamp,payload,integrity}[]`, `nextAfterSeq: integer>=-9007199254740991,<=9007199254740991|null`


## terrain (8)

### `terrain.create` (v1.0.0)

Create an editable heightfield terrain layer — a flat, deformable/paintable ground grid — as a world entity. Reshape it with terrain.deform. Records its params so it replays; heights are meters relative to origin.y. generate.source: 'map' rasterizes a committed WorldMap IR instead of the procedural generator.

- Permissions: `scene.write`
- Priority: `core`
- Input: `size: number>0,<=8192=256`, `resolution: integer>=2,<=1025=129`, `origin: [number,number,number]=[0,0,0]`, `baseHeight: number=0`, `color: integer>=0,<=16777215=4877114`, `generate?: {seed,amplitude,seaCoverage,noiseScale,octaves,lacunarity,gain,warp,erosion,source,mapAssetId}`, `mapHash?: string`
- Output: `entity: string`, `mapHash?: string`

### `terrain.deform` (v1.0.0)

Reshape an editable terrain layer with a brush stamp (raise/lower/smooth/flatten/noise) in a world-space radius. Deterministic + recorded, so hand-sculpted terrain replays and is editable.

- Permissions: `scene.write`
- Priority: `standard`
- Input: `entity?: string`, `center: [number,number]`, `radius: number>0`, `delta: number=1`, `mode: enum(raise|lower|smooth|flatten|noise)="raise"`, `falloff: enum(smooth|linear|constant)="smooth"`
- Output: `ok: boolean`

### `terrain.paint` (v1.0.0)

Paint a surface material (sand/grass/rock/dirt) onto an editable terrain layer with a brush in a world-space radius. Blends a per-vertex material weight into the ground shading; deterministic + recorded so painted ground replays. Does NOT change height (pair with terrain.deform).

- Permissions: `scene.write`
- Priority: `standard`
- Input: `entity?: string`, `center: [number,number]`, `radius: number>0`, `strength: number>=0,<=1=0.5`, `falloff: enum(smooth|linear|constant)="smooth"`, `material: enum(sand|grass|rock|dirt|snow|murk|tundra)="grass"`, `erase: boolean=false`
- Output: `ok: boolean`

### `terrain.sampleClimate` (v1.0.0)

Deterministic per-coordinate climate (tempC, precipMm, biome) for agent perception. Pass the region's terrain hints to read the per-type biome.

- Permissions: `terrain.read`
- Priority: `standard`
- Input: `seed: integer>=-9007199254740991,<=9007199254740991`, `x: number`, `z: number`, `hints?: object`
- Output: `tempC: number`, `precipMm: number`, `biome: integer>=-9007199254740991,<=9007199254740991`

### `terrain.sampleHeight` (v1.0.0)

O(1) deterministic surface-elevation query at a world (x,z) for a seed/lod (snapping/placement). Returns world Y.

- Permissions: `terrain.read`
- Priority: `standard`
- Input: `seed: integer>=-9007199254740991,<=9007199254740991`, `x: number`, `z: number`, `lod: integer>=0,<=4=0`
- Output: `y: number`

### `vegetation.grassField` (v1.0.0)

Create a deterministic, bounded, paint-driven grass field using native WebGPU compute when available and the canonical CPU field plan otherwise.

- Permissions: `scene.write`
- Priority: `standard`
- Input: `terrain?: string`, `seed: integer>=-2147483648,<=2147483647=1337`, `spacing: number>0=0.75`, `tileSize: number>0=24`, `elevationMin?: number`, `elevationMax?: number`, `slopeMax: number>=0=0.9`, `sizeRange: [number>=0,number>=0]=[0.7,1.3]`, `climate: enum(summer|autumn|dry|winter)="summer"`
- Output: `entity: string`, `gridTiles: integer>=-9007199254740991,<=9007199254740991`, `candidateSlots: integer>=-9007199254740991,<=9007199254740991`, `planHash: string`

### `vegetation.plant` (v1.0.0)

Plant a SINGLE tree of a species (spruce/pine/birch) at a point — the per-tree counterpart to vegetation.scatter. A light single entity (works where a full forest is too heavy), for composing a scene tree by tree. Deterministic + recorded.

- Permissions: `scene.write`
- Priority: `standard`
- Input: `species: enum(spruce|pine|birch|oak|ash|dead-oak)="spruce"`, `assets?: {id,weight,treeLod}[]`, `position?: [number,number,number]`, `terrain?: string`, `seed: integer>=-9007199254740991,<=9007199254740991=1`, `scale: number>0=1`, `yaw: number=0`, `tags?: string[]`
- Output: `entity: string`, `assetId: string`, `assetHash: string`

### `vegetation.scatter` (v1.0.0)

Scatter a forest of tree archetypes across an editable terrain layer, gated by slope + elevation (tree line), deterministic + recorded. Instanced trees sit on the sculpted ground. Returns the forest entity + instance count.

- Permissions: `scene.write`
- Priority: `core`
- Input: `terrain?: string`, `species?: enum(spruce|pine|birch|oak|ash|dead-oak)[]`, `assets?: {id,weight,treeLod}[]`, `density: integer>=1,<=192=16`, `seed: integer>=-9007199254740991,<=9007199254740991=1337`, `elevationMin?: number`, `elevationMax?: number`, `slopeMax: number>=0=0.85`, `sizeRange: [number>0,number>0]=[0.7,1.35]`, `coverage: number>=0,<=1=0.9`, `cluster: number>=0,<=1=0.45`, `exclusions?: {x,z,r}[]`, `inclusions?: {x,z,r}[]`, `tags?: string[]`
- Output: `entity: string`, `instances: integer>=-9007199254740991,<=9007199254740991`, `assetHashes: object`, `placements: any[]`


## three (11)

### `asset.place` (v1.0.0)

Place a curated glTF asset BY ID at a transform. Resolves the id through the content-addressed asset registry, loads it via the shared glTF pipeline, and spawns an entity. The world log records the REQUEST (assetId + transform + committed content hash); the bytes ride the registry/export package. Returns the entity id + content hash.

- Permissions: `scene.write`
- Priority: `core`
- Input: `assetId: string`, `position: [number,number,number]=[0,0,0]`, `rotation?: [number,number,number]`, `scale?: [number,number,number]`, `ground: boolean=true`, `normalizeHeight?: number>0,<=500`, `material?: {color,roughness,metalness}`, `hash?: string`, `designRef?: {schema,mapId,kind,id}`, `qcRender?: string`, `qcChecks?: object`
- Output: `entity: string`, `hash: string`, `resource: {kind,assetId,source,hash,bytes,rootName,objectCount,meshCount,materialCount,textureCount}`, `bounds: [number,number,number]`

### `asset.placeLod` (v1.0.0)

Place a curated glTF asset as a screen-distance LOD: multiple resolution levels that the renderer swaps by camera distance for draw-call control. Level 0 is the nearest/highest-detail mesh and defines the collider + committed identity. Same transform/ground/normalize semantics as asset.place; records the REQUEST (ordered level ids + distances + level-0 hash).

- Permissions: `scene.write`
- Priority: `standard`
- Input: `lods: {assetId,distance}[]`, `position: [number,number,number]=[0,0,0]`, `rotation?: [number,number,number]`, `scale?: [number,number,number]`, `ground: boolean=true`, `normalizeHeight?: number>0,<=500`, `hash?: string`
- Output: `entity: string`, `hash: string`, `levels: integer>=-9007199254740991,<=9007199254740991`, `resource: {kind,assetId,source,hash,bytes,rootName,objectCount,meshCount,materialCount,textureCount}`, `bounds: [number,number,number]`

### `asset.scatter` (v1.0.0)

Scatter curated glTF assets BY ID across an ALREADY-GENERATED region (by regionId) under an agent-set ScatterConfig (palette + density + elevation/slope/climate rules). Bound to the region's seed/lod + applied tiles, so placements sit on the visible, exported surface. Deterministic + replay-safe: the world log records the regionId + ScatterConfig REQUEST (+ pinned asset hashes), NEVER the instance transforms, which replay recomputes over the SAME baked/cached tiles. Optional LOD levels use cell-classified, draw-bounded aggregate instance batches. Returns the placement count + pinned hashes.

- Permissions: `scene.write`
- Priority: `standard`
- Input: `regionId: string`, `config: {seed,density,assets,cellSize,elevationMin,elevationMax,slopeMax,sizeRange,coverage,cluster,clusterFreq,embedRadius,biomes,tempMin,tempMax,exclusions,inclusions}`, `assetHashes?: object`
- Output: `regionId: string`, `instances: integer>=-9007199254740991,<=9007199254740991`, `mounted: integer>=-9007199254740991,<=9007199254740991`, `assetHashes: object`, `placements: {assetId,x,y,z,yaw,scale}[]`

### `material.import` (v1.2.0)

Import a CC0 texture pack (albedo + optional normal + roughness + ambient-occlusion images, BY content-addressed id) as a NAMED PBR material usable by scene.createEntity / three.setMaterial. Resolves + decodes the images through the content-addressed asset registry (bytes ride the export's assets.jsonl); the world log records only the import REQUEST (name + ids + committed hashes), never bytes. Optionally TRIPLANAR so the pack never UV-stretches on arbitrary primitives. Returns the name + pinned hashes.

- Permissions: `scene.write`
- Priority: `standard`
- Input: `name: string`, `albedo: string`, `normal?: string`, `roughness?: string`, `occlusion?: string`, `displacement?: string`, `occlusionStrength: number>=0,<=1=1`, `triplanar: boolean=false`, `scale: number>0=0.5`, `normalStrength: number>=0=1`, `sharpness: number>0=4`, `metalness: number>=0,<=1=0`, `baseRoughness: number>=0,<=1=0.85`, `color?: integer>=0,<=16777215`, `antiTiling: boolean=false`, `parallax?: {heightScale,minLayers,maxLayers,fadeStart,fadeEnd}`, `hashes?: object`
- Output: `name: string`, `maps: string[]`, `hashes: object`

### `three.addLight` (v1.0.0)

Add one directional/point/spot light to the scene (on top of setLighting's single ambient+directional pair) and return its id for later three.removeLight. Supports color/intensity, position, a directional/spot target, point/spot range+decay, spot angle+penumbra, and real shadow-map casting.

- Permissions: `scene.write`
- Priority: `standard`
- Input: `kind: enum(directional|point|spot)`, `color: integer>=0,<=16777215=16777215`, `intensity: number>=0,<=100=1`, `position: [number,number,number]=[0,0,0]`, `target?: [number,number,number]`, `distance: number>=0=0`, `decay: number>=0=2`, `angle: number>=0,<=1.5707963267948966=1.0471975511965976`, `penumbra: number>=0,<=1=0`, `castShadow: boolean=false`, `shadowMapSize: integer>=256,<=4096=1024`, `shadowCameraExtent: number>0,<=500=20`, `shadowCameraNear: number>0=0.5`, `shadowCameraFar: number>0=120`, `shadowBias: number>=-0.01,<=0.01=-0.0008`
- Output: `ok: boolean`, `id: string`

### `three.loadGLTF` (v1.0.0)

Load a glTF/glb model from a sandboxed asset id and add it to the scene at a position.

- Permissions: `scene.write`
- Priority: `standard`
- Input: `assetId: string`, `position: [number,number,number]=[0,0,0]`
- Output: `entity: string`, `resource: {kind,assetId,source,hash,bytes,rootName,objectCount,meshCount,materialCount,textureCount}`

### `three.removeLight` (v1.0.0)

Remove a light previously added via three.addLight, by its id.

- Permissions: `scene.write`
- Priority: `standard`
- Input: `id: string`
- Output: `ok: boolean`

### `three.setLighting` (v1.0.0)

Set scene lighting: one ambient + one directional light, optionally casting real shadow maps.

- Permissions: `scene.write`
- Priority: `standard`
- Input: `ambientColor: integer>=0,<=16777215=4210784`, `ambientIntensity: number>=0,<=10=1.2`, `directionalColor: integer>=0,<=16777215=16777215`, `directionalIntensity: number>=0,<=10=3`, `direction: [number,number,number]=[5,9,6]`, `castShadow: boolean=false`, `shadowMapSize: integer>=256,<=4096=2048`, `shadowCameraExtent: number>0,<=500=20`, `shadowCameraNear: number>0=0.5`, `shadowCameraFar: number>0=120`, `shadowBias: number>=-0.01,<=0.01=-0.0008`
- Output: `ok: boolean`

### `three.setMaterial` (v1.0.0)

Update an entity's PBR material (color, roughness, metalness) and/or shadow participation (castShadow/receiveShadow), across all meshes of a glTF entity. `material` accepts a palette name (optionally procedural-PBR via `pbr: true`) or an imported texture-pack material name (material.import); a PBR/imported material REPLACES the mesh material.

- Permissions: `scene.write`
- Priority: `standard`
- Input: `entity: string`, `material?: string`, `pbr: boolean=false`, `color?: integer>=0,<=16777215`, `roughness?: number>=0,<=1`, `metalness?: number>=0,<=1`, `castShadow?: boolean`, `receiveShadow?: boolean`
- Output: `ok: boolean`

### `three.setTransform` (v1.0.0)

Set an entity's position, rotation (Euler radians), and/or scale.

- Permissions: `scene.write`
- Priority: `standard`
- Input: `entity: string`, `position?: [number,number,number]`, `rotationEuler?: [number,number,number]`, `scale?: [number,number,number]`
- Output: `ok: boolean`

### `village.build` (v1.0.0)

Lay a terrain-aware settlement onto an editable terrain layer by placing curated library GLB assets. Reads the live heightfield, runs the shared deterministic layout planner (focal on the chosen ground, cluster terraced below, edge building beyond), and invokes asset.place per building. Deterministic + replay-safe: the world log records the direction + steering + seed + PINNED asset hashes, NEVER the transforms, which replay recomputes. Returns the placed entities + computed placements.

- Permissions: `scene.write`
- Priority: `standard`
- Input: `direction: {palette,mood,setting,artStyle}={}`, `steering: {buildings,layout,siting,anchors}`, `seed?: integer>=-9007199254740991,<=9007199254740991`, `terrainEntity?: string`, `assetHashes?: object`
- Output: `terrainEntity: string`, `placed: integer>=-9007199254740991,<=9007199254740991`, `assetHashes: object`, `entities: string[]`, `placements: {assetId,role,style,x,y,z,yaw,anchorId}[]`


## trigger (5)

### `trigger.create` (v1.0.0)

Create a trigger zone (box or sphere) at a position with configurable size. Returns the trigger id for attaching phase actions (onEnter/onExit/onStay).

- Permissions: `trigger.configure`
- Priority: `standard`
- Input: `shape: enum(box|sphere)="box"`, `center: [number,number,number]`, `size: [number,number,number]`, `config?: object`, `meta?: object`
- Output: `triggerId: string`

### `trigger.onEnter` (v1.0.0)

Attach a data-driven action descriptor to fire when an entity ENTERS a trigger zone. The descriptor (emit/setState/spawn/destroy/audio/animation/custom) is the agent-authored WHAT; the trigger pump returns it for the host to drive — it is not executed here.

- Permissions: `trigger.configure`
- Priority: `standard`
- Input: `triggerId: string`, `action: {type,target,data}`, `meta?: object`
- Output: `ok: boolean`

### `trigger.onExit` (v1.0.0)

Attach an action descriptor to fire when an entity EXITS a trigger zone (returned by the trigger pump for the host to drive).

- Permissions: `trigger.configure`
- Priority: `standard`
- Input: `triggerId: string`, `action: {type,target,data}`, `meta?: object`
- Output: `ok: boolean`

### `trigger.onStay` (v1.0.0)

Attach an action descriptor to fire each tick an entity STAYS inside a trigger zone (returned by the trigger pump for the host to drive).

- Permissions: `trigger.configure`
- Priority: `standard`
- Input: `triggerId: string`, `action: {type,target,data}`, `meta?: object`
- Output: `ok: boolean`

### `trigger.remove` (v1.0.0)

Remove a trigger zone and all its attached phase actions.

- Permissions: `trigger.configure`
- Priority: `standard`
- Input: `triggerId: string`, `meta?: object`
- Output: `ok: boolean`


## ui (9)

### `ui.callout` (v1.0.0)

Place an annotation box with a leader line to a target point.

- Permissions: `ui.write`
- Priority: `standard`
- Input: `anchor: {kind,entity,point,offset,billboard,renderOrder,depthTest}|{kind,corner,marginPx,distance,renderOrder}`, `style?: {background,border,title,text,padding,maxWidth,width,minWidth,height,maxLines,noWrap,shadow,gradient,runs}`, `text?: string`, `title?: string`, `lines?: string[]`, `maxWidth?: number>0`, `width?: number>0`, `maxLines?: integer>0,<=9007199254740991`, `pixelScale?: number>0`, `tail?: {toward,side,count,length,base}`, `leader?: {dx,dy,side,offset,width,color,dot}`, `lifecycle?: {fade,typewriter,ttl,queue,feed}`
- Output: `handle: string`

### `ui.hudPanel` (v1.0.0)

Place a screen-anchored HUD/overlay panel (corner-pinned, DPI-aware, over the scene).

- Permissions: `ui.write`
- Priority: `standard`
- Input: `anchor: {kind,entity,point,offset,billboard,renderOrder,depthTest}|{kind,corner,marginPx,distance,renderOrder}`, `style?: {background,border,title,text,padding,maxWidth,width,minWidth,height,maxLines,noWrap,shadow,gradient,runs}`, `text?: string`, `title?: string`, `lines?: string[]`, `maxWidth?: number>0`, `width?: number>0`, `maxLines?: integer>0,<=9007199254740991`, `pixelScale?: number>0`, `tail?: {toward,side,count,length,base}`, `leader?: {dx,dy,side,offset,width,color,dot}`, `lifecycle?: {fade,typewriter,ttl,queue,feed}`
- Output: `handle: string`

### `ui.label` (v1.0.0)

Place a billboard label (minimal chrome) tracking an entity or world point.

- Permissions: `ui.write`
- Priority: `standard`
- Input: `anchor: {kind,entity,point,offset,billboard,renderOrder,depthTest}|{kind,corner,marginPx,distance,renderOrder}`, `style?: {background,border,title,text,padding,maxWidth,width,minWidth,height,maxLines,noWrap,shadow,gradient,runs}`, `text?: string`, `title?: string`, `lines?: string[]`, `maxWidth?: number>0`, `width?: number>0`, `maxLines?: integer>0,<=9007199254740991`, `pixelScale?: number>0`, `tail?: {toward,side,count,length,base}`, `leader?: {dx,dy,side,offset,width,color,dot}`, `lifecycle?: {fade,typewriter,ttl,queue,feed}`
- Output: `handle: string`

### `ui.panel` (v1.0.0)

Author a styled UI container (kind = label/textBox/speechBubble/thoughtBubble/callout/hudPanel) with a full Zod style object, world/screen anchor, optional tail/leader and lifecycle (fade/typewriter/ttl/queue/feed). Returns an opaque handle.

- Permissions: `ui.write`
- Priority: `standard`
- Input: `kind: enum(label|textBox|speechBubble|thoughtBubble|callout|hudPanel)`, `anchor: {kind,entity,point,offset,billboard,renderOrder,depthTest}|{kind,corner,marginPx,distance,renderOrder}`, `style?: {background,border,title,text,padding,maxWidth,width,minWidth,height,maxLines,noWrap,shadow,gradient,runs}`, `text?: string`, `title?: string`, `lines?: string[]`, `maxWidth?: number>0`, `width?: number>0`, `maxLines?: integer>0,<=9007199254740991`, `pixelScale?: number>0`, `tail?: {toward,side,count,length,base}`, `leader?: {dx,dy,side,offset,width,color,dot}`, `lifecycle?: {fade,typewriter,ttl,queue,feed}`
- Output: `handle: string`

### `ui.remove` (v1.0.0)

Remove a live container by handle: detach its mesh from the scene and dispose its GPU resources.

- Permissions: `ui.write`
- Priority: `standard`
- Input: `handle: string`
- Output: `removed: boolean`

### `ui.speechBubble` (v1.0.0)

Place a speech bubble with a directional tail aimed at the speaker (entity/point).

- Permissions: `ui.write`
- Priority: `standard`
- Input: `anchor: {kind,entity,point,offset,billboard,renderOrder,depthTest}|{kind,corner,marginPx,distance,renderOrder}`, `style?: {background,border,title,text,padding,maxWidth,width,minWidth,height,maxLines,noWrap,shadow,gradient,runs}`, `text?: string`, `title?: string`, `lines?: string[]`, `maxWidth?: number>0`, `width?: number>0`, `maxLines?: integer>0,<=9007199254740991`, `pixelScale?: number>0`, `tail?: {toward,side,count,length,base}`, `leader?: {dx,dy,side,offset,width,color,dot}`, `lifecycle?: {fade,typewriter,ttl,queue,feed}`
- Output: `handle: string`

### `ui.textBox` (v1.0.0)

Place a titled text box (header bar + wrapped body) at a world or screen anchor.

- Permissions: `ui.write`
- Priority: `standard`
- Input: `anchor: {kind,entity,point,offset,billboard,renderOrder,depthTest}|{kind,corner,marginPx,distance,renderOrder}`, `style?: {background,border,title,text,padding,maxWidth,width,minWidth,height,maxLines,noWrap,shadow,gradient,runs}`, `text?: string`, `title?: string`, `lines?: string[]`, `maxWidth?: number>0`, `width?: number>0`, `maxLines?: integer>0,<=9007199254740991`, `pixelScale?: number>0`, `tail?: {toward,side,count,length,base}`, `leader?: {dx,dy,side,offset,width,color,dot}`, `lifecycle?: {fade,typewriter,ttl,queue,feed}`
- Output: `handle: string`

### `ui.thoughtBubble` (v1.0.0)

Place a thought bubble with trailing puffs leading back to the thinker.

- Permissions: `ui.write`
- Priority: `standard`
- Input: `anchor: {kind,entity,point,offset,billboard,renderOrder,depthTest}|{kind,corner,marginPx,distance,renderOrder}`, `style?: {background,border,title,text,padding,maxWidth,width,minWidth,height,maxLines,noWrap,shadow,gradient,runs}`, `text?: string`, `title?: string`, `lines?: string[]`, `maxWidth?: number>0`, `width?: number>0`, `maxLines?: integer>0,<=9007199254740991`, `pixelScale?: number>0`, `tail?: {toward,side,count,length,base}`, `leader?: {dx,dy,side,offset,width,color,dot}`, `lifecycle?: {fade,typewriter,ttl,queue,feed}`
- Output: `handle: string`

### `ui.update` (v1.0.0)

Update a live container by handle: change its text, title, body lines, and/or restyle it (re-composites). Returns whether the handle existed and re-composited.

- Permissions: `ui.write`
- Priority: `standard`
- Input: `handle: string`, `text?: string`, `title?: string`, `style?: {background,border,title,text,padding,maxWidth,width,minWidth,height,maxLines,noWrap,shadow,gradient,runs}`, `lines?: string[]`
- Output: `ok: boolean`, `changed: boolean`


## vfx (6)

### `vfx.atPosition` (v1.0.0)

Spawn a one-shot particle burst at a world position (explosion, spark, puff, etc.). Spawns REAL particles immediately; the system self-frees once they drain.

- Permissions: `vfx.write`
- Priority: `standard`
- Input: `position: [number,number,number]`, `color: [number,number,number,number]=[1,1,1,1]`, `size: number>0=0.2`, `lifetime: number>0=0.5`, `count: integer>=1,<=200=20`, `speed: number=3`, `config?: object`, `meta?: object`
- Output: `ok: boolean`, `vfxId: string`

### `vfx.attach` (v1.0.0)

Attach a particle system to an entity. The emitter follows the entity's transform each update (trail, aura, weapon effect), offset by `offset`.

- Permissions: `vfx.write`
- Priority: `standard`
- Input: `vfxId: string`, `entity: string`, `offset: [number,number,number]=[0,0,0]`, `meta?: object`
- Output: `ok: boolean`

### `vfx.create` (v1.0.0)

Create a CPU particle system with full configuration (emitter, lifetime, color, size, velocity, gravity, shape, blend mode). Builds a THREE.Points object on the scene; particles are simulated by the per-frame VFX update. Returns vfx id.

- Permissions: `vfx.write`
- Priority: `standard`
- Input: `config: {maxParticles,lifetime,emissionRate,startColor,endColor,startSize,endSize,startSpeed,gravity,spread,shape,blendMode,config}`, `meta?: object`
- Output: `vfxId: string`

### `vfx.destroy` (v1.0.0)

Destroy a particle system: remove its THREE.Points from the scene and free its geometry/material.

- Permissions: `vfx.write`
- Priority: `standard`
- Input: `vfxId: string`, `meta?: object`
- Output: `ok: boolean`

### `vfx.play` (v1.0.0)

Start emitting particles from a particle system.

- Permissions: `vfx.write`
- Priority: `standard`
- Input: `vfxId: string`, `meta?: object`
- Output: `ok: boolean`

### `vfx.stop` (v1.0.0)

Stop emitting; existing particles age out (a natural fade) instead of vanishing.

- Permissions: `vfx.write`
- Priority: `standard`
- Input: `vfxId: string`, `meta?: object`
- Output: `ok: boolean`


## world (14)

### `render.enablePost` (v1.0.0)

Build the RENDER-ONLY post-processing pipeline (real depth+normal pre-pass → GTAO contact AO → highlight bloom → gentle HDR grade) on the live renderer/scene/camera and store it on world.post for the render loop to drive (post.render() in place of renderer.render). A renderer-free headless authoring world accepts and records the command but defers pipeline creation until live replay. Returns the resolved preset and materialization status.

- Permissions: `scene.write`
- Priority: `standard`
- Input: `ao?: {enabled,radius,scale,distanceExponent,thickness,samples,resolutionScale,intensity}`, `bloom?: {enabled,strength,radius,threshold}`, `grade?: {enabled,exposure,contrast,saturation}`, `godrays?: {enabled,density,maxDensity,distanceAttenuation,raymarchSteps,intensity}`, `dof?: {enabled,focusDistance,focalLength,bokehScale}`, `outline?: {enabled,strength}`
- Output: `enabled: boolean`, `deferred: boolean`, `ao: boolean`, `bloom: boolean`, `grade: boolean`, `depth: boolean`, `normal: boolean`, `godrays: boolean`, `dof: boolean`, `outline: boolean`, `preset: any`

### `world.addMapRivers` (v1.0.0)

Render every waterway in a validated WorldMap asset as terrain-following river ribbons without duplicating its centerline data in authoring source.

- Permissions: `scene.write`
- Priority: `standard`
- Input: `mapAssetId: string`, `mapHash?: string`, `widthScale: number>0,<=10=1`, `color?: integer>=0,<=16777215`, `level?: number`, `terrainEntity?: string`
- Output: `rivers: integer>=-9007199254740991,<=9007199254740991`, `points: integer>=-9007199254740991,<=9007199254740991`, `mapHash: string`

### `world.addMapWater` (v1.0.0)

Mount the verified WorldMap ocean, standing WaterBodies, and waterways as one idempotent render-only water set.

- Permissions: `scene.write`
- Priority: `standard`
- Input: `mapAssetId: string`, `mapHash?: string`, `widthScale: number>0,<=10=1`, `color?: integer>=0,<=16777215`, `level?: number`, `terrainEntity?: string`
- Output: `ocean: integer>=-9007199254740991,<=9007199254740991`, `bodies: integer>=-9007199254740991,<=9007199254740991`, `rivers: integer>=-9007199254740991,<=9007199254740991`, `points: integer>=-9007199254740991,<=9007199254740991`, `mapHash: string`

### `world.addRiver` (v1.0.0)

Add a RENDER-ONLY river: a water ribbon draped along a carved channel polyline, following the terrain (a flat sea plane cannot render a river crossing elevated ground). Cosmetic only — no physics body, no ECS entity, replay rebuilds it from the logged request.

- Permissions: `scene.write`
- Priority: `standard`
- Input: `points: [number>=-10000000,<=10000000,number>=-10000000,<=10000000][]`, `widthM: number>0,<=100000=6`, `widths?: number>0,<=100000[]`, `class: enum(river|stream)="river"`, `order?: integer>=1,<=12`, `color?: integer>=-9007199254740991,<=9007199254740991`, `level?: number`, `terrainEntity?: string`
- Output: `points: integer>=-9007199254740991,<=9007199254740991`, `widthM: number`, `level: number`

### `world.addWater` (v1.0.0)

Add a RENDER-ONLY water surface (a large plane) at a sea-level Y so beaches/lakes/oceans read as water. Cosmetic only: no physics body, no collider, no ECS entity — it never affects the deterministic sim or replay. The world log records the REQUEST (level/size/color, and an optional region for true depth-aware shading); replay rebuilds the same surface from the logged request.

- Permissions: `scene.write`
- Priority: `standard`
- Input: `level?: number`, `size: number>0,<=100000=400`, `color: integer>=0,<=16777215=2841970`, `region?: {seed,type,bounds,hints,resolution}`, `terrainEntity?: string`
- Output: `level: number`, `size: number`, `color: integer>=-9007199254740991,<=9007199254740991`

### `world.generateRegion` (v1.0.0)

Generate a rectangular region of terrain: build the heightfield COLLIDERS from a deterministic source AND (by default) the VISIBLE procedural-PBR terrain mesh per tile, so the region renders a textured landscape out of the box. High-cost; streams tiles, emitting terrain.tile.ready per tile. Returns a region handle + the surveyed relief/seaLevel. The world log records this REQUEST; the tile bytes ride the cache/export; the visible meshes are RENDER-ONLY (rebuilt from the same tiles on replay). Opt out of the mesh with render:false (colliders/data only); tune the look with `surface`.

- Permissions: `terrain.generate`
- Priority: `core`
- Input: `seed: integer>=-9007199254740991,<=9007199254740991`, `bounds: {minTx,minTz,maxTx,maxTz}`, `lod: integer>=0,<=4=0`, `type?: enum(beach|mountains|forest|desert|plains|hills|islands)`, `hints?: object`, `render: boolean=true`, `surface?: {mode,color,roughness,metalness,doubleSide,seaLevel,seaFraction,minY,maxY,waterline,shoreline,exaggerateY}`
- Output: `regionId: string`, `tiles: integer>=-9007199254740991,<=9007199254740991`, `bodies: integer>=-9007199254740991,<=9007199254740991[]`, `keys: string[]`, `meshes: integer>=-9007199254740991,<=9007199254740991`, `relief?: {minY,maxY}`, `seaLevel?: number`

### `world.getSpawn` (v1.0.0)

Get the default spawn position for players.

- Permissions: `world.read`
- Priority: `standard`
- Input: `meta?: object`
- Output: `position: [number,number,number]`

### `world.populateBiome` (v1.0.0)

Scatter a terrain TYPE's biome content (trees/rocks/grass/cacti/palms, biome- and elevation-gated) over an ALREADY-GENERATED region (by regionId), via the deterministic asset.scatter seam. Surveys the region's relief with the hints it was generated with, resolves the type's content layers, and drives asset.scatter per layer. Deterministic + replay-safe: the world log records THIS request; the nested asset.scatter calls are recomputed on replay (no double-record). Returns the placement count + per-layer summary.

- Permissions: `scene.write`
- Priority: `standard`
- Input: `regionId: string`, `type?: enum(beach|mountains|forest|desert|plains|hills|islands)`, `waterLevel?: number`, `waterMargin?: number`, `cellSize?: number>0`, `seed?: integer>=-9007199254740991,<=9007199254740991`, `biomePack?: object`
- Output: `regionId: string`, `type: string`, `instances: integer>=-9007199254740991,<=9007199254740991`, `relief: {minY,maxY}`, `layers: {instances,mounted}[]`

### `world.setSpawn` (v1.0.0)

Set the default spawn position for players.

- Permissions: `world.write`
- Priority: `standard`
- Input: `position: [number,number,number]`, `meta?: object`
- Output: `ok: boolean`

### `world.setTerrainSource` (v1.0.0)

Bind the streamed-terrain source for this world: kind 'map' resolves + verifies a committed WorldMap IR asset and records its raster seed, amplitude, and optional versioned master-erosion recipe; omission preserves legacy no-erosion bytes. Replay reconstructs the same once-baked MapTerrainSource. kind 'procedural' restores the default generator. Must run BEFORE any world.generateRegion. Map tiles sample the baked master and are never export-retained.

- Permissions: `scene.write`
- Priority: `standard`
- Input: `kind: enum(procedural|map)`, `mapAssetId?: string`, `hash?: string`, `seed?: integer>=-2147483648,<=2147483647`, `baseAmplitude?: number>0`, `erosion?: {schema,enabled}|{schema,enabled,rain,thermal,talus,lifetime,capacity,deposition,erosionRate}`
- Output: `kind: enum(procedural|map)`, `source: string`, `hash?: string`

### `world.setTime` (v1.0.0)

Set the world's time of day. Affects lighting, skybox, and ambient audio.

- Permissions: `world.write`
- Priority: `standard`
- Input: `time: number>=0,<=24`, `transitionMs: number>=0,<=10000=0`, `meta?: object`
- Output: `ok: boolean`

### `world.setTimeScale` (v1.0.0)

Set the simulation time scale. 0 pauses the world, 1 is normal speed.

- Permissions: `world.write`
- Priority: `standard`
- Input: `scale: number>=0,<=10`, `meta?: object`
- Output: `ok: boolean`

### `world.setWeather` (v1.0.0)

Set the active weather with intensity. Supports clear, rain, snow, fog, storm, or custom types.

- Permissions: `world.write`
- Priority: `standard`
- Input: `weather: enum(clear|rain|snow|fog|storm|custom)`, `intensity: number>=0,<=1=1`, `config?: object`, `meta?: object`
- Output: `ok: boolean`

### `world.streamFollow` (v1.0.0)

Stream terrain tiles in a square window around an anchor (agent/camera): generate+apply tiles entering the window, remove tiles leaving a keep-margin. Returns the loaded/removed tile keys. Off-loop in production; synchronous here.

- Permissions: `terrain.generate`
- Priority: `standard`
- Input: `regionId: string`, `anchor: [number,number,number]`, `radius: integer>=0,<=8=1`
- Output: `regionId: string`, `loaded: string[]`, `removed: string[]`, `active: integer>=-9007199254740991,<=9007199254740991`

