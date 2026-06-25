// audio.* skills — the agent-native surface over the native limina-audio backend.
// A builder/agent plays synthesized SFX, looping ambience, and positional sound
// exactly as it authors the world: every call is Zod-validated, permission-checked
// (`audio.play`), and traced (registry `skill.executed` + an `audio.*` event). The
// skills drive a shared AudioManager (../audio/manager.ts); the host calls
// op_audio_init once and runs the per-frame listener/emitter sync.

import { z } from "../../build/zod.bundle.mjs";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";
import type { AudioManager, BusName } from "../audio/manager.ts";

const busEnum = z.enum(["master", "sfx", "ambience", "voice"]);
const vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

const playInput = z.object({
  freq: z.number().positive(),
  secs: z.number().positive().max(10),
  bus: busEnum.optional(),
  volume: z.number().min(0).max(1).optional(),
}).strict();
const ambientInput = z.object({
  bus: busEnum.optional(),
  volume: z.number().min(0).max(1).optional(),
}).strict();
const playAtInput = z.object({
  freq: z.number().positive(),
  secs: z.number().positive().max(10),
  position: vec3Schema,
  bus: busEnum.optional(),
  volume: z.number().min(0).max(1).optional(),
  maxDistance: z.number().min(0).optional(),
}).strict();
const stopInput = z.object({ handle: z.string() }).strict();
const setVolumeInput = z.object({ handle: z.string(), volume: z.number().min(0).max(1) }).strict();
const setBusInput = z.object({ bus: busEnum, volume: z.number().min(0).max(1) }).strict();

const handleOutput = z.object({ handle: z.string() });
const okOutput = z.object({ ok: z.boolean() });

export function registerAudioSkills(registry: SkillRegistry, audio: AudioManager): void {
  const play: SkillDefinition<z.infer<typeof playInput>, { handle: string }> = {
    name: "audio.play",
    version: "1.0.0",
    description: "Play a one-shot synthesized SFX blip (sine + envelope) on a bus (master/sfx/ambience/voice). Returns an opaque handle.",
    category: "audio",
    permissions: ["audio.play"],
    input: playInput,
    output: handleOutput,
    handler: (input, ctx) => {
      const bus: BusName = input.bus ?? "sfx";
      const handle = audio.play(input.freq, input.secs, bus, input.volume ?? 0.8);
      ctx.emit("audio.played", { handle, bus, freq: input.freq, secs: input.secs });
      return { handle };
    },
  };
  registry.register(play);

  const ambient: SkillDefinition<z.infer<typeof ambientInput>, { handle: string }> = {
    name: "audio.ambient",
    version: "1.0.0",
    description: "Start a looping synthesized ambience bed on a bus (default ambience). Returns an opaque handle.",
    category: "audio",
    permissions: ["audio.play"],
    input: ambientInput,
    output: handleOutput,
    handler: (input, ctx) => {
      const bus: BusName = input.bus ?? "ambience";
      const handle = audio.ambient(bus, input.volume ?? 0.5);
      ctx.emit("audio.ambient.started", { handle, bus });
      return { handle };
    },
  };
  registry.register(ambient);

  const playAt: SkillDefinition<z.infer<typeof playAtInput>, { handle: string }> = {
    name: "audio.playAt",
    version: "1.0.0",
    description: "Play a one-shot POSITIONAL synthesized SFX at a world position; 3D-panned + attenuated relative to the camera listener. Optional maxDistance cutoff. Returns an opaque handle.",
    category: "audio",
    permissions: ["audio.play"],
    input: playAtInput,
    output: handleOutput,
    handler: (input, ctx) => {
      const bus: BusName = input.bus ?? "sfx";
      const handle = audio.playAt(
        input.freq,
        input.secs,
        input.position,
        bus,
        input.volume ?? 0.9,
        input.maxDistance ?? 0,
      );
      ctx.emit("audio.played", { handle, bus, freq: input.freq, spatial: true, position: input.position });
      return { handle };
    },
  };
  registry.register(playAt);

  const speakInput = z.object({
    text: z.string().min(1).max(500),
    position: vec3Schema,
    volume: z.number().min(0).max(1).optional(),
  }).strict();
  const speak: SkillDefinition<z.infer<typeof speakInput>, { handle: string }> = {
    name: "audio.speak",
    version: "1.0.0",
    description: "Speak a line of text aloud at a world position via a pluggable local TTS voice (voice bus, positional). FIRE-AND-FORGET: returns immediately; synthesis runs off-thread and never blocks the frame. Returns an opaque handle.",
    category: "audio",
    permissions: ["audio.play"],
    input: speakInput,
    output: handleOutput,
    handler: (input, ctx) => {
      const handle = audio.speak(input.text, input.position, input.volume ?? 0.95);
      ctx.emit("audio.spoke", { handle, chars: input.text.length, position: input.position });
      return { handle };
    },
  };
  registry.register(speak);

  const stop: SkillDefinition<z.infer<typeof stopInput>, { ok: boolean }> = {
    name: "audio.stop",
    version: "1.0.0",
    description: "Stop a playing sound by handle.",
    category: "audio",
    permissions: ["audio.play"],
    input: stopInput,
    output: okOutput,
    handler: (input, ctx) => {
      const ok = audio.stop(input.handle);
      ctx.emit("audio.stopped", { handle: input.handle, ok });
      return { ok };
    },
  };
  registry.register(stop);

  const setVolume: SkillDefinition<z.infer<typeof setVolumeInput>, { ok: boolean }> = {
    name: "audio.setVolume",
    version: "1.0.0",
    description: "Set a playing sound's volume (0..1) by handle.",
    category: "audio",
    permissions: ["audio.play"],
    input: setVolumeInput,
    output: okOutput,
    handler: (input, ctx) => {
      const ok = audio.setVolume(input.handle, input.volume);
      ctx.emit("audio.volume.set", { handle: input.handle, volume: input.volume, ok });
      return { ok };
    },
  };
  registry.register(setVolume);

  const setBusVolume: SkillDefinition<z.infer<typeof setBusInput>, { ok: boolean }> = {
    name: "audio.setBusVolume",
    version: "1.0.0",
    description: "Set a mixer bus volume (master/sfx/ambience/voice), re-gaining all live sounds on it.",
    category: "audio",
    permissions: ["audio.play"],
    input: setBusInput,
    output: okOutput,
    handler: (input, ctx) => {
      audio.setBusVolume(input.bus, input.volume);
      ctx.emit("audio.bus.set", { bus: input.bus, volume: input.volume });
      return { ok: true };
    },
  };
  registry.register(setBusVolume);
}
