// P35 — adversarial boundary regressions from the production audit.
//
// These are small, explicit guards for three security/correctness failures:
//   1. MCP tools/list must expose only tools the initialized session can invoke.
//   2. Audit tools must require trace/audit read permission.
//   3. Replay/recovery must fail closed when a recorded skill cannot be re-applied.

import { EntityTable, ops } from "../src/engine.ts";
import { z } from "../build/zod.bundle.mjs";
import { createEcsWorld, MAX_ENTITIES, spawnRenderable } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { Mcp, StdioMcpTransport } from "../src/mcp/mcp.ts";
import type { JsonRpcResponse } from "../src/mcp/protocol.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { ReplayPlayer } from "../src/browser/player.ts";
import { DurableWorldLog } from "../src/worldlog/durable.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { replayCommands } from "../src/worldlog/replay.ts";
import type { WorldCommand } from "../src/worldlog/log.ts";
import type { LoadedExport } from "../src/export/package.ts";
import { base64ToBytes, parseSnapshot, SNAPSHOT_VERSION } from "../src/worldlog/snapshot.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p35_audit_boundary_regressions FAIL: " + msg);
}

function makeWorld(): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return {
    ecs,
    transforms: createTransformStorage(ecs),
    entities: new EntityTable(),
    tags: new Map(),
    scene,
    camera,
    ops,
    mode: "headless",
  };
}

function parseResponses(lines: readonly string[]): Map<string | number | null | undefined, JsonRpcResponse> {
  return new Map(lines.map((line) => {
    const response = JSON.parse(line) as JsonRpcResponse;
    return [response.id, response];
  }));
}

// 1. MCP tools/list is session-filtered. A player.limited session can read the
// scene, but must not be shown scene.createEntity because it lacks scene.write.
{
  const registry = new SkillRegistry(new LiminaTracer("ses_p35_mcp"));
  registerCoreSkills(registry);
  const writes: string[] = [];
  const transport = new StdioMcpTransport(new Mcp(registry, makeWorld()), (line) => writes.push(line), {
    allowedProfiles: new Set(["player.limited"]), specProfile: "player.limited",
  });
  await transport.handleLine(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { agentId: "agt_p35_player", sessionId: "ses_p35_player", profile: "player.limited" },
  }));
  await transport.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));
  const list = parseResponses(writes).get(2);
  const tools = (list?.result as { tools?: { name: string }[] } | undefined)?.tools ?? [];
  assert(tools.some((t) => t.name === "scene.queryEntities"), "player.limited should still see scene.queryEntities");
  assert(!tools.some((t) => t.name === "scene.createEntity"), "tools/list leaked scene.createEntity to player.limited");
}

// 2. Audit tools require trace/audit read permission. A player.limited session has
// no trace.read grant and must not be able to inspect the audit surface.
{
  const registry = new SkillRegistry(new LiminaTracer("ses_p35_audit"));
  registerCoreSkills(registry);
  const denied = await registry.invoke("audit.query", { decision: "all" }, {
    agentId: "agt_p35_player",
    sessionId: "ses_p35_player",
    profile: "player.limited",
    permissions: resolveProfile("player.limited"),
    tick: 0,
    world: makeWorld(),
  });
  assert(!denied.success && denied.error?.code === "forbidden", "audit.query was available without trace.read/audit.read");
}

// 3. Replay fails closed if a recorded skill cannot be re-applied. Silently
// continuing would certify a wrong reconstructed world.
{
  const commands: WorldCommand[] = [
    { kind: "seed", seq: 0, seed: 123 },
    {
      kind: "skill",
      seq: 1,
      tick: 1,
      tool: "scene.createEntity",
      input: { position: [0, 0, 0] },
      actorId: "agt_p35",
      sessionId: "ses_p35",
      perms: [],
    },
  ];
  let threw = false;
  try {
    await replayCommands(commands, {
      makeWorld,
      makeRegistry: (tracer) => {
        const registry = new SkillRegistry(tracer);
        registerCoreSkills(registry);
        return registry;
      },
      tracer: new LiminaTracer("ses_p35_replay"),
    });
  } catch (err) {
    threw = err instanceof Error && err.message.includes("scene.createEntity") && err.message.includes("forbidden");
  }
  assert(threw, "replayCommands ignored a failed skill invocation instead of throwing");
}

// 3b. Browser export playback must fail closed the same way as batch replay. It
// used to ignore MCPResponse.success and advance with a silently wrong world.
{
  const loaded: LoadedExport = {
    manifest: {
      kind: "limina.export",
      exportVersion: 1,
      worldId: "p35_player_failure",
      logVersion: 1,
      keyframeInterval: 1,
      ticks: 0,
      commands: 1,
      keyframes: 0,
      tiles: 0,
      assets: [],
      createdAt: "1970-01-01T00:00:00.000Z",
    },
    commands: [{
      kind: "skill",
      seq: 0,
      tick: 0,
      tool: "scene.createEntity",
      input: { position: [0, 0, 0] },
      actorId: "agt_p35",
      sessionId: "ses_p35",
      perms: [],
    }],
    keyframes: [],
    tiles: [],
    assets: [],
  };
  const player = new ReplayPlayer(loaded, {
    makeWorld: () => makeWorld(),
    makeRegistry: (tracer) => {
      const registry = new SkillRegistry(tracer);
      registerCoreSkills(registry);
      return registry;
    },
    tracer: new LiminaTracer("ses_p35_player_replay"),
  });
  let threw = false;
  try {
    await player.init();
  } catch (err) {
    threw = err instanceof Error && err.message.includes("scene.createEntity") && err.message.includes("forbidden");
  }
  assert(threw, "ReplayPlayer ignored a failed skill invocation instead of throwing");
}

// 4. Snapshot base64 rejects non-ASCII / out-of-table characters instead of
// silently OR-ing undefined as zero into the decoded bytes.
{
  let threw = false;
  try {
    base64ToBytes("Qé==");
  } catch (err) {
    threw = err instanceof Error && err.message.includes("invalid base64");
  }
  assert(threw, "base64ToBytes accepted a non-base64 character");
}

// 5. parseSnapshot validates load-bearing fields, especially rngState.
{
  const malformed = {
    snapshotVersion: SNAPSHOT_VERSION,
    sessionId: "ses_p35_snap",
    tick: 1,
    snapshotSeq: 1,
    entitySeq: 0,
    entityVersion: 0,
    entityIndex: {
      aliveCount: 0,
      maxId: 0,
      versioning: false,
      versionBits: 0,
      entityMask: 0,
      versionShift: 0,
      versionMask: 0,
      dense: [],
      sparse: [],
    },
    entities: [],
    characters: [],
    physics: "",
  };
  let threw = false;
  try {
    parseSnapshot(JSON.stringify(malformed));
  } catch (err) {
    threw = err instanceof Error && err.message.includes("malformed snapshot");
  }
  assert(threw, "parseSnapshot accepted a snapshot with no rngState");
}

// 6. spawnRenderable rejects eid values outside the fixed transform SoA capacity.
{
  const world = createEcsWorld();
  const object = { position: { set() {} }, quaternion: { set() {} }, scale: { set() {} } };
  let threw = false;
  for (let i = 0; i <= MAX_ENTITIES; i++) {
    try {
      spawnRenderable(world, object, 0, 0, 0);
    } catch (err) {
      threw = err instanceof Error && err.message.includes("MAX_ENTITIES");
      break;
    }
  }
  assert(threw, "spawnRenderable accepted an eid beyond MAX_ENTITIES");
}

// 7. Durable flushing waits for async skill commit-back. A flush while the handler
// is still pending must not persist a pre-commit command missing resolved identity.
{
  const registry = new SkillRegistry(new LiminaTracer("ses_p35_durable"));
  let release: (() => void) | undefined;
  const unblock = new Promise<void>((resolve) => { release = resolve; });
  registry.register({
    name: "p35.commitBack",
    version: "1.0.0",
    description: "test skill with async commitFields",
    category: "system",
    permissions: [],
    input: z.object({ name: z.string(), contentHash: z.string().optional() }),
    output: z.object({ contentHash: z.string() }),
    commitFields: ["contentHash"],
    async handler() {
      await unblock;
      return { contentHash: "sha256:p35" };
    },
  });
  const recorder = new WorldRecorder("ses_p35_durable");
  recorder.attach(registry);
  const durable = new DurableWorldLog(recorder, "p35_durable_commitback.jsonl");
  durable.open();
  const pending = registry.invoke("p35.commitBack", { name: "asset" }, {
    agentId: "agt_p35",
    sessionId: "ses_p35_durable",
    permissions: new Set(),
    tick: 1,
    world: makeWorld(),
  });
  await Promise.resolve();
  assert(durable.flush() === 0, "durable.flush persisted a skill command before async commit-back");
  assert(ops.op_read_trace("p35_durable_commitback.jsonl").length === 0, "pre-commit durable log should still be empty");
  release?.();
  const res = await pending;
  assert(res.success, "commit-back test skill failed");
  assert(durable.flush() === 1, "durable.flush did not persist the finalized skill command");
  const line = ops.op_read_trace("p35_durable_commitback.jsonl");
  assert(line.includes('"contentHash":"sha256:p35"'), "durable command did not include the commit-back field");
}

ops.op_log("p35_audit_boundary_regressions OK: least-privilege MCP/audit, replay fail-closed, strict snapshot/base64, ECS cap guard, durable commit-back flush ordering");
