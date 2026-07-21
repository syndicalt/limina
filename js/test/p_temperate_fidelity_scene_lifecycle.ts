// Production temperate-fidelity Edit/Play lifecycle gate. This intentionally runs headless:
// it mounts the authenticated runtime bundle through the real terrain, water, population,
// grass, tree, glTF-cache, HDR-lease, and post-graph composition path with a non-GPU renderer
// host. Two complete cycles on the same Scene/Camera prove that terminal teardown restores host
// state and does not strand revision-scoped objects or renderer-host HDR leases.

import * as THREE from "../build/three.bundle.mjs";
import sceneAuthority from "../../art-direction/temperate-fidelity-scene.json" with { type: "json" };
import { ops, type EngineOps } from "../src/engine.ts";
import { HdrEnvironmentCache } from "../src/render/environment-hdri.ts";
import {
  loadTemperateFidelityCandidate,
  mountTemperateFidelityScene,
  type TemperateFidelityResourceReader,
} from "../src/render/temperate-fidelity-scene.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_temperate_fidelity_scene_lifecycle FAIL: ${message}`);
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const assetId = (path: string): string => path.startsWith("assets/") ? path.slice("assets/".length) : path;
const reader: TemperateFidelityResourceReader = {
  readJson: async (path) => path === "art-direction/temperate-fidelity-scene.json"
    ? JSON.parse(JSON.stringify(sceneAuthority))
    : JSON.parse(decoder.decode(ops.op_read_asset(assetId(path)))),
  // The injected headless cache deliberately does not decode the HDR payload. Other bytes still
  // come from the same sandboxed asset root used by the aggregate gate runner.
  readBytes: async (path) => path === "site/public/hero/hdri/fantasy.hdr"
    ? new Uint8Array([0x4c, 0x49, 0x4d, 0x49, 0x4e, 0x41])
    : ops.op_read_asset(assetId(path)),
};

let sourceDisposals = 0;
let targetDisposals = 0;
const environmentCache = new HdrEnvironmentCache({}, {
  decode(bytes) {
    const texture = new THREE.DataTexture(new Float32Array([bytes[0] ?? 0, 0, 0, 1]), 1, 1,
      THREE.RGBAFormat, THREE.FloatType);
    texture.dispose = () => { sourceDisposals++; };
    return texture;
  },
  buildPmrem() {
    const texture = new THREE.Texture();
    return { texture, dispose: () => { targetDisposals++; texture.dispose(); } };
  },
});

const renderer = {
  shadowMap: { enabled: false, type: THREE.BasicShadowMap },
  toneMapping: THREE.NoToneMapping,
  toneMappingExposure: 0.375,
} as unknown as THREE.WebGPURenderer;
const scene = new THREE.Scene();
const retained = new THREE.Group(); retained.name = "host-retained-sentinel"; scene.add(retained);
const priorFog = new THREE.Fog(0x123456, 2, 300);
const priorBackground = new THREE.Color(0x234567);
const priorEnvironment = new THREE.Texture();
scene.fog = priorFog;
scene.background = priorBackground;
scene.environment = priorEnvironment;
scene.backgroundIntensity = 0.41;
scene.backgroundBlurriness = 0.17;
scene.backgroundRotation.set(0.11, 0.22, 0.33);
scene.environmentIntensity = 0.52;
scene.environmentRotation.set(0.44, 0.55, 0.66);
const camera = new THREE.PerspectiveCamera(37, 4 / 3, 0.25, 420);
camera.position.set(7, 8, 9);
camera.rotation.set(0.1, 0.2, 0.3);
camera.updateMatrixWorld(true);

const rendererBaseline = Object.freeze({ enabled: renderer.shadowMap.enabled, type: renderer.shadowMap.type,
  toneMapping: renderer.toneMapping, exposure: renderer.toneMappingExposure });
const cameraBaseline = Object.freeze({ aspect: camera.aspect, near: camera.near, far: camera.far, fov: camera.fov,
  position: camera.position.clone(), quaternion: camera.quaternion.clone() });
const backgroundRotation = scene.backgroundRotation.clone();
const environmentRotation = scene.environmentRotation.clone();

for (let cycle = 0; cycle < 2; cycle++) {
  const loaded = await loadTemperateFidelityCandidate({ reader, shot: "river-leading-line" });
  const [width, height] = loaded.sceneAuthority.presentation.minimumResolution as [number, number];
  const mounted = await mountTemperateFidelityScene({
    loaded,
    renderer,
    scene,
    camera,
    ops: ops as EngineOps,
    width,
    height,
    environmentCache,
    waterDebug: cycle === 1 ? "flat" : "",
  });
  assert(scene.children.includes(mounted.candidate.root), `cycle ${cycle} did not attach the candidate root`);
  assert(mounted.population.canopyInstances > 0 && mounted.population.groundCoverBlades > 0,
    `cycle ${cycle} did not exercise real tree and grass ownership`);
  assert(mounted.candidate.waterFragmentCount > 0 && mounted.candidate.terrainMeshCount > 0,
    `cycle ${cycle} did not exercise real water and terrain ownership`);
  assert(environmentCache.stats().activeLeases === 1,
    `cycle ${cycle} did not hold exactly one HDR environment lease`);

  await mounted.dispose();
  await mounted.dispose();
  assert(mounted.candidate.disposed && mounted.candidate.root.children.length === 0,
    `cycle ${cycle} retained candidate-owned scene resources`);
  assert(mounted.world.lods?.length === 0, `cycle ${cycle} retained grass/tree LOD controllers`);
  assert(scene.children.length === 1 && scene.children[0] === retained,
    `cycle ${cycle} leaked or removed host scene children: ${scene.children.map((child) => child.name)}`);
  assert(scene.fog === priorFog && scene.background === priorBackground && scene.environment === priorEnvironment,
    `cycle ${cycle} did not restore host fog/background/environment identities`);
  assert(scene.backgroundIntensity === 0.41 && scene.backgroundBlurriness === 0.17
      && scene.environmentIntensity === 0.52
      && scene.backgroundRotation.equals(backgroundRotation) && scene.environmentRotation.equals(environmentRotation),
    `cycle ${cycle} did not restore host environment presentation state`);
  assert(renderer.shadowMap.enabled === rendererBaseline.enabled && renderer.shadowMap.type === rendererBaseline.type
      && renderer.toneMapping === rendererBaseline.toneMapping && renderer.toneMappingExposure === rendererBaseline.exposure,
    `cycle ${cycle} did not restore renderer state`);
  assert(camera.aspect === cameraBaseline.aspect && camera.near === cameraBaseline.near
      && camera.far === cameraBaseline.far && camera.fov === cameraBaseline.fov
      && camera.position.equals(cameraBaseline.position) && camera.quaternion.equals(cameraBaseline.quaternion),
    `cycle ${cycle} did not restore camera state`);
  assert(environmentCache.stats().activeLeases === 0,
    `cycle ${cycle} retained an HDR environment lease after teardown`);
  assert(sourceDisposals === 0 && targetDisposals === 0,
    `cycle ${cycle} disposed renderer-host HDR resources with the world`);
}

assert(environmentCache.stats().decodes === 1,
  "repeated Edit/Play cycles decoded identical HDR content more than once in the host cache");
environmentCache.dispose();
environmentCache.dispose();
assert(sourceDisposals === 1 && targetDisposals === 1,
  "renderer-host shutdown did not dispose the shared HDR source and PMREM target exactly once");

// Force a late mount failure after the real population and authored lights have staged. The
// already-disposed external cache rejects acquire(), proving rollback retires the provisional
// candidate and restores the same reusable host state instead of relying on successful teardown.
const failedLoaded = await loadTemperateFidelityCandidate({ reader, shot: "river-leading-line", captureRadius: 0 });
const [failureWidth, failureHeight] = failedLoaded.sceneAuthority.presentation.minimumResolution as [number, number];
let mountFailure: unknown;
try {
  await mountTemperateFidelityScene({ loaded: failedLoaded, renderer, scene, camera, ops: ops as EngineOps,
    width: failureWidth, height: failureHeight, environmentCache });
} catch (error) { mountFailure = error; }
assert(mountFailure instanceof Error && /HDR environment cache is disposed/.test(mountFailure.message),
  `late scene-mount failure did not remain observable: ${String(mountFailure)}`);
assert(failedLoaded.candidate.disposed && failedLoaded.candidate.root.children.length === 0,
  "failed scene mount retained its provisional candidate resources");
assert(scene.children.length === 1 && scene.children[0] === retained
    && scene.fog === priorFog && scene.background === priorBackground && scene.environment === priorEnvironment,
  "failed scene mount did not restore host scene ownership");
assert(renderer.shadowMap.enabled === rendererBaseline.enabled && renderer.shadowMap.type === rendererBaseline.type
    && renderer.toneMapping === rendererBaseline.toneMapping && renderer.toneMappingExposure === rendererBaseline.exposure,
  "failed scene mount did not restore renderer state");
assert(camera.aspect === cameraBaseline.aspect && camera.near === cameraBaseline.near
    && camera.far === cameraBaseline.far && camera.fov === cameraBaseline.fov
    && camera.position.equals(cameraBaseline.position) && camera.quaternion.equals(cameraBaseline.quaternion),
  "failed scene mount did not restore camera state");
priorEnvironment.dispose();

ops.op_log("p_temperate_fidelity_scene_lifecycle OK: two authenticated production-scene create/dispose cycles plus a late-failure rollback exercised terrain, water, grass, trees, glTF cache, HDR leases, post graph, lights, camera, and renderer state headlessly; revision resources retire, host state restores exactly, and shared HDR resources survive until host shutdown");
