// p97 — WORLDLOG HARDENING GATE (adversarial-review fixes M8 / M13 / M17).
//
// Proves three worldlog changes, each with its falsifying counter-case:
//   1. M13 log format v2: a skill command whose caller permission set is exactly a
//      named profile's set persists the PROFILE NAME instead of the ~70-string
//      permission array; the reader materializes the array back, old v1 lines
//      (full perms array) still parse and replay, a NARROWED set is never widened
//      to its profile, and an unknown profile fails closed.
//   2. M8 compareWorldState covers the per-entity gameplay component set
//      (generation/parent/tags/material/resource/behavior): a gameplay-only
//      difference between two otherwise transform-identical worlds is DETECTED,
//      and the extension keeps the bit-exact number semantics (NaN==NaN, -0!=+0).
//   3. M17 divergence-aware merge: a divergent merge whose tails edit the same
//      entity (or carry the same command) is REFUSED with a structured conflict
//      report and touches neither branch; a conflict-free divergent merge appends
//      with ticks re-stamped monotonically.
//
// Run: LIMINA_AUDIO=null ./target/release/limina js/test/p98_worldlog_hardening.ts

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type InvokeBase, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { replayCommands } from "../src/worldlog/replay.ts";
import { WorldHistory } from "../src/worldlog/history.ts";
import {
  captureWorldState,
  compareWorldState,
  parseWorldLog,
  serializeWorldCommand,
  type SkillCommand,
  type WorldCommand,
  type WorldLike,
  type WorldStateSnapshot,
} from "../src/worldlog/log.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p98_worldlog_hardening FAIL: " + msg);
}
function makeWorld(worldOps: EngineOps): WorldContext {
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  const ecs = createEcsWorld();
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: scene as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops: worldOps, mode: "headless",
  };
}
const PROFILE = "builder.readWrite";
const PERMS = resolveProfile(PROFILE);

// ── 1. M13: profile-pinned v2 lines, v1 acceptance, never-widen, fail-closed. ─────────────────
{
  ops.op_physics_create_world(-9.81);
  const reg = new SkillRegistry(new LiminaTracer("ses_p97_m13"));
  registerCoreSkills(reg);
  const rec = new WorldRecorder("ses_p97_m13");
  rec.seed(151, { forceInstall: true });
  rec.attach(reg);
  const world = makeWorld(ops);
  const base: InvokeBase = { agentId: "agt", sessionId: "ses_p97_m13", permissions: PERMS, profile: PROFILE, tick: 0, world };
  for (const x of [0, 4]) await reg.invoke("scene.createEntity", { shape: "box", position: [x, 0, 0] }, base);
  const recordedState = captureWorldState(world);

  // In memory: perms stays materialized AND the profile is pinned.
  const skillCmds = rec.commands.filter((c): c is SkillCommand => c.kind === "skill");
  assert(skillCmds.length === 2, `recorded 2 skill commands (got ${skillCmds.length})`);
  for (const c of skillCmds) {
    assert(c.profile === PROFILE, `in-memory command pins profile (got ${String(c.profile)})`);
    assert(c.perms.length === PERMS.size, "in-memory command keeps the full perms array");
  }

  // On the wire: the FIRST pinned line per profile keeps its perms array — the
  // frozen mapping later name-only lines resolve from (D10: replay must grant
  // what the caller held at RECORD time, not what the live profile says now) —
  // and every later same-profile line drops the array.
  const jsonl = rec.toJsonl();
  const wireSkillLines = jsonl.split("\n").filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as { kind?: string; perms?: unknown; profile?: unknown })
    .filter((p) => p.kind === "skill");
  assert(wireSkillLines.length === 2, "two skill lines on the wire");
  assert(Array.isArray(wireSkillLines[0].perms) && (wireSkillLines[0].perms as unknown[]).length === PERMS.size,
    "first pinned line freezes the profile's full perms array into the log");
  assert(wireSkillLines[0].profile === PROFILE, "freeze line also carries the profile name");
  assert(wireSkillLines[1].perms === undefined, "later v2 skill lines drop the perms array");
  assert(wireSkillLines[1].profile === PROFILE, "later v2 skill lines carry the profile name");
  const meta = parseWorldLog(jsonl).meta;
  assert(meta !== undefined && meta.logVersion === 2, `meta carries logVersion 2 (got ${meta?.logVersion})`);
  const parsedCmds = parseWorldLog(jsonl).commands;
  for (const c of parsedCmds) {
    if (c.kind !== "skill") continue;
    assert([...c.perms].join(",") === [...PERMS].sort().join(","), "parse materializes perms from the frozen mapping");
  }
  // The frozen mapping decouples replay from live profile edits: a name-only line
  // with NO freeze in the log falls back to resolveProfile WITH a warning — and a
  // doctored freeze line proves parse reads the mapping, not the live profile.
  {
    const lines = jsonl.split("\n").filter((l) => l.length > 0);
    const noFreeze = lines.filter((l) => {
      if (!l.includes('"kind":"skill"')) return true;
      const p = JSON.parse(l) as { perms?: unknown };
      return p.perms === undefined;
    });
    // Drop the freeze line entirely: remaining name-only line must warn + fall back.
    const fallbackWarnings: string[] = [];
    const fallback = parseWorldLog(noFreeze.join("\n") + "\n", { onWarning: (m) => fallbackWarnings.push(m) });
    assert(fallbackWarnings.length === 1 && fallbackWarnings[0].includes(PROFILE),
      "pre-freeze v2 log warns once per profile resolved from the live definition");
    assert(fallback.commands.filter((c) => c.kind === "skill").every((c) => c.perms.length === PERMS.size),
      "pre-freeze fallback still materializes from the live profile");
    // Doctor the freeze to a narrowed set: later name-only lines must inherit the
    // FROZEN (narrowed) set even though the live profile is wider — falsifiability
    // that the mapping, not resolveProfile, is authoritative.
    const doctored = lines.map((l) => {
      if (!l.includes('"kind":"skill"')) return l;
      const p = JSON.parse(l) as SkillCommand & { perms?: string[] };
      if (p.perms !== undefined) return JSON.stringify({ ...p, perms: ["scene.read"] });
      return l;
    });
    const frozenParse = parseWorldLog(doctored.join("\n") + "\n");
    const frozenSkills = frozenParse.commands.filter((c): c is SkillCommand => c.kind === "skill");
    assert(frozenSkills.every((c) => c.perms.length === 1 && c.perms[0] === "scene.read"),
      "replay grants the FROZEN mapping, not the live profile definition");
    assert((frozenParse.warnings ?? []).length === 0, "a frozen log parses with no fallback warning");
  }

  // The parsed v2 stream replays to the recorded world, bit-identical.
  const replayed = await replayCommands(parsedCmds, {
    makeWorld: () => { ops.op_physics_create_world(-9.81); return makeWorld(ops); },
    makeRegistry: (tr) => { const r = new SkillRegistry(tr as LiminaTracer); registerCoreSkills(r); return r; },
    tracer: new LiminaTracer("ses_p97_m13_replay"),
  });
  const cmp = compareWorldState(recordedState, replayed.state);
  assert(cmp.identical, `v2 log replays bit-identical (diverged: ${cmp.detail})`);

  // v1 (legacy) line: full perms array, no profile, meta logVersion 1 — still parses and replays.
  const v1Skill = { ...skillCmds[0], profile: undefined, seq: 1 };
  delete (v1Skill as Record<string, unknown>).profile;
  const v1Jsonl = [
    JSON.stringify({ kind: "meta", logVersion: 1, sessionId: "ses_p97_v1", createdAt: "tick:0", commands: 2, ticks: 0 }),
    JSON.stringify(rec.commands[0]), // seed
    JSON.stringify(v1Skill),
  ].join("\n") + "\n";
  const v1 = parseWorldLog(v1Jsonl);
  assert(v1.commands.length === 2, "v1 log parses");
  const v1SkillParsed = v1.commands.find((c) => c.kind === "skill") as SkillCommand;
  assert(v1SkillParsed.perms.length === PERMS.size && v1SkillParsed.profile === undefined, "v1 line keeps its perms array");
  const v1Replay = await replayCommands(v1.commands, {
    makeWorld: () => { ops.op_physics_create_world(-9.81); return makeWorld(ops); },
    makeRegistry: (tr) => { const r = new SkillRegistry(tr as LiminaTracer); registerCoreSkills(r); return r; },
    tracer: new LiminaTracer("ses_p97_v1_replay"),
  });
  assert(v1Replay.skillInvokes === 1, "v1 log replays its skill command");

  // NEVER-WIDEN: a caller claiming a profile but holding a NARROWED set must record
  // the full (narrow) array, not the profile name.
  const narrowReg = new SkillRegistry(new LiminaTracer("ses_p97_narrow"));
  registerCoreSkills(narrowReg);
  const narrowRec = new WorldRecorder("ses_p97_narrow");
  narrowRec.attach(narrowReg);
  ops.op_physics_create_world(-9.81);
  const narrowWorld = makeWorld(ops);
  const narrowPerms = new Set(["scene.read", "scene.write", "ecs.read", "ecs.modify", "physics.read", "physics.write"]);
  await narrowReg.invoke("scene.createEntity", { shape: "box", position: [1, 0, 0] }, {
    agentId: "agt", sessionId: "ses_p97_narrow", permissions: narrowPerms, profile: PROFILE, tick: 0, world: narrowWorld,
  });
  const narrowCmd = narrowRec.commands.find((c) => c.kind === "skill") as SkillCommand;
  assert(narrowCmd.profile === undefined, "narrowed permission set must NOT pin the profile");
  const narrowLine = JSON.parse(serializeWorldCommand(narrowCmd)) as { perms?: string[]; profile?: string };
  assert(Array.isArray(narrowLine.perms) && narrowLine.perms.length === narrowPerms.size && narrowLine.profile === undefined,
    "narrowed set serializes the full perms array");

  // FAIL-CLOSED: an unknown profile on a persisted line is a parse error, never an
  // empty permission set.
  let threw = false;
  try {
    parseWorldLog(JSON.stringify({
      kind: "skill", seq: 0, tick: 0, tool: "scene.createEntity", input: {},
      actorId: "agt", sessionId: "s", profile: "no.such.profile",
    }) + "\n");
  } catch {
    threw = true;
  }
  assert(threw, "unknown profile in a log line must fail parse loudly");
}

// ── 2. M8: the comparator sees gameplay state, with bit-exact semantics kept. ─────────────────
{
  // Stub world: two entities, no bodies; gameplay state on the entries + tag map.
  interface StubEntry { eid: number; generation?: number; parent?: string; material?: unknown; resource?: unknown; behavior?: unknown }
  function stubWorld(entries: Record<string, StubEntry>, tags: Map<number, Set<string>>): WorldLike {
    return {
      entities: { ids: () => Object.keys(entries), resolve: (id: string) => entries[id] },
      ops,
      tags,
    };
  }
  const baseEntries = (): Record<string, StubEntry> => ({
    ent_0: { eid: 1, generation: 0, material: { color: 0xff0000, roughness: 0.5 } },
    ent_1: { eid: 2, generation: 0, parent: "ent_0" },
  });
  const a = captureWorldState(stubWorld(baseEntries(), new Map([[1, new Set(["tree"])]])));
  const same = captureWorldState(stubWorld(baseEntries(), new Map([[1, new Set(["tree"])]])));
  assert(compareWorldState(a, same).identical, "identical gameplay state compares identical");

  // Tag-only difference (transforms identical) is DETECTED — the pre-M8 comparator
  // was blind to exactly this.
  const tagDiff = captureWorldState(stubWorld(baseEntries(), new Map([[1, new Set(["tree", "burning"])]])));
  const tagCmp = compareWorldState(a, tagDiff);
  assert(!tagCmp.identical && (tagCmp.detail ?? "").includes("tags"), `tag divergence detected (${tagCmp.detail})`);

  // Material-only difference is detected.
  const matEntries = baseEntries();
  (matEntries.ent_0.material as { color: number }).color = 0x00ff00;
  const matCmp = compareWorldState(a, captureWorldState(stubWorld(matEntries, new Map([[1, new Set(["tree"])]]))));
  assert(!matCmp.identical && (matCmp.detail ?? "").includes("material"), `material divergence detected (${matCmp.detail})`);

  // Parent-only difference is detected.
  const parentEntries = baseEntries();
  delete parentEntries.ent_1.parent;
  const parentCmp = compareWorldState(a, captureWorldState(stubWorld(parentEntries, new Map([[1, new Set(["tree"])]]))));
  assert(!parentCmp.identical && (parentCmp.detail ?? "").includes("parent"), `parent divergence detected (${parentCmp.detail})`);

  // Bit-exact number semantics inside gameplay values: NaN equals itself; -0 != +0.
  const snap = (v: number): WorldStateSnapshot => ({
    entities: [{ id: "ent_0", eid: 1, pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1], material: { v } }],
  });
  assert(compareWorldState(snap(NaN), snap(NaN)).identical, "NaN inside gameplay state equals itself (Object.is semantics)");
  assert(!compareWorldState(snap(-0), snap(0)).identical, "-0 vs +0 inside gameplay state must diverge (bit-exact)");
}

// ── 3. M17: divergent merges are conflict-checked; safe appends re-stamp ticks. ───────────────
{
  const skill = (seq: number, tick: number, tool: string, input: unknown): WorldCommand => ({
    kind: "skill", seq, tick, tool, input, actorId: "agt", sessionId: "s", perms: ["scene.write"],
  });
  const base = [skill(0, 0, "scene.createEntity", { shape: "box" })];

  // 3a. Both tails edit the SAME entity → refused with a conflict report; branches untouched.
  const h = new WorldHistory(base);
  h.fork("a", "main");
  h.fork("b", "main");
  h.extend("a", [skill(0, 1, "three.setMaterial", { entity: "ent_0", color: 1 })]);
  h.extend("b", [skill(0, 1, "three.setMaterial", { entity: "ent_0", color: 2 })]);
  h.merge("main", "a");
  const tipBefore = h.tip("main");
  const bTipBefore = h.tip("b");
  const conflicted = h.merge("main", "b");
  assert(conflicted.kind === "conflict", `same-entity divergent merge is refused (got ${conflicted.kind})`);
  assert(conflicted.added === 0 && h.tip("main") === tipBefore && h.tip("b") === bTipBefore,
    "a refused merge modifies neither branch");
  assert(conflicted.conflict !== undefined && conflicted.conflict.entities.includes("ent_0"),
    `conflict report names the contested entity (got ${JSON.stringify(conflicted.conflict)})`);

  // 3b. The same command in both tails (duplicate edit past the fork) → refused.
  const h2 = new WorldHistory(base);
  h2.fork("x", "main");
  h2.fork("y", "main");
  // The duplicate sits at DIFFERENT positions past the fork, so the common-prefix
  // scan cannot absorb it and blind concatenation would replay it twice.
  const dup = skill(0, 1, "scene.createEntity", { shape: "sphere", position: [9, 0, 0] });
  h2.extend("x", [skill(0, 2, "scene.createEntity", { shape: "box", position: [1, 0, 0] }), dup]);
  h2.extend("y", [dup]);
  h2.merge("main", "x");
  const dupMerge = h2.merge("main", "y");
  assert(dupMerge.kind === "conflict" && dupMerge.conflict !== undefined && dupMerge.conflict.duplicateCommands === 1,
    `duplicated divergent command is refused (got ${dupMerge.kind}, ${JSON.stringify(dupMerge.conflict)})`);

  // 3c. Conflict-free divergent merge appends AND keeps ticks monotonic in seq order
  // (pre-M17 the appended tail kept its old, EARLIER ticks — non-monotonic).
  const h3 = new WorldHistory(base);
  h3.fork("late", "main");
  h3.fork("early", "main");
  h3.extend("late", [skill(0, 7, "scene.createEntity", { shape: "box", position: [2, 0, 0] })]);
  h3.extend("early", [skill(0, 2, "scene.createEntity", { shape: "sphere", position: [3, 0, 0] }), skill(0, 3, "scene.createEntity", { shape: "sphere", position: [4, 0, 0] })]);
  h3.merge("main", "late");
  const appended = h3.merge("main", "early");
  assert(appended.kind === "appended" && appended.added === 2, `disjoint divergent merge appends (got ${appended.kind}, +${appended.added})`);
  const mergedCmds = h3.commands("main");
  let lastTick = -1;
  for (const c of mergedCmds) {
    if (c.kind === "seed") continue;
    assert(c.tick >= lastTick, `merged log ticks are monotonic in seq order (tick ${c.tick} after ${lastTick})`);
    lastTick = c.tick;
  }
  // The tail's internal spacing survives the shift (2,3 -> 7,8).
  const tail = mergedCmds.slice(-2);
  assert(tail[0].kind === "skill" && tail[1].kind === "skill" && tail[1].tick - tail[0].tick === 1,
    "appended tail preserves its internal tick spacing");
}

// ── 4. M21: read-effect tools/call is metered per connection per tick. ────────────────────────
{
  const { ACCEPT_CLOSED, AuthoritativeServer } = await import("../src/net/server.ts");
  const { registerWorldlogSkills } = await import("../src/skills/worldlog.ts");
  const sent = new Map<number, string[]>();
  const transport = {
    accept: async (): Promise<number> => ACCEPT_CLOSED,
    recv: async (): Promise<string> => "",
    close: async (): Promise<void> => {},
    send: async (connId: number, line: string): Promise<void> => {
      const lines = sent.get(connId) ?? [];
      lines.push(line);
      sent.set(connId, lines);
    },
  };
  const server = new AuthoritativeServer(transport, { sessionId: "ses_p98_reads", seed: 0x98 });
  registerWorldlogSkills(server.registry, { recorder: server.recorder });
  interface TestConn {
    connId: number; session?: unknown; subscribed: boolean; closing: boolean;
    queuedIntents: number; readBudgetTick: number; readsThisTick: number;
  }
  const internals = server as unknown as {
    tick: number;
    handleLine: (conn: TestConn, line: string) => Promise<void>;
  };
  const conn: TestConn = {
    connId: 7,
    session: { agentId: "agt", sessionId: "ses_p98_reads", profile: "builder.readWrite", permissions: PERMS },
    subscribed: false, closing: false, queuedIntents: 0, readBudgetTick: -1, readsThisTick: 0,
  };
  const readLine = (id: number): string => JSON.stringify({
    jsonrpc: "2.0", id, method: "tools/call", params: { name: "worldlog.tail", arguments: { since: 0 } },
  });
  for (let i = 0; i < 40; i++) await internals.handleLine(conn, readLine(i));
  const replies = (sent.get(7) ?? []).map((l) => JSON.parse(l) as { result?: unknown; error?: { message?: string } });
  const ok = replies.filter((r) => r.result !== undefined).length;
  const rejected = replies.filter((r) => (r.error?.message ?? "").includes("read budget")).length;
  assert(ok === 32, `exactly the per-tick read budget succeeds (got ${ok})`);
  assert(rejected === 8, `reads beyond the budget are rejected with capacity_exceeded (got ${rejected})`);
  // The budget is per SIM TICK: advancing the tick restores it.
  internals.tick += 1;
  await internals.handleLine(conn, readLine(99));
  const last = JSON.parse((sent.get(7) ?? []).at(-1) ?? "{}") as { result?: unknown };
  assert(last.result !== undefined, "a new tick resets the per-connection read budget");
  await server.shutdown();
}

ops.op_log(
  "p98_worldlog_hardening OK: v2 profile-pinned log lines round-trip (v1 lines still parse+replay; a narrowed set is " +
  "never widened; unknown profiles fail closed); compareWorldState detects gameplay-only divergence (tags/material/" +
  "parent) with bit-exact NaN/-0 semantics kept; divergent merges refuse same-entity and duplicate-command conflicts " +
  "with a structured report and re-stamp ticks monotonically on safe appends; read-effect tools/call is metered per " +
  "connection per tick (32 pass, overflow rejected, budget resets on tick advance).",
);
