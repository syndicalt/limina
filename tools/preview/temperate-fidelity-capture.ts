import * as THREE from "../../js/build/three.bundle.mjs";
import type { EngineOps } from "../../js/src/engine.ts";
import { withFrozenRendererTime } from "../../js/src/render/frozen-render-time.ts";
import {
  loadTemperateFidelityCandidate,
  mountTemperateFidelityScene,
  temperateFidelityCaptureSchedule,
  type TemperateFidelityResourceReader,
  type TemperateFidelityStage,
} from "../../js/src/render/temperate-fidelity-scene.ts";
import { sha256 } from "../../js/src/world/sha256.mjs";

declare global { interface Window { __captureReady?: unknown; __captureError?: string } }

const reader: TemperateFidelityResourceReader = {
  readJson: async (path) => {
    const response = await fetch(`/${path}`);
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return response.json();
  },
  readBytes: async (path) => {
    const response = await fetch(`/${path}`);
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  },
};

async function main(): Promise<void> {
  const startedAt = performance.now();
  let stageStartedAt = startedAt;
  const timingsMs: Record<string, number> = {};
  const finishStage = (stage: TemperateFidelityStage | "rendererInit" | "warmupAndRender"): void => {
    const now = performance.now();
    timingsMs[stage] = Number((now - stageStartedAt).toFixed(2));
    stageStartedAt = now;
  };
  const query = new URLSearchParams(location.search);
  const shot = query.get("shot") ?? "forest-river";
  const waterDebug = query.get("waterDebug") ?? "";
  if (waterDebug !== "" && waterDebug !== "flat") throw new Error("waterDebug must be empty or 'flat'");
  const loaded = await loadTemperateFidelityCandidate({ reader, shot, stageComplete: finishStage });
  const [width, height] = loaded.sceneAuthority.presentation.minimumResolution as [number, number];
  const schedule = temperateFidelityCaptureSchedule(loaded.sceneAuthority);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  document.body.appendChild(canvas);
  document.body.style.cssText = "margin:0;overflow:hidden;background:#101820";
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL: true });
  await renderer.init();
  renderer.setSize(width, height, false);
  renderer.setPixelRatio(1);
  finishStage("rendererInit");

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(48, width / height, 0.1, 700);
  const ops = {
    op_sha256: (value: string): string => sha256(value),
    op_read_asset: (assetId: string): Uint8Array => {
      throw new Error(`fidelity capture cannot read unbundled asset '${assetId}'`);
    },
  } as EngineOps;
  const mounted = await mountTemperateFidelityScene({
    loaded,
    renderer,
    scene,
    camera,
    ops,
    width,
    height,
    waterDebug,
    stageComplete: finishStage,
  });
  await withFrozenRendererTime(renderer, schedule.fixedTimeSeconds, async (beginFrame) => {
    for (let frame = 0; frame < schedule.warmupFrames; frame++) {
      for (const lod of mounted.world.lods ?? []) (lod as { update(camera: unknown): void }).update(camera);
      beginFrame();
      mounted.post.render();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });
  finishStage("warmupAndRender");
  timingsMs.total = Number((performance.now() - startedAt).toFixed(2));
  window.__captureReady = {
    ...mounted.metadata,
    resolution: [width, height],
    fixedTimeSeconds: schedule.fixedTimeSeconds,
    warmupFrames: schedule.warmupFrames,
    timingsMs: Object.freeze({ ...timingsMs }),
  };
}

main().catch((error) => {
  window.__captureError = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
  console.error(error);
});
