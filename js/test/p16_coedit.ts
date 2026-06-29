// Phase 16 (Track D — Studio) — THE MULTI-AGENT CO-EDIT GATE.
//
// The Studio's promise is humans + agents co-authoring ONE world. The load-bearing core of that is
// CONCURRENT divergent edits merging deterministically over the shared command log. This gate proves
// it for the agent×agent case: from a shared base world, two agents each fork and author their own
// edits; merging both branches yields ONE world that contains EVERY contribution, is independent of
// merge order's confusion (each agent's commits are preserved), and replays byte-identically.
//
// Run: ./target/release/limina js/test/p16_coedit.ts   (exit 0 = pass)

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
import { worldStateDigest } from "../src/worldlog/verify.ts";
import type { WorldCommand } from "../src/worldlog/log.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p16_coedit FAIL: " + msg);
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

/** Author some boxes through skills with a recorder attached; return the recorded SKILL commands
 *  (one authoring agent's edit stream). */
async function authorEdits(session: string, positions: [number, number, number][]): Promise<WorldCommand[]> {
  ops.op_physics_create_world(-9.81);
  const reg = new SkillRegistry(new LiminaTracer(session));
  registerCoreSkills(reg);
  const rec = new WorldRecorder(session);
  rec.attach(reg);
  const world = makeWorld(ops);
  const base: InvokeBase = { agentId: session, sessionId: session, permissions: PERMS, tick: 0, world };
  for (const p of positions) await reg.invoke("scene.createEntity", { shape: "box", position: p }, base);
  return rec.commands.filter((c) => c.kind === "skill").map((c) => ({ ...c }) as WorldCommand);
}

async function replayDigest(commands: WorldCommand[]): Promise<string> {
  let world: WorldContext | undefined;
  await replayCommands(commands, {
    makeWorld: () => { ops.op_physics_create_world(-9.81); world = makeWorld(ops); return world; },
    makeRegistry: (tr) => { const r = new SkillRegistry(tr as LiminaTracer); registerCoreSkills(r); return r; },
    tracer: new LiminaTracer("ses_p16_coedit_replay"),
  });
  assert(world !== undefined, "replay constructed a world");
  return worldStateDigest(world);
}

// ── A shared base world (1 entity), and two agents' independent edits (2 each). ───────────────
const baseEdits = await authorEdits("ses_base", [[0, 0, 0]]);
const agentAEdits = await authorEdits("ses_agentA", [[1, 0, 0], [2, 0, 0]]);
const agentBEdits = await authorEdits("ses_agentB", [[3, 0, 0], [4, 0, 0]]);

// ── 1. Two agents fork the shared world and author concurrently. ──────────────────────────────
const hist = new WorldHistory(baseEdits);
assert(hist.fork("agentA", "main"), "agent A forked the shared world");
assert(hist.fork("agentB", "main"), "agent B forked the shared world");
hist.extend("agentA", agentAEdits);
hist.extend("agentB", agentBEdits);
assert(hist.diff("main", "agentA").bOnly.length === 2, "agent A has 2 unmerged commits");
assert(hist.diff("main", "agentB").bOnly.length === 2, "agent B has 2 unmerged commits");

// ── 2. Merge both agents' work into the shared world. ─────────────────────────────────────────
const m1 = hist.merge("main", "agentA");
assert(m1.kind === "fast-forward" && m1.added === 2, `agent A merges (fast-forward +2), got ${m1.kind} +${m1.added}`);
const m2 = hist.merge("main", "agentB");
assert(m2.kind === "appended" && m2.added === 2, `agent B merges over A's work (append +2), got ${m2.kind} +${m2.added}`);
assert(hist.tip("main") === 5, `the co-authored world has all 5 edits (1 base + 2 + 2), got ${hist.tip("main")}`);

// ── 3. The merged world contains EVERY agent's contribution and replays deterministically. ────
const merged = hist.commands("main");
const d1 = await replayDigest(merged);
const d2 = await replayDigest(merged);
assert(d1 === d2, `the co-authored world replays byte-identically (\n  ${d1}\n  ${d2})`);
assert(d1.startsWith("5|"), `the merged world has all 5 entities (digest=${d1})`);
// Every author's boxes are present (x = 0 base, 1&2 from A, 3&4 from B).
for (const x of [0, 1, 2, 3, 4]) {
  assert(d1.includes(`:${x.toFixed(4)},0.0000,0.0000`), `the co-authored world includes the box at x=${x} (digest=${d1})`);
}

// ── 4. Merge is symmetric in CONTENT: merging B first then A yields the same set of entities. ─
{
  const h2 = new WorldHistory(baseEdits);
  h2.fork("a", "main"); h2.extend("a", agentAEdits);
  h2.fork("b", "main"); h2.extend("b", agentBEdits);
  h2.merge("main", "b"); // B first this time
  h2.merge("main", "a");
  const d = await replayDigest(h2.commands("main"));
  assert(d.startsWith("5|"), `merging in the other order still yields all 5 entities (digest=${d})`);
  for (const x of [0, 1, 2, 3, 4]) assert(d.includes(`:${x.toFixed(4)},0.0000,0.0000`), `box x=${x} present regardless of merge order`);
}

ops.op_log(
  "p16_coedit OK: multi-agent co-edit over the shared world-log — two agents fork the same base, author " +
  "concurrently, and their divergent edits MERGE into one world that contains every contribution (5 entities), " +
  "replays byte-identically, and preserves all authors' boxes regardless of merge order. The Studio's collaboration core, proven.",
);
