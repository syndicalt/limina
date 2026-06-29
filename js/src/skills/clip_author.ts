// clip authoring skills — PROCEDURAL ANIMATION AUTHORING.
//
// The existing animation.* skills PLAY/blend imported glTF clips; they cannot CREATE animation
// data. This is the authoring half: an agent defines a clip from keyframe TRACKS (a property
// animated over time by {t, value} keys with step/linear interpolation) and SAMPLES it at any
// time — so animations (a door swing, a lift's path, a pulsing light, a patrol curve) can be
// generated, not just imported. Values are scalars or vectors (component-wise), so one track can
// drive a position [x,y,z], a scale, an angle, or a color.
//
// DETERMINISM: sampling is a pure function of (clip, t) — no wall clock, no RNG. The host applies
// the sampled values to entity transforms/properties on the render or sim side; because the value
// at a recorded tick t is deterministic, an authored animation is fully replay-safe. The manager
// owns only the clip DATA + sampling (it performs no side effects), exactly like the other
// data-driven primitives.

import { z } from "../../build/zod.bundle.mjs";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";

export type ClipValue = number | number[];
export type Interp = "step" | "linear";
export interface Keyframe { t: number; v: ClipValue; }
export interface Track { property: string; interp: Interp; keys: Keyframe[]; }
export interface AuthoredClip { duration: number; loop: boolean; tracks: Track[]; }

function lerp(a: ClipValue, b: ClipValue, f: number): ClipValue {
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) out[i] = a[i] + (b[i] - a[i]) * f;
    return out;
  }
  if (typeof a === "number" && typeof b === "number") return a + (b - a) * f;
  return a; // mismatched shapes → hold the earlier value rather than produce garbage
}

export class ClipAuthor {
  private readonly clips = new Map<string, AuthoredClip>();

  /** Register (or replace) a clip. Each track's keys are sorted ascending by time so sampling is
   *  order-independent for the author. */
  define(id: string, duration: number, loop: boolean, tracks: Track[]): { tracks: number; keys: number } {
    let keys = 0;
    const norm = tracks.map((tr) => {
      const sorted = [...tr.keys].sort((a, b) => a.t - b.t);
      keys += sorted.length;
      return { property: tr.property, interp: tr.interp, keys: sorted };
    });
    this.clips.set(id, { duration, loop, tracks: norm });
    return { tracks: norm.length, keys };
  }

  has(id: string): boolean {
    return this.clips.has(id);
  }

  /** Map a raw time onto the clip's playable range: wrap when looping, else clamp to [0,duration]. */
  private effectiveTime(clip: AuthoredClip, t: number): number {
    if (clip.loop && clip.duration > 0) return ((t % clip.duration) + clip.duration) % clip.duration;
    return t < 0 ? 0 : t > clip.duration ? clip.duration : t;
  }

  private sampleTrack(tr: Track, tt: number): ClipValue {
    const keys = tr.keys;
    if (keys.length === 0) return 0;
    if (tt <= keys[0].t) return keys[0].v;
    if (tt >= keys[keys.length - 1].t) return keys[keys.length - 1].v;
    let i = 0;
    while (i < keys.length - 1 && keys[i + 1].t <= tt) i++;
    const k0 = keys[i], k1 = keys[i + 1];
    if (tr.interp === "step") return k0.v;
    const span = k1.t - k0.t;
    const f = span > 0 ? (tt - k0.t) / span : 0;
    return lerp(k0.v, k1.v, f);
  }

  /** Sample every track at time `t`, returning property → value. null if the clip is unknown. */
  sample(id: string, t: number): Record<string, ClipValue> | null {
    const clip = this.clips.get(id);
    if (clip === undefined) return null;
    const tt = this.effectiveTime(clip, t);
    const out: Record<string, ClipValue> = {};
    for (const tr of clip.tracks) out[tr.property] = this.sampleTrack(tr, tt);
    return out;
  }
}

const valueSchema = z.union([z.number(), z.array(z.number())]);
const trackSchema = z.object({
  property: z.string().min(1).describe("What this track drives (e.g. \"position\", \"angle\", \"color\")."),
  interp: z.enum(["step", "linear"]).default("linear"),
  keys: z.array(z.object({ t: z.number().min(0), value: valueSchema })).min(1).describe("Keyframes {t, value}; sorted by t internally."),
});

export function registerClipAuthorSkills(registry: SkillRegistry): { clipAuthor: ClipAuthor } {
  const mgr = new ClipAuthor();

  const authorInput = z.object({
    id: z.string().min(1),
    duration: z.number().positive().max(100000).describe("Clip length in the same time unit as sample t."),
    loop: z.boolean().default(false),
    tracks: z.array(trackSchema).min(1).max(256),
    meta: z.record(z.string(), z.unknown()).optional(),
  });
  const author: SkillDefinition<z.infer<typeof authorInput>, { ok: boolean; tracks: number; keys: number }> = {
    name: "animation.authorClip",
    version: "1.0.0",
    description: "Author a procedural animation clip from keyframe tracks (property → {t,value} keys, step/linear). Sample it with animation.sampleClip; the host applies the values. Deterministic + replay-safe.",
    category: "animation",
    permissions: ["animation.write"],
    input: authorInput,
    output: z.object({ ok: z.boolean(), tracks: z.number(), keys: z.number() }),
    handler: (input, ctx) => {
      const tracks: Track[] = input.tracks.map((tr) => ({ property: tr.property, interp: tr.interp, keys: tr.keys.map((k) => ({ t: k.t, v: k.value })) }));
      const r = mgr.define(input.id, input.duration, input.loop, tracks);
      ctx.emit("animation.clipAuthored", { id: input.id, duration: input.duration, loop: input.loop, ...r, ...input.meta });
      return { ok: true, ...r };
    },
  };

  const sampleInput = z.object({ id: z.string(), t: z.number() });
  const sample: SkillDefinition<z.infer<typeof sampleInput>, { found: boolean; values?: Record<string, ClipValue> }> = {
    name: "animation.sampleClip",
    version: "1.0.0",
    description: "Sample an authored clip at time t — returns each track's interpolated value (looped/clamped per the clip). Pure read; the host applies the values to entities.",
    category: "animation",
    permissions: ["animation.read"],
    input: sampleInput,
    output: z.object({ found: z.boolean(), values: z.record(z.string(), valueSchema).optional() }),
    handler: (input) => {
      const values = mgr.sample(input.id, input.t);
      return values === null ? { found: false } : { found: true, values };
    },
  };

  registry.register(author);
  registry.register(sample);
  return { clipAuthor: mgr };
}
