// P111 — adversarial recorder/registry authority seam.
// Every successful top-level write records exactly once; every failed write
// records zero times; sequence numbers stay contiguous and outputs committed to
// the log are normalized, replay-serializable defensive snapshots.

import { z } from "../build/zod.bundle.mjs";
import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { SkillRegistry, type InvokeBase, type WorldContext } from "../src/skills/registry.ts";
import { parseWorldLog, type SkillCommand } from "../src/worldlog/log.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p111_recorder_authority_integrity FAIL: ${message}`);
}

function makeWorld(worldOps: EngineOps): WorldContext {
  const ecs = createEcsWorld();
  return {
    ecs,
    transforms: createTransformStorage(ecs),
    spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(),
    tags: new Map(),
    scene: { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null } as WorldContext["scene"],
    camera: { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} } as WorldContext["camera"],
    ops: worldOps,
    mode: "headless",
  };
}

function base(world: WorldContext): InvokeBase {
  return { agentId: "agt_p111", sessionId: "ses_p111", permissions: new Set(), tick: 1, world };
}

function skillCommands(recorder: WorldRecorder): SkillCommand[] {
  return recorder.commands.filter((command): command is SkillCommand => command.kind === "skill");
}

// Stale and guessed chain ids are independent heads unless accompanied by the
// exact live recorder-minted object capability. Genuine nesting forwards both.
{
  const registry = new SkillRegistry(new LiminaTracer("ses_p111_chain"));
  let writes = 0;
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  registry.register({
    name: "p111.write", version: "1.0.0", description: "counter write", category: "system",
    permissions: [], input: z.object({ value: z.number() }), output: z.object({ value: z.number() }),
    handler(input) { writes += input.value; return { value: writes }; },
  });
  registry.register({
    name: "p111.blocked", version: "1.0.0", description: "live-chain probe", category: "system",
    permissions: [], input: z.object({}), output: z.object({ ok: z.boolean() }),
    async handler() { await blocked; return { ok: true }; },
  });
  registry.register({
    name: "p111.parent", version: "1.0.0", description: "genuine nested write", category: "system",
    permissions: [], input: z.object({ value: z.number() }), output: z.object({ ok: z.boolean() }),
    async handler(input, ctx) {
      const response = await registry.invoke("p111.write", input, {
        ...base(ctx.world), chainId: ctx.chainId, chainToken: ctx.chainToken,
      });
      return { ok: response.success };
    },
  });
  const recorder = new WorldRecorder("ses_p111_chain");
  recorder.attach(registry);
  const world = makeWorld(recorder.wrapOps(ops));

  const stale = await registry.invoke("p111.write", { value: 1 }, { ...base(world), chainId: "chain_stale" });
  assert(stale.success && skillCommands(recorder).length === 1, "stale chain id evaded top-level recording");

  const pending = registry.invoke("p111.blocked", {}, base(world)); // predictable live chain_1
  await Promise.resolve();
  const forged = await registry.invoke("p111.write", { value: 2 }, { ...base(world), chainId: "chain_1" });
  assert(forged.success, "forged-id independent head failed");
  release?.();
  assert((await pending).success, "blocked head failed");
  assert(skillCommands(recorder).length === 3, "forged live chain id folded into another command");

  const beforeParent = skillCommands(recorder).length;
  const parent = await registry.invoke("p111.parent", { value: 4 }, base(world));
  assert(parent.success, "genuine nested call failed");
  assert(skillCommands(recorder).length === beforeParent + 1, "genuine nested call was recorded twice");
  assert(writes === 7, `expected all three writes to execute exactly once, got ${writes}`);
}

// Clone/preparation failures and native throws cannot burn a sequence or create
// phantom finalized commands. Unknown physics mutators fail before application.
{
  let nativeAdds = 0;
  let unsupportedMutations = 0;
  const target = new Proxy(ops, {
    get(object, property, receiver) {
      if (property === "op_physics_add_box") return () => { nativeAdds++; throw new Error("native add failed"); };
      if (property === "op_physics_set_body_transform") return () => { unsupportedMutations++; };
      return Reflect.get(object, property, receiver);
    },
  }) as EngineOps;
  const registry = new SkillRegistry(new LiminaTracer("ses_p111_seq"));
  registry.register({
    name: "p111.number", version: "1.0.0", description: "number write", category: "system",
    permissions: [], input: z.object({ value: z.number() }), output: z.object({ ok: z.boolean() }),
    handler() { return { ok: true }; },
  });
  const recorder = new WorldRecorder("ses_p111_seq");
  recorder.attach(registry);
  const wrapped = recorder.wrapOps(target);
  const world = makeWorld(wrapped);

  const invalid = await registry.invoke("p111.number", { value: 1n }, base(world));
  assert(!invalid.success && invalid.error?.code === "invalid_input", "invalid uncloneable input did not return structured invalid_input");
  const valid = await registry.invoke("p111.number", { value: 3 }, base(world));
  assert(valid.success, "valid invocation after clone failure failed");
  assert(recorder.commands.length === 1 && recorder.commands[0].seq === 0, "clone failure burned a sequence");

  let physicsThrew = false;
  try { wrapped.op_physics_add_box(0, 0, 0, 1); } catch { physicsThrew = true; }
  assert(physicsThrew && nativeAdds === 1, "throwing native mutator fixture did not execute exactly once");
  assert(recorder.commands.length === 1, "native throw left a phantom physics command");

  let unmappedThrew = false;
  try { wrapped.op_physics_set_body_transform(1, 0, 0, 0, 0, 0, 0, 1); } catch { unmappedThrew = true; }
  assert(unmappedThrew && unsupportedMutations === 0, "unmapped physics mutator crossed the authority boundary");

  wrapped.op_physics_create_world(0);
  assert(recorder.commands.length === 2 && recorder.commands[1].seq === 1, "successful physics op after failures was not contiguous");
  const parsed = parseWorldLog(recorder.toJsonl());
  assert(parsed.commands.length === 2 && parsed.commands.every((command, index) => command.seq === index), "serialized restart stream is not contiguous");
}

// Zod-normalized output is the only output seen by hooks/callers/commit-back;
// commit fields are snapshotted, and non-replayable commits roll back live state.
{
  const registry = new SkillRegistry(new LiminaTracer("ses_p111_output"));
  let hookSawSecret = false;
  let live = 0;
  let inputTransforms = 0;
  registry.register({
    name: "p111.transformedInput", version: "1.0.0", description: "one-shot input normalization", category: "system",
    permissions: [],
    input: z.object({ value: z.number().transform((value) => { inputTransforms++; return value + 1; }) }),
    output: z.object({ seen: z.number() }),
    handler(input) { return { seen: input.value }; },
  });
  registry.register({
    name: "p111.commit", version: "1.0.0", description: "normalized committed output", category: "system",
    permissions: [], input: z.object({ hash: z.object({ value: z.string() }).optional() }),
    output: z.object({ hash: z.object({ value: z.string() }) }), commitFields: ["hash"],
    hooks: { after(result) { hookSawSecret = "secret" in (result as Record<string, unknown>); } },
    handler() { return { hash: { value: "sha256:p111" }, secret: "must-strip" }; },
  });
  registry.register({
    name: "p111.badCommit", version: "1.0.0", description: "non-replayable committed output", category: "system",
    permissions: [], input: z.object({ payload: z.unknown().optional() }), output: z.object({ payload: z.unknown() }), commitFields: ["payload"],
    handler(_input, ctx) {
      live++;
      ctx.undo("p111.live", () => { live--; });
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      return { payload: circular };
    },
  });
  const recorder = new WorldRecorder("ses_p111_output");
  recorder.attach(registry);
  const world = makeWorld(recorder.wrapOps(ops));

  const transformed = await registry.invoke("p111.transformedInput", { value: 4 }, base(world));
  assert(transformed.success && (transformed.result as { seen: number }).seen === 5, "handler did not receive normalized input");
  assert(inputTransforms === 1, `input transform ran ${inputTransforms} times instead of once`);
  assert((skillCommands(recorder)[0].input as { value: number }).value === 5, "recorder did not snapshot normalized input");

  const response = await registry.invoke("p111.commit", {}, base(world));
  assert(response.success && !hookSawSecret && !("secret" in (response.result as Record<string, unknown>)), "raw output escaped Zod normalization");
  const command = skillCommands(recorder)[1];
  const returnedHash = (response.result as { hash: { value: string } }).hash;
  returnedHash.value = "mutated-after-return";
  assert(((command.input as { hash: { value: string } }).hash.value) === "sha256:p111", "caller mutation rewrote a recorded commit field");

  const before = recorder.commands.length;
  const bad = await registry.invoke("p111.badCommit", {}, base(world));
  assert(!bad.success && bad.error?.code === "contract_error", "non-replayable commit field was accepted");
  assert(live === 0, "non-replayable commit field escaped the armed rollback frame");
  assert(recorder.commands.length === before, "failed commit-field validation left a command");
}

ops.op_log("P111 recorder authority integrity OK");
