// EXPORT GENERATOR — bakes the Phase 14 CAPSTONE "The Relic Hunt" (the SAME authored world as
// js/src/demos/capstone_window.ts: buildCapstone, SEED=7331, a plains island with a quest-giver,
// three relics and a scorched-ground hazard) into a portable, browser-loadable EXPORT BUNDLE for
// the marketing site's live /examples playback — the capstone twin of tools/export-island.ts.
//
// It records the INITIAL authored game state (no playthrough): buildCapstone authors terrain +
// navmesh + player + NPC + relics + quest + dialogue + hazard through the recorded skill surface,
// then we attach the rigged glTF player + NPC models (three.loadGLTF robot.glb) posed in their idle
// clip and PIN their render transform with a recorded three.setTransform so the browser replay
// reproduces the posed characters from the package alone. The baked terrain TILES + the rigged-glTF
// and scatter ASSET bytes ride the bundle, so the browser rebuilds the world with no host asset root.
//
// The world has no driven bodies (the browser orbits a static, idle scene), so keyframes are EMPTY.
//
// RUN (regenerate the bundle on disk):
//   ./target/release/limina tools/export-relic-hunt.ts | node tools/write-relic-hunt-bundle.mjs
// The limina script emits the bundle JSON between markers; the node writer persists the files to
// site/public/examples/relic-hunt/. Verified headlessly: loadExport round-trips.

import * as THREE from "../js/build/three.bundle.mjs";
import { EntityTable, ops } from "../js/src/engine.ts";
import { createEcsWorld } from "../js/src/ecs/world.ts";
import { createTransformStorage } from "../js/src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../js/src/spatial/index.ts";
import { LiminaTracer } from "../js/src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../js/src/skills/registry.ts";
import { registerCoreSkills } from "../js/src/skills/index.ts";
import { resolveProfile } from "../js/src/skills/permissions.ts";
import { WorldRecorder } from "../js/src/worldlog/recorder.ts";
import { assembleExport, loadExport } from "../js/src/export/package.ts";
import { attachCharacterModel } from "../js/src/world/character_model.ts";
import { buildCapstone, SEED, CAPSTONE_LAYOUT } from "../js/src/demos/capstone_game.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("export-relic-hunt FAIL: " + msg);
}

// Warm THREE's lazy init on the DEFAULT rng before the seeded rng is installed, so the recorded
// run and any later replay draw the same seeded stream (mirrors export-island.ts).
void new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 16), new THREE.MeshStandardNodeMaterial({ color: 0x808080 }));
void new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardNodeMaterial({ color: 0x808080 }));

// ── A headless world context. mode:"windowed" makes buildCapstone author the VISIBLE world
//    (procedural-PBR terrain surface + biome scatter) — the same data path export-island proves
//    runs headlessly without a live renderer. ──────────────────────────────────────────────────
const ecs = createEcsWorld();
const scene = new THREE.Scene();
const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
const tracer = new LiminaTracer("ses_export_relic_hunt");
const registry = new SkillRegistry(tracer);
const core = registerCoreSkills(registry);
const recorder = new WorldRecorder("ses_export_relic_hunt");
recorder.attach(registry);
recorder.seed(SEED); // deterministic PRNG seed -> recorded so replay reinstalls it
const recOps = recorder.wrapOps(ops);
const world: WorldContext = {
  ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
  entities: new EntityTable(), tags: new Map(), scene: scene as WorldContext["scene"],
  camera: camera as WorldContext["camera"], ops: recOps, mode: "windowed",
};
const base = { agentId: "agt_export_relic_hunt", sessionId: "ses_export_relic_hunt", permissions: resolveProfile("builder.readWrite"), tick: 0, world };

// Recorded so a replay recreates the physics world before re-applying the authored state.
recOps.op_physics_create_world(-9.81);

// ── AUTHOR THE GAME — the shared, deterministic builder (terrain + navmesh + player + NPC +
//    relics + quest + dialogue + hazard), identical to the headless gate + the window demo. ─────
const capstone = await buildCapstone({ world, registry, core, base });

// ── RIGGED CHARACTER MODELS — the player + NPC visuals. attachCharacterModel records a
//    three.loadGLTF (carrying robot.glb into the bundle) + starts the idle clip; we then PIN the
//    auto-fit scale + foot-placed transform with a recorded three.setTransform so the browser
//    replay reproduces the posed model (the render-only setPose/scale are direct SoA writes that
//    do NOT ride the command log — three.setTransform does). ──────────────────────────────────
async function placeCharacter(footPos: [number, number, number], yaw: number): Promise<void> {
  const model = await attachCharacterModel({
    world, registry, base, animationManager: core.animation.animationManager,
    position: footPos,
  });
  // Record the final render transform (auto-fit scale + foot-fit Y + facing) so replay matches.
  const r = await registry.invoke("three.setTransform", {
    entity: model.entity,
    position: [footPos[0], footPos[1] + model.footY, footPos[2]],
    rotationEuler: [0, yaw, 0],
    scale: [model.scale, model.scale, model.scale],
  }, base);
  assert(r.success === true, "three.setTransform (character pin) failed: " + JSON.stringify(r.error));
}

// The NPC's authored scene-anchor box (the dialogue/bubble anchor) is a placeholder marker; the
// rigged robot below IS the NPC's visual. Shrink the box away (recorded → the browser replay hides
// it too) so the showcase shows a clean character, not a robot inside a debug cube.
const hideBox = await registry.invoke("three.setTransform", { entity: capstone.npcEntity, scale: [1e-4, 1e-4, 1e-4] }, base);
assert(hideBox.success === true, "three.setTransform (hide NPC anchor) failed: " + JSON.stringify(hideBox.error));

const pPos = capstone.playerController.position;
const groundOffset = capstone.playerController.groundOffset;
const playerFoot: [number, number, number] = [pPos[0], pPos[1] - groundOffset, pPos[2]];
await placeCharacter(playerFoot, capstone.playerController.facing);

const nPos = capstone.npcPos();
await placeCharacter([nPos[0], nPos[1], nPos[2]], capstone.npcFacing());

// ── ASSEMBLE the portable export (no keyframes — the scene is static + idle) ────────────────────
const tileEntries = core.terrain.cache.entries();
const assetBundle = core.assets.bundle();
const files = assembleExport({
  worldId: "limina-relic-hunt",
  meta: recorder.meta(),
  commands: recorder.commands,
  keyframes: [],
  keyframeInterval: 20,
  createdAt: "2026-01-01T00:00:00Z",
  tiles: tileEntries,
  assets: assetBundle,
});
assert(files["tiles.jsonl"].length > 0, "region tiles did not ride the export");
assert(files["assets.jsonl"].length > 0, "asset bytes did not ride the export");

// ── VERIFY: loadExport round-trips (the exact files a browser reads back) ───────────────────────
const loaded = loadExport(files, ops);
assert(loaded.manifest.kind === "limina.export", "manifest kind wrong");
assert(loaded.manifest.exportVersion === 1, "manifest exportVersion wrong");
assert(loaded.commands.length === recorder.commands.length, "command count lost on round-trip");
assert(loaded.tiles.length === tileEntries.length, "tile count lost on round-trip");
assert(loaded.assets.length === assetBundle.length, "asset count lost on round-trip");
assert(loaded.assets.some((a) => a.id === "robot.glb"), "rigged character asset (robot.glb) missing from bundle");

// ── Camera framing for the live page — orbit the authored layout (spawn + NPC + relics). ────────
const pts: readonly (readonly [number, number])[] = [
  CAPSTONE_LAYOUT.spawn, CAPSTONE_LAYOUT.npc, ...CAPSTONE_LAYOUT.relics,
];
const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
const cz = pts.reduce((s, p) => s + p[1], 0) / pts.length;
const groundY = pPos[1] - groundOffset;
const view = {
  center: [Math.round(cx * 10) / 10, Math.round((groundY + 1.4) * 10) / 10, Math.round(cz * 10) / 10],
  radius: 20,
  height: 11,
  maxRadius: 42,
  maxHeight: 26,
  far: 600,
};

const assetIds = loaded.assets.map((a) => a.id).join(", ");
console.log(
  `RELIC EXPORT OK: ${loaded.commands.length} commands, ${loaded.tiles.length} tiles, ${loaded.assets.length} assets ` +
  `(${assetIds}); ${loaded.keyframes.length} keyframes; player @${playerFoot.map((n) => n.toFixed(1)).join(",")}, ` +
  `npc @${nPos.map((n) => n.toFixed(1)).join(",")}`,
);

// Emit the bundle (+ the recommended camera view) for the node writer to persist.
console.log("===LIMINA_BUNDLE_BEGIN===");
console.log(JSON.stringify({ files, view }));
console.log("===LIMINA_BUNDLE_END===");
