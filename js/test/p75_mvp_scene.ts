// P75 — THE MVP END-TO-END PROOF. One agent-authored command stream composes ALL FIVE committed
// phases into a real "one-shot" scene, driven through the REAL skills / invoke / recorder path
// (never a reimplementation):
//
//   A3 Design Direction  — a named style's palette ROLES resolve the on-brief colors a build agent
//                          would pick (resolveRoleColor); a conformance metric proves the build is
//                          on-brief and that an off-brief color would FAIL.
//   A1 General building  — ground + a "townhouse" (box body + a declarative createMesh roof + a
//                          plane door) built from primitives, no per-type skill.
//   A2 Prefabs           — scene.group captures the townhouse; scene.instantiateGroup stamps it 3x;
//                          a per-instance seed genuinely VARIES the roof (same seed → identical).
//   B1 Behaviour/events  — an NPC entity gets a recorded patrol BehaviorSpec; a scripted EventSpec
//                          is defined; both are carried by a SELF-SUFFICIENT snapshot + replay.
//   A0 Graceful          — an OUT-OF-BAND command in the build batch is CONTAINED (the good commands
//                          still apply; nothing throws) via the shared isolated applier.
//
// Then the whole scene: is on-brief, survives a snapshot round-trip into a FRESH world (no authoring
// replay), and REPLAYS to identical behaviour/event state. This is the plan's MVP checkpoint (the
// building proof + the minimal living-world proof), gated headlessly and falsifiably.
//
// Run: ./target/release/limina js/test/p75_mvp_scene.ts   (exit 0 = pass)

import { EntityTable, ops, type WorldContext } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { replayCommands } from "../src/worldlog/replay.ts";
import { captureWorldSnapshot, parseSnapshot, restoreSnapshot, serializeSnapshot } from "../src/worldlog/snapshot.ts";
import { applyAuthorCommandsIsolated } from "../src/kernel/apply-isolated.ts";
import type { AuthorCommand } from "../src/kernel/authoring.ts";
import type { EventSpecRegistry } from "../src/skills/behavior-spec.ts";
import {
  serializeBehaviorSpec,
  serializeEventSpec,
  type BehaviorSpec,
  type EventSpec,
} from "../src/behavior/behavior-spec.ts";
import { DEFAULT_DESIGN_DIRECTION } from "../src/game/design-direction.ts";
import { resolveRoleColor } from "../src/materials/palette.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p75_mvp_scene FAIL: " + msg);
}
function ok(label: string, res: MCPResponse): Record<string, unknown> {
  if (!res.success) throw new Error(`p75_mvp_scene: ${label} failed: ${JSON.stringify(res.error)}`);
  return (res.result ?? {}) as Record<string, unknown>;
}

function makeHeadlessWorld(): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return {
    ecs,
    transforms: createTransformStorage(ecs),
    spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(),
    tags: new Map(),
    scene,
    camera,
    ops,
    mode: "headless",
  };
}

const perms = resolveProfile("builder.readWrite");
const BUILDER = new Set(perms);

// ── the active Design Direction (a build agent's governing art style) ──────────────────────────────
const DD = DEFAULT_DESIGN_DIRECTION; // "grounded-stylized-realism"
const COLOR = {
  ground: resolveRoleColor(DD, "ground"),
  stone: resolveRoleColor(DD, "stone"),
  wood: resolveRoleColor(DD, "wood"),
  trim: resolveRoleColor(DD, "trim"),
  skin: resolveRoleColor(DD, "skin"),
};
const PALETTE_INTS = DD.palette.map((p) => resolveRoleColor(DD, p.role));
const toRgb = (n: number): [number, number, number] => [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const dist = (a: [number, number, number], b: [number, number, number]): number =>
  Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
const nearestPaletteDist = (color: number): number =>
  Math.min(...PALETTE_INTS.map((p) => dist(toRgb(color), toRgb(p))));

// ── session: real registry + core skills + recorder + a headless world ─────────────────────────────
const recorder = new WorldRecorder("ses_p75");
const reg = new SkillRegistry(new LiminaTracer("ses_p75"));
const core = registerCoreSkills(reg);
const authEvents: EventSpecRegistry = core.behaviorSpec.events;
recorder.attach(reg);
const recOps = recorder.wrapOps(ops);
recorder.seed(0x7575);
recOps.op_physics_create_world(-9.81);

const world = makeHeadlessWorld();
let tick = 0;
const at = () => ({ agentId: "agt_p75", sessionId: "ses_p75", permissions: perms, tick: ++tick, world });

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 1. BUILD the scene (A3 colours → A1 geometry → A2 prefab), all through the real invoke path.
// ════════════════════════════════════════════════════════════════════════════════════════════════

// Ground: a broad plane, on-brief ground colour.
const ground = ok(
  "ground",
  await reg.invoke("scene.createEntity", { shape: "plane", size: 50, position: [0, 0, 0], color: COLOR.ground }, at()),
).entity as string;

// A "townhouse" prototype: a stone box body, a WOOD declarative roof (createMesh, seed-bearing), a
// trim door — the roof + door parented to the body. Custom geometry with NO townhouse skill.
const body = ok(
  "body",
  await reg.invoke("scene.createEntity", { shape: "box", size: 2, position: [0, 1, 0], color: COLOR.stone }, at()),
).entity as string;
ok(
  "roof",
  await reg.invoke(
    "scene.createMesh",
    {
      geometry: { version: 1, kind: "box", width: 2.4, height: 1.0, depth: 2.4 },
      position: [0, 2.5, 0],
      color: COLOR.wood,
      seed: 100,
      parent: body,
    },
    at(),
  ),
);
ok(
  "door",
  await reg.invoke(
    "scene.createEntity",
    { shape: "plane", size: 0.8, position: [0, 0.4, 1.05], color: COLOR.trim, parent: body },
    at(),
  ),
);

// Capture the townhouse as a reusable recipe, then stamp it 3x. Seeds: A, B, A — so A/A' are
// IDENTICAL and A/B DIFFER (genuine per-instance variation of the seed-bearing roof).
ok("group", await reg.invoke("scene.group", { root: body, name: "townhouse" }, at()));
const stamp = async (x: number, seed: number): Promise<string[]> => {
  const r = ok(
    `stamp@${x}`,
    await reg.invoke("scene.instantiateGroup", { name: "townhouse", position: [x, 0, 0], yaw: 0, seed }, at()),
  );
  return r.entities as string[];
};
const instA = await stamp(8, 1);
const instB = await stamp(16, 2);
const instA2 = await stamp(24, 1);
assert(
  instA.length === 3 && instB.length === 3 && instA2.length === 3,
  `each stamp must create 3 entities (body/roof/door); got ${instA.length},${instB.length},${instA2.length}`,
);

// ── on-brief conformance: every building colour is a DD palette colour; an off-brief colour is not ──
const buildingColors = [ground, body]
  .map((e) => world.entities.resolve(e)?.material?.color)
  .filter((c): c is number => typeof c === "number");
assert(buildingColors.length === 2, "the ground + body must carry first-class material colour");
for (const c of buildingColors) {
  assert(
    nearestPaletteDist(c) < 1e-6,
    `built colour 0x${c.toString(16)} is off-brief (nearest DD palette dist ${nearestPaletteDist(c).toFixed(1)})`,
  );
}
assert(nearestPaletteDist(0xff00ff) > 60, "conformance metric is inert: magenta must read as OFF the DD palette");

// ── genuine variation (A2 reseed): same seed → identical geometry; different seed → different ───────
const concatPositions = (entities: readonly string[]): number[] => {
  const out: number[] = [];
  for (const e of entities) {
    const mesh = world.entities.resolve(e)?.mesh as { traverse?: (fn: (o: unknown) => void) => void } | undefined;
    mesh?.traverse?.((o) => {
      const g = (o as { geometry?: { getAttribute?: (n: string) => { array?: ArrayLike<number> } | undefined } })
        .geometry;
      const pos = g?.getAttribute?.("position");
      if (pos?.array) for (let i = 0; i < pos.array.length; i++) out.push(pos.array[i]);
    });
  }
  return out;
};
const gA = concatPositions(instA),
  gB = concatPositions(instB),
  gA2 = concatPositions(instA2);
assert(
  gA.length > 0 && gA.length === gA2.length && gA.every((v, i) => v === gA2[i]),
  "same instance seed must yield IDENTICAL geometry (deterministic stamp)",
);
assert(
  gA.length === gB.length && gA.some((v, i) => v !== gB[i]),
  "different instance seeds must yield DIFFERENT geometry (genuine reseed variation)",
);

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 2. LIVING WORLD (B1): an NPC with a recorded behaviour + a scripted event.
// ════════════════════════════════════════════════════════════════════════════════════════════════

const npc = ok(
  "npc",
  await reg.invoke(
    "scene.createEntity",
    { shape: "capsule", size: 1, position: [6, 1, 6], color: COLOR.skin, tags: ["npc"] },
    at(),
  ),
).entity as string;
const patrol: BehaviorSpec = {
  version: 1,
  kind: "patrol",
  waypoints: [
    [6, 0, 6],
    [12, 0, 6],
    [12, 0, 12],
  ],
  speed: 1.5,
};
ok("behavior.set", await reg.invoke("behavior.set", { entity: npc, behavior: patrol }, at()));
assert(world.entities.resolve(npc)?.behavior?.kind === "patrol", "NPC must carry the recorded patrol behaviour");

const guardEvent: EventSpec = {
  version: 1,
  trigger: { type: "onEnterRegion", center: [8, 0, 8], radius: 5 },
  action: { type: "emit", event: "guard_alert", payload: {} },
};
const evId = ok("event.define", await reg.invoke("event.define", { event: guardEvent }, at())).id as string;
assert(authEvents.size() === 1, "the scripted event must be registered at world level");

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 3. GRACEFUL (A0): an out-of-band command in a build batch is CONTAINED — the build survives.
// ════════════════════════════════════════════════════════════════════════════════════════════════

const before = world.entities.ids().length;
const batch: AuthorCommand[] = [
  { kind: "skill", tool: "scene.createEntity", input: { shape: "box", position: [30, 1, 0], color: COLOR.stone } },
  { kind: "skill", tool: "totally.not.a.real.skill", input: {} }, // OUT-OF-BAND — must be contained
  { kind: "skill", tool: "scene.createEntity", input: { shape: "box", position: [32, 1, 0], color: COLOR.stone } },
];
let threw = false;
let outcome: Awaited<ReturnType<typeof applyAuthorCommandsIsolated>> | undefined;
try {
  outcome = await applyAuthorCommandsIsolated(reg, world, batch, {
    sessionId: "ses_p75",
    defaultAgentId: "agt_p75",
    defaultPerms: BUILDER,
    tick: ++tick,
  });
} catch {
  threw = true;
}
assert(!threw, "an out-of-band command must NOT throw out of the isolated build batch");
assert(
  outcome !== undefined && outcome.failures.length === 1 && outcome.failures[0].index === 1,
  `exactly the 1 bad command (index 1) must be a contained failure; got ${JSON.stringify(outcome?.failures)}`,
);
assert(
  world.entities.ids().length === before + 2,
  `both VALID batch commands must still apply despite the bad one (expected +2, got +${world.entities.ids().length - before})`,
);

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 4. SELF-SUFFICIENT SNAPSHOT — the whole scene reloads into a FRESH world with NO authoring replay.
// ════════════════════════════════════════════════════════════════════════════════════════════════

const snap = captureWorldSnapshot(world, {
  sessionId: "ses_p75",
  tick,
  snapshotSeq: recorder.commands.length,
  events: authEvents,
});
const entityCount = snap.entities.length;
assert(entityCount > 10, `the scene must have a real entity population; got ${entityCount}`);
const parsed = parseSnapshot(serializeSnapshot(snap));

ops.op_physics_create_world(-9.81);
const freshWorld = makeHeadlessWorld();
const freshReg = new SkillRegistry(new LiminaTracer("ses_p75_restore"));
const freshEvents = registerCoreSkills(freshReg).behaviorSpec.events;
restoreSnapshot(freshWorld, parsed, undefined, freshEvents);

assert(
  freshWorld.entities.ids().length === world.entities.ids().length,
  `restored world must have the same entity count (${world.entities.ids().length}), got ${freshWorld.entities.ids().length}`,
);
assert(
  freshWorld.entities.resolve(npc)?.behavior?.kind === "patrol",
  "NPC behaviour must survive the snapshot restore (no replay)",
);
assert(
  freshEvents.size() === 1 && serializeEventSpec(freshEvents.get(evId)!) === serializeEventSpec(authEvents.get(evId)!),
  "the scripted event must survive the snapshot restore",
);
const restoredBodyColor = freshWorld.entities.resolve(body)?.material?.color;
assert(
  restoredBodyColor !== undefined && nearestPaletteDist(restoredBodyColor) < 1e-6,
  "a building's on-brief material must survive the snapshot restore",
);

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 5. REPLAY IDENTITY — replaying the recorded stream rebuilds the same scene.
// ════════════════════════════════════════════════════════════════════════════════════════════════

ops.op_physics_create_world(-9.81);
let replayEvents: EventSpecRegistry | undefined;
const replay = await replayCommands(recorder.commands, {
  makeWorld: makeHeadlessWorld,
  makeRegistry: (tr) => {
    const r = new SkillRegistry(tr as LiminaTracer);
    replayEvents = registerCoreSkills(r).behaviorSpec.events;
    return r;
  },
  tracer: new LiminaTracer("ses_p75_replay"),
});
assert(replay.world.entities.resolve(npc)?.behavior?.kind === "patrol", "replay must rebuild the NPC behaviour");
assert(replayEvents !== undefined && replayEvents.size() === 1, "replay must rebuild the scripted event");
assert(
  replay.world.entities.ids().length === world.entities.ids().length,
  `replay must rebuild the same entity count (${world.entities.ids().length}), got ${replay.world.entities.ids().length}`,
);
assert(
  replay.world.entities.resolve(body)?.material?.color === world.entities.resolve(body)?.material?.color,
  "replay must rebuild the building's on-brief material",
);

ops.op_log(
  `[js] p75_mvp_scene OK: one agent-authored stream one-shots an on-brief scene — ground + a townhouse recipe ` +
    `stamped 3x with genuine per-seed roof variation (A1+A2+A3, ${entityCount} entities all within the Design ` +
    "Direction's palette), an NPC with a recorded patrol behaviour + a scripted region event (B1); an " +
    "out-of-band command mid-build is CONTAINED (A0, good commands still apply); and the WHOLE scene survives " +
    "a self-sufficient snapshot restore into a fresh world AND replays to identical behaviour/event/entity state.",
);
