// Numbers Party (windowed) — the Phase 3 native-parallelism SHOWCASE.
//
// ~200 anthropomorphic "number-people" mingle at a dusk club: each agent's BODY
// is literally a chunky 3D EXTRUDED NUMERAL (its digit 0-9) — a little glyph-
// person with eyes + feet that WANDERS, faces where it walks, APPROACHes a
// nearby reveller, pauses to CHAT in transient pairs facing its partner, then
// drifts off again. The whole crowd is driven by the REAL agent pipeline shipped
// in Phase 3 — the EXACT perception -> decision -> action loop from
// js/test/p3n4_capstone.ts:
//
//   • perceptionSystem  -> the NATIVE batched spatial query (op_ecs_spatial_query_batch
//                          via js/src/agents/systems.ts) — the native-parallel win.
//   • decisionSystem    -> a SCRIPTED social provider that runs OFF the frame loop
//                          (deferred: `await Promise.resolve()` then return tool calls),
//                          exactly like a real LLM, gated by the AgentScheduler.
//   • actionSystem      -> every move is a real `three.setTransform` call through the
//                          registry (permission-checked + TRACED).
//   • op_physics_step + transform sync + spatial.invalidate per fixed tick.
//
// Nothing about the conversations is faked: the AGENT OPS HUD streams the REAL
// tracer feed (the social state transitions the agents actually decided this run),
// and the perf overlay reports the live agent count, sim-step ms, steps/s and fps
// that prove the scale. NO per-agent speech boxes — hundreds of agents are shown
// as a live op stream, not 200 text bubbles.
//
// Rendering is INSTANCED: the numeral bodies are authored procedurally as
// 7-segment THREE.Shape paths + ExtrudeGeometry (no font / TextGeometry), one
// InstancedMesh per digit 0-9 (agents bucketed by index%10), with per-instance
// color (setColorAt) + a per-frame matrix from ECS Position (walk bob, forward
// lean, facing yaw). Eyes + feet are two more InstancedMeshes. ~16 draw calls
// for the whole crowd, not 200+ meshes. No nametag billboards.
//
// Run (release recommended for representative fps):
//   cargo build && ./target/release/limina --window js/src/demos/agent_build_showcase.ts
//   ./target/release/limina --window --fullscreen js/src/demos/agent_build_showcase.ts
//   ./target/release/limina --window --frames 600 js/src/demos/agent_build_showcase.ts
// (windowed-only: createEngine throws headless, so it is not in the headless suite.)

import * as THREE from "../../build/three.bundle.mjs";
import { createEngine, ops } from "../engine.ts";
import { createMaterial } from "../materials/palette.ts";
import { Position, Rotation, spawnRenderable, type Transformable } from "../ecs/world.ts";
import { LiminaTracer, type EngineEvent } from "../observability/event.ts";
import { SkillRegistry, type WorldContext } from "../skills/registry.ts";
import { registerCoreSkills } from "../skills/index.ts";
import { AgentRegistry } from "../agents/agent.ts";
import { actionSystem, decisionSystem, perceptionSystem, type ProviderMap } from "../agents/systems.ts";
import { AgentScheduler } from "../agents/scheduler.ts";
import { UniformGridSpatialIndex } from "../spatial/index.ts";
import { TraceHud } from "../ui/hud_feed.ts";
import { type TextStyle } from "../ui/compositor.ts";
import type { DecideRequest, LLMProvider } from "../agents/llm.ts";
import type { MCPRequest } from "../mcp/protocol.ts";
import { AudioManager } from "../audio/manager.ts";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const SESSION = "ses_agent_build_showcase";
// Sim handles 200 (p3n4: sim-step p95 ~4ms). The render path is the known ceiling,
// but instancing keeps it to a handful of draw calls, so 200 holds a smooth frame.
const AGENT_COUNT = 200;
const FLOOR_HALF = 17; // dance floor half-extent (34 x 34)
const SPAWN_R = 15; // agents spawn inside this radius
const MOVE_R = 16; // agents are kept inside this radius (stay on the lit floor)

const PERCEPTION_R = 6.5; // how far an agent perceives neighbours (native batch radius)
const PERSONAL = 0.85; // personal-space radius -> gentle separation (no pile-up)
const SEP_W = 0.9; // separation weight in the move blend

const STEP_WANDER = 0.30; // world units per decision while easing into a circle slot
const STEP_APPROACH = 0.52; // brisker when crossing the floor (mingler / long approach)

// Social grouping: most numerals gather into conversation circles around fixed
// group anchors and face inward; ~15% are "minglers" that roam between groups.
const GROUP_COUNT = 10; // conversation circles scattered across the floor (8-12)
const GROUP_SCATTER_R = 12.5; // group anchors land within this radius
const GROUP_RADIUS = 2.4; // members cluster within this radius of their anchor
const MINGLER_FRAC = 0.15; // fraction that roam between groups instead of joining one
const ARRIVE_SLOT = 0.7; // "settled into my circle spot" threshold
const ARRIVE_GROUP = GROUP_RADIUS + 1.2; // a mingler counts a group as "visited" here
const SETTLE_MIN = 10; // decisions held in a circle before a gentle re-slot
const SETTLE_VAR = 10;
const LINGER_MIN = 4; // decisions a mingler pauses at a group before drifting on
const LINGER_VAR = 5;
const HOLD_SEP = 0.12; // gentle personal-space nudge while settled (no frozen overlap)

// Body center height in ECS (movement is planar; y is preserved by the provider).
const BODY_CY = 0.55;
const CHAR_H = 1.4; // numeral character height (world units)
const GLYPH_CY = 0.78; // numeral center height so feet rest near the floor
const EYE_DX = 0.13; // eye half-spacing (local x)
const EYE_Y = 0.30; // eye height above glyph center
const EYE_Z = 0.2; // eye distance in front of the glyph face (+z forward)
const EYE_R = 0.075; // eye radius
const FOOT_DX = 0.17; // foot half-spacing (local x)
const FOOT_Y = -CHAR_H / 2 + 0.02; // foot height (just under the glyph)
const FOOT_Z = 0.04; // foot offset in front
const STEP_LIFT = 0.11; // how high a foot lifts mid-stride
const LEAN_MAX = 0.17; // max forward lean (radians) at full stride
const LEAN_K = 9.0; // lean per unit of smoothed speed
const SPD_REF = 0.02; // speed that reads as "full walking" (move/idle blend)
const SPEED_LERP = 0.16; // smoothing for per-agent speed
const IDLE_AMP = 0.022; // idle (chatting) bob amplitude
const IDLE_W = 0.0042; // idle bob angular speed (per ms)
const BOB_AMP = 0.06; // walk bob amplitude
const BOB_STRIDE = 5.2; // bob phase advanced per world unit walked

// Dynamic flythrough camera: a smooth closed loop whose radius + height weave so
// the camera flies among / through the conversation circles at low-ish height.
const FLY_SPEED = 0.000132; // radians per ms along the loop (dynamic, not dizzying) - +10%
const FLY_R_MID = 9.5; // mean loop radius - threads the r~5.4-14 cluster band
const FLY_R_AMP = 2.5; // radius weave through the cluster band - shallow enough to avoid burying in a circle
const FLY_R_FREQ = 3; // integer -> the loop closes cleanly each 2*pi
const FLY_BASE_H = 2.1; // skims just above the ~1.5-tall numeral heads (in the crowd, never top-down, no burial)
const FLY_Y_AMP = 0.45; // gentle rise/fall (stays 1.65-2.55 - head-height glide)
const FLY_Y_FREQ = 2;
const FLY_LOOK_AHEAD = 0.30; // look well ahead along the loop -> flat forward gaze (fly THROUGH, not down)
const FLY_LOOK_Y = 1.1; // look at numeral FACE height (you see their faces as you glide past)
const FLY_LOOK_BIAS = 0.12; // pull the look target slightly inward so the crowd stays framed
// Render-time look-at: a numeral within this radius of the flying camera turns to
// face it, then eases back to its group facing once the camera passes.
const LOOKAT_R = 6.0;

const CONFETTI_COUNT = 28; // light physics flavour: glitter that falls + settles

// Festive body palette (warm + neon club hues; tinted, never pure primaries).
const PALETTE = [
  0xff5d8f, 0xff8a3d, 0xffd24a, 0x6ee7b7, 0x38e1ff, 0x8b7bff,
  0xff6ad5, 0x5cf2c2, 0xc6ff5e, 0xffb05e, 0x7ad7ff, 0xb98bff,
  0xff7a7a, 0x4ad6a0, 0xe7e15e, 0x9b8cff,
];

// ---------------------------------------------------------------------------
// Engine + festive scene
// ---------------------------------------------------------------------------

const engine = await createEngine({ width: 1180, height: 740, renderBaseline: { ground: { enabled: false } } });
engine.scene.background = new THREE.Color(0x140a24); // deep dusk-purple club night

// Dance floor: a dark tinted slab + a club-toned grid + a glowing centre ring.
const floor = new THREE.Mesh(
  new THREE.BoxGeometry(FLOOR_HALF * 2, 0.2, FLOOR_HALF * 2),
  // Large STATIC dance floor → procedural-PBR palette surface (tactile grain).
  createMaterial("stone", { pbr: true }),
);
floor.position.y = -0.1;
engine.scene.add(floor);
const grid = new THREE.GridHelper(FLOOR_HALF * 2, 30, 0xff6ad5, 0x2a2148);
grid.position.y = 0.02;
engine.scene.add(grid);
const ring = new THREE.Mesh(
  new THREE.TorusGeometry(FLOOR_HALF * 0.62, 0.06, 10, 120),
  new THREE.MeshStandardNodeMaterial({ color: 0x38e1ff, roughness: 0.2, metalness: 0.5 }),
);
ring.position.y = 0.04;
ring.rotation.x = Math.PI / 2;
engine.scene.add(ring);

// Lighting: a low warm/cool ambient wash so nothing is pure black, plus a few
// colored party lamps that slowly orbit overhead for a club vibe (shadows off —
// no light.castShadow / mesh.castShadow — to stay cheap at 200 agents).
engine.scene.add(new THREE.HemisphereLight(0x8a7bff, 0x140a24, 0.85));
engine.scene.add(new THREE.AmbientLight(0xff9ad8, 0.2));
interface PartyLamp { light: THREE.PointLight; phase: number; radius: number; speed: number; }
const lampSpecs: [number, number, number, number][] = [
  // [color, radius, height, intensity]
  [0xff3da6, 11, 9, 90],
  [0x38e1ff, 13, 8, 85],
  [0xffd24a, 9, 10, 70],
  [0x9b6bff, 12, 7.5, 80],
];
const lamps: PartyLamp[] = lampSpecs.map(([color, radius, height, intensity], i) => {
  const light = new THREE.PointLight(color, intensity, 60, 1.6);
  light.position.set(radius, height, 0);
  engine.scene.add(light);
  return { light, phase: (i / lampSpecs.length) * Math.PI * 2, radius, speed: 0.00018 + i * 0.00006 };
});

// ---------------------------------------------------------------------------
// World context + agent pipeline plumbing (mirrors p3n4_capstone exactly)
// ---------------------------------------------------------------------------

const agents = new AgentRegistry();
const tracer = new LiminaTracer(SESSION);
const registry = new SkillRegistry(tracer);
const { ui } = registerCoreSkills(registry);

// A grid sized to the perception radius keeps the native batch query tight.
const spatial = new UniformGridSpatialIndex({ cellSize: 7 });
const world: WorldContext = {
  ecs: engine.world,
  entities: engine.entities,
  tags: engine.tags,
  transforms: engine.transforms,
  spatial,
  scene: engine.scene,
  camera: engine.camera,
  renderer: engine.renderer,
  ops: engine.ops,
  width: engine.width,
  height: engine.height,
  mode: engine.mode,
  agents,
};

ops.op_physics_create_world(-9.81);
ops.op_physics_add_ground(0);

// Deterministic LCG for spawn + waypoint scatter.
let seed = 0x0c0ffee5 >>> 0;
const rnd = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0xffffffff;
};
const discPoint = (radius: number): [number, number] => {
  const r = Math.sqrt(rnd()) * radius;
  const a = rnd() * Math.PI * 2;
  return [Math.cos(a) * r, Math.sin(a) * r];
};

// ---------------------------------------------------------------------------
// Agents: meshless ECS entities (rendered via instancing, not 200 scene meshes)
// ---------------------------------------------------------------------------

// A single shared no-op transformable satisfies spawnRenderable's binding without
// allocating 200 throwaway meshes; we never call renderSyncSystem on these — the
// instanced matrix update below is the render-sync analog, reading ECS Position.
const NOOP: Transformable = {
  position: { set(): void {} },
  quaternion: { set(): void {} },
  scale: { set(): void {} },
};

const eids = new Int32Array(AGENT_COUNT);
const entityIds: string[] = new Array(AGENT_COUNT);
const agentNums = new Int32Array(AGENT_COUNT); // the displayed "#" (the agent index)
const idxByEntity = new Map<string, number>();
// Smoothed display state (decoupled from the sparse, scheduler-paced commits).
const dispX = new Float32Array(AGENT_COUNT);
const dispZ = new Float32Array(AGENT_COUNT);
const walkPhase = new Float32Array(AGENT_COUNT);
const dispYaw = new Float32Array(AGENT_COUNT); // smoothed displayed facing (look-at)

// Social state machine. Most agents belong to a group (home >= 0) and cycle
// TOGROUP -> INGROUP around their anchor; minglers (home < 0) roam between groups.
// All motion is real per-agent decisions toward group-anchor targets + perception.
const MODE_TOGROUP = 0; // easing toward a spot in my circle
const MODE_INGROUP = 1; // settled, facing the circle centre (inward)
const MODE_MINGLE = 2; // roaming between group centres
interface SocialState { mode: number; tx: number; tz: number; home: number; target: number; settleLeft: number; }
const states: SocialState[] = new Array(AGENT_COUNT);

// Conversation-circle anchors, scattered around the floor (even angular spacing +
// jitter + varied radius -> distinct, organically placed clusters).
const groupX = new Float32Array(GROUP_COUNT);
const groupZ = new Float32Array(GROUP_COUNT);
for (let g = 0; g < GROUP_COUNT; g++) {
  const ang = (g / GROUP_COUNT) * Math.PI * 2 + (rnd() - 0.5) * 0.35;
  const rad = GROUP_SCATTER_R * (0.62 + rnd() * 0.34);
  groupX[g] = Math.cos(ang) * rad;
  groupZ[g] = Math.sin(ang) * rad;
}
let gAssign = 0; // round-robin cursor for balanced group assignment

// ---------------------------------------------------------------------------
// Number-people: meshless ECS entities, rendered as extruded-numeral instances
// ---------------------------------------------------------------------------

const tmpColor = new THREE.Color();
// Per-agent local instance slot within its digit group (group index = i % 10).
const localSlot = new Int32Array(AGENT_COUNT);
// Bucket agents by their displayed digit (index % 10) -> one InstancedMesh each.
const buckets: number[][] = Array.from({ length: 10 }, () => []);

for (let i = 0; i < AGENT_COUNT; i++) {
  const [x, z] = discPoint(SPAWN_R);
  const eid = spawnRenderable(world.ecs, NOOP, x, BODY_CY, z);
  const entity = world.entities.create({ eid });
  eids[i] = eid;
  entityIds[i] = entity;
  agentNums[i] = i;
  idxByEntity.set(entity, i);
  dispX[i] = x;
  dispZ[i] = z;
  walkPhase[i] = rnd() * Math.PI * 2;

  const d = i % 10;
  localSlot[i] = buckets[d].length;
  buckets[d].push(i);

  // Join a group (round-robin, balanced) or become a mingler; seed an initial spot.
  let home: number;
  let target: number;
  let mode: number;
  if (rnd() < MINGLER_FRAC) {
    home = -1;
    target = Math.floor(rnd() * GROUP_COUNT);
    mode = MODE_MINGLE;
  } else {
    home = gAssign++ % GROUP_COUNT;
    target = home;
    mode = MODE_TOGROUP;
  }
  const sa = rnd() * Math.PI * 2;
  const sr = home < 0 ? 0 : rnd() * GROUP_RADIUS;
  states[i] = {
    mode,
    tx: groupX[target] + Math.cos(sa) * sr,
    tz: groupZ[target] + Math.sin(sa) * sr,
    home,
    target,
    settleLeft: 0,
  };

  // Decision cadence: a staggered band so ~AGENT_COUNT/interval agents come due
  // per tick from the very first tick (no thundering herd, no perception re-emit).
  const interval = 12 + (i % 6); // 12..17
  const record = agents.add({
    id: `agt_${i}`,
    type: "player",
    entityId: entity,
    perceptionRadius: PERCEPTION_R,
    decisionIntervalTicks: interval,
    // builder.readWrite grants scene.write — REQUIRED for kinematic three.setTransform.
    // (player.limited only grants physics.write, for impulse-driven agents.)
    profile: "builder.readWrite",
    sessionId: SESSION,
    llm: { provider: "social", model: "scripted", systemPrompt: "" },
  });
  record.lastDecisionTick = -(i % interval); // spread first-due ticks across the band
}

// ---------------------------------------------------------------------------
// Numeral geometry — procedural 7-segment glyphs (THREE.Shape + ExtrudeGeometry,
// no font asset). Each digit's active segments (overlapping rounded bars) extrude
// into one connected, chunky, upright glyph; centered + scaled to CHAR_H. The
// readable face is local +Z, so the ECS facing yaw turns each numeral toward its
// target like a little person.
// ---------------------------------------------------------------------------

const SEG_W = 1.0; // glyph cell width  (pre-scale)
const SEG_H = 1.8; // glyph cell height (pre-scale)
const SEG_T = 0.27; // segment thickness
const SEG_R = SEG_T * 0.46; // segment corner radius

/** A rounded-rectangle bar as a THREE.Shape (center cx,cy; size w,h; radius r). */
function barShape(cx: number, cy: number, w: number, h: number, r: number): THREE.Shape {
  const rr = Math.min(r, Math.min(w, h) / 2);
  const x0 = cx - w / 2;
  const y0 = cy - h / 2;
  const x1 = cx + w / 2;
  const y1 = cy + h / 2;
  const s = new THREE.Shape();
  s.moveTo(x0 + rr, y0);
  s.lineTo(x1 - rr, y0);
  s.quadraticCurveTo(x1, y0, x1, y0 + rr);
  s.lineTo(x1, y1 - rr);
  s.quadraticCurveTo(x1, y1, x1 - rr, y1);
  s.lineTo(x0 + rr, y1);
  s.quadraticCurveTo(x0, y1, x0, y1 - rr);
  s.lineTo(x0, y0 + rr);
  s.quadraticCurveTo(x0, y0, x0 + rr, y0);
  return s;
}

// Seven segments a,b,c,d,e,f,g as [cx, cy, w, h]; verticals span a half-height so
// adjacent bars OVERLAP at the joints -> one solid glyph, no LED gaps.
const SEG_RECTS: [number, number, number, number][] = [
  [SEG_W / 2, SEG_H - SEG_T / 2, SEG_W, SEG_T], // a  top
  [SEG_W - SEG_T / 2, SEG_H * 0.75, SEG_T, SEG_H / 2], // b  upper-right
  [SEG_W - SEG_T / 2, SEG_H * 0.25, SEG_T, SEG_H / 2], // c  lower-right
  [SEG_W / 2, SEG_T / 2, SEG_W, SEG_T], // d  bottom
  [SEG_T / 2, SEG_H * 0.25, SEG_T, SEG_H / 2], // e  lower-left
  [SEG_T / 2, SEG_H * 0.75, SEG_T, SEG_H / 2], // f  upper-left
  [SEG_W / 2, SEG_H / 2, SEG_W, SEG_T], // g  middle
];
// Which segments light up per digit (order a,b,c,d,e,f,g).
const SEG_ON: number[][] = [
  [1, 1, 1, 1, 1, 1, 0], // 0
  [0, 1, 1, 0, 0, 0, 0], // 1
  [1, 1, 0, 1, 1, 0, 1], // 2
  [1, 1, 1, 1, 0, 0, 1], // 3
  [0, 1, 1, 0, 0, 1, 1], // 4
  [1, 0, 1, 1, 0, 1, 1], // 5
  [1, 0, 1, 1, 1, 1, 1], // 6
  [1, 1, 1, 0, 0, 0, 0], // 7
  [1, 1, 1, 1, 1, 1, 1], // 8
  [1, 1, 1, 1, 0, 1, 1], // 9
];

const EXTRUDE = { depth: 0.36, bevelEnabled: true, bevelThickness: 0.045, bevelSize: 0.045, bevelSegments: 1, steps: 1, curveSegments: 2 };

/** Build one centered, CHAR_H-tall extruded numeral geometry for digit d. */
function buildNumeralGeometry(d: number): THREE.ExtrudeGeometry {
  const shapes: THREE.Shape[] = [];
  const on = SEG_ON[d];
  for (let s = 0; s < 7; s++) {
    if (!on[s]) continue;
    const [cx, cy, w, h] = SEG_RECTS[s];
    shapes.push(barShape(cx, cy, w, h, SEG_R));
  }
  const geo = new THREE.ExtrudeGeometry(shapes, EXTRUDE);
  geo.center();
  geo.computeBoundingBox();
  const size = new THREE.Vector3();
  geo.boundingBox!.getSize(size);
  const scale = CHAR_H / size.y;
  geo.scale(scale, scale, scale);
  return geo;
}

const numeralMat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.46, metalness: 0.16 });
const numeralMeshes: (THREE.InstancedMesh | null)[] = new Array(10).fill(null);
for (let d = 0; d < 10; d++) {
  const members = buckets[d];
  if (members.length === 0) continue;
  const geo = buildNumeralGeometry(d);
  const mesh = new THREE.InstancedMesh(geo, numeralMat, members.length);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  for (let j = 0; j < members.length; j++) {
    mesh.setColorAt(j, tmpColor.set(PALETTE[members[j] % PALETTE.length]));
  }
  mesh.instanceColor!.needsUpdate = true;
  engine.scene.add(mesh);
  numeralMeshes[d] = mesh;
}

// ---------------------------------------------------------------------------
// Anthropomorphic touches — eyes + feet, each ONE InstancedMesh (2 per agent).
// Cheap, instanced; positioned on the glyph's front face / base each frame.
// ---------------------------------------------------------------------------

const eyeGeo = new THREE.SphereGeometry(EYE_R, 8, 8);
const eyeMat = new THREE.MeshStandardNodeMaterial({ color: 0x1a1422, roughness: 0.35, metalness: 0.1 });
const eyeMesh = new THREE.InstancedMesh(eyeGeo, eyeMat, AGENT_COUNT * 2);
eyeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
eyeMesh.frustumCulled = false;
engine.scene.add(eyeMesh);

const footGeo = new THREE.SphereGeometry(1, 8, 6);
const footMat = new THREE.MeshStandardNodeMaterial({ color: 0x241b30, roughness: 0.55, metalness: 0.1 });
const footMesh = new THREE.InstancedMesh(footGeo, footMat, AGENT_COUNT * 2);
footMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
footMesh.frustumCulled = false;
engine.scene.add(footMesh);
const FOOT_SX = 0.12;
const FOOT_SY = 0.07;
const FOOT_SZ = 0.2;

// ---------------------------------------------------------------------------
// Confetti — a light physics flavour layer (instanced + synced from native physics)
// ---------------------------------------------------------------------------

const confettiBodies = new Int32Array(CONFETTI_COUNT);
const confettiGeo = new THREE.BoxGeometry(0.18, 0.18, 0.18);
const confettiMat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.2 });
const confettiMesh = new THREE.InstancedMesh(confettiGeo, confettiMat, CONFETTI_COUNT);
confettiMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
confettiMesh.frustumCulled = false;
engine.scene.add(confettiMesh);
for (let i = 0; i < CONFETTI_COUNT; i++) {
  const [x, z] = discPoint(FLOOR_HALF * 0.7);
  const y = 5 + rnd() * 10;
  confettiBodies[i] = ops.op_physics_add_box_material(x, y, z, 0.09, 0.6, 0.25);
  confettiMesh.setColorAt(i, tmpColor.set(PALETTE[(i * 5) % PALETTE.length]));
}
confettiMesh.instanceColor.needsUpdate = true;

// ---------------------------------------------------------------------------
// Scripted social provider (deferred / off-loop, exactly like a real LLM)
// ---------------------------------------------------------------------------

const perf = (globalThis as { performance?: { now?: () => number } }).performance;
const now: () => number = typeof perf?.now === "function" ? () => perf.now!() : () => Date.now();

// The HUD narrates a live, readable SAMPLE of the real transitions: every agent
// runs the full machine, but we emit a social.* trace line only when a global
// token is free (~1 per NARRATE_GAP_MS), so the feed stays legible at any scale.
// Every narrated line is a real transition that really happened this tick.
const NARRATE_GAP_MS = 240;
let lastNarrateMs = 0;
function narrate(type: string, self: number, partner: number, nearby: number): void {
  const t = now();
  if (t - lastNarrateMs < NARRATE_GAP_MS) return;
  lastNarrateMs = t;
  tracer.emit({
    type,
    actorId: `agt_${self}`,
    threadId: SESSION,
    parentEventId: null,
    causedBy: [],
    payload: { self, partner, nearby },
  });
}

/** Sum personal-space pushes from neighbours within PERSONAL (separation steering). */
function separation(px: number, pz: number, nearby: DecideRequest["perception"]["nearby"]): [number, number] {
  let sx = 0;
  let sz = 0;
  for (const n of nearby) {
    if (n.distance > PERSONAL || n.distance < 1e-4) continue;
    const w = (PERSONAL - n.distance) / PERSONAL;
    sx += (px - n.position[0]) / n.distance * w;
    sz += (pz - n.position[2]) / n.distance * w;
  }
  return [sx, sz];
}

/** Hold position but apply a small separation-only nudge, clamped to the floor. */
function holdNudge(px: number, pz: number, nearby: DecideRequest["perception"]["nearby"]): [number, number] {
  const [sx, sz] = separation(px, pz, nearby);
  const sl = Math.hypot(sx, sz);
  if (sl < 1e-4) return [px, pz];
  let nx = px + (sx / sl) * Math.min(sl, 1) * HOLD_SEP;
  let nz = pz + (sz / sl) * Math.min(sl, 1) * HOLD_SEP;
  const rr = Math.hypot(nx, nz);
  if (rr > MOVE_R) { nx = nx / rr * MOVE_R; nz = nz / rr * MOVE_R; }
  return [nx, nz];
}

/** Blend a goal direction with personal-space separation, take one capped step,
 *  clamp to the floor, and return the next position + facing yaw. */
function stepToward(
  px: number, pz: number, gx: number, gz: number,
  nearby: DecideRequest["perception"]["nearby"], stepLen: number,
): { x: number; z: number; yaw: number } {
  let dx = gx - px;
  let dz = gz - pz;
  const gd = Math.hypot(dx, dz);
  if (gd > 1e-4) { dx /= gd; dz /= gd; } else { dx = 0; dz = 0; }
  const [sx, sz] = separation(px, pz, nearby);
  let vx = dx + sx * SEP_W;
  let vz = dz + sz * SEP_W;
  const vl = Math.hypot(vx, vz) || 1;
  vx /= vl;
  vz /= vl;
  let nx = px + vx * stepLen;
  let nz = pz + vz * stepLen;
  const rr = Math.hypot(nx, nz);
  if (rr > MOVE_R) { nx = nx / rr * MOVE_R; nz = nz / rr * MOVE_R; }
  return { x: nx, z: nz, yaw: Math.atan2(vx, vz) };
}

const socialProvider: LLMProvider = {
  name: "social",
  async decide(req: DecideRequest): Promise<{ toolCalls: MCPRequest[]; usage: { totalTokens: number } }> {
    await Promise.resolve(); // off-loop: lands in the post-tick microtask drain
    const self = req.perception.selfEntity;
    const pos = req.perception.position;
    if (self === undefined || pos === undefined) return { toolCalls: [], usage: { totalTokens: 0 } };
    const idx = idxByEntity.get(self);
    if (idx === undefined) return { toolCalls: [], usage: { totalTokens: 0 } };
    const st = states[idx];
    const nearby = req.perception.nearby;
    const px = pos[0];
    const pz = pos[2];
    const mate = nearby.length ? idxByEntity.get(nearby[0].id) : undefined;
    const mateNum = mate !== undefined ? agentNums[mate] : -1;

    let goalX = px;
    let goalZ = pz;
    let stepLen = STEP_WANDER;
    let moving = true;
    let yaw: number | undefined;
    let nx = px;
    let nz = pz;

    if (st.home < 0) {
      // MINGLER: roam toward the target group, LINGER briefly on arrival (facing
      // in, with the same personal-space nudge as everyone), then drift onward.
      const ax = groupX[st.target];
      const az = groupZ[st.target];
      const d = Math.hypot(ax - px, az - pz);
      if (d < ARRIVE_GROUP) {
        if (st.settleLeft <= 0) {
          st.settleLeft = LINGER_MIN + Math.floor(rnd() * LINGER_VAR);
          if (mateNum >= 0) narrate("social.chat", agentNums[idx], mateNum, nearby.length);
        }
        st.settleLeft -= 1;
        if (st.settleLeft <= 0) {
          // Visited long enough -> pick a different group to drift to.
          let g = st.target;
          if (GROUP_COUNT > 1) { while (g === st.target) g = Math.floor(rnd() * GROUP_COUNT); }
          st.target = g;
          narrate("social.wander", agentNums[idx], -1, nearby.length);
          goalX = groupX[g];
          goalZ = groupZ[g];
          stepLen = STEP_APPROACH;
        } else {
          // Lingering in the group: hold, face the centre, but still nudge clear.
          moving = false;
          yaw = Math.atan2(ax - px, az - pz);
          [nx, nz] = holdNudge(px, pz, nearby);
        }
      } else {
        if (d < PERCEPTION_R && mateNum >= 0) narrate("social.approach", agentNums[idx], mateNum, nearby.length);
        goalX = ax;
        goalZ = az;
        stepLen = STEP_APPROACH;
      }
    } else {
      const ax = groupX[st.home];
      const az = groupZ[st.home];
      if (st.mode === MODE_TOGROUP) {
        if (Math.hypot(st.tx - px, st.tz - pz) < ARRIVE_SLOT) {
          st.mode = MODE_INGROUP;
          st.settleLeft = SETTLE_MIN + Math.floor(rnd() * SETTLE_VAR);
          if (mateNum >= 0) narrate("social.chat", agentNums[idx], mateNum, nearby.length);
        }
        goalX = st.tx;
        goalZ = st.tz;
        stepLen = STEP_WANDER;
      } else {
        // INGROUP: hold the slot facing the circle centre (inward), but keep a
        // gentle personal-space nudge so dense circles never freeze overlapping.
        moving = false;
        yaw = Math.atan2(ax - px, az - pz);
        [nx, nz] = holdNudge(px, pz, nearby);
        st.settleLeft -= 1;
        if (st.settleLeft <= 0) {
          // Gentle churn: pick a fresh spot in the circle and ease over to it.
          const na = rnd() * Math.PI * 2;
          const nr = rnd() * GROUP_RADIUS;
          st.tx = ax + Math.cos(na) * nr;
          st.tz = az + Math.sin(na) * nr;
          st.mode = MODE_TOGROUP;
          narrate("social.perceive", agentNums[idx], -1, nearby.length);
        }
      }
    }

    if (moving) {
      const stepped = stepToward(px, pz, goalX, goalZ, nearby, stepLen);
      nx = stepped.x;
      nz = stepped.z;
      yaw = stepped.yaw;
    }

    const input: { entity: string; position: [number, number, number]; rotationEuler?: [number, number, number] } = {
      entity: self,
      position: [nx, pos[1], nz],
    };
    if (yaw !== undefined) input.rotationEuler = [0, yaw, 0];
    return { toolCalls: [{ tool: "three.setTransform", input }], usage: { totalTokens: 0 } };
  },
};
const providers: ProviderMap = { social: socialProvider };

// Demo-tuned scheduler: the same AgentScheduler, with caps comfortably above the
// steady decision/action rate at 200 agents (interval ~14 -> ~14 due/tick), so
// agents act often enough for lively motion without backpressure spam. Per-frame
// interpolation (below) smooths the scheduler-paced commits into a continuous glide.
const scheduler = new AgentScheduler({
  maxDecisionStartsPerTick: 28,
  maxGlobalActionsPerTick: 56,
  defaultAgentBudget: {
    weight: 1,
    maxQueueDepth: 2,
    maxToolCallsPerDecision: 2,
    maxActionsPerTick: 1,
    decisionTimeoutMs: 250,
  },
});

// ---------------------------------------------------------------------------
// HUD: live AGENT OPS feed (real tracer) + perf overlay
// ---------------------------------------------------------------------------

const SYM_APPROACH = "\u25b8"; // ▸
const SYM_CHAT = "\u2726"; // ✦
const SYM_WANDER = "\u21bb"; // ↻
const SYM_PERCEIVE = "\u25cc"; // ◌

function numOf(p: unknown, key: string): number {
  if (p !== null && typeof p === "object" && key in p) {
    const v = Reflect.get(p, key);
    if (typeof v === "number") return v;
  }
  return -1;
}

/** Real social-transition events -> compact, readable feed lines. Never canned:
 *  the numbers are the agents that actually decided this transition this tick. */
function hudFormat(ev: EngineEvent): string {
  const self = numOf(ev.payload, "self");
  const partner = numOf(ev.payload, "partner");
  const nearby = numOf(ev.payload, "nearby");
  switch (ev.type) {
    case "social.approach": return `#${self} ${SYM_APPROACH} approaching #${partner}`;
    case "social.chat": return `#${self} ${SYM_CHAT} chatting with #${partner}`;
    case "social.wander": return `#${self} ${SYM_WANDER} wandering off`;
    case "social.perceive": return `#${self} ${SYM_PERCEIVE} perceiving ${nearby} nearby`;
    default: return `${ev.type} \u00b7 #${self}`;
  }
}

const hud = new TraceHud(ui, tracer, {
  scene: engine.scene,
  title: "AGENT OPS",
  corner: "bottom-right",
  maxLines: 11,
  width: 360,
  // Only the social op stream (the "conversations"); the pipeline's per-agent
  // perception/decision/action events stay in the trace but off this feed.
  filter: (ev) => ev.type.startsWith("social."),
  revealIntervalMs: 250,
  format: hudFormat,
});

// Perf overlay: a static (overwritten) panel that proves the scale.
const PERF_STYLE: TextStyle = {
  background: { color: 0x0b0720, opacity: 0.84 },
  border: { width: 1, color: 0x4a3aa0, radius: 6 },
  title: { background: 0x1b1240, color: 0x9b8cff, height: 24, align: "left" },
  text: { color: 0xe6ddff, scale: 2, align: "left", lineHeight: 22 },
  padding: { top: 7, right: 12, bottom: 9, left: 12 },
};
const perfPanel = ui.create(engine.scene, "hudPanel", {
  anchor: { kind: "screen", corner: "top-left", marginPx: [16, 16] },
  title: "LIMINA \u00b7 NATIVE PARALLELISM",
  style: PERF_STYLE,
  width: 320,
  lines: ["warming up\u2026"],
});
const perfHandle = perfPanel.handle;
const drawCalls = 3 /* floor+grid+ring */ + numeralMeshes.filter((m) => m !== null).length /* numerals */ + 2 /* eyes+feet */ + 1 /* confetti */;

// ---------------------------------------------------------------------------
// Per-frame instanced render-sync (the instanced analog of renderSyncSystem)
// ---------------------------------------------------------------------------

const mat4 = new THREE.Matrix4();
const vPos = new THREE.Vector3();
const qRot = new THREE.Quaternion();
const qYaw = new THREE.Quaternion();
const qLean = new THREE.Quaternion();
const qEye = new THREE.Quaternion(); // identity orientation for the eye spheres
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const vScale = new THREE.Vector3();
const confScratch = new Float32Array(7);
// Per-agent smoothed planar speed -> drives lean, foot-lift, walk/idle bob blend.
const spd = new Float32Array(AGENT_COUNT);
let animClock = 0; // ms accumulator for the idle bob

/** Shortest-arc interpolation between two angles (radians). */
function angTo(a: number, b: number, t: number): number {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * t;
}

function syncInstances(dtMs: number): void {
  animClock += dtMs;
  const camX = engine.camera.position.x;
  const camZ = engine.camera.position.z;
  const lerp = 1 - Math.exp(-dtMs * 0.012); // frame-rate-independent smoothing
  for (let i = 0; i < AGENT_COUNT; i++) {
    const eid = eids[i];
    const tx = Position.x[eid];
    const tz = Position.z[eid];
    const ox = dispX[i];
    const oz = dispZ[i];
    const nx = ox + (tx - ox) * lerp;
    const nz = oz + (tz - oz) * lerp;
    const moved = Math.hypot(nx - ox, nz - oz);
    dispX[i] = nx;
    dispZ[i] = nz;
    walkPhase[i] += moved * BOB_STRIDE;

    // Smoothed speed -> walk/idle blend, lean, foot lift.
    spd[i] += (moved - spd[i]) * SPEED_LERP;
    const moveAmt = Math.min(spd[i] / SPD_REF, 1);
    const walkBob = Math.abs(Math.sin(walkPhase[i])) * BOB_AMP * moveAmt;
    const idleBob = Math.sin(animClock * IDLE_W + walkPhase[i]) * IDLE_AMP * (1 - moveAmt);
    const bob = walkBob + idleBob;

    // Facing: the group facing the provider wrote into ECS Rotation, overridden
    // toward the flythrough camera when it passes near (then eased back).
    const baseYaw = 2 * Math.atan2(Rotation.y[eid], Rotation.w[eid]);
    let wantYaw = baseYaw;
    const cdx = camX - nx;
    const cdz = camZ - nz;
    const cdist = Math.hypot(cdx, cdz);
    if (cdist < LOOKAT_R) {
      wantYaw = angTo(baseYaw, Math.atan2(cdx, cdz), 1 - cdist / LOOKAT_R);
    }
    dispYaw[i] = angTo(dispYaw[i], wantYaw, 1 - Math.exp(-dtMs * 0.009));
    const yaw = dispYaw[i];
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);

    // Body: yaw + a subtle forward lean that scales with stride.
    const lean = Math.min(spd[i] * LEAN_K, LEAN_MAX);
    qYaw.setFromAxisAngle(Y_AXIS, yaw);
    qLean.setFromAxisAngle(X_AXIS, lean);
    qRot.copy(qYaw).multiply(qLean);
    const gy = GLYPH_CY + bob;
    vPos.set(nx, gy, nz);
    vScale.set(1, 1, 1);
    mat4.compose(vPos, qRot, vScale);
    const grp = numeralMeshes[i % 10];
    if (grp !== null) grp.setMatrixAt(localSlot[i], mat4);

    // Eyes: two dark dots on the upper front face (offset rotated by yaw only).
    const eyeWy = gy + EYE_Y;
    {
      const lx = -EYE_DX * cosY + EYE_Z * sinY;
      const lz = EYE_DX * sinY + EYE_Z * cosY;
      vPos.set(nx + lx, eyeWy, nz + lz);
      vScale.set(1, 1, 1);
      mat4.compose(vPos, qEye, vScale);
      eyeMesh.setMatrixAt(i * 2, mat4);
    }
    {
      const lx = EYE_DX * cosY + EYE_Z * sinY;
      const lz = -EYE_DX * sinY + EYE_Z * cosY;
      vPos.set(nx + lx, eyeWy, nz + lz);
      mat4.compose(vPos, qEye, vScale);
      eyeMesh.setMatrixAt(i * 2 + 1, mat4);
    }

    // Feet: two flattened spheres at the base; alternating lift = stepping. Feet
    // stay grounded (no body bob) so the glyph bobs over planted feet.
    vScale.set(FOOT_SX, FOOT_SY, FOOT_SZ);
    const footBaseY = GLYPH_CY + FOOT_Y;
    const liftL = Math.max(0, Math.sin(walkPhase[i])) * STEP_LIFT * moveAmt;
    const liftR = Math.max(0, Math.sin(walkPhase[i] + Math.PI)) * STEP_LIFT * moveAmt;
    {
      const lx = -FOOT_DX * cosY + FOOT_Z * sinY;
      const lz = FOOT_DX * sinY + FOOT_Z * cosY;
      vPos.set(nx + lx, footBaseY + liftL, nz + lz);
      mat4.compose(vPos, qYaw, vScale);
      footMesh.setMatrixAt(i * 2, mat4);
    }
    {
      const lx = FOOT_DX * cosY + FOOT_Z * sinY;
      const lz = -FOOT_DX * sinY + FOOT_Z * cosY;
      vPos.set(nx + lx, footBaseY + liftR, nz + lz);
      mat4.compose(vPos, qYaw, vScale);
      footMesh.setMatrixAt(i * 2 + 1, mat4);
    }
  }
  for (let d = 0; d < 10; d++) {
    const m = numeralMeshes[d];
    if (m !== null) m.instanceMatrix.needsUpdate = true;
  }
  eyeMesh.instanceMatrix.needsUpdate = true;
  footMesh.instanceMatrix.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Fixed-step (sim) + frame (render) callbacks
// ---------------------------------------------------------------------------

let tick = 0;
let stepCount = 0;
const simStepMs: number[] = [];
const frameMs: number[] = [];
let lastFrameAt = 0;

function pushCapped(arr: number[], v: number, cap = 240): void {
  arr.push(v);
  if (arr.length > cap) arr.shift();
}

function fixedStep(_dt: number): void {
  tick += 1;
  const t0 = now();
  perceptionSystem(agents, world, tracer, tick); // NATIVE batched spatial query
  decisionSystem(agents, registry, providers, tracer, tick, scheduler); // off-loop scripted social
  void actionSystem(agents, registry, world, tick, scheduler); // three.setTransform, traced
  ops.op_physics_step();
  for (let i = 0; i < CONFETTI_COUNT; i++) {
    ops.op_physics_body_transform(confettiBodies[i], confScratch);
    vPos.set(confScratch[0], confScratch[1], confScratch[2]);
    qRot.set(confScratch[3], confScratch[4], confScratch[5], confScratch[6]);
    vScale.set(1, 1, 1);
    mat4.compose(vPos, qRot, vScale);
    confettiMesh.setMatrixAt(i, mat4);
  }
  confettiMesh.instanceMatrix.needsUpdate = true;
  spatial.invalidate();
  pushCapped(simStepMs, now() - t0);
  stepCount += 1;
}

function p95(v: number[]): number {
  if (v.length === 0) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
}

let perfClock = 0;
let lastPerfAt = now();
let lastPerfSteps = 0;
function updatePerf(): void {
  const t = now();
  const elapsed = Math.max(1, t - lastPerfAt);
  const stepsPerSec = (stepCount - lastPerfSteps) / elapsed * 1000;
  lastPerfAt = t;
  lastPerfSteps = stepCount;
  const simMean = simStepMs.length ? simStepMs.reduce((a, b) => a + b, 0) / simStepMs.length : 0;
  const frameMean = frameMs.length ? frameMs.reduce((a, b) => a + b, 0) / frameMs.length : 0;
  const fps = frameMean > 0 ? 1000 / frameMean : 0;
  ui.update(perfHandle, {
    lines: [
      `agents ${AGENT_COUNT}  \u00b7  perceive: native batch`,
      `sim-step ${simMean.toFixed(2)}ms  p95 ${p95(simStepMs).toFixed(2)}ms`,
      `steps/s ${stepsPerSec.toFixed(0)}   fps ${fps.toFixed(0)}`,
      `instanced \u00b7 ~${drawCalls} draw calls`,
    ],
  });
}

// Flythrough camera path: a smooth closed loop (radius + height weave) sampled
// for the eye position and a slightly-ahead look target.
// --- audio: a soft club ambience bed + positional chatter chirps you hear as the
// flythrough camera passes each group (spatial, pitched by digit, distance-culled).
const audio = new AudioManager();
let chatterAcc = 0;
const CHATTER_R2 = 16 * 16; // only chirp from numerals within ~16u of the camera
const CHATTER_MAX = 22; // spatial cutoff distance
const CHATTER_FREQ = [392, 440, 494, 587, 659, 784, 880, 988, 1175, 1319]; // by digit

const camScratch = new THREE.Vector3();
const camAheadScratch = new THREE.Vector3();
function camPath(a: number, out: THREE.Vector3): THREE.Vector3 {
  const rad = FLY_R_MID + Math.sin(a * FLY_R_FREQ) * FLY_R_AMP;
  out.set(Math.cos(a) * rad, FLY_BASE_H + Math.sin(a * FLY_Y_FREQ + 0.7) * FLY_Y_AMP, Math.sin(a) * rad);
  return out;
}

function render(_alpha: number): void {
  const t = now();
  const dt = lastFrameAt !== 0 ? t - lastFrameAt : 1000 / 60;
  lastFrameAt = t;
  pushCapped(frameMs, dt);

  // Dynamic flythrough: weave the camera along a smooth closed loop, looking a
  // little ahead so it appears to fly among / through the conversation circles.
  const a = t * FLY_SPEED;
  const cur = camPath(a, camScratch);
  engine.camera.position.set(cur.x, cur.y, cur.z);
  const ahead = camPath(a + FLY_LOOK_AHEAD, camAheadScratch);
  // Bias the look target inward toward the crowd so the framing never drifts off.
  engine.camera.lookAt(ahead.x * (1 - FLY_LOOK_BIAS), FLY_LOOK_Y, ahead.z * (1 - FLY_LOOK_BIAS));

  // Audio listener = the flythrough camera (two ears from its right vector), so the
  // positional chatter pans + attenuates as we sweep through the groups.
  const lookX = ahead.x * (1 - FLY_LOOK_BIAS);
  const lookZ = ahead.z * (1 - FLY_LOOK_BIAS);
  audio.syncListener([cur.x, cur.y, cur.z], [-(lookZ - cur.z), 0, lookX - cur.x]);
  chatterAcc += dt;
  if (chatterAcc >= 340) {
    chatterAcc = 0;
    let emitted = 0;
    for (let s = 0; s < 10 && emitted < 2; s++) {
      const i = (Math.random() * AGENT_COUNT) | 0;
      const eid = eids[i];
      const dx = Position.x[eid] - cur.x;
      const dz = Position.z[eid] - cur.z;
      if (dx * dx + dz * dz <= CHATTER_R2) {
        audio.playAt(CHATTER_FREQ[i % 10], 0.09, [Position.x[eid], 0.85, Position.z[eid]], "sfx", 0.4, CHATTER_MAX);
        emitted++;
      }
    }
  }

  // Drifting club lamps.
  for (const lamp of lamps) {
    lamp.phase += dt * lamp.speed;
    lamp.light.position.set(Math.cos(lamp.phase) * lamp.radius, lamp.light.position.y, Math.sin(lamp.phase) * lamp.radius);
  }
  ring.rotation.z += dt * 0.0003;

  syncInstances(dt);
  hud.pump(dt); // pull NEW real trace events, reveal at a calm cadence
  ui.update(engine.camera, engine.width, engine.height, dt); // anchors + feed lifecycle
  if (++perfClock >= 20) { perfClock = 0; updatePerf(); }

  engine.renderer.render(engine.scene, engine.camera);
  ops.op_surface_present(engine.context);
}

// ---------------------------------------------------------------------------
// Warm-up (compile pipelines, avoid the blank first frame), then start the loop
// ---------------------------------------------------------------------------

const camWarm = camPath(0, camScratch);
engine.camera.position.set(camWarm.x, camWarm.y, camWarm.z);
const camWarmLook = camPath(FLY_LOOK_AHEAD, camAheadScratch);
engine.camera.lookAt(camWarmLook.x, FLY_LOOK_Y, camWarmLook.z);
for (let i = 0; i < CONFETTI_COUNT; i++) {
  ops.op_physics_body_transform(confettiBodies[i], confScratch);
  vPos.set(confScratch[0], confScratch[1], confScratch[2]);
  qRot.set(confScratch[3], confScratch[4], confScratch[5], confScratch[6]);
  vScale.set(1, 1, 1);
  mat4.compose(vPos, qRot, vScale);
  confettiMesh.setMatrixAt(i, mat4);
}
confettiMesh.instanceMatrix.needsUpdate = true;
syncInstances(1000 / 60);
ui.update(engine.camera, engine.width, engine.height, 1000 / 60);
engine.renderer.render(engine.scene, engine.camera);
ops.op_surface_present(engine.context);

ops.op_set_fixed_step_callback(fixedStep);
ops.op_audio_init();
audio.ambient("ambience", 0.3); // soft synth-pad club bed (no-op under LIMINA_AUDIO=null)
audio.setBusVolume("master", 0.85);

ops.op_set_frame_callback(render);
// (Resize stays createEngine's robust default — swapchain reconfigure on resize.)

ops.op_log(
  `agent_build_showcase ready: ${AGENT_COUNT} number-people mingling via the REAL native-parallel ` +
  `agent pipeline (perception->decision->action, traced). AGENT OPS HUD bottom-right, perf overlay top-left.`,
);
