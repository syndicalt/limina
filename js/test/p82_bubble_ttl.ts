// Phase 8x — SPEECH-BUBBLE TTL (auto-expire without a ConversationDirector).
//
// The NPC demo (settlement_npcs) has no ConversationDirector, so nothing used to
// dismiss the bubble `social.say` creates — it persisted forever above every NPC's
// head. The fix gives every bubble a default auto-expiring TTL (UiManager ticks it
// from ui.update's dtMs). This gate proves, headlessly, that:
//
//   1. A bubble from social.say is REMOVED from the UiManager after its readable TTL
//      elapses (drive ui.update forward N frames → the live-bubble count returns to 0,
//      and social.revealed() reports no bubble).
//   2. The TTL is FROZEN while the line is still typing (a LONG line is never cut off:
//      it outlives the raw TTL because the countdown only runs once fully revealed).
//   3. Speaking again REFRESHES the window (an actively-talking NPC keeps its bubble)
//      rather than expiring or stacking a second bubble.
//   4. It is RENDER-ONLY: social.say still emits the recorded `social.said` event; the
//      bubble lives only in the UiManager (never the ECS / world-log), so determinism
//      (p81) is untouched. This gate never touches the recorder/world state.
//
// Run (headless): ./target/release/limina js/test/p82_bubble_ttl.ts

import * as THREE from "../build/three.bundle.mjs";
import { type SceneLike } from "../src/engine.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { createHeadlessContext } from "../src/game/context.ts";
import { spawnHumanoid } from "../src/world/humanoid.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("P82 FAIL: " + message);
}

const SESSION = "ses_p82_bubble_ttl";
const NPC = "agt_npc_ttl";
const W = 960, H = 640, DT_MS = 1000 / 30;

// Headless scene that tracks its children (so we can count live bubble meshes too).
const sceneChildren: unknown[] = [];
const scene: SceneLike = {
  add(c: unknown) { sceneChildren.push(c); },
  remove(c: unknown) { const i = sceneChildren.indexOf(c); if (i >= 0) sceneChildren.splice(i, 1); },
  position: { set() {}, x: 0, y: 0, z: 0 },
  background: null as unknown,
};
const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 200);

const ctx = createHeadlessContext({ session: SESSION, scene, camera });
const world = ctx.world;
const registry = ctx.registry;
const tracer = ctx.tracer;
const { ui, locomotion, social } = ctx.core;

// Bind one NPC to a humanoid so social.say can resolve its speaker → entity.
const npc = spawnHumanoid(world, { color: 0x9be37d, position: [0, 0, 0] });
locomotion.add({ agentId: NPC, entityId: npc.entityId, eid: npc.eid, humanoid: npc.humanoid, speed: 2, talkDistance: 2 });

const ACTOR = { agentId: NPC, sessionId: SESSION, permissions: resolveProfile("social.actor"), tick: 0, world };

const tick = (n: number): void => { for (let i = 0; i < n; i++) ui.update(camera, W, H, DT_MS); };
const liveBubble = (): boolean => {
  const h = social.bubbleHandle(NPC);
  return h !== undefined && ui.has(h);
};
const say = async (text: string): Promise<void> => {
  const res = await registry.invoke("social.say", { text }, ACTOR);
  assert(res.success, `social.say failed: ${JSON.stringify((res as { error?: unknown }).error)}`);
};

// ── 1. A short line: bubble appears, then auto-expires after reveal + TTL ──────
await say("Hi, neighbor.");
assert(liveBubble(), "(1) social.say did not author a live bubble");
const saidEvents = tracer.trace(NPC).filter((e) => e.type === "social.said").length;
assert(saidEvents === 1, "(1) social.say must still emit the recorded social.said event (render-only bubble)");

// Still present partway through the readable window (short line reveals in ~9 frames,
// TTL 3500ms ≈ 105 frames after that): at 60 frames (~2000ms) it must still be up.
tick(60);
assert(liveBubble(), "(1) bubble expired DURING its readable window — TTL too short / not frozen through reveal");

// Well past reveal + TTL (140 total frames ≈ 4666ms > ~285ms reveal + 3500ms TTL): gone.
tick(90);
assert(!liveBubble(), "(1) bubble was NOT auto-dismissed after its TTL — the never-clears bug is back");
assert(social.revealed(NPC) === true, "(1) a dismissed bubble must report revealed (no live bubble to wait on)");

// ── 2. A LONG line is never cut off: the TTL is frozen while it types ──────────
// 220 chars at cps 42 ≈ 5240ms reveal (≈ 157 frames) — LONGER than the 3500ms TTL. If
// the TTL were not frozen during reveal, the bubble would vanish mid-sentence.
const longLine = "So ".repeat(70).trim() + "."; // ~210 chars
await say(longLine);
assert(liveBubble(), "(2) long-line bubble was not created");
tick(120); // ≈ 4000ms > TTL 3500ms, but the line is STILL typing → frozen, must persist
assert(liveBubble(), "(2) long line was CUT OFF — TTL drained while the bubble was still revealing");
assert(social.revealed(NPC) === false, "(2) the long line should not be fully revealed yet (gate not exercised)");
tick(260); // finish revealing (~157f) then drain the 3500ms TTL (~105f) → gone
assert(!liveBubble(), "(2) long-line bubble never expired after it finished revealing");

// ── 3. Speaking again REFRESHES the window (no stacking, no premature expiry) ──
await say("First line.");
assert(liveBubble(), "(3) bubble not created for refresh test");
const handleA = social.bubbleHandle(NPC);
tick(90); // ~3000ms — inside the window, about to expire
assert(liveBubble(), "(3) bubble expired before the refresh");
await say("Second line, still talking."); // same speaker → refresh, not a new stacked bubble
assert(social.bubbleHandle(NPC) === handleA, "(3) a second say from the same speaker stacked a NEW bubble instead of reusing/refreshing");
tick(90); // another ~3000ms: without the refresh the original would already be gone
assert(liveBubble(), "(3) refresh did not extend the bubble's life — an actively-talking NPC lost its bubble");
// And it still eventually clears once the NPC goes quiet.
tick(220);
assert(!liveBubble(), "(3) bubble never cleared after the NPC stopped talking");

console.log("P82 OK: speech bubbles auto-expire after a readable TTL (frozen through reveal, refreshed on re-say), render-only — no ConversationDirector needed, determinism untouched.");
ctx.core; // touch to keep the context alive for teardown symmetry
