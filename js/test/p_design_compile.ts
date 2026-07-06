// K6 GATE -- compile sibling design artifacts into the GDS.
//
// Proves worldBible/cast/storyboard remain sibling design artifacts, but compile into the existing
// GameDesignSpec shape and the existing world-compile path. The compiler is pure/deterministic:
// this gate validates the merged GDS, authors its world slice through authorWorldSlice, and pins
// cast/entity plus storyboard->DoD assertion projection.
//
// Run: ./target/release/limina js/test/p_design_compile.ts   (exit 0 = pass)

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { validateGDS, type Assertion, type GameDesignSpec } from "../src/game/gds.ts";
import { authorWorldSlice } from "../src/game/world-compile.ts";
import { compileDesignToGds } from "../src/game/design-compile.ts";
import type { Cast } from "../src/game/cast.ts";
import type { Storyboard } from "../src/game/storyboard.ts";
import type { WorldBible } from "../src/game/world-bible.ts";
import type { DesignArtifactStore } from "../src/world/design-artifacts.ts";

let pass = 0;
function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p_design_compile FAIL: " + message);
  pass++;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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

const baseGds: GameDesignSpec = {
  id: "design-compile-sample",
  pitch: "A compact frontier quest assembled from sibling design artifacts.",
  loopSentence: "Explore the hamlet, speak to allies, gather supplies, and secure the beacon.",
  controls: { scheme: "keyboard-mouse", intents: [{ name: "move-forward", binding: "KeyW" }] },
  winCondition: "The beacon is secured.",
  loseCondition: "The hamlet falls.",
  artDirection: "Grounded stylized medieval frontier.",
  targetPlatforms: ["web"],
  scopeTier: "prototype",
  optIn: "record+export",
  entities: [
    { id: "player", name: "Placeholder Hero", role: "player" },
    { id: "wolf", name: "Blighted Wolf", role: "hazard", states: ["idle"] },
  ],
  mechanics: [{ id: "move", name: "Move", skill: "player.move" }],
  content: [],
  dod: [{
    id: "base-win",
    statement: "The base concept remains automated.",
    kind: "state-transition",
    drives: { steps: [{ forward: 1 }], assert: [{ check: "gameState", value: "won" }] },
  }],
};

const worldBible: WorldBible = {
  version: "world-bible/1",
  setting: {
    name: "Hearthmere",
    era: "late medieval frontier",
    premise: "A river hamlet braces for a blight moving out of the marsh.",
  },
  regions: [
    { id: "green-march", name: "Green March", biome: "temperate-forest", climate: "misty", description: "Wet forest and pasture." },
    { id: "salt-marsh", name: "Salt Marsh", biome: "marsh", description: "Low reeds and old causeways." },
  ],
  locations: [
    { id: "hearthmere", name: "Hearthmere", regionId: "green-march", kind: "settlement", description: "A palisaded river hamlet.", position: [4, -2] },
    { id: "old-beacon", name: "Old Beacon", regionId: "salt-marsh", kind: "landmark", description: "A cold signal tower.", position: [18, 12] },
  ],
  map: { width: 64, height: 64, notes: "test map" },
};

const cast: Cast = {
  version: "cast/1",
  player: { id: "player", name: "Warden", archetype: "guard", brief: { motive: "keep the beacon lit" } },
  npcs: [
    { id: "elder-mara", name: "Mara", archetype: "elder", role: "quest giver", locationId: "hearthmere" },
    { id: "scout-iven", name: "Iven", archetype: "villager", role: "scout", locationId: "old-beacon" },
  ],
};

const storyboard: Storyboard = {
  version: "storyboard/1",
  beats: [{ id: "arrival", title: "Arrival", description: "The warden reaches Hearthmere.", locationId: "hearthmere", castIds: ["player", "elder-mara"] }],
  quests: [{
    id: "first-light",
    name: "First Light",
    giverId: "elder-mara",
    steps: [
      { id: "raise-flag", objective: "Raise the camp ready flag.", kind: "flag", target: "camp_ready", value: "true" },
      { id: "gather-reeds", objective: "Gather three dry reeds.", kind: "counter", target: "reeds", value: 3 },
      { id: "reach-beacon", objective: "Reach the beacon.", kind: "reach", target: "old-beacon" },
      { id: "talk-mara", objective: "Report to Mara.", kind: "talk", target: "elder-mara" },
      { id: "collect-lens", objective: "Collect the beacon lens.", kind: "collect", target: "beacon_lens" },
    ],
  }],
};

// (a) a store without gds returns the required issue and no spec.
{
  const result = compileDesignToGds({ artifacts: new Map([["cast", cast]]) } as DesignArtifactStore);
  assert(result.gds === undefined, "missing concept GDS must not return a spec");
  assert(result.issues.length === 1 && result.issues[0].path === "gds" && result.issues[0].message === "concept GDS required",
    `missing concept GDS issue must be exact (got ${JSON.stringify(result.issues)})`);
}

const store: DesignArtifactStore = {
  artifacts: new Map([
    ["gds", clone(baseGds)],
    ["worldBible", clone(worldBible)],
    ["cast", clone(cast)],
    ["storyboard", clone(storyboard)],
  ]),
};

const compiled = compileDesignToGds(store);
assert(compiled.gds !== undefined, `filled store must return a GDS, issues: ${JSON.stringify(compiled.issues)}`);
assert(compiled.issues.length === 0, `filled store must not return issues: ${JSON.stringify(compiled.issues)}`);

// (b) a sample filled store compiles to a valid GameDesignSpec.
const validation = validateGDS(compiled.gds);
assert(validation.ok && validation.data !== undefined, `compiled GDS must validate: ${JSON.stringify(validation.issues)}`);
const gds = validation.data;

// (c) the produced world slice is accepted by world-compile and authors entity placements. Unsourced
// environment content placements are the existing collected-failure path until content sourcing runs.
ops.op_physics_create_world(-9.81);
const registry = new SkillRegistry(new LiminaTracer("p_design_compile"));
registerCoreSkills(registry);
const world = makeWorld(ops);
const authored = await authorWorldSlice(registry, world, gds, {
  sessionId: "p_design_compile",
  tick: 1,
  defaultAgentId: "design_compile_gate",
  defaultPerms: resolveProfile("builder.readWrite"),
});
assert(authored.placementToEntity.has("entity-player"), "world-compile must author the player placement");
assert(authored.placementToEntity.has("entity-elder-mara"), "world-compile must author an NPC placement");
assert(authored.placementToEntity.has("entity-scout-iven"), "world-compile must author each NPC placement");
assert(authored.failures.filter((f) => f.id.startsWith("location-")).length === worldBible.locations.length,
  `unsourced location environment placements must be collected as content failures: ${JSON.stringify(authored.failures)}`);

// (d) each cast NPC is present as an npc entity, and the player is present as the sole player.
assert(gds.entities.filter((e) => e.role === "player").length === 1, "compiled GDS must have exactly one player");
assert(gds.entities.some((e) => e.id === "player" && e.name === "Warden" && e.role === "player"), "cast player must project to the GDS player entity");
for (const npc of cast.npcs) {
  assert(gds.entities.some((e) => e.id === npc.id && e.name === npc.name && e.role === "npc"),
    `cast NPC ${npc.id} must project to a GDS npc entity`);
}

// (e) each storyboard quest step maps to a DoD assertion of the right check kind.
const projectedChecks = new Map<string, Assertion["check"]>();
for (const dod of gds.dod) {
  for (const assertion of dod.drives?.assert ?? []) {
    if (assertion.target !== undefined) projectedChecks.set(`${dod.id}:${assertion.target}`, assertion.check);
  }
}
const expected: Array<[string, Assertion["check"]]> = [
  ["story-first-light-raise-flag:camp_ready", "flagTrue"],
  ["story-first-light-gather-reeds:reeds", "counterAtLeast"],
  ["story-first-light-reach-beacon:18,12", "playerReachedXZ"],
  ["story-first-light-talk-mara:talked:elder-mara", "flagTrue"],
  ["story-first-light-collect-lens:collected:beacon_lens", "flagTrue"],
];
for (const [key, check] of expected) {
  assert(projectedChecks.get(key) === check, `storyboard step ${key} must map to ${check}; got ${projectedChecks.get(key)}`);
}

ops.op_log(
  `p_design_compile OK: ${pass} assertions -- missing gds is rejected; worldBible/cast/storyboard ` +
    `compile into a valid GDS; authorWorldSlice authors player+NPC placements while collecting unsourced ` +
    `location asset placements; cast entities and storyboard assertion checks are projected faithfully.`,
);
