// Wave 2 (windowed) — LIVE agent-conversation forest. An agent-controlled
// humanoid walks up to two forest NPCs and holds a SHORT, real-time,
// NON-DETERMINISTIC conversation driven by a local Ollama model (qwen2.5:7b),
// rendered as REAL speech bubbles, with a live REAL agent-ops HUD and a fixed
// third-person camera behind the player.
//
// Nothing is canned: every spoken line is whatever the model generates this run
// (run it twice -> different dialogue). If Ollama is unreachable the demo still
// runs and shows an honest "LLM offline / waiting" status — it NEVER fabricates a
// line. Decisions/LLM calls run OFF the frame loop (async), so render never
// blocks on the slow model.
//
// Reuses Wave 1 verbatim: spawnHumanoid + Locomotion + social.* skills + the
// trace-fed TraceHud + the ui.* skill surface. The new piece is the turn-based
// ConversationDirector (../agents/conversation.ts), which is the turn arbiter.
//
// Run: ./target/debug/limina --window --frames 9000 js/src/demos/forest_conversation.ts

import * as THREE from "../../build/three.bundle.mjs";
import { createEngine, ops } from "../engine.ts";
import { Position, renderSyncSystem } from "../ecs/world.ts";
import { LiminaTracer, type EngineEvent } from "../observability/event.ts";
import { SkillRegistry, type InvokeBase, type WorldContext } from "../skills/registry.ts";
import { registerCoreSkills } from "../skills/index.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { AgentRegistry } from "../agents/agent.ts";
import { OllamaChat } from "../agents/llm.ts";
import { spawnHumanoid } from "../world/humanoid.ts";
import { TraceHud } from "../ui/hud_feed.ts";
import { ConversationDirector, type Persona } from "../agents/conversation.ts";
import { AudioManager } from "../audio/manager.ts";
import { createMaterial } from "../materials/palette.ts";

const MODEL = "qwen2.5:7b";
const OLLAMA_URL = "http://localhost:11434/api/chat";
const SESSION = "ses_forest_convo";
const DT_MS = 1000 / 60;

// ---------------------------------------------------------------------------
// Engine + world context
// ---------------------------------------------------------------------------

const engine = await createEngine({ width: 1024, height: 640 });
engine.scene.background = new THREE.Color(0x9ec7e8); // soft dusk-blue sky

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

const tracer = new LiminaTracer(SESSION);
const registry = new SkillRegistry(tracer);
const { ui, locomotion, social } = registerCoreSkills(registry);

// Host/builder identity for the scene chrome (name tags, status panel).
const builder: InvokeBase = {
  agentId: "agt_director",
  sessionId: SESSION,
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
async function uiCreate(tool: string, input: unknown): Promise<string> {
  const res = await registry.invoke(tool, input, builder);
  if (!res.success) throw new Error(`${tool} failed: ${JSON.stringify(res.error)}`);
  return handleOf(res.result);
}

// ---------------------------------------------------------------------------
// Forest dressing: ground + scattered trees + light + sky
// ---------------------------------------------------------------------------

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(40, 48),
  createMaterial("grass", { pbr: true }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
engine.scene.add(ground);

const trunkMat = createMaterial("wood", { pbr: true });
const foliageMats = [
  createMaterial("foliage", { pbr: true }),
  createMaterial("leaf", { pbr: true }),
  createMaterial("foliage", { pbr: true }),
];

/** A tree = a trunk cylinder + two stacked foliage cones. */
function tree(x: number, z: number, scale: number, foliage: number): void {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.24, 2.0, 8), trunkMat);
  trunk.position.y = 1.0;
  trunk.castShadow = true;
  g.add(trunk);
  const lower = new THREE.Mesh(new THREE.ConeGeometry(1.15, 2.2, 10), foliageMats[foliage % foliageMats.length]);
  lower.position.y = 2.5;
  lower.castShadow = true;
  g.add(lower);
  const upper = new THREE.Mesh(new THREE.ConeGeometry(0.85, 1.8, 10), foliageMats[(foliage + 1) % foliageMats.length]);
  upper.position.y = 3.5;
  upper.castShadow = true;
  g.add(upper);
  g.position.set(x, 0, z);
  g.scale.setScalar(scale);
  engine.scene.add(g);
}

// --- Conversation geometry: the cast's spots + where the side two-shot camera
// frames each pair. The trees below are scattered to keep CLEAR of all of it so
// nothing in the foreground ever occludes a conversation or the camera's view.
const PLAYER_POS: [number, number, number] = [0, 0, 0];
const BIRCH_POS: [number, number, number] = [4.5, 0, 6.5];
const WILLOW_POS: [number, number, number] = [-5, 0, 5.5];
const TALK = 1.6; // talkDistance the player stops at (also used by locomotion below)

// Deterministic scatter (small LCG) in an annulus ringing the clearing, REJECTING
// any tree whose trunk would crowd a conversation spot or block the side two-shot
// camera's view of a talking pair. Keep-clear set (all in the XZ plane):
//   • a disc around the player start, each NPC, each arrival spot + midpoint;
//   • the side two-shot camera position for BOTH framing sides of each pair; and
//   • the sightline from each of those cameras to the pair it frames.
// (Same ~22 trees + natural look as before — just relocated out of the way.)
type P2 = { x: number; z: number };
const xz = (p: [number, number, number]): P2 => ({ x: p[0], z: p[2] });
const mid2 = (a: P2, b: P2): P2 => ({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
const arrival2 = (from: P2, to: P2, talk: number): P2 => {
  const dx = to.x - from.x, dz = to.z - from.z;
  const l = Math.hypot(dx, dz) || 1;
  return { x: to.x - (dx / l) * talk, z: to.z - (dz / l) * talk };
};
/** Squared distance from point (px,pz) to the segment a->b (XZ). */
const distSqToSeg = (px: number, pz: number, a: P2, b: P2): number => {
  const dx = b.x - a.x, dz = b.z - a.z;
  const len2 = dx * dx + dz * dz || 1;
  let t = ((px - a.x) * dx + (pz - a.z) * dz) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = a.x + t * dx, cz = a.z + t * dz;
  return (px - cx) ** 2 + (pz - cz) ** 2;
};

const keepDiscs: { p: P2; r: number }[] = [];
const keepLines: { a: P2; b: P2; r: number }[] = [];
const NODE_R = 4.0; // clearance around a person / arrival / midpoint
const CAM_R = 4.6; // clearance around a camera position (keep it out of the lens)
const LINE_R = 3.6; // clearance either side of a camera->pair sightline

const player2 = xz(PLAYER_POS);
keepDiscs.push({ p: player2, r: NODE_R });
// Chain the walk exactly as the demo does: origin -> Birch, then Birch's arrival
// spot -> Willow; the side two-shot camera is framed off each arrival pose.
let prevSpot = player2;
for (const npcPos of [BIRCH_POS, WILLOW_POS]) {
  const npc2 = xz(npcPos);
  const arr = arrival2(prevSpot, npc2, TALK);
  const m = mid2(arr, npc2);
  keepDiscs.push({ p: npc2, r: NODE_R }, { p: arr, r: NODE_R }, { p: m, r: NODE_R }, { p: mid2(player2, npc2), r: NODE_R });
  const ax = npc2.x - arr.x, az = npc2.z - arr.z;
  const al = Math.hypot(ax, az) || 1;
  const perpx = -az / al, perpz = ax / al; // unit perpendicular to the pair axis
  const dist = Math.max(5.2, al * 1.25 + 3.4); // matches aimCamera()'s side two-shot
  for (const s of [1, -1]) {
    const cam: P2 = { x: m.x + s * perpx * dist, z: m.z + s * perpz * dist };
    keepDiscs.push({ p: cam, r: CAM_R });
    keepLines.push({ a: cam, b: npc2, r: LINE_R }, { a: cam, b: arr, r: LINE_R }, { a: cam, b: m, r: LINE_R });
  }
  prevSpot = arr;
}

const treeViolatesKeepClear = (x: number, z: number): boolean => {
  for (const d of keepDiscs) if ((x - d.p.x) ** 2 + (z - d.p.z) ** 2 < d.r * d.r) return true;
  for (const s of keepLines) if (distSqToSeg(x, z, s.a, s.b) < s.r * s.r) return true;
  return false;
};

let seed = 0x9e3779b1;
const rand = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0xffffffff;
};
let treesPlaced = 0;
for (let attempt = 0; attempt < 5000 && treesPlaced < 22; attempt++) {
  const angle = rand() * Math.PI * 2;
  const radius = 9 + rand() * 9;
  const x = Math.cos(angle) * radius, z = Math.sin(angle) * radius;
  if (treeViolatesKeepClear(x, z)) continue;
  tree(x, z, 0.8 + rand() * 0.9, Math.floor(rand() * 3));
  treesPlaced++;
}

const sun = new THREE.DirectionalLight(0xfff0d2, 2.8);
sun.position.set(9, 15, 7);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 60;
sun.shadow.camera.left = -22;
sun.shadow.camera.right = 22;
sun.shadow.camera.top = 22;
sun.shadow.camera.bottom = -22;
engine.scene.add(sun);
engine.scene.add(new THREE.HemisphereLight(0xbfd8f0, 0x32502f, 1.15));

// ---------------------------------------------------------------------------
// Cast: an agent-controlled player + two forest NPCs (distinct colors)
// ---------------------------------------------------------------------------

const PLAYER = "agt_wanderer";
const BIRCH = "agt_birch";
const WILLOW = "agt_willow";
const SPEED = 1.7;

const player = spawnHumanoid(world, { color: 0x5fa8ff, position: PLAYER_POS });
const birch = spawnHumanoid(world, { color: 0xe8c98a, position: BIRCH_POS });
const willow = spawnHumanoid(world, { color: 0x8fd6c0, position: WILLOW_POS });

locomotion.add({ agentId: PLAYER, entityId: player.entityId, eid: player.eid, humanoid: player.humanoid, speed: SPEED, talkDistance: TALK });
locomotion.add({ agentId: BIRCH, entityId: birch.entityId, eid: birch.eid, humanoid: birch.humanoid, speed: SPEED, talkDistance: TALK });
locomotion.add({ agentId: WILLOW, entityId: willow.entityId, eid: willow.eid, humanoid: willow.humanoid, speed: SPEED, talkDistance: TALK });

const NAMES: Record<string, string> = { [PLAYER]: "Wanderer", [BIRCH]: "Birch", [WILLOW]: "Willow" };

// Name tags over the ui.* skill surface, each tracking its humanoid. They are
// DUMB free-floating billboards: they take NO part in the bubble layout pass
// (never push or get pushed; overlapping each other is fine) and sit at a LOW
// renderOrder so a speech bubble (renderOrder 20, depthTest off) always draws
// over them.
async function nameTag(entityId: string, name: string, color: number): Promise<void> {
  await uiCreate("ui.label", {
    anchor: { kind: "world", entity: entityId, offset: [0, 1.95, 0], billboard: true, renderOrder: 0 },
    text: name,
    style: { text: { color }, background: { color: 0x0c1018, opacity: 0.55 }, border: { width: 1, color, radius: 8 }, padding: 6 },
  });
}
await nameTag(player.entityId, "Wanderer", 0xbfe0ff);
await nameTag(birch.entityId, "Birch", 0xf3dcad);
await nameTag(willow.entityId, "Willow", 0xc6f0e2);

// ---------------------------------------------------------------------------
// On-screen status overlay (honest LLM connection state) + live agent-ops HUD
// ---------------------------------------------------------------------------

const statusHandle = await uiCreate("ui.hudPanel", {
  anchor: { kind: "screen", corner: "bottom-left", marginPx: [16, 16] },
  title: "OLLAMA",
  lines: ["starting\u2026"],
  width: 360,
  maxLines: 4, // fixed-size status console: pinned width + height, one truncated row per line
  style: { background: { color: 0x0c1018, opacity: 0.82 }, border: { width: 2, color: 0x46506a, radius: 10 }, text: { color: 0xeaf2ff }, padding: 10 },
});

/** Wrap a status string into short lines so the panel stays legible. */
function wrap(s: string, width = 42): string[] {
  const words = s.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur.length > 0 && (cur.length + 1 + w.length) > width) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur.length === 0 ? w : `${cur} ${w}`;
    }
  }
  if (cur.length > 0) lines.push(cur);
  return lines.slice(0, 4);
}

function setStatus(s: string): void {
  void registry.invoke("ui.update", { handle: statusHandle, lines: wrap(s, 18) }, builder);
  ops.op_log(`[convo-status] ${s}`);
}

/** Real trace events -> compact HUD lines (the actual payload; never canned). */
function hudFormat(ev: EngineEvent): string {
  const p = ev.payload;
  const get = (key: string): unknown => (p !== null && typeof p === "object" && key in p ? Reflect.get(p, key) : undefined);
  const who = NAMES[ev.actorId] ?? ev.actorId;
  switch (ev.type) {
    case "agent.thinking": return `${who} \u00b7 thinking\u2026`;
    case "llm.response": return `${who} \u00b7 replied (${String(get("latencyMs"))}ms)`;
    case "llm.unavailable": return `LLM offline \u00b7 ${who}`;
    case "conversation.approach": return `${who} \u00b7 approaching ${String(get("name"))}`;
    case "conversation.ended": return `done \u00b7 ${String(get("lines"))} lines`;
    case "conversation.started": return `conversation begins`;
    case "social.said": {
      const t = typeof get("text") === "string" ? String(get("text")) : "";
      return `${who}: ${t.length > 38 ? `${t.slice(0, 38)}\u2026` : t}`;
    }
    case "social.approached": return `${who} \u00b7 approach`;
    case "skill.executed": return `skill \u00b7 ${String(get("skill"))}`;
    case "security.permission.denied": return `DENIED \u00b7 ${String(get("skill"))}`;
    default: return `${ev.type} \u00b7 ${who}`;
  }
}

const hud = new TraceHud(ui, tracer, {
  scene: engine.scene,
  title: "AGENT OPS",
  corner: "bottom-right", // console-style: pinned to the bottom, newest line lowest, older scroll up
  maxLines: 10, // fixed console height: 10 visible rows, newest at the bottom, oldest scrolls off
  width: 400,
  // De-noised: only the meaningful conversation ops (thinking / replied /
  // social.said / approached / done / offline / denied). `skill.executed` is
  // dropped on purpose — every social.say/approach already shows as its semantic
  // event, and the per-status `ui.update` status-panel writes were pure spam.
  filter: (ev) =>
    ev.type === "agent.thinking" ||
    ev.type === "llm.response" ||
    ev.type === "llm.unavailable" ||
    ev.type.startsWith("conversation.") ||
    ev.type.startsWith("social.") ||
    ev.type === "security.permission.denied",
  // Calm, readable cadence: reveal ~1 new line per 650ms (backlog queued + drained).
  revealIntervalMs: 650,
  format: hudFormat,
});

// ---------------------------------------------------------------------------
// Register the three agents (identity/profile) + the live dialogue director
// ---------------------------------------------------------------------------

const agents = new AgentRegistry();
const player_p: Persona = { agentId: PLAYER, name: "Wanderer", voice: "You are a wandering traveler crossing an old forest at dusk: curious, a little weary, warm and plain-spoken." };
const birch_p: Persona = { agentId: BIRCH, name: "Birch", voice: "You are Birch, an ancient and gruff forest warden: terse, dry, wary of strangers but ultimately fair." };
const willow_p: Persona = { agentId: WILLOW, name: "Willow", voice: "You are Willow, a dreamy river-spirit of the grove: gentle and poetic, speaking in soft images of water, leaves, and light." };
for (const pr of [player_p, birch_p, willow_p]) {
  agents.add({ id: pr.agentId, type: "player", entityId: locomotion.entityIdOf(pr.agentId), perceptionRadius: 50, decisionIntervalTicks: 1, profile: "social.actor", sessionId: SESSION, llm: { provider: "ollama", model: MODEL, systemPrompt: pr.voice } });
}

// --- audio: a soft forest ambience bed + spoken dialogue (TTS at the speaker's
// head) layered over the speech bubbles. The voice runs Rust-side + off-thread,
// so a slow synth never stalls the conversation or the frame.
const audio = new AudioManager();
ops.op_audio_init();
audio.ambient("ambience", 0.18); // subtle background bed (no-op under LIMINA_AUDIO=null)
const eidOf: Record<string, number> = { [PLAYER]: player.eid, [BIRCH]: birch.eid, [WILLOW]: willow.eid };

const director = new ConversationDirector({
  registry,
  world,
  tracer,
  locomotion,
  chat: new OllamaChat(MODEL, OLLAMA_URL),
  model: MODEL,
  sessionId: SESSION,
  player: player_p,
  npcs: [birch_p, willow_p],
  linesPerExchange: 4,
  holdFrames: 110, // ~1.8s a line lingers before the reply (60 fixed steps/s)
  beatFrames: 80, // ~1.3s pause between exchanges
  arrivalFrames: 1800, // ~30s budget to walk up before giving up
  framingFrames: 48, // ~0.8s camera-settle window: the two-shot frames BEFORE the first LLM line fires
  onStatus: setStatus,
  // Fade out + remove a pair's bubbles when their exchange ends (and all at the
  // very end) so lines never linger past the conversation.
  clearBubbles: (ids) => { for (const id of ids) social.dismiss(id); },
  // Reveal-gate the hold: don't reply until the speaker's bubble has fully typed
  // its line (then holdFrames as a readable pause), so long lines never cut off.
  bubbleRevealed: (id) => social.revealed(id),
  onSpeak: (agentId, text) => {
    const eid = eidOf[agentId];
    if (eid !== undefined) audio.speak(text, [Position.x[eid], 1.6, Position.z[eid]], 0.95);
  },
});

// ---------------------------------------------------------------------------
// Fixed third-person camera behind + above the player (gentle follow)
// ---------------------------------------------------------------------------

const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3();
const desiredPos = new THREE.Vector3();
const desiredLook = new THREE.Vector3();
const EID: Record<string, number> = { [PLAYER]: player.eid, [BIRCH]: birch.eid, [WILLOW]: willow.eid };

function aimCamera(lerpPos: number, lerpLook: number): void {
  const peid = player.eid;
  const px = Position.x[peid], py = Position.y[peid], pz = Position.z[peid];
  const partnerId = director.inConversation ? director.activePartnerAgentId : undefined;
  const qeid = partnerId !== undefined ? EID[partnerId] : undefined;
  if (qeid !== undefined) {
    // SIDE TWO-SHOT once a conversation is live: frame the player + partner in
    // profile, viewed perpendicular to the line between them, so they sit on
    // OPPOSITE sides of the frame (their bubbles then separate naturally) with
    // headroom above each head. Lerped in from the follow pose (no hard cut).
    const qx = Position.x[qeid], qz = Position.z[qeid];
    const mx = (px + qx) / 2, mz = (pz + qz) / 2;
    const ax = qx - px, az = qz - pz;
    const al = Math.hypot(ax, az) || 1;
    let perpx = -az / al, perpz = ax / al; // unit perpendicular in the XZ plane
    // Keep the camera on the side it is already on (no flip through the subjects).
    if (perpx * (camPos.x - mx) + perpz * (camPos.z - mz) < 0) { perpx = -perpx; perpz = -perpz; }
    const dist = Math.max(5.2, al * 1.25 + 3.4);
    desiredPos.set(mx + perpx * dist, py + 2.7, mz + perpz * dist);
    desiredLook.set(mx, py + 1.95, mz);
  } else {
    // FOLLOW while walking/approaching: third-person behind + above the player.
    const f = locomotion.facing(PLAYER) ?? [0, 0, 1]; // [sin yaw, 0, cos yaw]
    desiredPos.set(px - f[0] * 7.4, py + 4.0, pz - f[2] * 7.4);
    desiredLook.set(px + f[0] * 3.2, py + 2.0, pz + f[2] * 3.2);
  }
  camPos.lerp(desiredPos, lerpPos);
  camLook.lerp(desiredLook, lerpLook);
  engine.camera.position.copy(camPos);
  engine.camera.lookAt(camLook);
  engine.camera.updateMatrixWorld(true);
}

// ---------------------------------------------------------------------------
// Fixed-step (logic) + render callbacks
// ---------------------------------------------------------------------------

let tick = 0;
function fixedStep(_dt: number): void {
  tick += 1;
  // Single writer of planar Position + yaw; also ticks each humanoid's walk anim.
  locomotion.step(world, DT_MS);
  // Advance the live conversation one frame (synchronous turn arbiter). It walks
  // the player, fires the detached LLM call, speaks lines, and counts holds — all
  // off the render path. The director self-starts on its first tick.
  director.tick();
}


function render(_alpha: number): void {
  // Snappier glide into the side two-shot while framing/talking so it SETTLES
  // within the director's ~48-frame framing window (camera in place BEFORE the
  // first LLM line); a gentler lerp while following the walk.
  const framed = director.inConversation;
  aimCamera(framed ? 0.12 : 0.08, framed ? 0.16 : 0.12);
  // Audio listener follows the two-shot camera (ears from its look direction).
  audio.syncListener([camPos.x, camPos.y, camPos.z], [-(camLook.z - camPos.z), 0, camLook.x - camPos.x]);
  renderSyncSystem(engine.world); // ECS Position/Rotation -> the humanoid group roots
  hud.pump(DT_MS); // record NEW real trace events; reveal them into the feed at a calm pace
  ui.update(engine.camera, engine.width, engine.height, DT_MS); // anchors + bubble/feed lifecycles (incl. the side-placement pass)
  engine.renderer.render(engine.scene, engine.camera);
  ops.op_surface_present(engine.context);
}

// Warm-up: snap the camera to its framed pose and compile WebGPU pipelines before
// the loop (avoids the known blank/white first frame), then start the loop.
aimCamera(1, 1);
renderSyncSystem(engine.world);
ui.update(engine.camera, engine.width, engine.height, DT_MS);
engine.renderer.render(engine.scene, engine.camera);
ops.op_surface_present(engine.context);

ops.op_set_fixed_step_callback(fixedStep);
ops.op_set_frame_callback(render);

// (The conversation advances from fixedStep via director.tick() — see above.)

ops.op_log(`forest_conversation ready: live ${MODEL} dialogue; agent walks up + talks in real speech bubbles (agent-ops HUD bottom-right, Ollama status bottom-left)`);
