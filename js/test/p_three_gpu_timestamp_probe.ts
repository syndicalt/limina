// Minimal surface-backed proof of the exact patched Three r184 timestamp path.
// Run Iris first, then NVIDIA only with the explicit Xid-risk acknowledgement:
//   LIMINA_GPU_POWER_PREFERENCE=low-power LIMINA_GPU_EXPECTED_ADAPTER_SUBSTRING=Iris \
//     ./target/release/limina --window --frames 120 js/test/p_three_gpu_timestamp_probe.ts
//   LIMINA_GPU_POWER_PREFERENCE=high-performance LIMINA_GPU_EXPECTED_ADAPTER_SUBSTRING=NVIDIA \
//     LIMINA_GPU_TIMESTAMP_RISK_ACK=I_UNDERSTAND_XID_RISK \
//     ./target/release/limina --window --frames 120 js/test/p_three_gpu_timestamp_probe.ts

import * as THREE from "../build/three.bundle.mjs";
import {
  assertGpuTimestampAdapter,
  assertGpuTimestampRiskAccepted,
  parseGpuTimestampPairs,
} from "../src/render/gpu-timestamp-diagnostic.ts";
import { ThreeGpuTimestampCapture } from "../src/render/three-gpu-timestamp-capture.ts";

type PowerPreference = "low-power" | "high-performance";

interface ProbeOps {
  op_create_window_context(): unknown;
  op_surface_present(context: unknown): void;
  op_set_frame_callback(callback: () => void): void;
  op_log(message: string): void;
  op_read_env(name: string): string;
  op_sleep_ms(milliseconds: number): Promise<void>;
}

declare const Deno: { core: { ops: ProbeOps } };
const ops = Deno.core.ops;
const configuredPreference = ops.op_read_env("LIMINA_GPU_POWER_PREFERENCE");

// OPT-IN supervised hardware diagnostic (it also needs a --window run): with no
// LIMINA_GPU_POWER_PREFERENCE it has not been configured for this run — an
// environmental gap in the swept glob, not a probe failure — so announce the skip and
// exit clean. A NON-EMPTY but invalid value is a misconfiguration and stays a hard
// FAIL. Once opted in, every downstream error is a real FAIL by design.
if (configuredPreference === "") {
  ops.op_log("__LIMINA_SKIP__ p_three_gpu_timestamp_probe: LIMINA_GPU_POWER_PREFERENCE unset — supervised GPU diagnostic not configured for this run");
} else {
  if (configuredPreference !== "low-power" && configuredPreference !== "high-performance") {
    throw new Error("Three timestamp probe requires LIMINA_GPU_POWER_PREFERENCE=low-power|high-performance");
  }
  await runProbe(configuredPreference as PowerPreference);
}

async function runProbe(powerPreference: PowerPreference): Promise<void> {
  const captureFrames = parseGpuTimestampPairs(ops.op_read_env("LIMINA_GPU_TIMESTAMP_PAIRS") || "1");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference });
  if (!adapter) throw new Error("Three timestamp probe: no WebGPU adapter");
  const adapterIdentity = [adapter.info?.vendor, adapter.info?.architecture, adapter.info?.device, adapter.info?.description]
    .filter(Boolean).join(" ");
  assertGpuTimestampAdapter(adapterIdentity, ops.op_read_env("LIMINA_GPU_EXPECTED_ADAPTER_SUBSTRING"));
  assertGpuTimestampRiskAccepted(adapterIdentity, ops.op_read_env("LIMINA_GPU_TIMESTAMP_RISK_ACK"));
  if (!adapter.features.has("timestamp-query")) throw new Error("Three timestamp probe: adapter lacks timestamp-query");
  ops.op_log(`Three timestamp probe: accepted adapter ${adapterIdentity}`);

  const device = await adapter.requestDevice({ requiredFeatures: ["timestamp-query"] });
  const context = ops.op_create_window_context();
  const canvas = { width: 320, height: 240, style: {} };
  const renderer = new THREE.WebGPURenderer({
    device,
    context,
    canvas,
    antialias: false,
    trackTimestamp: false,
  });
  await renderer.init();
  renderer.setSize(canvas.width, canvas.height, false);
  if (renderer.backend.trackTimestamp !== false || renderer.hasFeature("timestamp-query") !== true) {
    throw new Error("Three timestamp probe: renderer timestamp initialization invariant failed");
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111827);
  const camera = new THREE.PerspectiveCamera(55, canvas.width / canvas.height, 0.1, 20);
  camera.position.set(0, 0, 3);
  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicNodeMaterial({ color: 0x22c55e }),
  );
  scene.add(cube);

  const capture = new ThreeGpuTimestampCapture(renderer, true, { captureFrames });
  capture.start();
  let done = false;
  function render(): void {
    if (done || capture.phase !== "capturing") return;
    const routeFrame = capture.capturedFrames;
    capture.beforeRendered(routeFrame);
    cube.rotation.x += 0.01;
    cube.rotation.y += 0.02;
    renderer.render(scene, camera);
    ops.op_surface_present(context);
    if (!capture.afterRendered()) return;
    ops.op_log("Three timestamp probe: captured frame population; awaiting submitted render work");
    void capture.settleAndResolve(
      (milliseconds) => {
        ops.op_log(`Three timestamp probe: queue fence passed; settling ${milliseconds}ms before resolve`);
        return ops.op_sleep_ms(milliseconds);
      },
      async () => {
        await renderer.backend.device.queue.onSubmittedWorkDone();
        ops.op_log("Three timestamp probe: submitted render work completed");
      },
    )
      .then((report) => {
        done = true;
        ops.op_log(`Three timestamp probe: PASS ${JSON.stringify({ adapter: adapterIdentity, ...report })}`);
      })
      .catch((error) => {
        done = true;
        ops.op_log(`Three timestamp probe: FAIL ${String(error)}`);
        throw error;
      });
  }

  ops.op_set_frame_callback(render);
  ops.op_log("Three timestamp probe: patched r184 bounded capture started");
}
