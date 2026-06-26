// W0 comparison. Loads native.json + wasm.json and reports per-body L2 position
// drift and quaternion angle drift (max + mean across bodies).

import { readFileSync } from "node:fs";

function load(name) {
  return JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8"));
}

const native = load("native.json");
const wasm = load("wasm.json");

if (native.bodies.length !== wasm.bodies.length) {
  throw new Error(
    `body count mismatch: native ${native.bodies.length} vs wasm ${wasm.bodies.length}`,
  );
}

function l2(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Angle (radians) of the relative rotation between two unit quaternions, robust to
// sign double-cover: angle = 2*acos(|dot|).
function quatAngle(q1, q2) {
  let dot = q1[0] * q2[0] + q1[1] * q2[1] + q1[2] * q2[2] + q1[3] * q2[3];
  dot = Math.min(1, Math.max(-1, Math.abs(dot)));
  return 2 * Math.acos(dot);
}

const rows = [];
let maxPos = 0;
let sumPos = 0;
let maxAng = 0;
let sumAng = 0;

for (let i = 0; i < native.bodies.length; i++) {
  const n = native.bodies[i];
  const w = wasm.bodies[i];
  if (n.id !== w.id) {
    throw new Error(`body id mismatch at index ${i}: ${n.id} vs ${w.id}`);
  }
  const posDrift = l2(n.pos, w.pos);
  const angDrift = quatAngle(n.quat, w.quat);
  maxPos = Math.max(maxPos, posDrift);
  sumPos += posDrift;
  maxAng = Math.max(maxAng, angDrift);
  sumAng += angDrift;
  rows.push({
    id: n.id,
    posL2: posDrift,
    angRad: angDrift,
    angDeg: (angDrift * 180) / Math.PI,
  });
}

const n = native.bodies.length;
const meanPos = sumPos / n;
const meanAng = sumAng / n;

console.log(`native engine: ${native.engine}`);
console.log(`wasm   engine: ${wasm.engine}`);
console.log(`steps: ${native.steps}  dt: ${native.dt}  gravityY: ${native.gravityY}`);
console.log("");
console.log("per-body drift:");
console.log("  id |        pos L2 |     angle (rad) |   angle (deg)");
for (const r of rows) {
  console.log(
    `  ${String(r.id).padStart(2)} | ${r.posL2.toExponential(6).padStart(13)} | ` +
      `${r.angRad.toExponential(6).padStart(14)} | ${r.angDeg.toFixed(4).padStart(11)}`,
  );
}
console.log("");
console.log(`position drift  L2 (meters):  max=${maxPos.toExponential(6)}  mean=${meanPos.toExponential(6)}`);
console.log(`rotation drift  angle (rad):  max=${maxAng.toExponential(6)}  mean=${meanAng.toExponential(6)}`);
console.log(`rotation drift  angle (deg):  max=${((maxAng * 180) / Math.PI).toFixed(4)}  mean=${((meanAng * 180) / Math.PI).toFixed(4)}`);
