// Phase 5 — Agent-conversation FOUNDATION (headless, DETERMINISTIC).
//
// Proves the full embodied-conversation pipeline end-to-end with a ScriptedProvider
// (CI-only; Wave 2 swaps in live Ollama + a windowed demo):
//
//   approach -> walk -> arrive + face -> say -> REAL speech bubble -> reply ->
//   REAL traced events surfaced in a REAL trace-fed HUD.
//
// Three agents (player + 2 NPCs) each inhabit a procedural humanoid entity. A
// ScriptedProvider drives the player to social.approach(npc1); the locomotion
// system walks the player there over fixed steps; on ARRIVAL the player
// social.say's a greeting (a real bubble over its head); npc1 REACTS to the
// player's real traced utterance and social.say's a reply. Every claim is
// asserted against real state: monotonic approach + exact arrival + facing; one
// host-bound `social.said` per speaker; a live UiManager bubble anchored to each
// speaker; and a HUD whose feed is built ONLY from tracer.tail events.
//
// Plus the gates: a profile lacking `social.act` is DENIED with zero effect, and
// a payload-forced wrong actorId is ignored (attribution is host-bound). Both are
// falsifiable (the same call under a permitted profile / the locomotion step that
// causes arrival are shown to be the load-bearing pieces).
//
// Run (headless): ./target/debug/limina js/test/p5_conversation.ts

import * as THREE from "../build/three.bundle.mjs";
import { EntityTable, ops, type SceneLike } from "../src/engine.ts";
import { createEcsWorld, Position } from "../src/ecs/world.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import type { InvokeBase, WorldContext } from "../src/skills/registry.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { AgentRegistry } from "../src/agents/agent.ts";
import { ScriptedProvider } from "../src/agents/llm.ts";
import { actionSystem, decisionSystem, perceptionSystem } from "../src/agents/systems.ts";
import { AgentScheduler } from "../src/agents/scheduler.ts";
import { spawnHumanoid } from "../src/world/humanoid.ts";
import { TraceHud } from "../src/ui/hud_feed.ts";
import type { MCPRequest } from "../src/mcp/protocol.ts";
import { ConversationDirector } from "../src/agents/conversation.ts";
import type { ChatClient, ChatMessage, ChatTurnResult } from "../src/agents/llm.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("P5 CONVO FAIL: " + message);
}
function field(value: unknown, key: string): unknown {
  if (typeof value === "object" && value !== null && key in value) return (value as Record<string, unknown>)[key];
  return undefined;
}
function planarDist(a: number, b: number): number {
  return Math.hypot(Position.x[a] - Position.x[b], Position.z[a] - Position.z[b]);
}

// ---- headless world: a child-tracking scene + a real camera ----------------

const sceneChildren: unknown[] = [];
const scene: SceneLike = {
  add(o: unknown) { sceneChildren.push(o); },
  remove(o: unknown) { const i = sceneChildren.indexOf(o); if (i >= 0) sceneChildren.splice(i, 1); },
  background: null,
  position: { set() {}, x: 0, y: 0, z: 0 },
};
const W = 960;
const H = 640;
const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 200);
camera.position.set(0, 6, 14);
camera.lookAt(2, 1, 1);
camera.updateMatrixWorld(true);

const SESSION = "ses_p5_convo";
const agents = new AgentRegistry();
const world: WorldContext = { ecs: createEcsWorld(), entities: new EntityTable(), tags: new Map(), scene, camera, ops, agents };

const tracer = new LiminaTracer(SESSION);
const registry = new SkillRegistry(tracer);
const { ui, locomotion, social } = registerCoreSkills(registry);

// ---- forest cast: a player + two NPC humanoids -----------------------------

const PLAYER = "agt_player";
const NPC1 = "agt_birch";
const NPC2 = "agt_willow";
const SPEED = 1.8;
const TALK = 1.4;

const player = spawnHumanoid(world, { color: 0x6db1ff, position: [0, 0, 0] });
const npc1 = spawnHumanoid(world, { color: 0x9be37d, position: [5, 0, 0] });
const npc2 = spawnHumanoid(world, { color: 0xffb066, position: [-3, 0, 6] });

locomotion.add({ agentId: PLAYER, entityId: player.entityId, eid: player.eid, humanoid: player.humanoid, speed: SPEED, talkDistance: TALK });
locomotion.add({ agentId: NPC1, entityId: npc1.entityId, eid: npc1.eid, humanoid: npc1.humanoid, speed: SPEED, talkDistance: TALK });
locomotion.add({ agentId: NPC2, entityId: npc2.entityId, eid: npc2.eid, humanoid: npc2.humanoid, speed: SPEED, talkDistance: TALK });

// Name labels authored over the SAME ui.* skill surface (builder, ui.write),
// each anchored to follow its humanoid.
const HOST: InvokeBase = { agentId: "engine", sessionId: SESSION, permissions: resolveProfile("builder.readWrite"), tick: 0, world };
async function nameLabel(entityId: string, name: string): Promise<string> {
  const r = await registry.invoke("ui.label", { anchor: { kind: "world", entity: entityId, offset: [0, 2.15, 0], billboard: true }, text: name, style: { text: { color: 0xffffff } } }, HOST);
  assert(r.success, `name label '${name}' failed: ${JSON.stringify(r.error)}`);
  return field(r.result, "handle") as string;
}
const playerLabel = await nameLabel(player.entityId, "Wanderer");
const npc1Label = await nameLabel(npc1.entityId, "Birch");
const npc2Label = await nameLabel(npc2.entityId, "Willow");
assert(ui.has(playerLabel) && ui.has(npc1Label) && ui.has(npc2Label), "name labels not live in the UiManager");

// ---- ScriptedProvider conversation (deterministic state machines) ----------

const GREETING = "Well met. Have you walked far today?";
const REPLY = "Greetings, wanderer. The grove is quiet this season.";

let playerStage: "approach" | "walking" | "spoke" = "approach";
const playerProvider = new ScriptedProvider((): MCPRequest[] => {
  if (playerStage === "approach") {
    playerStage = "walking";
    return [{ tool: "social.approach", input: { target: NPC1 } }];
  }
  if (playerStage === "walking" && locomotion.hasArrived(PLAYER)) {
    playerStage = "spoke";
    return [{ tool: "social.say", input: { text: GREETING } }];
  }
  return [];
});

let npcReplied = false;
const npcProvider = new ScriptedProvider((): MCPRequest[] => {
  if (npcReplied) return [];
  // React to the player's REAL traced utterance (the same trace the HUD reads).
  if (tracer.trace(PLAYER).some((e) => e.type === "social.said")) {
    npcReplied = true;
    return [{ tool: "social.say", input: { text: REPLY } }];
  }
  return [];
});
const idleProvider = new ScriptedProvider((): MCPRequest[] => []);
const providers = { player: playerProvider, npc: npcProvider, idle: idleProvider };

agents.add({ id: PLAYER, type: "player", entityId: player.entityId, perceptionRadius: 50, decisionIntervalTicks: 1, profile: "social.actor", sessionId: SESSION, llm: { provider: "player", model: "", systemPrompt: "approach a neighbor and greet them" } });
agents.add({ id: NPC1, type: "player", entityId: npc1.entityId, perceptionRadius: 50, decisionIntervalTicks: 1, profile: "social.actor", sessionId: SESSION, llm: { provider: "npc", model: "", systemPrompt: "reply when greeted" } });
agents.add({ id: NPC2, type: "player", entityId: npc2.entityId, perceptionRadius: 50, decisionIntervalTicks: 1, profile: "social.actor", sessionId: SESSION, llm: { provider: "idle", model: "", systemPrompt: "observe" } });

// Cap decision starts to the agent count so each agent is admitted EXACTLY ONCE
// per tick. The default scheduler round-robins a sole/under-capped candidate set
// up to `candidates*2` visits, re-admitting agents within a tick — and the last
// generation wins, dropping an earlier one-shot decision's tool call. With the
// cap == #agents (all due every tick), admission stops after one pass.
const scheduler = new AgentScheduler({ maxDecisionStartsPerTick: agents.all().length });

// ---- REAL trace-fed agent-ops HUD ------------------------------------------

const hud = new TraceHud(ui, tracer, { scene, title: "AGENT OPS", maxLines: 12, width: 360 });

// ---- the fixed-step pipeline loop ------------------------------------------

const DT_MS = 1000 / 30;
const MAX_TICKS = 300;
const startDist = planarDist(player.eid, npc1.eid);
const distSamples: number[] = [];
let arrivedTick = -1;
let tick = 0;
for (; tick < MAX_TICKS; tick++) {
  perceptionSystem(agents, world, tracer, tick);
  decisionSystem(agents, registry, providers, tracer, tick, scheduler);
  await actionSystem(agents, registry, world, tick, scheduler);
  locomotion.step(world, DT_MS);
  const d = locomotion.distanceToTarget(world, PLAYER);
  if (d !== undefined) distSamples.push(d);
  if (arrivedTick < 0 && locomotion.hasArrived(PLAYER)) arrivedTick = tick;
  ui.update(camera, W, H, DT_MS);
  hud.pump();
  await Promise.resolve(); // pump microtasks so scripted decisions enqueue
  if (tracer.trace(NPC1).some((e) => e.type === "social.said")) break;
}

// =============================================================================
// 1. LOCOMOTION: monotonic approach to EXACT arrival, facing the partner.
// =============================================================================

assert(arrivedTick >= 0, "player never arrived within talkDistance");
const finalDist = planarDist(player.eid, npc1.eid);
assert(finalDist <= TALK + 1e-3, `player did not arrive: finalDist ${finalDist.toFixed(3)} > talk ${TALK}`);
assert(finalDist < startDist - 0.5, `distance did not decrease (${startDist.toFixed(2)} -> ${finalDist.toFixed(2)})`);
assert(distSamples.length > 10, `expected many walk samples, got ${distSamples.length}`);
for (let i = 1; i < distSamples.length; i++) {
  assert(distSamples[i] <= distSamples[i - 1] + 1e-6, `distance increased during approach at step ${i} (${distSamples[i - 1]} -> ${distSamples[i]})`);
}
const fwd = locomotion.facing(PLAYER);
assert(fwd !== undefined, "player has no facing");
const dir = [Position.x[npc1.eid] - Position.x[player.eid], Position.z[npc1.eid] - Position.z[player.eid]];
const dlen = Math.hypot(dir[0], dir[1]) || 1;
const facingDot = (fwd[0] * dir[0] + fwd[2] * dir[1]) / dlen;
assert(facingDot > 0.999, `player not facing npc1 after arrival (dot ${facingDot.toFixed(4)})`);
console.log(`CONVO (1) OK: player walked ${startDist.toFixed(2)} -> ${finalDist.toFixed(2)} (<= talk ${TALK}) over ${distSamples.length} monotonic steps, facing npc1 (dot ${facingDot.toFixed(4)})`);

// =============================================================================
// 2. SOCIAL.SAY: one host-bound social.said per speaker, with the said text.
// =============================================================================

const playerSaid = tracer.trace(PLAYER).filter((e) => e.type === "social.said");
const npcSaid = tracer.trace(NPC1).filter((e) => e.type === "social.said");
assert(playerSaid.length === 1, `expected exactly one player social.said, got ${playerSaid.length}`);
assert(npcSaid.length === 1, `expected exactly one npc1 social.said, got ${npcSaid.length}`);
// Host-bound attribution at BOTH levels: the event envelope actorId AND payload.
assert(playerSaid[0].actorId === PLAYER && field(playerSaid[0].payload, "actorId") === PLAYER, "player social.said not host-bound to the player");
assert(npcSaid[0].actorId === NPC1 && field(npcSaid[0].payload, "actorId") === NPC1, "npc1 social.said not host-bound to npc1");
assert(field(playerSaid[0].payload, "text") === GREETING, "player social.said carried the wrong text");
assert(field(npcSaid[0].payload, "text") === REPLY, "npc1 social.said carried the wrong text");
// Causality: npc1's reply was provoked by the player's real utterance.
console.log("CONVO (2) OK: each social.say emitted one host-bound social.said with the spoken line (npc reply provoked by the player's real utterance)");

// =============================================================================
// 3. REAL SPEECH BUBBLES anchored above each speaking humanoid.
// =============================================================================

const playerBubble = social.bubbleHandle(PLAYER);
const npcBubble = social.bubbleHandle(NPC1);
assert(playerBubble !== undefined && ui.has(playerBubble), "no live speech bubble for the player");
assert(npcBubble !== undefined && ui.has(npcBubble), "no live speech bubble for npc1");
assert(playerBubble !== npcBubble, "both speakers share one bubble (per-speaker bubbles expected)");
ui.update(camera, W, H, DT_MS); // tick anchors so the bubbles place over their speakers
const pbMesh = ui.mesh(playerBubble as string);
const nbMesh = ui.mesh(npcBubble as string);
assert(pbMesh !== undefined && nbMesh !== undefined, "speech-bubble meshes missing");
assert(Math.abs(pbMesh.position.x - Position.x[player.eid]) < 1e-3 && Math.abs(pbMesh.position.z - Position.z[player.eid]) < 1e-3, "player bubble not anchored over the player's humanoid");
assert(pbMesh.position.y > Position.y[player.eid] + 1.5, `player bubble not above the head (y ${pbMesh.position.y})`);
assert(Math.abs(nbMesh.position.x - Position.x[npc1.eid]) < 1e-3 && Math.abs(nbMesh.position.z - Position.z[npc1.eid]) < 1e-3, "npc1 bubble not anchored over npc1's humanoid");
// The bubble is a REAL composited container, not a logged string.
const pbPanel = ui.panel(playerBubble as string);
assert(pbPanel !== undefined && pbPanel.composited.width > 0 && pbPanel.composited.height > 0, "player bubble did not composite a real texture");
console.log("CONVO (3) OK: a real per-speaker speech bubble exists and anchors above each speaking humanoid (composited container, not a string)");

// =============================================================================
// 4. REAL trace-fed HUD: its feed is built from tracer.tail events.
// =============================================================================

assert(ui.has(hud.handle), "HUD panel not live in the UiManager");
const hudPanel = ui.panel(hud.handle);
assert(hudPanel !== undefined && hudPanel.composited.height > 0, "HUD panel did not composite");
assert(hud.lines().length > 0, "HUD consumed no trace events");
assert(hud.has((l) => l.includes("social.said") && l.includes(PLAYER)), "HUD feed missing the player's real social.said");
assert(hud.has((l) => l.includes("social.said") && l.includes(NPC1)), "HUD feed missing npc1's real social.said");
assert(hud.has((l) => l.includes("skill.executed") && l.includes("social.say")), "HUD feed missing a real skill.executed(social.say)");
assert(hud.has((l) => l.includes("skill.executed") && l.includes("social.approach")), "HUD feed missing a real skill.executed(social.approach)");
console.log(`CONVO (4) OK: HUD surfaced ${hud.lines().length} REAL trace lines incl. social.said + skill.executed(social.say/approach) — no canned content`);

// =============================================================================
// 5. PERMISSION GATE: no `social.act` -> social.say denied with ZERO effect.
// =============================================================================

const MUTE = "agt_mute";
const mute = spawnHumanoid(world, { color: 0xc9ced8, position: [-6, 0, -6] });
locomotion.add({ agentId: MUTE, entityId: mute.entityId, eid: mute.eid, humanoid: mute.humanoid }); // bound, so only the GATE can block
const uiSizeBefore = ui.size;
const denied = await registry.invoke("social.say", { text: "I have no permission to speak" }, { agentId: MUTE, sessionId: SESSION, permissions: resolveProfile("player.limited"), tick, world });
assert(!denied.success && denied.error?.code === "forbidden", `social.say not forbidden for player.limited: ${JSON.stringify(denied)}`);
assert(tracer.trace(MUTE).every((e) => e.type !== "social.said"), "denied social.say still emitted social.said");
assert(social.bubbleHandle(MUTE) === undefined, "denied social.say created a speech bubble");
assert(ui.size === uiSizeBefore, `denied social.say changed the UiManager (${ui.size} != ${uiSizeBefore})`);
assert(tracer.trace(MUTE).some((e) => e.type === "security.permission.denied" && field(e.payload, "missing") === "social.act"), "no security.permission.denied(social.act)");
// Falsifiable: the SAME call under social.actor DOES emit + author a bubble.
const allowed = await registry.invoke("social.say", { text: "Now I may speak" }, { agentId: MUTE, sessionId: SESSION, permissions: resolveProfile("social.actor"), tick, world });
assert(allowed.success, `falsifiable: social.actor social.say should succeed: ${JSON.stringify(allowed.error)}`);
const muteBubble = social.bubbleHandle(MUTE);
assert(muteBubble !== undefined && ui.has(muteBubble), "falsifiable: the permitted call did not author the bubble the denied one could not");
console.log("CONVO (5) OK: social.act gate denies social.say with zero effect (no event/bubble) + security.permission.denied; the same call under social.actor succeeds");

// =============================================================================
// 6. HOST-BOUND ATTRIBUTION: a payload-forced actorId is IGNORED.
// =============================================================================

const before = tracer.trace(NPC2).filter((e) => e.type === "social.said").length;
const spoof = await registry.invoke("social.say", { text: "I am totally Birch", actorId: NPC1 }, { agentId: NPC2, sessionId: SESSION, permissions: resolveProfile("social.actor"), tick, world });
assert(spoof.success, `host-bound say failed: ${JSON.stringify(spoof.error)}`);
const npc2Said = tracer.trace(NPC2).filter((e) => e.type === "social.said");
assert(npc2Said.length === before + 1, "spoofed say did not emit under the real (host-bound) speaker");
const spoofEv = npc2Said[npc2Said.length - 1];
assert(spoofEv.actorId === NPC2 && field(spoofEv.payload, "actorId") === NPC2, `payload actorId leaked: envelope=${spoofEv.actorId}, payload=${String(field(spoofEv.payload, "actorId"))}`);
assert(tracer.trace(NPC1).filter((e) => e.type === "social.said").length === 1, "the spoof falsely attributed an utterance to npc1");
const spoofBubble = social.bubbleHandle(NPC2);
assert(spoofBubble !== undefined && ui.has(spoofBubble) && spoofBubble !== social.bubbleHandle(NPC1), "spoofed say did not author npc2's own bubble (host-bound)");
ui.update(camera, W, H, DT_MS);
const sbMesh = ui.mesh(spoofBubble as string);
assert(sbMesh !== undefined && Math.abs(sbMesh.position.x - Position.x[npc2.eid]) < 1e-3 && Math.abs(sbMesh.position.z - Position.z[npc2.eid]) < 1e-3, "spoofed say's bubble did not anchor to the REAL speaker (npc2)");
console.log("CONVO (6) OK: a payload-forced actorId is ignored — the event + bubble bind to ctx.agentId (npc2), never the spoofed npc1");

// =============================================================================
// 7. FALSIFIABILITY: locomotion.step is what causes arrival.
// =============================================================================

const PROBE = "agt_probe";
const probe = spawnHumanoid(world, { color: 0x8a8f99, position: [12, 0, 12] });
locomotion.add({ agentId: PROBE, entityId: probe.entityId, eid: probe.eid, humanoid: probe.humanoid, speed: SPEED, talkDistance: TALK });
locomotion.setTarget(PROBE, { kind: "entity", entity: npc1.entityId });
const probeStart = locomotion.distanceToTarget(world, PROBE);
assert(probeStart !== undefined, "probe has no distance to target");
// WITHOUT a step: no movement, no arrival — the exact assert a skipped step fails.
assert(!locomotion.hasArrived(PROBE) && locomotion.distanceToTarget(world, PROBE) === probeStart, "probe moved/arrived without any locomotion step");
// WITH stepping: it advances and arrives.
let probeArrived = false;
for (let i = 0; i < 600 && !probeArrived; i++) {
  locomotion.step(world, DT_MS);
  probeArrived = locomotion.hasArrived(PROBE);
}
assert(probeArrived, "probe never arrived even after stepping");
const probeEnd = locomotion.distanceToTarget(world, PROBE);
assert(probeEnd !== undefined && probeEnd < probeStart, `probe distance did not shrink after stepping (${probeStart} -> ${String(probeEnd)})`);
console.log(`CONVO (7) OK: locomotion is load-bearing — probe stayed at ${probeStart.toFixed(2)} with no step, arrived (${probeEnd?.toFixed(2)}) only after stepping`);

// =============================================================================
// 8. FRAMING PHASE: a deterministic camera-settle window BEFORE the first line.
//    On arrival the ConversationDirector enters `framing` and waits K frames
//    before ANY social.say / LLM call, so the demo camera glides into the side
//    two-shot with nothing pending; only after framing does the first say fire.
//    Frame-driven: a counter, no awaits in the per-frame path. Falsifiable:
//    expecting a say DURING framing fails the asserts below.
// =============================================================================

const FR_PLAYER = "agt_walker2";
const FR_NPC = "agt_oak";
const fwalker = spawnHumanoid(world, { color: 0x77aaff, position: [0, 0, -10] });
const foak = spawnHumanoid(world, { color: 0xb08a55, position: [3.2, 0, -10] });
locomotion.add({ agentId: FR_PLAYER, entityId: fwalker.entityId, eid: fwalker.eid, humanoid: fwalker.humanoid, speed: SPEED, talkDistance: TALK });
locomotion.add({ agentId: FR_NPC, entityId: foak.entityId, eid: foak.eid, humanoid: foak.humanoid, speed: SPEED, talkDistance: TALK });

const FR_K = 48;
let chatCalls = 0;
// Deterministic stub for the director's chat seam — never touches the network.
const fakeChat: ChatClient = {
  chat: (_msgs: ChatMessage[]): Promise<ChatTurnResult> => {
    chatCalls++;
    return Promise.resolve({ content: "Hail, traveler.", latencyMs: 1, evalCount: 3, promptEvalCount: 5 });
  },
};
const frDirector = new ConversationDirector({
  registry, world, tracer, locomotion,
  chat: fakeChat,
  model: "test-model",
  sessionId: SESSION,
  player: { agentId: FR_PLAYER, name: "Walker", voice: "a traveler" },
  npcs: [{ agentId: FR_NPC, name: "Oak", voice: "an old oak" }],
  linesPerExchange: 2,
  holdFrames: 4,
  beatFrames: 4,
  arrivalFrames: 4000,
  framingFrames: FR_K,
});
const frSaid = (): number =>
  tracer.trace(FR_PLAYER).filter((e) => e.type === "social.said").length +
  tracer.trace(FR_NPC).filter((e) => e.type === "social.said").length;

// Drive the director (step locomotion THEN tick, as the host does) until it
// reaches `framing` on arrival. No say must have fired during the walk-up.
let frTick = 0;
for (; frTick < 4000; frTick++) {
  locomotion.step(world, DT_MS);
  frDirector.tick();
  await Promise.resolve(); // flush the detached social.approach microtask
  if (frDirector.framing) break;
}
assert(frDirector.framing, "(8) director never reached the framing phase after arrival");
assert(frSaid() === 0, "(8) a social.said fired before/at the start of framing");
// The partner CHOICE fires exactly ONE detached chat during `choosing`, BEFORE
// approaching/framing; assert that and the emitted conversation.choose (the sole
// NPC pool means the choice resolves to Oak — proving choosing runs first).
const chatAtFraming = chatCalls;
assert(chatAtFraming === 1, `(8) expected exactly the partner-choice chat before framing, got ${chatAtFraming}`);
const chose8 = tracer.trace(FR_PLAYER).filter((e) => e.type === "conversation.choose");
assert(chose8.length === 1 && field(chose8[0].payload, "who") === FR_NPC, "(8) the choosing phase did not emit conversation.choose for the sole NPC before framing");
// Framing counts as in-conversation + exposes the partner so the camera frames it.
assert(frDirector.inConversation, "(8) framing should report inConversation (camera frames the two-shot)");
assert(frDirector.activePartnerAgentId === FR_NPC, "(8) framing did not expose the active partner");

// Tick THROUGH the rest of the framing window: still framing, still SILENT, no LLM.
let framingFrames = 1;
while (frDirector.framing) {
  locomotion.step(world, DT_MS);
  frDirector.tick();
  await Promise.resolve();
  framingFrames++;
  if (frDirector.framing) {
    assert(frSaid() === 0, `(8) social.said fired DURING framing (frame ${framingFrames})`);
    assert(chatCalls === chatAtFraming, `(8) the LLM chat fired DURING framing (frame ${framingFrames})`);
  }
}
assert(framingFrames >= FR_K, `(8) framing lasted only ${framingFrames} frames, expected >= ${FR_K}`);

// Framing complete -> the first LLM call fires, then the first line is spoken.
let firstSaidFrame = -1;
for (let i = 0; i < 40 && firstSaidFrame < 0; i++) {
  locomotion.step(world, DT_MS);
  frDirector.tick();
  await Promise.resolve();
  if (frSaid() > 0) firstSaidFrame = i;
}
assert(chatCalls > chatAtFraming, "(8) the dialogue LLM chat never fired after framing completed");
assert(firstSaidFrame >= 0, "(8) no social.said after framing completed (first line never fired)");
console.log(`CONVO (8) OK: choosing fired 1 chat before framing; framing then held ${framingFrames} frames (>= ${FR_K}) with ZERO say/LLM; the first line fired only after framing (chat calls ${chatCalls})`);

// =============================================================================
// 9. LLM-DRIVEN PARTNER CHOICE: the player picks WHOM to approach through the
//    chat seam, NOT the pool order. Two stubs prove the choice is the LLM's: a
//    stub returning "Willow" (NOT first in the pool [Birch, Willow]) makes the
//    FIRST `choosing` pick Willow + approach Willow + emit conversation.choose
//    {who:willow}; a stub returning "Birch" picks Birch. Falsifiable: a
//    hardcoded-order director would ALWAYS pick Birch first, failing the Willow
//    case.
// =============================================================================

let pcSpawnZ = 40;
async function pickFirst(tag: string, reply: string): Promise<{ who: string; matched: boolean; approachTarget: string; birch: string; willow: string; calls: number }> {
  const P = `agt_pc_player_${tag}`;
  const B = `agt_pc_birch_${tag}`;
  const Wl = `agt_pc_willow_${tag}`;
  const z = pcSpawnZ;
  pcSpawnZ += 8;
  const ph = spawnHumanoid(world, { color: 0x6db1ff, position: [0, 0, z] });
  const bh = spawnHumanoid(world, { color: 0x9be37d, position: [4, 0, z] });
  const wh = spawnHumanoid(world, { color: 0x8fd6c0, position: [-4, 0, z] });
  locomotion.add({ agentId: P, entityId: ph.entityId, eid: ph.eid, humanoid: ph.humanoid, speed: SPEED, talkDistance: TALK });
  locomotion.add({ agentId: B, entityId: bh.entityId, eid: bh.eid, humanoid: bh.humanoid, speed: SPEED, talkDistance: TALK });
  locomotion.add({ agentId: Wl, entityId: wh.entityId, eid: wh.eid, humanoid: wh.humanoid, speed: SPEED, talkDistance: TALK });
  let calls = 0;
  const stub: ChatClient = {
    chat: (_m: ChatMessage[]): Promise<ChatTurnResult> => {
      calls++;
      return Promise.resolve({ content: reply, latencyMs: 1, evalCount: 1, promptEvalCount: 1 });
    },
  };
  const d = new ConversationDirector({
    registry, world, tracer, locomotion, chat: stub, model: "test-model", sessionId: SESSION,
    player: { agentId: P, name: "Wanderer", voice: "a plain-spoken wanderer" },
    npcs: [
      { agentId: B, name: "Birch", voice: "a gruff forest warden" },
      { agentId: Wl, name: "Willow", voice: "a dreamy river-spirit" },
    ],
    linesPerExchange: 2, holdFrames: 2, beatFrames: 2, framingFrames: 2, arrivalFrames: 4000,
  });
  // Drive ticks until the FIRST conversation.choose fires (init -> choosing ->
  // detached chat -> pickup). No locomotion step needed: choosing precedes the walk.
  for (let i = 0; i < 80 && tracer.trace(P).filter((e) => e.type === "conversation.choose").length === 0; i++) {
    d.tick();
    await Promise.resolve();
  }
  const chose = tracer.trace(P).filter((e) => e.type === "conversation.choose");
  assert(chose.length >= 1, `(9/${tag}) choosing never emitted conversation.choose`);
  // conversation.approach is emitted synchronously in the SAME tick as the choice.
  const approached = tracer.trace(P).filter((e) => e.type === "conversation.approach");
  assert(approached.length >= 1, `(9/${tag}) the director never approached after choosing`);
  return {
    who: String(field(chose[0].payload, "who")),
    matched: field(chose[0].payload, "matched") === true,
    approachTarget: String(field(approached[0].payload, "target")),
    birch: B, willow: Wl, calls,
  };
}

const pickW = await pickFirst("W", "Willow");
assert(pickW.who === pickW.willow, `(9) stub 'Willow' did not pick Willow (got ${pickW.who})`);
assert(pickW.who !== pickW.birch, "(9) stub 'Willow' picked the pool's FIRST entry (Birch) — the choice is hardcoded order, not the LLM's");
assert(pickW.matched, "(9) stub 'Willow' should be a real name MATCH, not a fallback");
assert(pickW.approachTarget === pickW.willow, `(9) approached ${pickW.approachTarget}, not the chosen Willow`);
assert(pickW.calls >= 1, "(9) the choice did not go through the chat seam");

const pickB = await pickFirst("B", "Birch");
assert(pickB.who === pickB.birch, `(9) stub 'Birch' did not pick Birch (got ${pickB.who})`);
assert(pickB.matched, "(9) stub 'Birch' should be a real name MATCH");
assert(pickB.approachTarget === pickB.birch, `(9) approached ${pickB.approachTarget}, not the chosen Birch`);
console.log("CONVO (9) OK: the player LLM-CHOOSES whom to approach via the chat seam — stub 'Willow' -> Willow (NOT the pool-first Birch); stub 'Birch' -> Birch; both real name-matches, each approached the CHOSEN npc (conversation.choose traced)");

// =============================================================================
// 10. REVEAL-GATED HOLD: a spoken line must FULLY type out before the reply. The
//     director's `holding` phase waits until the speaker's bubble reports
//     fully-revealed, THEN counts holdFrames, THEN advances. With a LONG line +
//     the bubble's cps, the reveal OUTLASTS holdFrames, so the director MUST stay
//     in `holding` (no reply, no next chat) until reveal completes; only then
//     does it apply the readable hold and advance. Falsifiable: advancing at
//     holdFrames (the old bug) leaves holding before reveal -> the asserts fail.
// =============================================================================

const RG_PLAYER = "agt_rg_walker";
const RG_NPC = "agt_rg_elm";
const rgw = spawnHumanoid(world, { color: 0x77aaff, position: [0, 0, 70] });
const rge = spawnHumanoid(world, { color: 0x6f9f6a, position: [2.0, 0, 70] }); // close -> quick arrival
locomotion.add({ agentId: RG_PLAYER, entityId: rgw.entityId, eid: rgw.eid, humanoid: rgw.humanoid, speed: SPEED, talkDistance: TALK });
locomotion.add({ agentId: RG_NPC, entityId: rge.entityId, eid: rge.eid, humanoid: rge.humanoid, speed: SPEED, talkDistance: TALK });

// A long line whose typewriter reveal (bubble cps 42) far outlasts holdFrames;
// contains no "elm" substring so the single-NPC choice resolves by fallback.
const RG_LINE = "Greetings, friend; the wind carries a hush across the water tonight, and the long shadows stretch slow and quiet beneath the old trees.";
const RG_HOLD = 3;
let rgChatCalls = 0;
const rgChat: ChatClient = {
  chat: (_m: ChatMessage[]): Promise<ChatTurnResult> => {
    rgChatCalls++;
    return Promise.resolve({ content: RG_LINE, latencyMs: 1, evalCount: 1, promptEvalCount: 1 });
  },
};
const rgDirector = new ConversationDirector({
  registry, world, tracer, locomotion, chat: rgChat, model: "test-model", sessionId: SESSION,
  player: { agentId: RG_PLAYER, name: "Walker", voice: "a quiet walker" },
  npcs: [{ agentId: RG_NPC, name: "Elm", voice: "a still old elm" }],
  linesPerExchange: 4, holdFrames: RG_HOLD, beatFrames: 2, framingFrames: 2, arrivalFrames: 4000,
  bubbleRevealed: (id) => social.revealed(id), // gate the hold on the bubble's reveal
});
const rgSaid = (id: string): number => tracer.trace(id).filter((e) => e.type === "social.said").length;

// Drive (step -> tick -> flush -> ui.update) until the player speaks the first line.
for (let rgF = 0; rgF < 4000 && rgSaid(RG_PLAYER) < 1; rgF++) {
  locomotion.step(world, DT_MS);
  rgDirector.tick();
  await Promise.resolve();
  ui.update(camera, W, H, DT_MS); // advance the bubble typewriter (the host's render tick)
}
assert(rgSaid(RG_PLAYER) === 1, "(10) player never spoke the first line");
assert(rgDirector.holding, "(10) director not in holding after the first line");
assert(social.revealed(RG_PLAYER) === false, "(10) the line revealed within ONE frame — line too short / cps too fast; gate not exercised");

// The GATE: drive frames. While the bubble is still revealing the director MUST
// stay in holding (no reply, no next chat), EVEN past holdFrames; only after the
// bubble reports fully-revealed does it arm the hold and advance.
const rgChatAtHold = rgChatCalls;
let holdingFramesBeforeReveal = 0;
let revealedFrame = -1;
let leftHoldingFrame = -1;
for (let i = 0; i < 6000; i++) {
  if (revealedFrame < 0 && social.revealed(RG_PLAYER) === true) revealedFrame = i;
  if (revealedFrame < 0) {
    holdingFramesBeforeReveal++;
    assert(rgDirector.holding, `(10) director LEFT holding before the line fully revealed (frame ${i}) — the line was cut off`);
    assert(rgSaid(RG_NPC) === 0, `(10) the reply fired before the first line fully revealed (frame ${i})`);
    assert(rgChatCalls === rgChatAtHold, `(10) the next-turn chat fired before the line fully revealed (frame ${i})`);
  }
  locomotion.step(world, DT_MS);
  rgDirector.tick();
  await Promise.resolve();
  ui.update(camera, W, H, DT_MS);
  if (revealedFrame >= 0 && !rgDirector.holding) { leftHoldingFrame = i; break; }
}
assert(revealedFrame >= 0, "(10) the long line never fully revealed");
assert(holdingFramesBeforeReveal > RG_HOLD, `(10) gate not exercised: only ${holdingFramesBeforeReveal} holding frames before reveal (<= holdFrames ${RG_HOLD}) — reveal must OUTLAST the hold`);
assert(leftHoldingFrame >= 0, "(10) director never advanced after reveal + hold");
assert(leftHoldingFrame > revealedFrame, "(10) director advanced at the very frame it revealed (the readable hold was not applied after reveal)");
console.log(`CONVO (10) OK: holding gated on reveal — stayed ${holdingFramesBeforeReveal} frames (>> holdFrames ${RG_HOLD}) until the long line fully typed, then advanced ${leftHoldingFrame - revealedFrame} frames after reveal (the line is never cut off)`);

console.log("P5 CONVO OK: approach -> walk -> arrive+face -> say -> real bubble -> reply -> real traced events in a real HUD; permission-gated + host-bound + falsifiable; deterministic FRAMING delay before the first line");
ops.op_log("p5_conversation OK: deterministic embodied-conversation pipeline (humanoids + locomotion + social.* + trace HUD)");
