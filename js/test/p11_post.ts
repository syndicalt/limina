// Phase 3 (terrain overhaul) — RENDER-ONLY post-processing stack (headless).
//
// buildPostPipeline() composites the scene colour through a real depth+normal
// pre-pass → GTAO (contact ambient occlusion) → bloom (highlight glow) → a gentle
// HDR grade, over three's PostProcessing. This proves the GRAPH CONSTRUCTS and is
// WIRED correctly without a live GPU: the nodes are plain JS objects until the
// shader compiles (windowed UAT / the demo boot is the empirical GPU proof).
//
// Proves:
//   (1) the pipeline constructs (PostProcessing + scene pass + an outputNode).
//   (2) the depth + normal PRE-PASS is real: the scene pass exposes a sampleable
//       'depth' and 'normal' texture node (not a camera-distance proxy).
//   (3) GTAO is present and FED the pre-pass depth+normal (its depthNode/normalNode
//       are the scene pass's texture nodes), with the preset's params on its uniforms.
//   (4) bloom is present with the preset's strength/radius/threshold.
//   (5) the grade + preset are FALSIFIABLE: overrides actually change the node
//       params / preset, and a disabled stage drops its node to null.
//
// Run: limina js/test/p11_post.ts   (exit 0 = pass)

import * as THREE from "../build/three.bundle.mjs";
import {
  buildPostPipeline,
  DEFAULT_POST_PRESET,
  resolvePostPreset,
} from "../src/render/post.ts";
import { ops } from "../src/engine.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p11_post FAIL: " + msg);
}

// A real Scene + PerspectiveCamera (GTAO reads camera.projectionMatrix at build).
// The renderer is only STORED by PostProcessing (no GPU call until render()), so a
// minimal stub stands in for the headless (no-adapter) path.
function makeSceneCamera(): { scene: unknown; camera: unknown } {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 200);
  camera.updateProjectionMatrix();
  return { scene, camera };
}
const stubRenderer = {} as unknown;

// ===========================================================================
// (1) constructs — PostProcessing + scene pass + an outputNode
// ===========================================================================
{
  const { scene, camera } = makeSceneCamera();
  const pipe = buildPostPipeline(stubRenderer, scene, camera);
  assert(pipe.postProcessing !== undefined && pipe.postProcessing !== null, "no PostProcessing object");
  assert((pipe.postProcessing as { outputNode?: unknown }).outputNode !== undefined, "PostProcessing.outputNode not set");
  assert(pipe.scenePass !== undefined && pipe.scenePass !== null, "no scene pass node");
  assert(typeof pipe.render === "function" && typeof pipe.setSize === "function", "driver methods missing");
}

// ===========================================================================
// (2) the depth + normal PRE-PASS is real (sampleable texture nodes)
// ===========================================================================
{
  const { scene, camera } = makeSceneCamera();
  const pipe = buildPostPipeline(stubRenderer, scene, camera);
  assert(pipe.depthNode !== undefined && pipe.depthNode !== null, "scene pass exposes no depth texture node");
  assert(pipe.normalNode !== undefined && pipe.normalNode !== null, "scene pass exposes no normal texture node (MRT not wired)");
  // A scene pass with MRT carries an mrt node — the proof the normal target exists.
  const mrt = (pipe.scenePass as { getMRT?: () => unknown }).getMRT?.();
  assert(mrt !== undefined && mrt !== null, "scene pass has no MRT (depth+normal pre-pass not configured)");
  // The depth/normal nodes are distinct texture nodes off the same pass.
  assert(pipe.depthNode !== pipe.normalNode, "depth and normal nodes must be distinct");
}

// ===========================================================================
// (3) GTAO present + FED the pre-pass depth/normal + preset params on its uniforms
// ===========================================================================
{
  const { scene, camera } = makeSceneCamera();
  const pipe = buildPostPipeline(stubRenderer, scene, camera);
  assert(pipe.aoNode !== null && pipe.aoNode !== undefined, "GTAO node absent (AO enabled by default)");
  // deno-lint-ignore no-explicit-any
  const ao = pipe.aoNode as any;
  // The GTAO node consumes the SCENE PASS's depth + normal texture nodes — i.e. the
  // real pre-pass, not a proxy. (ao(depthNode, normalNode, camera) stores them.)
  assert(ao.depthNode === pipe.depthNode, "GTAO depthNode is NOT the scene pass depth node");
  assert(ao.normalNode === pipe.normalNode, "GTAO normalNode is NOT the scene pass normal node");
  // Preset params landed on the node's uniforms.
  const p = DEFAULT_POST_PRESET.ao;
  assert(ao.radius.value === p.radius, `GTAO radius ${ao.radius.value} != preset ${p.radius}`);
  assert(ao.scale.value === p.scale, "GTAO scale not from preset");
  assert(ao.samples.value === p.samples, "GTAO samples not from preset");
  assert(ao.thickness.value === p.thickness, "GTAO thickness not from preset");
  assert(ao.distanceExponent.value === p.distanceExponent, "GTAO distanceExponent not from preset");
  assert(ao.resolutionScale === p.resolutionScale, "GTAO resolutionScale not from preset");
}

// ===========================================================================
// (4) bloom present with the preset's strength/radius/threshold
// ===========================================================================
{
  const { scene, camera } = makeSceneCamera();
  const pipe = buildPostPipeline(stubRenderer, scene, camera);
  assert(pipe.bloomNode !== null && pipe.bloomNode !== undefined, "bloom node absent (bloom enabled by default)");
  // deno-lint-ignore no-explicit-any
  const b = pipe.bloomNode as any;
  const p = DEFAULT_POST_PRESET.bloom;
  assert(b.strength.value === p.strength, `bloom strength ${b.strength.value} != preset ${p.strength}`);
  assert(b.threshold.value === p.threshold, `bloom threshold ${b.threshold.value} != preset ${p.threshold}`);
  assert(b.radius.value === p.radius, "bloom radius not from preset");
}

// ===========================================================================
// (5) FALSIFIABLE — overrides change params; disabled stages drop to null
// ===========================================================================
{
  // resolvePostPreset deep-merges per stage.
  const merged = resolvePostPreset({ ao: { radius: 1.7, intensity: 0.5 }, bloom: { threshold: 0.5 } });
  assert(merged.ao.radius === 1.7 && merged.ao.intensity === 0.5, "override did not change AO preset");
  assert(merged.ao.scale === DEFAULT_POST_PRESET.ao.scale, "override clobbered untouched AO fields");
  assert(merged.bloom.threshold === 0.5, "override did not change bloom preset");
  assert(merged.grade.contrast === DEFAULT_POST_PRESET.grade.contrast, "override clobbered untouched grade");

  const { scene, camera } = makeSceneCamera();
  const pipe = buildPostPipeline(stubRenderer, scene, camera, { ao: { radius: 1.7 }, bloom: { strength: 0.9 } });
  // deno-lint-ignore no-explicit-any
  assert((pipe.aoNode as any).radius.value === 1.7, "override radius not applied to GTAO node");
  // deno-lint-ignore no-explicit-any
  assert((pipe.bloomNode as any).strength.value === 0.9, "override strength not applied to bloom node");

  // Disabling a stage drops its node (and is reflected in the preset).
  const off = buildPostPipeline(stubRenderer, scene, camera, {
    ao: { enabled: false },
    bloom: { enabled: false },
    grade: { enabled: false },
  });
  assert(off.aoNode === null, "disabled AO must drop the GTAO node");
  assert(off.bloomNode === null, "disabled bloom must drop the bloom node");
  assert(off.preset.ao.enabled === false && off.preset.bloom.enabled === false && off.preset.grade.enabled === false, "disabled flags not on preset");
  // With AO off, the depth+normal pre-pass is still built (cheap + harmless), and the
  // outputNode is still set (the colour pass, plain).
  assert((off.postProcessing as { outputNode?: unknown }).outputNode !== undefined, "outputNode missing with all stages off");
}

// ===========================================================================
// (6) NAVIGATION regression guard — the post path renders from the LIVE camera.
//     pipeline.render() must refresh camera.matrixWorld from the current transform
//     BEFORE the scene pass samples it (the bare renderer.render this replaced did
//     so implicitly). Drive 2 frames with DIFFERENT camera positions and assert the
//     camera's world matrix tracks frame-to-frame through pipeline.render().
//
//     Headless has no GPU, so post.render() (the real RenderPipeline) throws once it
//     reaches the quad render — but the camera refresh runs FIRST, so we catch the
//     throw and assert the matrix updated. FALSIFIABLE: drop the refresh from
//     render() and the matrix stays stale (this section fails).
// ===========================================================================
{
  const { scene, camera } = makeSceneCamera();
  // deno-lint-ignore no-explicit-any
  const cam = camera as any;
  const pipe = buildPostPipeline(stubRenderer, scene, camera);

  function driveFrame(x: number, y: number, z: number): number[] {
    cam.position.set(x, y, z);
    // The real loop also calls lookAt; position alone is enough to prove the refresh.
    try {
      pipe.render(); // refreshes camera.matrixWorld, then post.render() throws (no GPU)
    } catch (_e) {
      // expected: the quad render needs a real renderer. The camera refresh ran first.
    }
    return [...cam.matrixWorld.elements];
  }

  const m1 = driveFrame(5, 0, 0);
  const m2 = driveFrame(-7, 2, 9);
  // matrixWorld translation column = the camera world position → it tracked the move.
  assert(m1[12] === 5 && m1[13] === 0 && m1[14] === 0, `frame 1 camera matrix stale: [${m1[12]},${m1[13]},${m1[14]}]`);
  assert(m2[12] === -7 && m2[13] === 2 && m2[14] === 9, `frame 2 camera matrix stale: [${m2[12]},${m2[13]},${m2[14]}]`);
  assert(m1[12] !== m2[12] || m1[14] !== m2[14], "camera matrix did NOT change frame-to-frame (navigation frozen)");
}

ops.op_log(
  "p11_post OK: post pipeline constructs (PostProcessing + scene pass + outputNode); " +
  "REAL depth+normal pre-pass (sampleable depth/normal texture nodes + MRT); " +
  "GTAO fed the pre-pass depth+normal with preset params on its uniforms; " +
  "bloom present (strength/radius/threshold from preset); " +
  "grade + preset FALSIFIABLE (overrides change node params; disabled stages drop to null); " +
  "NAVIGATION guard: pipeline.render() refreshes the camera world matrix from the live transform " +
  "each frame (tracks position frame-to-frame — no frozen view). " +
  "GPU path proven by the windowed demo boot.",
);
