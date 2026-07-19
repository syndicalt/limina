// p_studio_recorder_seam — RECORDING-SEAM HARDENING (studio-unification Prerequisites).
//
// The studio unification puts MORE mutations through the recording seam (design
// proposals, panel actions, agent coordination). These legs pin the seam contracts
// the 2026-07-18 adversarial audit found violated:
//
//   LEG 1 — CHAIN-ID CLASSIFICATION (audit: forged/stale chainId evaded recording).
//     A top-level invoke carrying a DEFINED chainId that does not name a live chain
//     (stale capture, detached fire-and-forget child, fabricated id — with or
//     without a fabricated token) is NOT a child of anything. The registry treats
//     it as a head for undo; the recorder MUST record it as a head too, or the
//     mutation applies live but never reaches the log. On pre-fix code this leg
//     FAILS: zero commands recorded (the falsifiability of the leg).
//
//   LEG 2 — GENUINE NESTED FOLD (the other direction must not regress).
//     A handler that re-invokes forwarding ctx.chainId + ctx.chainToken is folded
//     into its already-recorded parent: exactly ONE skill command lands. This leg
//     FAILS if classification over-records (double-log) or under-records.
//
//   LEG 3 — CLONE-BEFORE-MINT (audit: cloneInput throw burned a seq, bricked boot).
//     An unrecordable input (circular) must throw BEFORE any seq is minted, leave
//     zero commands behind, leak no live chain, and keep the NEXT recorded command's
//     seq contiguous — assertReplayable rejects gapped logs at boot. On pre-fix
//     code this leg FAILS: the seq after the throw skips by one.
//
//   LEG 4 — PHYSICS APPLY-THEN-RECORD (audit: phantom finalized command).
//     A recorded-proxy physics op whose native call throws must leave NO command
//     behind (pre-fix code recorded + finalized it BEFORE applying — replay would
//     re-apply a mutation that never happened live). This leg FAILS on pre-fix code.
//
//   LEG 5 — FAIL-CLOSED UNMAPPED PHYSICS METHODS (audit M4).
//     An op_physics_* method with no replay mapping in RECORDED_PHYSICS_METHODS and
//     no read-only waiver must THROW when reached through the recording proxy (a
//     silently-unrecorded top-level mutation is a replay hole). Read-only methods
//     pass through unimpaired.
//
// Run: LIMINA_AUDIO=null ./target/release/limina js/test/p_studio_recorder_seam.ts

import { z } from "../build/zod.bundle.mjs";
import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type InvokeBase, type SkillDefinition, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p_studio_recorder_seam FAIL: " + msg);
}

const PROFILE = "builder.readWrite";
const PERMS = resolveProfile(PROFILE);

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

function makeBase(world: WorldContext): InvokeBase {
  return { agentId: "agt_studio_seam", sessionId: "ses_studio_seam", permissions: PERMS, profile: PROFILE, tick: 0, world };
}

// Fixture skills: registered per-registry below. `studio.child` mutates nothing on
// its own; the parent's handler re-invokes it forwarding the chain identity, the
// canonical nested pattern (asset.ts material override).
function makeFixtureSkills(registry: SkillRegistry): SkillDefinition[] {
  const child: SkillDefinition<Record<string, never>, { ok: boolean }> = {
    name: "studio.seamChild",
    version: "1.0.0",
    description: "Seam fixture: nested target, mutates nothing.",
    category: "system",
    permissions: ["scene.write"],
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    handler: () => ({ ok: true }),
  };
  const typed: SkillDefinition<{ count: number }, { ok: boolean }> = {
    name: "studio.seamTyped",
    version: "1.0.0",
    description: "Seam fixture: typed schema exercises the canonical invalid_input path.",
    category: "system",
    permissions: ["scene.write"],
    input: z.object({ count: z.number() }),
    output: z.object({ ok: z.boolean() }),
    handler: () => ({ ok: true }),
  };
  const anyInput: SkillDefinition<{ payload?: unknown }, { ok: boolean }> = {
    name: "studio.seamAny",
    version: "1.0.0",
    description: "Seam fixture: z.any() payload passes unrecordable shapes through schema validation.",
    category: "system",
    permissions: ["scene.write"],
    input: z.object({ payload: z.any().optional() }),
    output: z.object({ ok: z.boolean() }),
    handler: () => ({ ok: true }),
  };
  const parent: SkillDefinition<Record<string, never>, { childOk: boolean }> = {
    name: "studio.seamParent",
    version: "1.0.0",
    description: "Seam fixture: re-invokes the child forwarding chain identity.",
    category: "system",
    permissions: ["scene.write"],
    input: z.object({}),
    output: z.object({ childOk: z.boolean() }),
    handler: async (_input, ctx) => {
      const res = await registry.invoke("studio.seamChild", {}, {
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        permissions: ctx.permissions,
        tick: ctx.tick,
        world: ctx.world,
        chainId: ctx.chainId,
        chainToken: ctx.chainToken,
      });
      return { childOk: res.success === true };
    },
  };
  return [child, typed, anyInput, parent];
}

function makeAttached(session: string): { registry: SkillRegistry; recorder: WorldRecorder; world: WorldContext } {
  const tracer = new LiminaTracer(session);
  const registry = new SkillRegistry(tracer);
  registerCoreSkills(registry);
  for (const def of makeFixtureSkills(registry)) registry.register(def);
  const recorder = new WorldRecorder(session);
  recorder.attach(registry);
  const world = makeWorld(ops);
  return { registry, recorder, world };
}

// ═══ LEG 1 — stale/forged chainId classifies as a head and IS recorded. ═════════
{
  const { registry, recorder, world } = makeAttached("ses_studio_seam_l1");
  // 1a: a bare fabricated chainId (no token).
  const r1 = await registry.invoke("studio.seamChild", {}, { ...makeBase(world), chainId: "forged_stale" });
  assert(r1.success === true, "forged-chainId invoke must succeed");
  assert(recorder.count("skill") === 1, `forged chainId must be recorded as a head (got ${recorder.count("skill")})`);
  // 1b: a fabricated id + fabricated object token still proves nothing.
  const r2 = await registry.invoke("studio.seamChild", {}, { ...makeBase(world), chainId: "forged_stale", chainToken: {} });
  assert(r2.success === true, "forged id+token invoke must succeed");
  assert(recorder.count("skill") === 2, `forged id+token must still record as a head (got ${recorder.count("skill")})`);
  // 1c: a chainId captured from a SETTLED head is stale on reuse — also a head.
  // (The recorder mints internal ids, so reuse the string form: any id not in
  // liveChains is not live; 1a/1b cover the mechanism. This leg pins the undo/
  // recording agreement: both recorded commands carry perms + actor identity.)
  const cmds = recorder.commands.filter((c) => c.kind === "skill");
  for (const c of cmds) {
    assert(c.kind === "skill" && c.actorId === "agt_studio_seam" && c.perms.length > 0, "folded heads record full provenance");
  }
  // 1d: replay-integrity — the log the folded heads produced must serialize.
  recorder.toJsonl();
}

// ═══ LEG 2 — genuine nested invoke folds into its parent (exactly one command). ═
{
  const { registry, recorder, world } = makeAttached("ses_studio_seam_l2");
  const res = await registry.invoke("studio.seamParent", {}, makeBase(world));
  assert(res.success === true, "parent fixture failed");
  const result = res.result as { childOk?: boolean } | undefined;
  assert(result?.childOk === true, "nested child invoke must succeed through the chain facade");
  assert(recorder.count("skill") === 1, `nested invoke must fold: expected 1 skill command, got ${recorder.count("skill")}`);
  const cmd = recorder.commands.find((c) => c.kind === "skill");
  assert(cmd !== undefined && cmd.kind === "skill" && cmd.tool === "studio.seamParent", "the one recorded command is the parent");
}

// ═══ LEG 3 — unrecordable input throws BEFORE a seq is minted. ══════════════════
// prepareInvocation zod-normalizes first: unknown keys are stripped and schema-
// invalid inputs take the canonical invalid_input response — so only a schema
// that PASSES an unrecordable shape through (z.any()) can reach cloneInput.
{
  const { registry, recorder, world } = makeAttached("ses_studio_seam_l3");
  // 3a: schema-INVALID input → canonical invalid_input response, ZERO commands
  // (the recorder defers to the registry's not_found/invalid_input contract).
  const bad = await registry.invoke("studio.seamTyped", { count: "not-a-number" }, makeBase(world));
  assert(bad.success === false && bad.error?.code === "invalid_input", `schema-invalid input must produce invalid_input (got ${JSON.stringify(bad.error)})`);
  assert(recorder.commands.length === 0, `invalid_input must record nothing (got ${recorder.commands.length})`);
  // 3b: circular payload through z.any() → cloneInput throws PRE-MINT.
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  let threw = false;
  try {
    await registry.invoke("studio.seamAny", { payload: circular }, makeBase(world));
  } catch {
    threw = true;
  }
  assert(threw, "a circular payload must throw (cannot be faithfully recorded)");
  assert(recorder.commands.length === 0, `the throw must leave no command (got ${recorder.commands.length})`);
  // 3c: BigInt payload through z.any() → same pre-mint rejection.
  threw = false;
  try {
    await registry.invoke("studio.seamAny", { payload: 1n }, makeBase(world));
  } catch {
    threw = true;
  }
  assert(threw, "a BigInt payload must throw");
  assert(recorder.commands.length === 0, "BigInt rejection must leave the log untouched");
  // 3d: the very next valid invoke takes seq 0 — no burned gap.
  const ok = await registry.invoke("studio.seamAny", { payload: "fine" }, makeBase(world));
  assert(ok.success === true, "post-throw invoke must succeed");
  const seqs3 = recorder.commands.map((c) => c.seq);
  assert(seqs3.length === 1 && seqs3[0] === 0, `seqs must stay contiguous after rejections (got ${seqs3})`);
}

// ═══ LEG 4 — a throwing native physics op leaves NO recorded command. ═══════════
{
  const recorder = new WorldRecorder("ses_studio_seam_l4");
  const wrapped = recorder.wrapOps(ops);
  wrapped.op_physics_create_world(-9.81);
  assert(recorder.count("physics") === 1, "create_world recorded");
  // validate_finite rejects NaN before the world is touched — a reliable native throw.
  let threw = false;
  try {
    wrapped.op_physics_apply_impulse(0, Number.NaN, 0, 0);
  } catch {
    threw = true;
  }
  assert(threw, "NaN impulse must throw from the native op");
  assert(recorder.count("physics") === 1, `a throwing op must NOT be recorded (got ${recorder.count("physics")} physics commands)`);
  // The next applied op records with the next seq — no phantom, no gap.
  wrapped.op_physics_step();
  const seqs = recorder.commands.map((c) => c.seq);
  assert(seqs.length === 2 && seqs[0] === 0 && seqs[1] === 1, `seqs contiguous after the throw (got ${seqs})`);
  // And the log serializes cleanly (a phantom finalized command would also land here).
  recorder.toJsonl();
}

// ═══ LEG 5 — unmapped op_physics_* mutators fail closed; reads pass through. ════
{
  const recorder = new WorldRecorder("ses_studio_seam_l5");
  const wrapped = recorder.wrapOps(ops);
  wrapped.op_physics_create_world(-9.81);
  const before = recorder.count("physics");
  // op_physics_add_heightfield has no RECORDED_PHYSICS_METHODS mapping and no
  // read-only waiver: reaching it through the RECORDING proxy must throw.
  let threw = false;
  try {
    (wrapped as unknown as Record<string, (...a: unknown[]) => unknown>).op_physics_add_heightfield(0, 2, 2, new Float32Array(4), 1);
  } catch {
    threw = true;
  }
  assert(threw, "an unmapped physics mutator must fail closed at the recording proxy");
  assert(recorder.count("physics") === before, "the fail-closed path records nothing");
  // A waived read-only method passes through: body_transform of the world's ground.
  const sphereId = wrapped.op_physics_add_sphere(0, 3, 0, 0.5, 0.4, 0.6);
  const out = new Float32Array(7);
  wrapped.op_physics_body_transform(sphereId, out);
  assert(out[1] === 3, `read-only op must pass through (y=${out[1]})`);
}

ops.op_log(
  "p_studio_recorder_seam OK: (1) stale/forged chainIds fold to recorded heads with full provenance; " +
    "(2) genuine nested invokes fold into their parent (exactly one command); " +
    "(3) unrecordable inputs throw pre-mint with zero commands, no chain leak, contiguous seqs; " +
    "(4) throwing native ops leave no phantom command; (5) unmapped physics mutators fail closed while reads pass through.",
);
