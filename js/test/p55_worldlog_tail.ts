// P55 -- worldlog.tail: the live editor viewport's authoring-stream feed (headless, deterministic).
//
// The live viewport re-authors the authoritative server's recorded command stream to render the
// world an agent is building. worldlog.tail exposes that stream incrementally, but FILTERED to
// AUTHORING commands: physics (world setup) + mutating skills, with the seed marker and the
// read-only introspection the editor itself polls (trace.tail / inspector.snapshot) EXCLUDED so
// loadWorld never replays a read or an unknown tool. worldCommandsToAuthor then translates the
// recorded WorldCommands into the AuthorCommand[] loadWorld consumes.
//
// Run: limina js/test/p55_worldlog_tail.ts   (exit 0 = pass)

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { registerWorldlogSkills, worldCommandsToAuthor } from "../src/skills/worldlog.ts";
import type { WorldCommand } from "../src/worldlog/log.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

const SESSION = "ses_p55";
const SEED = 0x55;
const BUILDER = resolveProfile("builder.readWrite");
let pass = 0;
function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p55_worldlog_tail: " + msg);
  pass++;
}
function ok(res: MCPResponse): Record<string, unknown> {
  if (!res.success) throw new Error("call failed: " + JSON.stringify(res.error));
  return res.result as Record<string, unknown>;
}
function makeWorld(worldOps: EngineOps): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene: scene as WorldContext["scene"],
    camera: camera as WorldContext["camera"], ops: worldOps, mode: "headless",
  };
}

// Wire a registry + recorder exactly as the AuthoritativeServer does (attach → seed → wrapOps).
const registry = new SkillRegistry(new LiminaTracer(SESSION));
registerCoreSkills(registry);
const recorder = new WorldRecorder(SESSION);
registerWorldlogSkills(registry, { recorder });
recorder.attach(registry);
recorder.seed(SEED);
const recOps = recorder.wrapOps(ops);
const world = makeWorld(recOps);
const base = { agentId: "agt_build", sessionId: SESSION, permissions: BUILDER, tick: 1, world };

// Author a MIX: a top-level physics op (world setup), two mutating skills, and a READ-ONLY poll.
recOps.op_physics_create_world(-9.81);
const e1 = ok(await registry.invoke("scene.createEntity", { shape: "box", position: [1, 2, 3] }, base)).entity as string;
ok(await registry.invoke("ecs.updateComponent", { entity: e1, component: "position", value: [4, 5, 6] }, base));
await registry.invoke("trace.tail", { afterSeq: -1 }, base); // read-only introspection — MUST be filtered out

// ---- A. worldlog.tail returns ONLY authoring commands, after the cursor -------------------------
const tail = ok(await registry.invoke("worldlog.tail", { since: 0 }, base)) as { commands: WorldCommand[]; next: number; reset: boolean };
const tools = tail.commands.filter((c) => c.kind === "skill").map((c) => (c as { tool: string }).tool);
assert(tools.includes("scene.createEntity"), "A: authoring scene.createEntity must be present");
assert(tools.includes("ecs.updateComponent"), "A: authoring ecs.updateComponent must be present");
assert(!tools.includes("trace.tail"), "A: read-only trace.tail must be EXCLUDED from the authoring stream");
assert(!tools.includes("worldlog.tail"), "A: the tail skill must exclude ITSELF (read-only)");
assert(tail.commands.some((c) => c.kind === "physics" && (c as { op: string }).op === "create_world"), "A: the world-setup physics op must be present (short name)");
assert(!tail.commands.some((c) => c.kind === "seed"), "A: the seed marker must be EXCLUDED");
assert(tail.reset === false, "A: no compaction → reset is false");

// ---- B. cursor advances: a second tail from `next` yields no NEW authoring commands -------------
const tail2 = ok(await registry.invoke("worldlog.tail", { since: tail.next }, base)) as { commands: WorldCommand[]; next: number };
assert(tail2.commands.filter((c) => c.kind === "skill" || c.kind === "physics").length === 0,
  `B: nothing authored since the cursor → empty authoring tail (got ${tail2.commands.length})`);
assert(tail2.next >= tail.next, "B: the cursor is monotonic");

// ---- C. worldCommandsToAuthor translates the stream loadWorld consumes --------------------------
const authored = worldCommandsToAuthor(tail.commands);
assert(!authored.some((c) => (c as { kind: string }).kind === "seed"), "C: translation drops the seed marker");
const phys = authored.find((c) => c.kind === "physics") as { kind: "physics"; op: string } | undefined;
assert(phys !== undefined && phys.op === "op_physics_create_world", `C: physics op remapped short→full (got ${phys?.op})`);
const createCmd = authored.find((c) => c.kind === "skill" && (c as { tool: string }).tool === "scene.createEntity") as { agentId?: string } | undefined;
assert(createCmd !== undefined && createCmd.agentId === "agt_build", "C: skill command carries actorId→agentId provenance");

ops.op_log(
  `p55_worldlog_tail OK: ${pass} assertions -- worldlog.tail exposes ONLY authoring commands ` +
    `(read-only polls + seed filtered), the cursor advances, and worldCommandsToAuthor translates ` +
    `the stream (physics op remapped, seed dropped) into loadWorld's AuthorCommand[].`,
);
