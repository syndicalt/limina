// Phase 15 (Track E — Ship) — THE EXPORT-INTEGRITY GATE.
//
// verifyWorldLog gates a world bundle before it ships: it must parse, carry a manifest, the
// manifest's command count must match the actual log (no truncation), seqs must be strictly
// increasing (no reorder / loss), and every command must be a known kind. This gate proves a
// genuine recorded bundle passes, and that each corruption mode is CAUGHT with a clear reason —
// so a ship pipeline never emits a world a player can't load.
//
// Run: ./target/release/limina js/test/p15_export_verify.ts   (exit 0 = pass)

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type InvokeBase, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { verifyWorldLog } from "../src/worldlog/verify.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p15_export_verify FAIL: " + msg);
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
const PERMS = resolveProfile("builder.readWrite");

// ── Record + serialize a genuine bundle. ──────────────────────────────────────────────────────
ops.op_physics_create_world(-9.81);
const reg = new SkillRegistry(new LiminaTracer("ses_p15_export"));
registerCoreSkills(reg);
const recorder = new WorldRecorder("ses_p15_export");
recorder.attach(reg);
const world = makeWorld(ops);
const base: InvokeBase = { agentId: "agt", sessionId: "ses_p15_export", permissions: PERMS, tick: 0, world };
for (const x of [0, 4, 8]) await reg.invoke("scene.createEntity", { shape: "box", position: [x, 0, 0] }, base);
const good = recorder.toJsonl();

// ── 1. A genuine bundle verifies clean. ───────────────────────────────────────────────────────
{
  const v = verifyWorldLog(good);
  assert(v.ok, `a genuine recorded bundle verifies ok (reason=${v.reason})`);
  assert(v.commandCount === recorder.commands.length, `commandCount ${v.commandCount} matches the recorder (${recorder.commands.length})`);
  assert(v.checks.parsed && v.checks.metaPresent && v.checks.nonEmpty && v.checks.countMatches && v.checks.seqsContiguous && v.checks.kindsValid, "every check passes on a good bundle");
}

const lines = good.replace(/\n+$/, "").split("\n");
const meta = lines[0];
const cmds = lines.slice(1);
assert(cmds.length >= 3, "the serialized bundle has at least 3 command lines to tamper with");

// ── 2. TRUNCATION: drop the last command — manifest count no longer matches. ──────────────────
{
  const truncated = [meta, ...cmds.slice(0, -1)].join("\n") + "\n";
  const v = verifyWorldLog(truncated);
  assert(!v.ok && v.checks.countMatches === false, "truncation is caught (count mismatch)");
  assert(/declares .* commands but the log has/.test(String(v.reason)), `clear truncation reason (got: ${v.reason})`);
}

// ── 3. DUPLICATED seq: same command count, but a command's seq collides — contiguity breaks.
//      (A line reorder is NOT corruption: parseWorldLog is seq-addressed and re-sorts, so the
//      log is order-independent by design. The integrity invariant is the seq SET = 0..n-1.) ──
{
  const c0seq = (JSON.parse(cmds[0]) as { seq: number }).seq;
  const dup = JSON.parse(cmds[1]) as { seq: number };
  dup.seq = c0seq; // collide with the first command's seq
  const corrupted = [meta, cmds[0], JSON.stringify(dup), ...cmds.slice(2)].join("\n") + "\n";
  const v = verifyWorldLog(corrupted);
  assert(!v.ok && v.checks.seqsContiguous === false, "a duplicated seq is caught (contiguity broken)");
  assert(/duplicated, lost, or renumbered/.test(String(v.reason)), `clear contiguity reason (got: ${v.reason})`);
}

// ── 4. EMPTY + GARBAGE: neither passes, both fail safely. ─────────────────────────────────────
{
  const empty = verifyWorldLog("");
  assert(!empty.ok, "an empty string never verifies");
  const garbage = verifyWorldLog("this is not a world log\n{\"oops\":");
  assert(!garbage.ok, "garbage never verifies");
  assert(typeof (empty.reason ?? garbage.reason) === "string", "failures carry a human reason");
}

// ── 5. A re-serialized good bundle still verifies (round-trip stable). ────────────────────────
{
  const roundTrip = [meta, ...cmds].join("\n") + "\n";
  assert(verifyWorldLog(roundTrip).ok, "a faithfully re-joined bundle still verifies");
}

ops.op_log(
  "p15_export_verify OK: export integrity gate — a genuine recorded bundle verifies clean (parse, manifest, " +
  "count, contiguous seqs 0..n-1, known kinds); truncation, a duplicated seq, empty, and garbage are each CAUGHT " +
  "with a clear reason, so the ship pipeline never emits a world a player can't load.",
);
