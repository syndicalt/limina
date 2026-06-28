// P5-A UI showcase (windowed) — now AGENT-NATIVE: every container is authored
// THROUGH the `ui.*` skills (registry.invoke, builder.readWrite, permission-
// checked + traced), exactly as a builder over MCP would, and the host ticks the
// shared UiManager once per frame. A screenshot proves legible, styled text on
// screen — speech bubble (tail to a marker), thought bubble (puffs), titled text
// box, callout (leader line), and a screen-anchored agent-ops HUD that stays put
// while the camera auto-orbits (world panels billboard; the HUD does not move).
//
// Run: limina --window --frames 120 js/src/demos/ui_showcase.ts

import * as THREE from "../../build/three.bundle.mjs";
import { createEngine, ops } from "../engine.ts";
import { LiminaTracer } from "../observability/event.ts";
import { SkillRegistry, type InvokeBase, type WorldContext } from "../skills/registry.ts";
import { registerCoreSkills } from "../skills/index.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { createMaterial } from "../materials/palette.ts";

const engine = await createEngine({ width: 960, height: 640, renderBaseline: { ground: { enabled: false } } });
engine.scene.background = new THREE.Color(0x0a0d13);

// --- scene: ground + marker entities the containers point at ----------------
const ground = new THREE.Mesh(
  new THREE.BoxGeometry(40, 0.2, 40),
  createMaterial("stone", { pbr: true }),
);
ground.position.y = -0.1;
engine.scene.add(ground);

function marker(color: number, x: number, z: number, shape: "sphere" | "box"): THREE.Mesh {
  const geo = shape === "sphere" ? new THREE.SphereGeometry(0.5, 24, 16) : new THREE.BoxGeometry(0.8, 0.8, 0.8);
  const m = new THREE.Mesh(geo, new THREE.MeshStandardNodeMaterial({ color, roughness: 0.5, metalness: 0.1 }));
  m.position.set(x, shape === "sphere" ? 0.5 : 0.4, z);
  engine.scene.add(m);
  return m;
}
const speaker = marker(0xff8c1a, -4, 0, "sphere"); // speech bubble points here
const thinker = marker(0x4ade80, 4, 0, "sphere"); // thought bubble points here
const calloutTarget = marker(0xffd166, 0, 3, "box"); // callout leader points here

const sun = new THREE.DirectionalLight(0xffffff, 3.2);
sun.position.set(6, 12, 8);
engine.scene.add(sun);
engine.scene.add(new THREE.HemisphereLight(0x90b0ff, 0x202830, 1.1));

// --- agent-native skill surface ---------------------------------------------
// A builder authors every container over the SAME typed/permissioned/traced
// pipeline it uses for the world; the host drives the returned UiManager.
const tracer = new LiminaTracer("ses_ui_showcase");
const registry = new SkillRegistry(tracer);
const { ui } = registerCoreSkills(registry);
const world: WorldContext = {
  ecs: engine.world,
  entities: engine.entities,
  tags: engine.tags,
  transforms: engine.transforms,
  spatial: engine.spatial,
  scene: engine.scene,
  camera: engine.camera,
  renderer: engine.renderer,
  ops: engine.ops,
  width: engine.width,
  height: engine.height,
  mode: engine.mode,
};
const builder: InvokeBase = {
  agentId: "agt_builder",
  sessionId: "ses_ui_showcase",
  permissions: resolveProfile("builder.readWrite"),
  tick: 0,
  world,
};

/** Read the `{ handle }` of a ui.* create result without an unchecked cast. */
function handleOf(result: unknown): string {
  if (result !== null && typeof result === "object" && "handle" in result && typeof result.handle === "string") {
    return result.handle;
  }
  throw new Error("ui.* create returned no handle");
}
async function create(tool: string, input: unknown): Promise<string> {
  const res = await registry.invoke(tool, input, builder);
  if (!res.success) throw new Error(`${tool} failed: ${JSON.stringify(res.error)}`);
  return handleOf(res.result);
}

// Speech bubble above the speaker, tail pointing DOWN at it; lines cycle via a
// queue lifecycle (advanced by the host tick); fades in.
await create("ui.speechBubble", {
  anchor: { kind: "world", point: [speaker.position.x, speaker.position.y + 2.0, speaker.position.z], billboard: true },
  text: "...",
  maxWidth: 260,
  tail: { toward: { x: 0, y: -1 } },
  lifecycle: {
    fade: { from: 0, to: 1, durationMs: 600 },
    queue: { mode: "queue", defaultHoldMs: 1400, lines: ["Hello there, traveller!", "Fine weather on the ridge.", "Mind the loose stones ahead."] },
  },
});

// Thought bubble above the thinker, puffs trailing DOWN to it; fades in.
await create("ui.thoughtBubble", {
  anchor: { kind: "world", point: [thinker.position.x, thinker.position.y + 2.1, thinker.position.z], billboard: true },
  text: "Where did that\npath go?",
  maxWidth: 200,
  tail: { toward: { x: 0, y: -1 }, count: 3 },
  lifecycle: { fade: { from: 0, to: 1, durationMs: 800 } },
});

// Titled text box floating in the world.
const boxHandle = await create("ui.textBox", {
  anchor: { kind: "world", point: [0, 3.2, -4], billboard: true },
  title: "FOREST LOG",
  text: "Two agents meet\non the north trail.\nWind: gentle.",
  maxWidth: 240,
});

// Callout box below the cube, leader pointing up to the yellow cube.
await create("ui.callout", {
  anchor: { kind: "world", point: [calloutTarget.position.x, calloutTarget.position.y - 1.7, calloutTarget.position.z + 0.4], billboard: true },
  title: "ARTIFACT",
  text: "ancient marker",
  maxWidth: 180,
  leader: { side: "top", offset: 0.5, dx: 0, dy: -40, color: 0xffd166, width: 3 },
});

// Screen-anchored agent-ops HUD (top-right), camera-independent + over the scene;
// a feed lifecycle scrolls the latest ops lines as the host appends them.
const hudHandle = await create("ui.hudPanel", {
  anchor: { kind: "screen", corner: "top-right", marginPx: [18, 16], distance: 1.5 },
  title: "AGENT OPS",
  lines: ["booting..."],
  width: 300,
  lifecycle: { feed: { maxLines: 6 } },
});

let opsCursor = -1;
/** One REAL trace event -> a compact HUD line (real type + detail; never canned). */
function fmtEvent(ev: { type: string; actorId: string; payload: unknown }): string {
  const p = (typeof ev.payload === "object" && ev.payload !== null) ? (ev.payload as Record<string, unknown>) : {};
  const detail = String(p.tool ?? p.cap ?? p.kind ?? p.name ?? ev.actorId);
  return detail ? `${ev.type}  ${detail}` : ev.type;
}

// --- loop -------------------------------------------------------------------
let frame = 0;
let logUpdated = false;
const DT = 1000 / 60;

function render(_alpha: number): void {

  // Stream REAL trace events (every ui.* skill call this demo issues is traced)
  // into the HUD — no canned content.
  const recent = tracer.tail({ afterSeq: opsCursor, limit: 3 });
  for (const ev of recent.events) ui.feedAppend(hudHandle, fmtEvent(ev));
  if (recent.nextAfterSeq !== null) opsCursor = recent.nextAfterSeq;
  // mid-run, prove ui.update over MCP mutates a live container by handle.
  if (frame === 48 && !logUpdated) {
    logUpdated = true;
    void registry.invoke("ui.update", { handle: boxHandle, text: "Two agents meet\non the north trail.\nThey begin to talk." }, builder);
  }

  // The host tick advances every anchor (world panels billboard; HUD stays put)
  // and every lifecycle (fade ramps, speech queue cycles) in one call.
  ui.update(engine.camera, engine.width, engine.height, DT);

  engine.renderer.render(engine.scene, engine.camera);
  ops.op_surface_present(engine.context);
  frame++;
}

// Warm-up render so the host compiles WebGPU pipelines before the loop (avoids
// the known blank/white-window first frame).
// Fixed camera framing the scene (no orbit) — a steady vantage on the containers;
// the world panels billboard to face it, the screen HUD stays pinned.
engine.camera.position.set(0, 3, 13);
engine.camera.lookAt(0, 2, -0.5);
engine.camera.updateMatrixWorld(true);
ui.update(engine.camera, engine.width, engine.height, DT);
engine.renderer.render(engine.scene, engine.camera);
ops.op_surface_present(engine.context);

ops.op_set_frame_callback(render);
ops.op_log("ui_showcase ready: speech/thought/textbox/callout + HUD authored via ui.* skills, ticked by UiManager");
