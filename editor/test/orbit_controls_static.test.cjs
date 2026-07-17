// LIMITATION (known, accepted): this is a SOURCE-TEXT wiring test — it asserts exact
// code fragments in the module's source instead of executing it (execution needs a
// real DOM/WebGPU browser realm; the behavioral twins are the *_browser.test.cjs
// suites, which need chromium). It can FAIL on a harmless rename and stay GREEN
// through a logic inversion the grepped fragments survive. A green here is a wiring
// check, never a behavioral verdict.
const fs = require("fs");
const path = require("path");

function fail(message) {
  console.error("FAIL: " + message);
  process.exit(1);
}

const root = path.resolve(__dirname, "..", "..");
const threeEntry = fs.readFileSync(path.join(root, "js/build/three-entry.js"), "utf8");
const browserEntry = fs.readFileSync(path.join(root, "js/src/browser-entry.ts"), "utf8");
const viewport = fs.readFileSync(path.join(root, "editor/src/viewport.js"), "utf8");

if (!threeEntry.includes('export { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";')) {
  fail("three bundle entry does not export OrbitControls");
}
if (!browserEntry.includes("export { OrbitControls } from")) {
  fail("browser runtime does not re-export OrbitControls");
}
if (!/orbitControls\?: boolean/.test(browserEntry)) {
  fail("RunLiveOptions does not expose opt-in orbitControls");
}
if (!/new THREE\.OrbitControls\(camera, renderer\.domElement\)/.test(browserEntry)) {
  fail("runLive does not create OrbitControls against the runtime canvas");
}
if (!/if \(cameraControls !== undefined\)/.test(browserEntry) || !/else \{\s*angle \+= orbitSpin;/.test(browserEntry)) {
  fail("runLive does not keep auto-spin behind the falsy orbitControls path");
}
if (!/setCameraControlsEnabled/.test(browserEntry)) {
  fail("RunningLive does not expose setCameraControlsEnabled");
}
if (!/orbitControls: true/.test(viewport)) {
  fail("editor viewport does not opt into OrbitControls");
}
if (/orbit:\s*\{\s*center:\s*\[0,\s*1,\s*0\],\s*radius:\s*16,\s*height:\s*8\s*\}/.test(viewport)) {
  fail("editor viewport still overrides runtime auto-framing with the legacy origin orbit");
}
if ((viewport.match(/orbitControls: true/g) || []).length < 2) {
  fail("both Edit and Play must opt into OrbitControls while using runtime auto-framing");
}
if (!/setCameraControlsEnabled\(false\)/.test(viewport) || !/setCameraControlsEnabled\(true\)/.test(viewport)) {
  fail("gizmo dragging does not suspend and restore camera controls");
}
if (!/CLICK_MOVE_TOLERANCE_PX/.test(viewport) || !/pointerup/.test(viewport) || /canvas\.addEventListener\("pointerdown", pickEntity\)/.test(viewport)) {
  fail("viewport picking is not gated to click-sized pointer gestures");
}

console.log("orbit_controls_static.test OK");
