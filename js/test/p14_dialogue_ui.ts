// Phase 14 — dialogue → UI bridge: DialogueRuntime renders an active dialogue and the
// player drives it by choice INDEX. Pins the invariants the bridge MUST honour:
//   1. STATE vs RENDER SPLIT: open/choose/advance drive the RECORDED dialogue.* skills
//      for STATE; the UiManager is driven DIRECTLY for RENDER. The recorded surface is
//      EXACTLY dialogue.start/choose/end (never dialogue.get, never ui.*).
//   2. open() renders the start node: a speechBubble with the node's text + a HUD choices
//      panel with the node's choices as NUMBERED lines.
//   3. choose(i) advances the DialogueManager session AND re-renders to the new node.
//   4. A terminal node + advance() fires dialogue.end and close() removes all panels.
//   5. An out-of-range choose(99) is a clean no-op (no advance, no throw).
//   6. REPLAY-EQUIVALENCE: record open→choose→choose with WorldRecorder, snapshot the
//      DialogueManager session, replay the recorded commands into a FRESH core, snapshot
//      again — assert BIT-IDENTICAL (proves the recorded surface is exactly dialogue.*
//      and replays deterministically). Then advance()→end is recorded + replays too.
//
// Run: limina js/test/p14_dialogue_ui.ts   (exit 0 = pass)

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld, spawnRenderable } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type InvokeBase, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills, type CoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { replayCommands } from "../src/worldlog/replay.ts";
import { DialogueRuntime } from "../src/world/dialogue_runtime.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p14_dialogue_ui FAIL: " + msg);
}
function ok(res: MCPResponse): Record<string, unknown> {
  if (!res.success) throw new Error("call failed: " + JSON.stringify(res.error));
  return res.result as Record<string, unknown>;
}

// A scene stub that RECORDS the meshes added/removed, so UI panels can be inspected (and
// we can prove close() detaches them). Mirrors the p12 stub plus add/remove accounting.
function makeWorld(): { world: WorldContext; added: Set<unknown> } {
  const added = new Set<unknown>();
  const scene = {
    add(o: unknown) { added.add(o); },
    remove(o: unknown) { added.delete(o); },
    position: { set() {}, x: 0, y: 0, z: 0 },
    background: null as unknown,
  };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  const ecs = createEcsWorld();
  const world: WorldContext = {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: scene as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops, mode: "headless",
  };
  return { world, added };
}

const PERMS = resolveProfile("builder.readWrite");
const LISTENER = "player";
const TREE = "guard_gate";

// A 3-node BRANCHING tree: n1 branches (2 choices); n2 funnels to the terminal n3.
// open → n1 ; choose(0) → n2 ; choose(0) → n3 (terminal) ; advance → end.
const TREE_DEF = {
  id: TREE, name: "Guard Gate", startNode: "n1",
  nodes: [
    { id: "n1", text: "Halt! Who goes there?", speaker: "guard", mood: "stern",
      choices: [{ text: "A friend.", nextNodeId: "n2" }, { text: "None of your business.", nextNodeId: "n3" }] },
    { id: "n2", text: "A friend, you say. Will you vouch for the realm?", speaker: "guard",
      choices: [{ text: "On my honor.", nextNodeId: "n3" }, { text: "I vouch for no one.", nextNodeId: "n3" }] },
    { id: "n3", text: "Then we are done here.", speaker: "guard", choices: [] },
  ],
};

// Build a core + a real speaker entity (the bubble anchors to it). Returns the runtime,
// the core (for manager inspection), the world (for scene-add inspection) and the
// speaker entity id.
function buildScene(reg: SkillRegistry): { core: CoreSkills; runtime: DialogueRuntime; speaker: string; world: WorldContext; base: InvokeBase; added: Set<unknown> } {
  const core = registerCoreSkills(reg);
  const { world, added } = makeWorld();
  const eid = spawnRenderable(world.ecs, { position: { set() {} } } as never, 1, 0, 2);
  const speaker = world.entities.create({ eid, mesh: {} as never });
  const base: InvokeBase = { agentId: "agt", sessionId: "ses_p14", permissions: PERMS, tick: 100, world };
  const runtime = new DialogueRuntime({ registry: reg, base, uiManager: core.ui, world });
  return { core, runtime, speaker, world, base, added };
}

/** The numbered lines we EXPECT for a node's choices (independent of the runtime). */
function expectedNumbered(choices: { text: string }[]): string[] {
  return choices.map((c, i) => `${i + 1}) ${c.text}`);
}

// Read the live session's current node text straight from the DialogueManager (an
// INDEPENDENT source of truth from the runtime's own tracking).
function sessionNodeText(core: CoreSkills, speaker: string): string | undefined {
  const dm = core.behavior.dialogueManager;
  const session = dm.getCurrentSession(speaker, LISTENER);
  if (session === undefined) return undefined;
  return dm.getTree(session.treeId)?.nodes.get(session.currentNodeId)?.text;
}

// ── AUTHORING (recorded) ─────────────────────────────────────────────────────────────────
const recorder = new WorldRecorder("ses_p14");
const recReg = new SkillRegistry(new LiminaTracer("ses_p14"));
const { core, runtime, speaker, base, added } = buildScene(recReg);
recorder.attach(recReg);

// Define the tree (recorded; replays to rebuild the tree in a fresh core).
ok(await recReg.invoke("dialogue.define", TREE_DEF, { ...base, tick: 99 }));

const dm = core.behavior.dialogueManager;

// (2) open() → start node rendered as a speechBubble (text) + choices panel (numbered).
const uiBefore = core.ui.size;
await runtime.open(speaker, LISTENER, TREE);
assert(runtime.isActive(), "runtime not active after open()");
assert(core.ui.size === uiBefore + 2, `open() should create EXACTLY 2 panels (bubble + choices); size went ${uiBefore}→${core.ui.size}`);

const n1 = TREE_DEF.nodes[0];
assert(runtime.currentText() === n1.text, `speech text mismatch after open: got "${runtime.currentText()}"`);
// Independent check: the manager session sits on the start node n1.
assert(sessionNodeText(core, speaker) === n1.text, "DialogueManager session not on the start node after open()");
// Choices panel: the rendered lines are the node's choices, NUMBERED.
assert(JSON.stringify(runtime.choiceLines()) === JSON.stringify(expectedNumbered(n1.choices)),
  `choices panel lines not numbered choices: got ${JSON.stringify(runtime.choiceLines())}`);
// Both panels are live handles AND their meshes were added to the scene.
const sH = runtime.speechBubbleHandle, cH = runtime.choicesPanelHandle;
assert(sH !== undefined && cH !== undefined && core.ui.has(sH) && core.ui.has(cH), "open() did not register both panel handles");
assert(added.has(core.ui.mesh(sH)) && added.has(core.ui.mesh(cH)), "open() panels were not added to the scene");

// (5) out-of-range choose(99): clean no-op (no advance, no throw), still on n1.
const noop = await runtime.choose(99);
assert(noop === false, "choose(99) should return false (no advance)");
assert(sessionNodeText(core, speaker) === n1.text, "choose(99) wrongly advanced the session");
assert(core.ui.size === uiBefore + 2, "choose(99) changed the panel set");

// (3) choose(0): advances n1 → n2, re-renders the new node + its choices.
const adv1 = await runtime.choose(0);
assert(adv1 === true, "choose(0) should advance");
const session1 = dm.getCurrentSession(speaker, LISTENER);
assert(session1?.currentNodeId === "n2", `choose(0) did not advance the session to n2: ${session1?.currentNodeId}`);
assert(session1.history.length === 1 && session1.history[0].nodeId === "n1" && session1.history[0].choiceIndex === 0,
  "session history did not record the n1 choice");
const n2 = TREE_DEF.nodes[1];
assert(runtime.currentText() === n2.text, `speech text not updated to n2: "${runtime.currentText()}"`);
assert(JSON.stringify(runtime.choiceLines()) === JSON.stringify(expectedNumbered(n2.choices)), "choices panel not updated to n2's choices");
// Same handles re-used (updated in place, not recreated).
assert(runtime.speechBubbleHandle === sH && runtime.choicesPanelHandle === cH, "choose() leaked/recreated panel handles");

// ── REPLAY-EQUIVALENCE (teeth): snapshot the LIVE session after choose→choose ─────────────
// choose(0) again: advances n2 → n3 (terminal). The recorded stream so far is exactly
// dialogue.define + dialogue.start + dialogue.choose + dialogue.choose.
const adv2 = await runtime.choose(0);
assert(adv2 === true, "second choose(0) should advance");
const n3 = TREE_DEF.nodes[2];
assert(runtime.isTerminal(), "n3 should be terminal (no choices)");
assert(runtime.currentText() === n3.text, "speech text not updated to terminal n3");
// Terminal node renders the line + a continue prompt (no numbered choices).
assert(runtime.choiceLines().length === 1 && runtime.currentChoices().length === 0,
  `terminal node should show a single continue prompt + no choices: ${JSON.stringify(runtime.choiceLines())}`);

// Only dialogue.* skills were recorded — prove it (no ui.* / dialogue.get crept in).
const recordedTools = recorder.commands.filter((c) => c.kind === "skill").map((c) => (c as { tool: string }).tool);
assert(recordedTools.every((t) => t.startsWith("dialogue.")), `non-dialogue skill recorded (UI/read leaked into the log): ${recordedTools.join(",")}`);
assert(recordedTools.filter((t) => t === "dialogue.start").length === 1, "expected exactly one dialogue.start recorded");
assert(recordedTools.filter((t) => t === "dialogue.choose").length === 2, "expected exactly two dialogue.choose recorded");

function snapshotSession(c: CoreSkills): string {
  const m = c.behavior.dialogueManager;
  const s = m.getCurrentSession(speaker, LISTENER);
  return JSON.stringify(s ?? null);
}
const authState = snapshotSession(core);
assert(authState !== JSON.stringify(null), "auth session should be live before replay snapshot");

let replayCore: CoreSkills | undefined;
await replayCommands(recorder.commands, {
  makeWorld: () => makeWorld().world,
  makeRegistry: (tr) => {
    const r = new SkillRegistry(tr as LiminaTracer);
    replayCore = registerCoreSkills(r);
    return r;
  },
  tracer: new LiminaTracer("ses_p14_replay"),
});
assert(replayCore !== undefined, "replay did not construct a core");
const replayState = snapshotSession(replayCore);
assert(replayState === authState,
  "replay recomputed DIFFERENT dialogue session than authoring\n  auth  : " + authState + "\n  replay: " + replayState);

// ── (4) terminal advance() → dialogue.end fired + close() removed all panels ───────────────
const beforeEnd = core.ui.size;
const ended = await runtime.advance();
assert(ended === true, "advance() on a terminal node should end + close");
assert(dm.getCurrentSession(speaker, LISTENER) === undefined, "advance() did not fire dialogue.end (session still live)");
assert(!runtime.isActive(), "runtime still active after advance()");
assert(core.ui.size === beforeEnd - 2, `close() should remove BOTH panels; size ${beforeEnd}→${core.ui.size}`);
assert(runtime.speechBubbleHandle === undefined && runtime.choicesPanelHandle === undefined, "panel handles not cleared after close()");
assert(!core.ui.has(sH) && !core.ui.has(cH), "panel handles still live in the UiManager after close()");
assert(!added.has(core.ui.mesh(sH ?? "")) && added.size === 0, "panel meshes not detached from the scene after close()");

// dialogue.end is now in the recorded stream; replaying the FULL stream into a fresh core
// reproduces the ended (deleted) session — confirming end is part of the recorded surface.
let replayCore2: CoreSkills | undefined;
await replayCommands(recorder.commands, {
  makeWorld: () => makeWorld().world,
  makeRegistry: (tr) => {
    const r = new SkillRegistry(tr as LiminaTracer);
    replayCore2 = registerCoreSkills(r);
    return r;
  },
  tracer: new LiminaTracer("ses_p14_replay2"),
});
assert(replayCore2 !== undefined && replayCore2.behavior.dialogueManager.getCurrentSession(speaker, LISTENER) === undefined,
  "replaying the full stream (with dialogue.end) did not reproduce the ended session");

// A choose() after close() is a clean no-op (not active).
assert((await runtime.choose(0)) === false, "choose() after close() should be a no-op");

ops.op_log(
  `p14_dialogue_ui OK: DialogueRuntime bridges dialogue.* (STATE, recorded: start/choose/end only — no ui.*/dialogue.get in the log) to the UiManager (RENDER, direct). ` +
  `open() renders the start node as a speechBubble + a NUMBERED choices HUD panel anchored to the speaker entity; choose(i) advances n1→n2→n3 and re-renders in place; ` +
  `a terminal node shows a continue prompt; advance() fires dialogue.end and close() removes both panels (UiManager + scene). ` +
  `out-of-range choose(99) is a clean no-op. Record open→choose→choose→end + replay into a fresh core recomputes BIT-IDENTICAL session state.`,
);
