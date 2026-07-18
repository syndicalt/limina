// p107 — EDITOR SESSION FAST-BOOT: snapshot + bounded tail (headless, REAL
// sockets, falsifiable).
//
// THE PROBLEM THIS GATE PINS: the editor viewport boots by re-authoring the
// session's ENTIRE recorded authoring stream (worldlog.tail from 0). A long
// session (the user's real one: 7,327 commands) re-invokes every command in
// both browser realms at connect and hangs the browser. The engine already has
// self-sufficient v3 snapshots + recoverWorld (p4/p57/p104); what was missing
// is the EDITOR PATH: a host endpoint serving {snapshot, resume cursor} and a
// viewer boot that restores the snapshot and replays only the bounded tail.
//
// THE PATH UNDER TEST:
//   host  — worldlog.snapshotBoot (js/src/skills/worldlog.ts): a v3 snapshot
//           (entities + managers + physics) + the cursor to resume the stream
//           from, with an ELIGIBILITY verdict (sessions authoring state a
//           snapshot cannot carry answer eligible:false and keep full replay).
//   viewer — snapshotBootProgram + finalizeSnapshotBoot (browser/snapshot-boot.ts):
//           author the deterministic boot program (bootstrap ops + each live
//           entity's origin command), verify allocation parity, install BOTH
//           RNG streams, overwrite transforms/tags/first-class state, re-pose
//           bodies, restore manager state via the participant registry, then
//           apply the tail. This gate drives that EXACT procedure headless
//           (native ops in place of wasm Rapier — same code path).
//
// PROOF SHAPE:
//   1. REAL host: AuthoritativeServer on a self-bound localhost WS listener with
//      registerWorldlogSkills({snapshotBoot}) — the editor_host wiring. A
//      builder.readWrite NetClient authors 50+ commands over the wire: entities
//      with tags/material/behavior + moves, and manager state (inventory, a
//      quest mid-progress, an interaction door OPENED, game flags).
//   2. worldlog.snapshotBoot over the wire → eligible, snapshot parses, cursor
//      at the committed count. Then 6 more commands are authored (the TAIL,
//      fetched via worldlog.tail from the returned cursor).
//   3. Boot A (fast path, exactly as the viewport): program → finalize → tail.
//      Boot B (the current full-replay path): worldlog.tail from 0, re-author
//      everything. captureWorldState(A) must be BIT-IDENTICAL to B, and boot
//      A's participant captures BIT-IDENTICAL to the LIVE SERVER's (full
//      replay cannot even reproduce tick-stamped manager state — the snapshot
//      path must).
//   4. RNG: after boot A, both installed streams sit at the snapshot's exact
//      states (no tail draws) — the mid-stream resume the tail depends on.
//   5. FALSIFIABILITY (in code):
//      (a) stripping a manager from the snapshot → boot's participant capture
//          DIVERGES from the server's (the comparison catches the drop);
//      (b) tampering a snapshot entity's material → captureWorldState diverges;
//      (c) tampering a snapshot entity's eid → finalizeSnapshotBoot THROWS
//          (allocation-parity verification is load-bearing);
//      (d) authoring a non-carried command (three.addLight) then destroying an
//          entity → snapshotBoot answers eligible:false with the specific
//          reason each time (the eligibility gate cannot be slid past).
//
// Run: LIMINA_AUDIO=null ./target/release/limina js/test/p107_editor_snapshot_boot.ts

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills, type CoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { AuthoritativeServer, listenerTransport } from "../src/net/server.ts";
import { NetClient, type JsonRpcMsg } from "../src/net/client.ts";
import type { NetOps } from "../src/net/protocol.ts";
import { registerWorldlogSkills, worldCommandsToAuthor } from "../src/skills/worldlog.ts";
import { applyAuthorCommandsIsolated } from "../src/kernel/apply-isolated.ts";
import type { AuthorCommand } from "../src/kernel/authoring.ts";
import { captureRandomState, captureWorldState, compareWorldState, type WorldCommand, type WorldStateSnapshot } from "../src/worldlog/log.ts";
import { parseSnapshot, serializeSnapshot, type SnapshotParticipantRegistry, type WorldSnapshot } from "../src/worldlog/snapshot.ts";
import { finalizeSnapshotBoot, snapshotBootProgram, type SnapshotBootPayload } from "../src/browser/snapshot-boot.ts";

const net = ops as unknown as NetOps;

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p107_editor_snapshot_boot FAIL: " + msg);
}

interface ToolOutcome { success: boolean; result?: Record<string, unknown>; message?: string }
async function callTool(client: NetClient, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const msg: JsonRpcMsg = await client.call(name, args);
  if (msg.error !== undefined) return { success: false, message: msg.error.message };
  const mcp = msg.result as { success: boolean; result?: unknown; error?: { message?: string } };
  if (mcp.success) return { success: true, result: mcp.result as Record<string, unknown> };
  return { success: false, message: mcp.error?.message };
}
async function toolOk(client: NetClient, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out = await callTool(client, name, args);
  assert(out.success, `${name} failed over the wire: ${out.message ?? "?"}`);
  return out.result ?? {};
}

function makeWorld(worldOps: EngineOps): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: scene as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops: worldOps, mode: "headless",
    // Deliberately NO rng: the browser realms' worlds carry none either; the fast
    // path installs it in finalizeSnapshotBoot (that is part of what is under test).
  };
}

/** JSON of every participant's capture(), keyed by participant key. */
function captureAll(participants: SnapshotParticipantRegistry): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of participants.keys()) out[key] = JSON.stringify(participants.get(key)!.capture());
  return out;
}

function diffCaptureKeys(a: Record<string, string>, b: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => a[k] !== b[k]).sort();
}

const REPLAY_PERMS = resolveProfile("builder.readWrite");

interface FreshBoot {
  world: WorldContext;
  core: CoreSkills;
  state: WorldStateSnapshot;
  captures: Record<string, string>;
  ms: number;
}

/** Boot a FRESH context by the fast path — the EXACT viewport realm procedure:
 *  author the boot program (isolated), finalize against the snapshot, apply the
 *  tail (isolated). Captures state immediately (the native physics world is a
 *  process singleton, so a later boot clobbers it). */
async function bootFast(payload: SnapshotBootPayload, snap: WorldSnapshot, tail: readonly WorldCommand[], label: string): Promise<FreshBoot> {
  const t0 = Date.now();
  const registry = new SkillRegistry(new LiminaTracer(`ses_p107_${label}`));
  const core = registerCoreSkills(registry);
  const world = makeWorld(ops);
  const program = snapshotBootProgram(snap, payload.bootstrapCommands);
  const applyOpts = { sessionId: `ses_p107_${label}`, defaultAgentId: "author", defaultPerms: REPLAY_PERMS, tick: 0 };
  const programOutcome = await applyAuthorCommandsIsolated(registry, world, program, applyOpts);
  assert(programOutcome.failures.length === 0,
    `[${label}] boot program isolated failures: ` + programOutcome.failures.map((f) => `#${f.index} ${f.command}: ${f.message}`).join("; "));
  finalizeSnapshotBoot(world, snap, core.snapshotParticipants);
  // Immediately after finalize, BOTH streams sit at the snapshot's exact states.
  // (The tail below legitimately advances the GLOBAL stream — mesh creation draws
  // Math.random for three UUIDs — which is precisely why skills draw world.rng.)
  assert(captureRandomState() === snap.rngState,
    `[${label}] finalize must install the global Math.random stream at the snapshot's state`);
  assert(world.rng !== undefined && world.rng.getState() === (snap.skillRngState ?? snap.rngState),
    `[${label}] finalize must install the world-owned skill RNG at the snapshot's state`);
  const tailOutcome = await applyAuthorCommandsIsolated(registry, world, worldCommandsToAuthor(tail), applyOpts);
  assert(tailOutcome.failures.length === 0,
    `[${label}] tail isolated failures: ` + tailOutcome.failures.map((f) => `#${f.index} ${f.command}: ${f.message}`).join("; "));
  const ms = Date.now() - t0;
  return { world, core, state: captureWorldState(world), captures: captureAll(core.snapshotParticipants), ms };
}

/** Boot a FRESH context by the CURRENT viewport path: re-author the whole stream. */
async function bootFullReplay(commands: readonly WorldCommand[], label: string): Promise<FreshBoot> {
  const t0 = Date.now();
  const registry = new SkillRegistry(new LiminaTracer(`ses_p107_${label}`));
  const core = registerCoreSkills(registry);
  const world = makeWorld(ops);
  const outcome = await applyAuthorCommandsIsolated(registry, world, worldCommandsToAuthor(commands), {
    sessionId: `ses_p107_${label}`, defaultAgentId: "author", defaultPerms: REPLAY_PERMS, tick: 0,
  });
  assert(outcome.failures.length === 0,
    `[${label}] full-replay isolated failures: ` + outcome.failures.map((f) => `#${f.index} ${f.command}: ${f.message}`).join("; "));
  const ms = Date.now() - t0;
  return { world, core, state: captureWorldState(world), captures: captureAll(core.snapshotParticipants), ms };
}

// ═════════ Phase 1 — REAL host + a builder authoring 50+ commands over the wire ═════════

const listenerId = await net.op_net_listen(0);
const port = net.op_net_listener_port(listenerId);
const server = new AuthoritativeServer(listenerTransport(net, listenerId), {
  sessionId: "p107_host",
  seed: 0x107b007,
  tickMs: 8,
});
// The exact editor_host wiring for the fast-boot endpoint.
registerWorldlogSkills(server.registry, {
  recorder: server.recorder,
  visibleCount: () => server.publishedWorldlogCommands,
  snapshotBoot: { participants: server.core.snapshotParticipants },
});
server.start();
await server.ready;

const builder = await NetClient.connect(net, `ws://127.0.0.1:${port}/`);
await builder.initialize("agt_p107_builder", "ses_p107_wire", "builder.readWrite");

// Entities: static primitives (gravity is irrelevant — nothing may drift between
// the full-replay boot, which never steps, and the snapshot poses).
const entityIds: string[] = [];
for (let i = 0; i < 24; i++) {
  const res = await toolOk(builder, "scene.createEntity", {
    shape: i % 3 === 0 ? "box" : i % 3 === 1 ? "sphere" : "cylinder",
    size: 0.5 + (i % 5) * 0.25,
    color: (0x102030 + i * 0x0a0b0c) & 0xffffff,
    position: [(i % 6) * 3 - 7.5, 0.5, Math.floor(i / 6) * 3 - 4.5],
    static: true,
  });
  entityIds.push(res.entity as string);
}
// Tags, material edits, behavior, moves — the per-entity first-class state.
await toolOk(builder, "ecs.addComponent", { entity: entityIds[0], component: "tag", value: "landmark" });
await toolOk(builder, "ecs.addComponent", { entity: entityIds[0], component: "tag", value: "spawn" });
await toolOk(builder, "ecs.addComponent", { entity: entityIds[5], component: "tag", value: "door" });
await toolOk(builder, "three.setMaterial", { entity: entityIds[1], color: 0xaa3311, roughness: 0.85 });
await toolOk(builder, "three.setMaterial", { entity: entityIds[2], color: 0x2266cc, metalness: 0.4 });
await toolOk(builder, "behavior.set", { entity: entityIds[3], behavior: { version: 1, kind: "wander", radius: 4, speed: 1.2 } });
await toolOk(builder, "scene.moveEntity", { entity: entityIds[4], position: [12, 0.5, -3] });
await toolOk(builder, "scene.moveEntity", { entity: entityIds[7], position: [-11, 0.5, 6] });
// Manager state: inventory, quest mid-progress, an interaction DOOR opened, flags.
await toolOk(builder, "item.define", { id: "apple", name: "Apple", stackable: true, maxStack: 5, weight: 0.2, category: "food" });
await toolOk(builder, "inventory.create", { entity: "hero", capacity: 8 });
await toolOk(builder, "inventory.add", { entity: "hero", itemId: "apple", quantity: 3 });
await toolOk(builder, "quest.define", {
  id: "q_p107", name: "Fast Boot", description: "Prove the tail.",
  objectives: [{ id: "collect", type: "collect", description: "Collect 5 apples", required: 5 }],
});
await toolOk(builder, "quest.offer", { entity: "hero", questId: "q_p107" });
await toolOk(builder, "quest.accept", { entity: "hero", questId: "q_p107" });
await toolOk(builder, "quest.update", { entity: "hero", questId: "q_p107", objectiveId: "collect", progress: 2 });
await toolOk(builder, "interaction.register", { entity: entityIds[5], prompt: "Open the door", maxRange: 3, type: "open" });
const doorOpen = await toolOk(builder, "interaction.open", { entity: entityIds[5] });
assert(doorOpen.ok === true, "interaction.open must succeed (tick-stamped door state is the snapshot-only payload)");
await toolOk(builder, "game.flag", { name: "fast_boot", value: true });
await toolOk(builder, "game.counter", { name: "coins", action: "set", value: 12 });
// NPC-manager + dialogue state (the enrolled behavior/dialogue participants): a
// behavior assignment with a TICK-STAMPED active goal and an IN-PROGRESS dialogue
// session (mid-tree cursor + history) — snapshot-only payloads a tick-0 full
// replay cannot reproduce (goal ids embed the server's invoke tick).
await toolOk(builder, "behavior.define", { id: "prof_p107", name: "Sentry", goals: [{ id: "g0", type: "guard", priority: 1 }] });
await toolOk(builder, "behavior.assign", { entity: "npc_p107", profileId: "prof_p107" });
await toolOk(builder, "behavior.setGoal", { entity: "npc_p107", type: "patrol", priority: 2 });
await toolOk(builder, "npc.memorize", { entity: "npc_p107", key: "sawPlayer", value: true });
await toolOk(builder, "dialogue.define", {
  id: "dlg_p107", name: "Gate", startNode: "a",
  nodes: [
    { id: "a", text: "Who goes there?", speaker: "npc_p107", choices: [{ text: "A friend.", nextNodeId: "b" }] },
    { id: "b", text: "Pass.", speaker: "npc_p107", choices: [] },
  ],
});
await toolOk(builder, "dialogue.start", { treeId: "dlg_p107", speaker: "npc_p107", listener: "hero" });
const p107Chose = await toolOk(builder, "dialogue.choose", { speaker: "npc_p107", listener: "hero", choiceIndex: 0 });
assert(p107Chose.ok === true, "dialogue.choose must advance the fixture session mid-tree");

// ═════════ Phase 2 — the fast-boot endpoint over the wire, then a real tail ═════════

// Below-threshold probe: no capture, an explicit reason.
const below = await toolOk(builder, "worldlog.snapshotBoot", { minCommands: 1_000_000 });
assert(below.eligible === false && String(below.reason ?? "").includes("threshold"), "below-threshold probe must answer eligible:false with the threshold reason");

const boot = await toolOk(builder, "worldlog.snapshotBoot", { minCommands: 10 });
assert(boot.eligible === true, `snapshotBoot must be eligible for this session (got: ${boot.reason})`);
assert(typeof boot.snapshot === "string" && typeof boot.next === "number" && boot.next === boot.snapshotSeq, "snapshotBoot payload shape");
const payload: SnapshotBootPayload = {
  snapshotSeq: boot.snapshotSeq as number,
  snapshot: boot.snapshot as string,
  bootstrapCommands: (boot.bootstrapCommands ?? []) as AuthorCommand[],
};
const snap = parseSnapshot(payload.snapshot);
assert(snap.snapshotSeq === payload.snapshotSeq, "parsed snapshot's seq must match the payload");
assert(snap.entities.length === entityIds.length, `snapshot must carry all ${entityIds.length} entities (got ${snap.entities.length})`);
assert(Object.keys(snap.managers).length >= 17, "snapshot must carry the full participant manager capture (incl. behavior + dialogue)");
assert(snap.physics.length > 0, "snapshot must carry the native physics blob (full capture, not the hot-path projection)");
assert(payload.bootstrapCommands.length >= 1, "the server's op_physics_create_world bootstrap must ride bootstrapCommands");

// The TAIL: authored AFTER the snapshot boundary — entity-only + non-tick-stamped
// manager mutations (a tick-stamped tail command would replay with tick 0 in ANY
// viewer path; that is a pre-existing full-replay property, not a fast-boot one).
const tailEntity = await toolOk(builder, "scene.createEntity", {
  shape: "box", size: 0.8, color: 0x44aa55, position: [0, 0.4, 14], static: true,
});
await toolOk(builder, "scene.moveEntity", { entity: entityIds[9], position: [3, 0.5, 9] });
await toolOk(builder, "three.setMaterial", { entity: tailEntity.entity as string, color: 0x775533, roughness: 0.6 });
await toolOk(builder, "ecs.addComponent", { entity: tailEntity.entity as string, component: "tag", value: "tail" });
await toolOk(builder, "inventory.add", { entity: "hero", itemId: "apple", quantity: 1 });

const tailRes = await toolOk(builder, "worldlog.tail", { since: payload.snapshotSeq });
assert(tailRes.reset !== true, "tail from the snapshot cursor must not reset");
const tail = tailRes.commands as WorldCommand[];
assert(tail.length >= 5, `expected the 5 tail commands (got ${tail.length})`);
const fullRes = await toolOk(builder, "worldlog.tail", { since: 0 });
const fullStream = fullRes.commands as WorldCommand[];
assert(fullStream.length > tail.length + 40, "full stream must dwarf the tail");

// Server-side ground truth for manager state, captured BEFORE any fresh boot
// touches the process's native physics world.
const serverCaptures = captureAll(server.core.snapshotParticipants);
const serverEntityCount = server.world.entities.snapshot().entries.length;
assert(serverEntityCount === entityIds.length + 1, "server must hold authored + tail entities");

// ═════════ Phase 3 — boot B (full replay) vs boot A (fast path): bit-identical ═════════

const bootB = await bootFullReplay(fullStream, "full");
const bootA = await bootFast(payload, snap, tail, "fast");

const cmp = compareWorldState(bootB.state, bootA.state);
assert(cmp.identical, `fast boot diverged from full replay (${cmp.comparisons} fields): ${cmp.detail ?? "?"}`);
assert(bootA.state.entities.length === entityIds.length + 1, "fast boot must hold authored + tail entities");

// Manager state: the fast path must be bit-identical to the LIVE SERVER —
// including tick-stamped state (door lastInteractTick, quest offer/accept ticks)
// that full replay CANNOT reproduce (it re-invokes with tick 0).
const fastVsServer = diffCaptureKeys(bootA.captures, serverCaptures);
assert(fastVsServer.length === 0, `fast-boot participant captures diverge from the server's: ${fastVsServer.join(", ")}`);
// The newly enrolled rows are NOT vacuously equal — the fast boot carries the
// authored mid-tree behavior assignment and the in-progress dialogue session.
assert(bootA.core.behavior.behaviorManager.getAssignedProfile("npc_p107")?.id === "prof_p107",
  "fast boot must restore the NPC's assigned behavior profile");
assert(bootA.core.behavior.behaviorManager.getGoal("npc_p107")?.type === "patrol",
  "fast boot must restore the NPC's tick-stamped active goal");
{
  const s = bootA.core.behavior.dialogueManager.getCurrentSession("npc_p107", "hero");
  assert(s?.currentNodeId === "b" && s.history.length === 1,
    "fast boot must restore the IN-PROGRESS dialogue session (mid-tree cursor + history)");
}
const fullVsServer = diffCaptureKeys(bootB.captures, serverCaptures);
assert(fullVsServer.length > 0,
  "control: full replay was expected to LOSE tick-stamped manager state vs the server -- if it no longer does, tighten this gate");

// RNG mid-stream resume: the world-owned SKILL stream still sits at the
// snapshot's state after the tail (no tail skill drew from it) — post-boot
// skill draws continue the recorded stream. The global-stream install is
// asserted inside bootFast at the finalize boundary (mesh UUID draws in the
// tail legitimately advance it afterwards).
assert(bootA.world.rng !== undefined && bootA.world.rng.getState() === (snap.skillRngState ?? snap.rngState),
  "fast boot must keep the world-owned skill RNG on the snapshot's stream through the tail");

// Allocation continuity: the tail's create allocated the SAME id as the server.
assert(bootA.world.entities.resolve(tailEntity.entity as string) !== undefined,
  "the tail-created entity must exist under its authoritative id after fast boot");

// ═════════ Phase 4 — FALSIFIABILITY ═════════

// (a) Strip one manager from the snapshot → the participant comparison MUST catch it.
{
  const tampered: WorldSnapshot = JSON.parse(serializeSnapshot(snap));
  delete (tampered.managers as Record<string, unknown>).inventory;
  const bootC = await bootFast({ ...payload, snapshot: serializeSnapshot(tampered) }, tampered, tail, "noInv");
  const diff = diffCaptureKeys(bootC.captures, serverCaptures);
  assert(diff.includes("inventory"), "dropping managers.inventory from the snapshot did NOT diverge -- manager restore is not load-bearing");
}
// (b) Tamper an entity's snapshot material → captureWorldState MUST diverge.
{
  const tampered: WorldSnapshot = JSON.parse(serializeSnapshot(snap));
  const victim = tampered.entities.find((e) => e.id === entityIds[1]);
  assert(victim?.material !== undefined, "victim entity must carry material");
  victim.material = { ...victim.material, color: 0x000001 };
  const bootD = await bootFast({ ...payload, snapshot: serializeSnapshot(tampered) }, tampered, tail, "badMat");
  assert(!compareWorldState(bootB.state, bootD.state).identical,
    "tampering a snapshot material did NOT diverge -- first-class entity state restore is not load-bearing");
}
// (c) Tamper an entity's eid → allocation-parity verification MUST throw.
{
  const tampered: WorldSnapshot = JSON.parse(serializeSnapshot(snap));
  tampered.entities[3].eid = tampered.entities[3].eid + 7;
  let threw = "";
  try {
    await bootFast({ ...payload, snapshot: serializeSnapshot(tampered) }, tampered, tail, "badEid");
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  assert(threw.includes("allocation diverged"), `eid tamper must fail the allocation-parity verify (got: ${threw || "no throw"})`);
}
// (d) Eligibility: a non-carried command, then a destroyed entity, each flip the
// verdict with a SPECIFIC reason.
{
  await toolOk(builder, "three.addLight", { kind: "point", position: [0, 4, 0], intensity: 2 });
  const afterLight = await toolOk(builder, "worldlog.snapshotBoot", { minCommands: 10 });
  assert(afterLight.eligible === false && String(afterLight.reason ?? "").includes("three.addLight"),
    `a non-carried tool must make the session ineligible naming the tool (got: ${afterLight.reason})`);
  await toolOk(builder, "scene.destroyEntity", { entity: entityIds[10] });
  const afterDestroy = await toolOk(builder, "worldlog.snapshotBoot", { minCommands: 10 });
  assert(afterDestroy.eligible === false, "a destroyed entity must make the session ineligible (allocation gaps)");
}

// ═════════ teardown + verdict ═════════

await builder.close();
await server.shutdown();
net.op_net_close_listener(listenerId);

ops.op_log(
  `p107_editor_snapshot_boot OK: real host served snapshot@seq${payload.snapshotSeq} ` +
    `(${snap.entities.length} entities, ${Object.keys(snap.managers).length} managers, ${payload.bootstrapCommands.length} bootstrap ops) ` +
    `+ ${tail.length}-command tail out of a ${fullStream.length}-command stream; fast boot == full replay bit-identical ` +
    `(${cmp.comparisons} fields) in ${bootA.ms}ms vs ${bootB.ms}ms full replay; manager state == SERVER bit-exact ` +
    `(full replay demonstrably loses tick-stamped state: ${fullVsServer.join(",")}); both RNG streams resumed at snapshot states; ` +
    `falsified: manager-drop diverged, material-tamper diverged, eid-tamper threw allocation-parity, ` +
    `non-carried tool + destroy each answered eligible:false with reasons.`,
);
