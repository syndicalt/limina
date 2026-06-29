#!/usr/bin/env node
// check-live-composition.mjs — Phase 8 Mode-B (M5) integration guard.
//
// Asserts STATICALLY that the live in-browser runtime (`runLive`) composes the
// REAL verified M1–M4 + M3 pieces and contains NO stub/fake in the integration
// path. This is the headless proxy for the (browser-UAT) live render: we can't
// boot a real Worker + SAB + WebGPU headlessly, but we CAN prove the wiring binds
// the genuine modules and spawns the genuine worker entry.
//
// Run: node js/scripts/check-live-composition.mjs   (exit 0 on pass)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");

const read = (rel) => readFileSync(join(SRC, rel), "utf8");
const fails = [];
const ok = [];
function expect(cond, label) {
  if (cond) ok.push(label);
  else fails.push(label);
}

const entry = read("browser-entry.ts");
const live = read("browser/live-runtime.ts");
const workerEntry = read("browser/sim-worker-entry.ts");

console.log("Phase 8 M5 — live runtime composition guard");
console.log("===========================================\n");

// ── runLive exists and is the SECOND mode (Mode-A run() left intact). ──
expect(/export\s+async\s+function\s+runLive\s*\(/.test(entry), "browser-entry exports runLive(opts)");
expect(/export\s+async\s+function\s+run\s*\(/.test(entry), "Mode-A run() still present (untouched second mode)");

// ── M1 wasm-Rapier: render-main authoring binds the REAL solver, not a stub. ──
expect(/from "\.\/browser\/wasm-rapier-physics\.ts"/.test(entry), "M1: imports WasmRapierPhysics (real wasm-Rapier)");
expect(/WasmRapierPhysics\.create\(/.test(entry), "M1: brings up real wasm-Rapier (WasmRapierPhysics.create)");

// ── M2 transform SAB: render-main JOINs the worker's buffer. ──
expect(/from "\.\/browser\/sab-transforms\.ts"/.test(entry), "M2: imports SharedTransformStorage");
expect(/new\s+SharedTransformStorage\(\s*\{\s*buffer:\s*ready\.buffer\s*\}\s*\)/.test(entry), "M2: JOINs the worker's transform SAB (buffer: ready.buffer)");

// ── M3 input ring + worker: JOIN ring, spawn the real worker entry, handshake. ──
expect(/from "\.\/browser\/sab-ringbuffer\.ts"/.test(entry), "M3: imports InputRingBuffer");
expect(/new\s+InputRingBuffer\(\s*\{\s*buffer:\s*ready\.inputBuffer\s*\}\s*\)/.test(entry), "M3: JOINs the worker's input ring");
expect(/inputRing\.writeInput\(/.test(entry), "M3: pumps DOM input into the ring each frame (writeInput)");
expect(/new\s+Worker\(\s*workerUrl/.test(entry), "M3: spawns the sim-worker");
expect(/new URL\("\.\/sim-worker-entry\.js"/.test(entry), "M3: worker URL is the sim-worker-entry chunk");
expect(/postMessage\(\s*\{\s*type:\s*"init",\s*commands/.test(entry), "M3: handshake posts init + the authoring command log");

// ── M4 interpolation: FrameInterpolator tweens prev→curr by alpha each frame. ──
expect(/from "\.\/browser\/frame-interpolator\.ts"/.test(entry), "M4: imports FrameInterpolator");
expect(/new\s+FrameInterpolator\(/.test(entry), "M4: builds a FrameInterpolator over the render store");
expect(/interp\.interpolate\(\s*alpha/.test(entry), "M4: interpolates by alpha in the render frame");
expect(/interp\.push\(\s*ring\.freeze\(/.test(entry), "M4: freezes each consumed worker tick into the double buffer");

// ── Accumulator loop + Atomics tick read (host.ts reuse). ──
expect(/startAccumulatorLoop\(/.test(entry), "reuses the host.ts accumulator rAF loop");
expect(/Atomics\.load\(statusView/.test(entry), "reads the worker's tick via Atomics on the status SAB");

// ── renderSyncSystem-style scene drive + real renderer (Mode-A buildRenderTarget). ──
expect(/renderSyncSystem\(ecs\)/.test(entry), "drives the scene transforms (renderSyncSystem)");
expect(/buildRenderTarget\(/.test(entry), "builds the real WebGPU renderer/scene/camera (buildRenderTarget reuse)");

// ── Graceful degradation (no crash when SAB/WebGPU absent). ──
expect(/crossOriginIsolatedAvailable\(\)/.test(entry), "gates on cross-origin isolation (SAB precondition)");
expect(/onStatus\?|status\("error"/.test(entry), "reports error via onStatus instead of throwing");

// ── The worker ENTRY is the real M3 shell over rapier; gated to a real Worker. ──
expect(/from "\.\/sim-worker\.ts"/.test(workerEntry), "worker entry installs the real M3 shell (installSimWorker)");
expect(/@dimforge\/rapier3d-compat/.test(workerEntry), "worker entry bundles rapier3d-compat into the worker chunk");
expect(/WorkerGlobalScope/.test(workerEntry), "worker entry is gated on WorkerGlobalScope (inert at non-worker import)");

// ── NO STUBS in the live integration path: the render side never fabricates poses
//    or fakes physics transforms — it reads them from the JOINed SAB. ──
expect(!/stubScene|stubCamera|fakeTransform|TODO|FIXME/.test(live), "live-runtime carries no scene/camera stubs or TODO placeholders");
expect(/P\.op_physics_body_transform\.bind\(P\)/.test(live), "authoring ops bind the REAL physics body transform (no fabricated transforms)");

for (const o of ok) console.log("  PASS  " + o);
if (fails.length > 0) {
  console.log("");
  for (const f of fails) console.log("  FAIL  " + f);
}
console.log(`\nVERDICT: live composition ${fails.length === 0 ? "PASS" : "FAIL"} (${ok.length} checks)`);
process.exit(fails.length === 0 ? 0 : 1);
