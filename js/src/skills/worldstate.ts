// worldstate.* and audio.* extension skills — world dynamics (time, weather, timeScale, spawn) and audio extensions (BGM, SFX, reverb).
// All inputs accept optional `meta` for agent-supplied extension data.

import { z } from "../../build/zod.bundle.mjs";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
const MetaField = z.record(z.string(), z.unknown()).optional().describe("Agent-supplied extension metadata.");

export interface WorldState {
  timeOfDay: number; // 0-24
  weather: string;
  weatherIntensity: number; // 0-1
  timeScale: number;
  spawnPosition: [number, number, number];
  config?: Record<string, unknown>;
}

export class WorldStateManager {
  private state: WorldState = {
    timeOfDay: 12,
    weather: "clear",
    weatherIntensity: 0,
    timeScale: 1,
    spawnPosition: [0, 0, 0],
  };

  getState(): WorldState {
    return this.state;
  }

  setTime(time: number): void {
    this.state.timeOfDay = Math.max(0, Math.min(24, time));
  }

  setWeather(weather: string, intensity: number): void {
    this.state.weather = weather;
    this.state.weatherIntensity = Math.max(0, Math.min(1, intensity));
  }

  setTimeScale(scale: number): void {
    this.state.timeScale = Math.max(0, scale);
  }

  setSpawn(position: [number, number, number]): void {
    this.state.spawnPosition = position;
  }

  getSpawn(): [number, number, number] {
    return this.state.spawnPosition;
  }
}

export interface BGMTrack {
  id: string;
  name: string;
  handle?: string;
  volume: number;
}

export class BGMManager {
  private current: BGMTrack | null = null;
  private tracks = new Map<string, BGMTrack>();

  register(track: { id: string; name: string }): void {
    this.tracks.set(track.id, { id: track.id, name: track.name, volume: 0.5 });
  }

  play(id: string, volume?: number): { ok: boolean; track?: BGMTrack } {
    const track = this.tracks.get(id);
    if (track === undefined) return { ok: false };
    track.volume = volume ?? track.volume;
    this.current = track;
    return { ok: true, track };
  }

  stop(): void {
    this.current = null;
  }

  crossfade(newId: string, duration: number, volume?: number): boolean {
    const newTrack = this.tracks.get(newId);
    if (newTrack === undefined) return false;
    newTrack.volume = volume ?? newTrack.volume;
    this.current = newTrack;
    return true;
  }

  getCurrent(): BGMTrack | null {
    return this.current;
  }
}

export class ReverbManager {
  private readonly zones = new Map<string, { center: [number, number, number]; radius: number; size: number; decay: number; damping: number }>();
  private seq = 0;

  addZone(center: [number, number, number], radius: number, opts: { size?: number; decay?: number; damping?: number }): string {
    const id = `reverb_${this.seq++}`;
    this.zones.set(id, { center, radius, size: opts.size ?? 1, decay: opts.decay ?? 1, damping: opts.damping ?? 0.5 });
    return id;
  }

  getZoneAt(position: [number, number, number]): { size: number; decay: number; damping: number } | undefined {
    for (const zone of this.zones.values()) {
      const dx = position[0] - zone.center[0];
      const dy = position[1] - zone.center[1];
      const dz = position[2] - zone.center[2];
      if (dx * dx + dy * dy + dz * dz <= zone.radius * zone.radius) {
        return { size: zone.size, decay: zone.decay, damping: zone.damping };
      }
    }
    return undefined;
  }
}

// ---- Skill registration ----
//
// The skills are defined INSIDE the register function so each handler CLOSES OVER
// the concrete managers created (or supplied) here — there is no `ctx.world.*Manager`
// seam to read (the cut-1 module-level skills did, and it was never set → every call
// was a silent no-op). Closing over the managers makes the state real and keeps a
// fresh replay registry's managers fresh.

export function registerWorldAudioExtensionSkills(
  registry: SkillRegistry,
  opts?: { worldStateManager?: WorldStateManager; bgmManager?: BGMManager; reverbManager?: ReverbManager },
): { worldStateManager: WorldStateManager; bgmManager: BGMManager; reverbManager: ReverbManager } {
  const worldMgr = opts?.worldStateManager ?? new WorldStateManager();
  const bgmMgr = opts?.bgmManager ?? new BGMManager();
  const reverbMgr = opts?.reverbManager ?? new ReverbManager();

  // DETERMINISTIC SFX handle counter (closure state). Mirrors ReverbManager's
  // `reverb_${seq++}` pattern: the handle is derived from ctx.tick + this monotone
  // sequence, NOT a wall clock — so replaying the same skill sequence recomputes the
  // SAME handles bit-for-bit. (The old cut used Date.now(), a determinism violation:
  // the returned/traced handle would differ on every run and break replay parity.)
  let sfxSeq = 0;

  // ---- World state skills ----

  const setTimeInput = z.object({
    time: z.number().min(0).max(24).describe("Time of day in hours (0-24). 0=midnight, 6=dawn, 12=noon, 18=dusk."),
    transitionMs: z.number().min(0).max(10000).default(0).describe("Smooth transition duration in ms (0 = instant)."),
    meta: MetaField,
  });

  const setTime: SkillDefinition<z.infer<typeof setTimeInput>, { ok: boolean }> = {
    name: "world.setTime",
    version: "1.0.0",
    description: "Set the world's time of day. Affects lighting, skybox, and ambient audio.",
    category: "world",
    permissions: ["world.write"],
    input: setTimeInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      worldMgr.setTime(input.time);
      ctx.emit("world.timeSet", { time: input.time, transitionMs: input.transitionMs, ...input.meta });
      return { ok: true };
    },
  };

  const setWeatherInput = z.object({
    weather: z.enum(["clear", "rain", "snow", "fog", "storm", "custom"]).describe("Weather type."),
    intensity: z.number().min(0).max(1).default(1).describe("Weather intensity (0 = none, 1 = full)."),
    config: z.record(z.string(), z.unknown()).optional().describe("Custom weather data (particle params, audio, visibility, etc.)."),
    meta: MetaField,
  });

  const setWeather: SkillDefinition<z.infer<typeof setWeatherInput>, { ok: boolean }> = {
    name: "world.setWeather",
    version: "1.0.0",
    description: "Set the active weather with intensity. Supports clear, rain, snow, fog, storm, or custom types.",
    category: "world",
    permissions: ["world.write"],
    input: setWeatherInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      worldMgr.setWeather(input.weather, input.intensity);
      ctx.emit("world.weatherSet", { weather: input.weather, intensity: input.intensity, ...input.meta });
      return { ok: true };
    },
  };

  const setTimeScaleInput = z.object({
    scale: z.number().min(0).max(10).describe("Simulation time scale (0 = pause, 1 = normal, 2 = double speed, etc.)."),
    meta: MetaField,
  });

  const setTimeScale: SkillDefinition<z.infer<typeof setTimeScaleInput>, { ok: boolean }> = {
    name: "world.setTimeScale",
    version: "1.0.0",
    description: "Set the simulation time scale. 0 pauses the world, 1 is normal speed.",
    category: "world",
    permissions: ["world.write"],
    input: setTimeScaleInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      // DETERMINISM NOTE: this is a RECORDED CONFIG VALUE ONLY. It is deliberately NOT
      // wired into the fixed-timestep sim loop here. A mid-run, wall-clock-driven timescale
      // would be a determinism hazard (replay must advance the SAME number of fixed steps
      // regardless of how fast/slow they ran in real time), so the engine's step count is
      // never derived from this value. A renderer/host may read it to pace playback; the sim
      // truth stays the fixed timestep.
      worldMgr.setTimeScale(input.scale);
      ctx.emit("world.timeScaleSet", { scale: input.scale, ...input.meta });
      return { ok: true };
    },
  };

  const getSpawnInput = z.object({ meta: MetaField });

  const getSpawn: SkillDefinition<z.infer<typeof getSpawnInput>, { position: [number, number, number] }> = {
    name: "world.getSpawn",
    version: "1.0.0",
    description: "Get the default spawn position for players.",
    category: "world",
    permissions: ["world.read"],
    input: getSpawnInput,
    output: z.object({ position: Vec3 }),
    // Pure read — no emit (mirrors the other read-only skills).
    handler: () => ({ position: worldMgr.getSpawn() }),
  };

  const setSpawnInput = z.object({
    position: Vec3.describe("Spawn position [x, y, z]."),
    meta: MetaField,
  });

  const setSpawn: SkillDefinition<z.infer<typeof setSpawnInput>, { ok: boolean }> = {
    name: "world.setSpawn",
    version: "1.0.0",
    description: "Set the default spawn position for players.",
    category: "world",
    permissions: ["world.write"],
    input: setSpawnInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      worldMgr.setSpawn(input.position);
      ctx.emit("world.spawnSet", { position: input.position, ...input.meta });
      return { ok: true };
    },
  };

  // ---- Audio extension skills ----
  //
  // A render/audio-only seam: no audio backend is required headless. These skills
  // store the BGM/reverb config in their managers and EMIT a scheduling event; they do
  // NOT themselves produce sound. An audio backend (windowed/live host) consumes the
  // stored state + the emitted events to actually play. Honest: they schedule/configure,
  // they do not claim playback that doesn't happen.

  const playBGMInput = z.object({
    trackId: z.string().min(1).describe("BGM track id."),
    volume: z.number().min(0).max(1).default(0.5),
    loop: z.boolean().default(true),
    config: z.record(z.string(), z.unknown()).optional().describe("Custom BGM data (tempo, mood, transition, etc.)."),
    meta: MetaField,
  });

  const playBGM: SkillDefinition<z.infer<typeof playBGMInput>, { ok: boolean }> = {
    name: "audio.playBGM",
    version: "1.0.0",
    description: "Schedule background music for the audio backend (looping, volume independent of the SFX bus). Stores the current-track config; the backend consumes it to play. Returns ok:false if the track id is not registered.",
    category: "audio",
    permissions: ["audio.play"],
    input: playBGMInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      const { ok } = bgmMgr.play(input.trackId, input.volume);
      ctx.emit("audio.bgmPlayed", { trackId: input.trackId, volume: input.volume, ok, ...input.meta });
      return { ok };
    },
  };

  const stopBGMInput = z.object({
    fadeMs: z.number().min(0).default(500).describe("Fade-out duration in ms."),
    meta: MetaField,
  });

  const stopBGM: SkillDefinition<z.infer<typeof stopBGMInput>, { ok: boolean }> = {
    name: "audio.stopBGM",
    version: "1.0.0",
    description: "Schedule a stop/fade-out of the current background music. Clears the stored current-track config; the backend consumes the event to fade out.",
    category: "audio",
    permissions: ["audio.play"],
    input: stopBGMInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      bgmMgr.stop();
      ctx.emit("audio.bgmStopped", { fadeMs: input.fadeMs, ...input.meta });
      return { ok: true };
    },
  };

  const setBGMInput = z.object({
    trackId: z.string().min(1),
    duration: z.number().positive().default(1).describe("Crossfade duration in seconds."),
    volume: z.number().min(0).max(1).default(0.5),
    meta: MetaField,
  });

  const setBGM: SkillDefinition<z.infer<typeof setBGMInput>, { ok: boolean }> = {
    name: "audio.setBGM",
    version: "1.0.0",
    description: "Schedule a crossfade from the current BGM to a new track over a duration. Stores the new current-track config; the backend consumes it to crossfade. Returns ok:false if the track id is not registered.",
    category: "audio",
    permissions: ["audio.play"],
    input: setBGMInput,
    output: z.object({ ok: z.boolean() }),
    handler: (input, ctx) => {
      const ok = bgmMgr.crossfade(input.trackId, input.duration, input.volume);
      ctx.emit("audio.bgmCrossfade", { trackId: input.trackId, duration: input.duration, ok, ...input.meta });
      return { ok };
    },
  };

  const playSFXInput = z.object({
    name: z.string().min(1).describe("SFX name from the sound library."),
    position: Vec3.optional().describe("Optional position for spatial playback."),
    volume: z.number().min(0).max(1).default(0.8),
    config: z.record(z.string(), z.unknown()).optional().describe("Custom SFX data (pitch variation, randomization, etc.)."),
    meta: MetaField,
  });

  const playSFX: SkillDefinition<z.infer<typeof playSFXInput>, { ok: boolean; handle: string }> = {
    name: "audio.playSFX",
    version: "1.0.0",
    description: "Schedule a named sound effect from the SFX library for the audio backend. Returns a DETERMINISTIC handle (derived from the call tick + a monotone sequence) the backend uses to track/stop the instance; replay recomputes the same handle.",
    category: "audio",
    permissions: ["audio.play"],
    input: playSFXInput,
    output: z.object({ ok: z.boolean(), handle: z.string() }),
    handler: (input, ctx) => {
      // Deterministic handle: tick + monotone seq (NOT Date.now()). Same skill sequence
      // → same handles on replay, so the returned + traced handle is replay-stable.
      const handle = `sfx_${input.name}_t${ctx.tick}_${sfxSeq++}`;
      ctx.emit("audio.sfxPlayed", { name: input.name, position: input.position, volume: input.volume, handle, ...input.meta });
      return { ok: true, handle };
    },
  };

  const setReverbInput = z.object({
    position: Vec3.describe("Reverb zone center position."),
    radius: z.number().positive().describe("Zone radius."),
    size: z.number().positive().default(1).describe("Room size."),
    decay: z.number().positive().default(1).describe("Reverb decay time."),
    damping: z.number().min(0).max(1).default(0.5).describe("High-frequency damping."),
    meta: MetaField,
  });

  const setReverb: SkillDefinition<z.infer<typeof setReverbInput>, { zoneId: string }> = {
    name: "audio.setReverb",
    version: "1.0.0",
    description: "Register a reverb zone (configurable size, decay, damping) for an area. Stores the zone in the reverb manager; the audio backend applies it when the listener is inside. Returns a deterministic zone id.",
    category: "audio",
    permissions: ["audio.play"],
    input: setReverbInput,
    output: z.object({ zoneId: z.string() }),
    handler: (input, ctx) => {
      const id = reverbMgr.addZone(input.position, input.radius, { size: input.size, decay: input.decay, damping: input.damping });
      ctx.emit("audio.reverbZone", { zoneId: id, position: input.position, radius: input.radius, ...input.meta });
      return { zoneId: id };
    },
  };

  registry.register(setTime);
  registry.register(setWeather);
  registry.register(setTimeScale);
  registry.register(getSpawn);
  registry.register(setSpawn);
  registry.register(playBGM);
  registry.register(stopBGM);
  registry.register(setBGM);
  registry.register(playSFX);
  registry.register(setReverb);

  return { worldStateManager: worldMgr, bgmManager: bgmMgr, reverbManager: reverbMgr };
}
