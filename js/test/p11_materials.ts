// Phase 2b — the GENERAL MATERIAL SYSTEM. Two deliverables, both FALSIFIABLE + headless:
//
//   A. PROCEDURAL-PBR FOR PRIMITIVES (palette). `createMaterial(name, { pbr:true })` and
//      `scene.createEntity({ material, pbr:true })` upgrade a flat preset to a tactile
//      procedural-PBR surface — colorNode + a VIEW-SPACE detail normalNode + roughnessNode,
//      driven by the SAME baked 256² triplanar detail noise the terrain uses. OPT-IN: the flat
//      default sets NONE of those nodes (byte-identical to before) — proven by control asserts.
//
//   B. TEXTURE-PACK IMPORT (material.import). Imports a CC0 image set (albedo + normal +
//      roughness) BY content-addressed id as a NAMED material usable by createEntity/setMaterial.
//      Proves the REAL portability contract (mirrors asset.place): content-addressed + stable
//      hash; the recorder COMMITS the hashes into the log; the bytes ride assets.jsonl; a REAL
//      round-trip replays the import from the SERIALIZED package (guarded vs the native asset
//      root) and rebuilds the material; a swapped/pinned-mismatch texture is REJECTED.
//
// Run: limina js/test/p11_materials.ts   (exit 0 = pass)

import { EntityTable, ops, type EngineOps, type SceneObject } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills, type CoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { createMaterial } from "../src/materials/palette.ts";
import { AssetRegistry } from "../src/asset-registry.ts";
import { assembleExport, loadExport, exportAssetBundle } from "../src/export/package.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { replayCommands } from "../src/worldlog/replay.ts";
import type { SkillCommand } from "../src/worldlog/log.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p11_materials FAIL: " + msg);
}
function ok(res: MCPResponse): Record<string, unknown> {
  if (!res.success) throw new Error("call failed: " + JSON.stringify(res.error));
  assert(typeof res.result === "object" && res.result !== null, "expected result object");
  return res.result as Record<string, unknown>;
}
function field(value: unknown, key: string): unknown {
  if (typeof value === "object" && value !== null && key in value) return (value as Record<string, unknown>)[key];
  return undefined;
}
// deno-lint-ignore no-explicit-any
const isSet = (n: any) => n !== undefined && n !== null;

// Traverse a built TSL node graph; collect referenced texture widths (teeth: prove the node
// actually references the 256² detail singleton, not just a non-null scalar).
// deno-lint-ignore no-explicit-any
function texWidths(root: any): number[] {
  const seen = new Set<unknown>(); const texW = new Set<number>();
  // deno-lint-ignore no-explicit-any
  function walk(n: any) {
    if (!n || typeof n !== "object" || seen.has(n)) return; seen.add(n);
    if (n.isTextureNode && n.value && n.value.image) texW.add(n.value.image.width);
    if (typeof n.getChildren === "function") for (const c of n.getChildren()) walk(c);
  }
  walk(root);
  return [...texW];
}
// The immediate children's constructor/method tags of a (VarNode) root node — used to prove the
// normalNode root WRAPS the transformNormalToView Fn call (ShaderCallNodeInternal) and is NOT the
// inverted `transformDirection(vec, cameraViewMatrix)` math node (the cut-1 inverted-normal bug).
// deno-lint-ignore no-explicit-any
function rootChildTags(root: any): string[] {
  if (typeof root.getChildren !== "function") return [];
  // deno-lint-ignore no-explicit-any
  return [...root.getChildren()].map((k: any) => (k.constructor?.name ?? "?") + (typeof k.method === "string" ? ":" + k.method : ""));
}
// Falsifiable VIEW-SPACE detail-normal teeth (mirrors p11_terrain_pbr.ts:99-101): references the
// 256² detail texture (not bare clay) AND its root applies transformNormalToView, NOT the
// inverted-rotation transformDirection form. `label` names the failing material in the message.
// deno-lint-ignore no-explicit-any
function assertViewSpaceDetailNormal(normalNode: any, label: string): void {
  assert(texWidths(normalNode).includes(256), `${label} normalNode must reference the shared 256² detail texture (else it is clay)`);
  const tags = rootChildTags(normalNode);
  assert(tags.includes("ShaderCallNodeInternal"), `${label} normalNode root must wrap the transformNormalToView Fn call (got [${tags}])`);
  assert(!tags.some((t) => t === "_MathNode:transformDirection"), `${label} normalNode must NOT apply transformDirection at the root (the inverted-rotation bug) (got [${tags}])`);
}

ops.op_physics_create_world(0);
const BUILDER = resolveProfile("builder.readWrite");

function makeWorld(worldOps: EngineOps): WorldContext {
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  const ecs = createEcsWorld();
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene, camera, ops: worldOps, mode: "headless",
  };
}

// ===========================================================================
// A. PROCEDURAL-PBR FOR PRIMITIVES
// ===========================================================================

// (A1) createMaterial flat default sets NO PBR nodes (opt-in / back-compat control).
const flatRock = createMaterial("rock");
// deno-lint-ignore no-explicit-any
const fr = flatRock as any;
assert(!isSet(fr.colorNode) && !isSet(fr.normalNode) && !isSet(fr.roughnessNode),
  "flat createMaterial must NOT set colorNode/normalNode/roughnessNode (opt-in regression)");
assert(fr.color.getHex() === 0x6f675e, "flat rock lost its preset base color");

// (A2) createMaterial({ pbr:true }) sets all three PBR nodes + the normal/color reference the
// shared 256² detail texture (falsifiable: a clay/flat material references no 256² texture).
const pbrRock = createMaterial("rock", { pbr: true });
// deno-lint-ignore no-explicit-any
const pr = pbrRock as any;
assert(isSet(pr.colorNode) && isSet(pr.normalNode) && isSet(pr.roughnessNode),
  "pbr createMaterial must set colorNode + normalNode + roughnessNode");
// VIEW-SPACE detail normal (NOT the inverted transformDirection form) + references the 256² noise.
assertViewSpaceDetailNormal(pr.normalNode, "pbr createMaterial");
assert(texWidths(pr.colorNode).includes(256), "pbr colorNode must reference the shared 256² detail texture (procedural albedo mottle)");

// (A3) Per-call knob override flows through.
const pbrRock2 = createMaterial("rock", { pbr: true, pbrKnobs: { mottle: 0.4 } });
// deno-lint-ignore no-explicit-any
assert(isSet((pbrRock2 as any).normalNode), "pbr with knob override must still build");

// (A4) Via the skill: scene.createEntity({ material, pbr }) yields the PBR primitive; without
// pbr it is the flat preset (control).
const recTracer = new LiminaTracer("ses_p11_mat_author");
const authReg = new SkillRegistry(recTracer);
const authCore: CoreSkills = registerCoreSkills(authReg);
const recorder = new WorldRecorder("ses_p11_mat_author");
recorder.attach(authReg);
const authWorld = makeWorld(ops);
const authCtx = { agentId: "agt_builder", sessionId: "ses_p11_mat_author", permissions: BUILDER, tick: 0, world: authWorld };

const pbrEnt = field(ok(await authReg.invoke("scene.createEntity", { shape: "box", material: "stone", pbr: true, position: [0, 1, 0] }, authCtx)), "entity");
// deno-lint-ignore no-explicit-any
const pbrMat = authWorld.entities.resolve(pbrEnt as string)?.mesh?.material as any;
assert(isSet(pbrMat?.colorNode) && isSet(pbrMat?.normalNode) && isSet(pbrMat?.roughnessNode),
  "createEntity({material,pbr:true}) must produce a procedural-PBR material");
assertViewSpaceDetailNormal(pbrMat.normalNode, "createEntity pbr");

const flatEnt = field(ok(await authReg.invoke("scene.createEntity", { shape: "box", material: "stone", position: [2, 1, 0] }, authCtx)), "entity");
// deno-lint-ignore no-explicit-any
const flatMat = authWorld.entities.resolve(flatEnt as string)?.mesh?.material as any;
assert(!isSet(flatMat?.colorNode) && !isSet(flatMat?.normalNode), "createEntity without pbr must stay flat (opt-in)");
assert(flatMat.color.getHex() === 0x9b9890, "flat createEntity lost the stone preset color");

// ===========================================================================
// B. TEXTURE-PACK IMPORT  (content-addressed + export round-trip, like asset.place)
// ===========================================================================
const ALBEDO = "limina-hero.png";
const NORMAL = "limina-x-header.png";
const ROUGH = "limina-hero.png"; // reuse a real PNG for the roughness slot

// (B1) Content-addressed images: stable, byte-sensitive hashes.
const reg = new AssetRegistry();
const aHash = reg.resolve(ALBEDO).hash;
const nHash = reg.resolve(NORMAL).hash;
assert(aHash.startsWith("sha256:") && aHash.length > "sha256:".length, `albedo not a real sha256: ${aHash}`);
assert(aHash === reg.resolve(ALBEDO).hash, "albedo resolve not content-addressed (two resolves differ)");
assert(nHash.startsWith("sha256:") && nHash !== aHash, "distinct images must content-address differently");

// (B2) Author a material.import: resolves + decodes the pack → a NAMED material; returns pinned hashes.
const PACK = "herostone";
const importRes = ok(await authReg.invoke("material.import", {
  name: PACK, albedo: ALBEDO, normal: NORMAL, roughness: ROUGH,
}, authCtx));
assert(importRes.name === PACK, "material.import returned the wrong name");
const importedHashes = importRes.hashes as Record<string, string>;
assert(importedHashes[ALBEDO] === aHash && importedHashes[NORMAL] === nHash, "material.import did not pin the resolved image hashes");

// The built material carries the decoded maps (UV mode → map/normalMap/roughnessMap).
// deno-lint-ignore no-explicit-any
const built = authCore.materials.build(PACK) as any;
assert(isSet(built.map) && isSet(built.map.image) && built.map.image.data instanceof Uint8Array,
  "imported material has no decoded albedo map (texture-pack import failed to decode)");
assert(isSet(built.normalMap) && isSet(built.roughnessMap), "imported material missing the normal/roughness maps");
assert(built.map.image.width > 0 && built.map.image.data.length === built.map.image.width * built.map.image.height * 4,
  "imported albedo decoded to a malformed RGBA buffer");

// (B3) The imported NAME is usable by scene.createEntity (the whole point — primitives upgrade to the pack).
const packEnt = field(ok(await authReg.invoke("scene.createEntity", { shape: "sphere", material: PACK, position: [4, 1, 0] }, authCtx)), "entity");
// deno-lint-ignore no-explicit-any
const packMat = authWorld.entities.resolve(packEnt as string)?.mesh?.material as any;
assert(isSet(packMat?.map) && isSet(packMat?.map?.image), "createEntity({material:<imported pack>}) did not apply the imported maps");

// (B4) A TRIPLANAR import builds node-based color/normal/roughness (no UVs needed).
const TPACK = "herostone_tri";
ok(await authReg.invoke("material.import", { name: TPACK, albedo: ALBEDO, normal: NORMAL, roughness: ROUGH, triplanar: true, scale: 0.4 }, authCtx));
// deno-lint-ignore no-explicit-any
const triMat = authCore.materials.build(TPACK) as any;
assert(isSet(triMat.colorNode) && isSet(triMat.normalNode) && isSet(triMat.roughnessNode), "triplanar import must set colorNode/normalNode/roughnessNode");
// The imported triplanar normal must ALSO be a real VIEW-SPACE detail normal referencing the
// decoded normal-map texture, NOT the inverted transformDirection form (same trap as the terrain).
const triNormalTex = texWidths(triMat.normalNode);
assert(triNormalTex.length > 0 && triNormalTex.some((w) => w > 0), "triplanar import normalNode must reference the decoded normal-map texture (else it samples nothing)");
const triTags = rootChildTags(triMat.normalNode);
assert(triTags.includes("ShaderCallNodeInternal"), `triplanar import normalNode root must wrap the transformNormalToView Fn call (got [${triTags}])`);
assert(!triTags.some((t) => t === "_MathNode:transformDirection"), `triplanar import normalNode must NOT apply transformDirection at the root (the inverted-rotation bug) (got [${triTags}])`);

// (B5) The RECORDER committed the hashes into the recorded command (pins authored identity; FALSIFIABLE).
const importCmd = recorder.commands.find((c): c is SkillCommand => c.kind === "skill" && c.tool === "material.import" && (c.input as Record<string, unknown>).name === PACK);
assert(importCmd !== undefined, "material.import not recorded as a command");
const cmdInput = importCmd.input as Record<string, unknown>;
const cmdHashes = cmdInput.hashes as Record<string, string> | undefined;
assert(cmdHashes !== undefined && cmdHashes[ALBEDO] === aHash && cmdHashes[NORMAL] === nHash,
  "recorder did NOT commit the image hashes into the replay log (authored pack identity unpinned)");
assert(!("b64" in cmdInput) && !("bytes" in cmdInput), "recorded import command must carry the request, not bytes");

// (B6) Assemble the export — the IMAGE bytes ride assets.jsonl; the log carries no bytes.
const files = assembleExport({
  worldId: "p11mat", meta: recorder.meta(), commands: recorder.commands, keyframes: [],
  keyframeInterval: 10, createdAt: "2026-01-01T00:00:00Z",
  assets: authCore.assets.bundle(),
});
assert(files["assets.jsonl"].length > 0, "assets.jsonl is empty (image bytes did not ride the export)");
const assetIds = files["assets.jsonl"].split("\n").filter((l) => l.length > 0).map((l) => (JSON.parse(l) as { id: string }).id);
assert(assetIds.includes(ALBEDO) && assetIds.includes(NORMAL), "export assets.jsonl missing the imported pack images");

// (B7) REAL round-trip: reload from the SERIALIZED package and replay the import from it — NOT
// the native asset root (a guard host throws on op_read_asset, so success proves package origin).
const loaded = loadExport(files, ops);
assert(loaded.assets.length >= 2, "export did not round-trip the image bytes");
const guardOps: EngineOps = new Proxy(ops, {
  get(t, p, r) {
    if (p === "op_read_asset") return (id: string) => { throw new Error(`p11_materials: native asset root must not be read on replay (id=${id})`); };
    return Reflect.get(t, p, r);
  },
}) as EngineOps;

let replayCore: CoreSkills | undefined;
async function replayFromPackage(commands: SkillCommand[], tracer: LiminaTracer): Promise<void> {
  await replayCommands(commands, {
    makeWorld: () => makeWorld(guardOps),
    makeRegistry: (tr) => {
      const r = new SkillRegistry(tr as LiminaTracer);
      const pkgReg = AssetRegistry.fromBundle(exportAssetBundle(loaded), guardOps);
      replayCore = registerCoreSkills(r, { assets: pkgReg });
      return r;
    },
    tracer,
  });
}
await replayFromPackage(recorder.commands, new LiminaTracer("ses_p11_mat_replay"));
assert(replayCore !== undefined, "replay did not construct a core");
// The material was rebuilt from the PACKAGE images (op_read_asset was a hard error during replay).
assert(replayCore.materials.has(PACK), "replay did not rebuild the imported material from the package");
// deno-lint-ignore no-explicit-any
const replayedMat = replayCore.materials.build(PACK) as any;
assert(isSet(replayedMat.map) && isSet(replayedMat.map.image) && replayedMat.map.image.data instanceof Uint8Array,
  "replayed imported material has no decoded albedo map (did not load from package bytes)");
assert(replayCore.materials.hashesOf(PACK)[ALBEDO] === aHash, "replayed imported material lost the pinned albedo hash");

// (B8) Pin enforcement: a WRONG committed hash is REJECTED on replay (FALSIFIABLE — drop the
// handler's hash check and this loads a swapped texture).
const pkgReg2 = AssetRegistry.fromBundle(exportAssetBundle(loaded), guardOps);
const pinReg = new SkillRegistry(new LiminaTracer("ses_p11_mat_pin"));
registerCoreSkills(pinReg, { assets: pkgReg2 });
const pinCtx = { agentId: "a", sessionId: "s", permissions: BUILDER, tick: 0, world: makeWorld(guardOps) };
const pinOk = await pinReg.invoke("material.import", { name: PACK, albedo: ALBEDO, normal: NORMAL, roughness: ROUGH, hashes: { [ALBEDO]: aHash, [NORMAL]: nHash } }, pinCtx);
assert(pinOk.success, `pinned import with the correct hashes should load: ${JSON.stringify(pinOk.error)}`);
const pinBad = await pinReg.invoke("material.import", { name: PACK, albedo: ALBEDO, normal: NORMAL, roughness: ROUGH, hashes: { [ALBEDO]: nHash } }, pinCtx);
assert(!pinBad.success && JSON.stringify(pinBad.error).includes("content hash mismatch"),
  "replay did NOT verify the committed image hash (a swapped texture would load)");

ops.op_log(
  `p11_materials OK: (A) procedural-PBR primitives — createMaterial/createEntity { pbr } set colorNode+normalNode+roughnessNode wired to the shared 256² triplanar detail noise; flat default sets none (opt-in). ` +
  `(B) material.import resolves ${assetIds.length} content-addressed images → a NAMED material (UV + triplanar) usable by createEntity; recorder commits the hashes (pinned); bytes ride assets.jsonl; replay rebuilds the material from the SERIALIZED package (guarded vs native root); a swapped/pinned-mismatch texture is rejected.`,
);
