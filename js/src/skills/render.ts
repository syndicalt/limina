// Phase 11 — the render.* skill seam: opt-in, RENDER-ONLY post-processing.
//
// `render.enablePost` wraps buildPostPipeline (render/post.ts) as a first-class skill: it
// builds the GTAO + bloom + grade pipeline on the LIVE renderer/scene/camera and stores
// it on the world (`world.post`) so a render loop can drive `post.render()` in place of
// `renderer.render(...)`. Renderer-free authoring accepts the declarative command for
// recording/replay and reports it as deferred. Returns the resolved preset and status.
//
// RENDER-ONLY: the post stack composites the colour the scene pass already produced. It
// reads NOTHING from and writes NOTHING to the sim / physics / world-log / replay — a
// world renders identically (and logs/replays bit-for-bit) with or without it.
//
// Camera matrices are refreshed from the live transform before every post frame, so orbit and
// free-fly navigation use current camera state. Execution quality may cap the authored AO/bloom
// cost, but it never mutates the recorded artistic preset.

import { z } from "../../build/zod.bundle.mjs";
import { buildPostPipeline, resolvePostPreset, type PostPipeline } from "../render/post.ts";
import type { SkillDefinition, SkillRegistry } from "./registry.ts";

const aoOverride = z.object({
  enabled: z.boolean().optional(),
  radius: z.number().optional(),
  scale: z.number().optional(),
  distanceExponent: z.number().optional(),
  thickness: z.number().optional(),
  samples: z.number().int().optional(),
  resolutionScale: z.number().optional(),
  intensity: z.number().optional(),
}).optional();
const bloomOverride = z.object({
  enabled: z.boolean().optional(),
  strength: z.number().optional(),
  radius: z.number().optional(),
  threshold: z.number().optional(),
}).optional();
const gradeOverride = z.object({
  enabled: z.boolean().optional(),
  exposure: z.number().optional(),
  contrast: z.number().optional(),
  saturation: z.number().optional(),
}).optional();
const godraysOverride = z.object({
  enabled: z.boolean().optional(),
  density: z.number().optional(),
  maxDensity: z.number().optional(),
  distanceAttenuation: z.number().optional(),
  raymarchSteps: z.number().int().optional(),
  intensity: z.number().optional(),
}).optional();
const dofOverride = z.object({
  enabled: z.boolean().optional(),
  focusDistance: z.number().optional(),
  focalLength: z.number().optional(),
  bokehScale: z.number().optional(),
}).optional();
const outlineOverride = z.object({
  enabled: z.boolean().optional(),
  strength: z.number().optional(),
}).optional();

const enablePostInput = z.object({
  /** Per-stage preset overrides (deep-merged onto the "Grounded Stylized Realism" default).
   *  Omit for the tuned default. ao/bloom/grade are on by default; godrays/dof/outline off. */
  ao: aoOverride,
  bloom: bloomOverride,
  grade: gradeOverride,
  godrays: godraysOverride,
  dof: dofOverride,
  outline: outlineOverride,
});

const enablePostOutput = z.object({
  /** Whether the live pipeline was built. False in a renderer-free authoring/export world. */
  enabled: z.boolean(),
  /** True when the declarative command was accepted for replay but no renderer exists yet. */
  deferred: z.boolean(),
  /** Which stages are wired (a disabled stage drops its node). */
  ao: z.boolean(),
  bloom: z.boolean(),
  grade: z.boolean(),
  /** Proof the real depth + normal pre-pass is wired (GTAO's true source). */
  depth: z.boolean(),
  normal: z.boolean(),
  /** Opt-in stages: godrays wires only if a shadow-casting sun was found; dof/outline
   *  wire whenever enabled. All false unless explicitly turned on. */
  godrays: z.boolean(),
  dof: z.boolean(),
  outline: z.boolean(),
  /** The resolved preset the pipeline was built from. */
  preset: z.unknown(),
});

/** Register the render.* skills. `render.enablePost` builds the post pipeline on the live
 *  renderer (windowed) and stashes it on `world.post` for the render loop to drive. */
export function registerRenderSkills(registry: SkillRegistry): void {
  const enablePost: SkillDefinition<z.infer<typeof enablePostInput>, z.infer<typeof enablePostOutput>> = {
    name: "render.enablePost",
    version: "1.0.0",
    description: "Build the RENDER-ONLY post-processing pipeline (real depth+normal pre-pass → GTAO contact AO → highlight bloom → gentle HDR grade) on the live renderer/scene/camera and store it on world.post for the render loop to drive (post.render() in place of renderer.render). A renderer-free headless authoring world accepts and records the command but defers pipeline creation until live replay. Returns the resolved preset and materialization status.",
    category: "world",
    permissions: ["scene.write"],
    input: enablePostInput,
    output: enablePostOutput,
    handler: (input, ctx) => {
      const renderer = ctx.world.renderer;
      if (renderer === undefined || renderer === null) {
        if (ctx.world.mode !== "headless") {
          throw new Error("render.enablePost: no renderer on a non-headless world");
        }
        const preset = resolvePostPreset({
          ao: input.ao, bloom: input.bloom, grade: input.grade,
          godrays: input.godrays, dof: input.dof, outline: input.outline,
        });
        ctx.emit("render.post.deferred", {});
        return {
          enabled: false,
          deferred: true,
          ao: false,
          bloom: false,
          grade: false,
          depth: false,
          normal: false,
          godrays: false,
          dof: false,
          outline: false,
          preset,
        };
      }
      const pipeline: PostPipeline = buildPostPipeline(renderer, ctx.world.scene, ctx.world.camera, {
        ao: input.ao, bloom: input.bloom, grade: input.grade,
        godrays: input.godrays, dof: input.dof, outline: input.outline,
      });
      // Stash the live pipeline on the world so the render loop can drive it.
      (ctx.world.post as { dispose?(): void } | undefined)?.dispose?.();
      ctx.world.post = pipeline;
      ctx.emit("render.post.enabled", {
        ao: pipeline.preset.ao.enabled, bloom: pipeline.preset.bloom.enabled, grade: pipeline.preset.grade.enabled,
      });
      return {
        enabled: true,
        deferred: false,
        ao: pipeline.aoNode !== null,
        bloom: pipeline.bloomNode !== null,
        grade: pipeline.preset.grade.enabled,
        depth: pipeline.depthNode !== undefined && pipeline.depthNode !== null,
        normal: pipeline.normalNode !== undefined && pipeline.normalNode !== null,
        godrays: pipeline.godraysNode !== null && pipeline.godraysNode !== undefined,
        dof: pipeline.preset.dof.enabled,
        outline: pipeline.preset.outline.enabled,
        preset: pipeline.preset,
      };
    },
  };

  registry.register(enablePost);
}
