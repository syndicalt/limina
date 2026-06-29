// Phase 16 (Track E — Ship) — THE SHIP GATE: structural integrity + REPLAY-EQUIVALENCE.
//
// Before publishing a world, the ship pipeline must prove not only that the bundle is structurally
// intact (verifyWorldLog) but that it REPLAYS to a stable, deterministic state — replaying it twice
// must reconstruct an identical world (worldStateDigest). This gate proves a genuine bundle is
// shippable on both counts, that replaying it twice is byte-identical, that a shorter (time-traveled)
// bundle reconstructs a provably different state, and that a corrupt bundle is rejected.
//
// Run: ./target/release/limina js/test/p16_ship_gate.ts   (exit 0 = pass)

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
import { parseWorldLog, type WorldCommand } from "../src/worldlog/log.ts";
import { verifyWorldLog, worldStateDigest } from "../src/worldlog/verify.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p16_ship_gate FAIL: " + msg);
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

/** Replay a command list into a fresh core and return a stable digest of the reconstructed world. */
async function replayDigest(commands: WorldCommand[]): Promise<string> {
  let world: WorldContext | undefined;
  await replayCommands(commands, {
    makeWorld: () => { ops.op_physics_create_world(-9.81); world = makeWorld(ops); return world; },
    makeRegistry: (tr) => { const r = new SkillRegistry(tr as LiminaTracer); registerCoreSkills(r); return r; },
    tracer: new LiminaTracer("ses_p16_ship_replay"),
  });
  assert(world !== undefined, "replay constructed a world");
  return worldStateDigest(world);
}

/** The full ship gate: structural integrity AND replay-equivalence (deterministic reconstruction). */
async function assessBundle(jsonl: string): Promise<{ shippable: boolean; structural: boolean; deterministic: boolean; digest?: string; reason?: string }> {
  const v = verifyWorldLog(jsonl);
  if (!v.ok) return { shippable: false, structural: false, deterministic: false, reason: "structural: " + v.reason };
  const commands = parseWorldLog(jsonl).commands;
  const d1 = await replayDigest(commands);
  const d2 = await replayDigest(commands);
  const deterministic = d1 === d2;
  return { shippable: deterministic, structural: true, deterministic, digest: d1, reason: deterministic ? undefined : `replay non-deterministic: ${d1} vs ${d2}` };
}

// ── Record + serialize a genuine bundle (3 placed boxes). ─────────────────────────────────────
ops.op_physics_create_world(-9.81);
const reg = new SkillRegistry(new LiminaTracer("ses_p16_ship"));
registerCoreSkills(reg);
const recorder = new WorldRecorder("ses_p16_ship");
recorder.attach(reg);
const world = makeWorld(ops);
const base: InvokeBase = { agentId: "agt", sessionId: "ses_p16_ship", permissions: PERMS, tick: 0, world };
for (const x of [0, 4, 8]) await reg.invoke("scene.createEntity", { shape: "box", position: [x, 0, 0] }, base);
const good = recorder.toJsonl();

// ── 1. A genuine bundle is SHIPPABLE: structurally intact AND replay-deterministic. ───────────
{
  const a = await assessBundle(good);
  assert(a.shippable && a.structural && a.deterministic, `a genuine bundle is shippable (reason=${a.reason})`);
  assert((a.digest ?? "").startsWith("3|"), `the reconstructed world has 3 entities (digest=${a.digest})`);
}

// ── 2. REPLAY-EQUIVALENCE: replaying the same bundle twice reconstructs an identical world. ───
{
  const commands = parseWorldLog(good).commands;
  const d1 = await replayDigest(commands);
  const d2 = await replayDigest(commands);
  assert(d1 === d2, `replay is byte-identical across runs (\n  ${d1}\n  ${d2})`);
}

// ── 3. TIME-TRAVEL shows a real state difference: a shorter prefix reconstructs fewer entities. ─
{
  const commands = parseWorldLog(good).commands;
  const full = await replayDigest(commands);
  const prefix = await replayDigest(commands.slice(0, -1)); // drop the last command
  assert(full !== prefix, "a shorter bundle reconstructs a provably different world");
  assert(prefix.startsWith("2|"), `the prefix reconstructs 2 entities (digest=${prefix})`);
}

// ── 4. A corrupt bundle is NOT shippable. ─────────────────────────────────────────────────────
{
  const lines = good.replace(/\n+$/, "").split("\n");
  const truncated = [lines[0], ...lines.slice(1, -1)].join("\n") + "\n"; // manifest count now mismatches
  const a = await assessBundle(truncated);
  assert(!a.shippable && !a.structural, "a truncated bundle is rejected by the ship gate");
  assert(/structural/.test(String(a.reason)), `rejection cites the structural failure (got: ${a.reason})`);
}

ops.op_log(
  "p16_ship_gate OK: the ship gate proves a world is publishable on BOTH counts — structural integrity " +
  "(verifyWorldLog) AND replay-equivalence (replaying the bundle twice reconstructs a byte-identical world via " +
  "worldStateDigest). Replay is deterministic; a time-traveled prefix reconstructs a provably different state; " +
  "a corrupt bundle is rejected. Track E hardening, proven headlessly.",
);
