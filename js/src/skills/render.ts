// Phase 11 — the render.* skill seam: opt-in, RENDER-ONLY post-processing.
//
// `render.enablePost` wraps buildPostPipeline (render/post.ts) as a first-class skill: it
// builds the GTAO + bloom + grade pipeline on the LIVE renderer/scene/camera and stores
// it on the world (`world.post`) so a render loop can drive `post.render()` in place of
// `renderer.render(...)`. Returns a handle (the resolved preset + which stages are wired).
//
// RENDER-ONLY: the post stack composites the colour the scene pass already produced. It
// reads NOTHING from and writes NOTHING to the sim / physics / world-log / replay — a
// world renders identically (and logs/replays bit-for-bit) with or without it.
//
// STATIC / CINEMATIC-ONLY, OPT-IN: on this WebGPU windowed backend the post composite does
// not reliably present a FRESH frame per camera move (the known native present-frame
// limitation — see render/post.ts and the USE_POST notes in the windowed demos), so the
// view can stick while the camera moves. Use it for SCREENSHOTS / FIXED-CAMERA shots until
// that native fix lands; for live free-fly navigation drive the bare renderer.render path.

import { z } from "../../build/zod.bundle.mjs";
import { buildPostPipeline, type PostPipeline } from "../render/post.ts";
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

const enablePostInput = z.object({
  /** Per-stage preset overrides (deep-merged onto the "Grounded Stylized Realism" default).
   *  Omit for the tuned default. */
  ao: aoOverride,
  bloom: bloomOverride,
  grade: gradeOverride,
});

const enablePostOutput = z.object({
  /** Whether the pipeline was built (false would be an error path — kept for symmetry). */
  enabled: z.boolean(),
  /** Which stages are wired (a disabled stage drops its node). */
  ao: z.boolean(),
  bloom: z.boolean(),
  grade: z.boolean(),
  /** Proof the real depth + normal pre-pass is wired (GTAO's true source). */
  depth: z.boolean(),
  normal: z.boolean(),
  /** The resolved preset the pipeline was built from. */
  preset: z.unknown(),
});

/** Register the render.* skills. `render.enablePost` builds the post pipeline on the live
 *  renderer (windowed) and stashes it on `world.post` for the render loop to drive. */
export function registerRenderSkills(registry: SkillRegistry): void {
  const enablePost: SkillDefinition<z.infer<typeof enablePostInput>, z.infer<typeof enablePostOutput>> = {
    name: "render.enablePost",
    version: "1.0.0",
    description: "Build the RENDER-ONLY post-processing pipeline (real depth+normal pre-pass → GTAO contact AO → highlight bloom → gentle HDR grade) on the live renderer/scene/camera and store it on world.post for the render loop to drive (post.render() in place of renderer.render). Returns the resolved preset + which stages are wired. STATIC/CINEMATIC-ONLY + OPT-IN: on this WebGPU windowed backend the composite does not reliably present a fresh frame per camera move, so use it for screenshots/fixed-camera shots (drive the bare renderer.render path for live navigation). Render-only: never touches the sim/log/replay.",
    category: "world",
    permissions: ["scene.write"],
    input: enablePostInput,
    output: enablePostOutput,
    handler: (input, ctx) => {
      const renderer = ctx.world.renderer;
      if (renderer === undefined || renderer === null) {
        throw new Error("render.enablePost: no renderer on the world (windowed/live-renderer only)");
      }
      const pipeline: PostPipeline = buildPostPipeline(renderer, ctx.world.scene, ctx.world.camera, {
        ao: input.ao, bloom: input.bloom, grade: input.grade,
      });
      // Stash the live pipeline on the world so the render loop can drive it.
      ctx.world.post = pipeline;
      ctx.emit("render.post.enabled", {
        ao: pipeline.preset.ao.enabled, bloom: pipeline.preset.bloom.enabled, grade: pipeline.preset.grade.enabled,
      });
      return {
        enabled: true,
        ao: pipeline.aoNode !== null,
        bloom: pipeline.bloomNode !== null,
        grade: pipeline.preset.grade.enabled,
        depth: pipeline.depthNode !== undefined && pipeline.depthNode !== null,
        normal: pipeline.normalNode !== undefined && pipeline.normalNode !== null,
        preset: pipeline.preset,
      };
    },
  };

  registry.register(enablePost);
}
