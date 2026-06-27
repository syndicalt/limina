// Phase 11 — content-addressed asset registry + asset.place, proving the REAL
// "ships everywhere + replays + verifies" contract (not just in-engine plumbing):
//
//   1. The registry content-addresses a real bundled GLTF (stable, byte-sensitive).
//   2. asset.place spawns an entity carrying the hash; the place REQUEST hits the
//      trace (assetId + transform + hash, NEVER bytes).
//   3. The RECORDER commits the resolved content hash into the recorded command,
//      so the replay LOG pins authored identity (FAILS on revert of commitFields).
//   4. The export SERIALIZES the asset BYTES (assets.jsonl); the command log carries
//      only the request (no bytes).
//   5. A REAL round-trip: read the package back from its SERIALIZED form (NOT the
//      native asset root — proven by a guard that throws on op_read_asset), build a
//      package-backed registry, and REPLAY the recorded command into a fresh world —
//      the asset loads from the package bytes with the expected metadata.
//   6. Replay VERIFIES the loaded bytes against the committed hash (a swapped asset
//      is rejected — FAILS on revert of the verify).
//   7. loadExport / verifyExportAssets recompute the hash from the round-tripped
//      bytes and reject a tamper.

import { EntityTable, ops, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerCoreSkills } from "../src/skills/index.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { AssetRegistry, assetContentHash } from "../src/asset-registry.ts";
import { assembleExport, loadExport, exportAssetBundle, verifyExportAssets } from "../src/export/package.ts";
import { WorldRecorder } from "../src/worldlog/recorder.ts";
import { replayCommands } from "../src/worldlog/replay.ts";
import type { SkillCommand } from "../src/worldlog/log.ts";
import type { MCPResponse } from "../src/mcp/protocol.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p11_asset_place FAIL: " + msg);
}
function ok(res: MCPResponse): Record<string, unknown> {
  if (!res.success) throw new Error("call failed: " + JSON.stringify(res.error));
  assert(typeof res.result === "object" && res.result !== null, "expected result object");
  return res.result as Record<string, unknown>;
}

ops.op_physics_create_world(0);

const ASSET = "textured-triangle.gltf";
const GLB = "triangle.glb";

function makeWorld(worldOps: EngineOps): WorldContext {
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  const ecs = createEcsWorld();
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene, camera, ops: worldOps, mode: "headless",
  };
}
const BUILDER = resolveProfile("builder.readWrite");

// 1. Registry content-addresses a real bundled GLTF (stable + byte-sensitive) -----
const reg = new AssetRegistry();
const r1 = reg.resolve(ASSET);
assert(r1.hash.startsWith("sha256:") && r1.hash.length > "sha256:".length, `not a real sha256: ${r1.hash}`);
assert(r1.hash === reg.resolve(ASSET).hash, "two resolves differ (not content-addressed)");
const glbHash = reg.resolve(GLB).hash;
assert(glbHash.startsWith("sha256:") && glbHash !== r1.hash, "distinct assets must content-address differently");
const tampered = r1.bytes.slice(); tampered[0] ^= 0xff;
assert(assetContentHash(tampered) !== r1.hash, "content hash unchanged when bytes changed (hashing is vacuous)");
assert(reg.verify(r1.bytes, r1.hash) && !reg.verify(tampered, r1.hash), "registry.verify does not check the content address");

// 2 + 3. Record an asset.place; the RECORDER commits the hash into the log --------
const recWorld = makeWorld(ops);
const recTracer = new LiminaTracer("ses_p11_author");
const authReg = new SkillRegistry(recTracer);
const authCore = registerCoreSkills(authReg);
const recorder = new WorldRecorder("ses_p11_author");
recorder.attach(authReg); // patches invoke to record + commit-back
const placeArgs = { assetId: ASSET, position: [1, 2, 3], rotation: [0, Math.PI / 2, 0], scale: [2, 2, 2] };
const authCtx = { agentId: "agt_builder", sessionId: "ses_p11_author", permissions: BUILDER, tick: 0, world: recWorld };
const placed = ok(await authReg.invoke("asset.place", placeArgs, authCtx));
assert(placed.hash === r1.hash, "authoring resolved a different content hash than the registry");
assert((placed.resource as Record<string, unknown>).hash === placed.hash, "resource metadata is missing the content hash");

// The place REQUEST rode the trace (assetId + transform + hash; no bytes).
const placeEvent = recTracer.trace("agt_builder").find((ev) => ev.type === "asset.placed");
assert(placeEvent !== undefined, "asset.placed request not on the trace");
const pl = placeEvent.payload as Record<string, unknown>;
assert(pl.assetId === ASSET && pl.hash === r1.hash && Array.isArray(pl.position), "trace request missing assetId/hash/transform");

// THE COMMIT: the recorded command's input now carries the resolved hash (pins the
// authored identity in the LOG). FALSIFIABLE — removing commitFields drops this.
const placeCmd = recorder.commands.find((c): c is SkillCommand => c.kind === "skill" && c.tool === "asset.place");
assert(placeCmd !== undefined, "asset.place not recorded as a command");
const cmdInput = placeCmd.input as Record<string, unknown>;
assert(cmdInput.hash === r1.hash, "recorder did NOT commit the content hash into the replay log (authored identity unpinned)");
assert(cmdInput.assetId === ASSET && !("bytes" in cmdInput) && !("b64" in cmdInput), "recorded command must carry the request, not bytes");

// 4. Assemble the export — bytes ride assets.jsonl; the LOG carries no bytes -------
const files = assembleExport({
  worldId: "p11", meta: recorder.meta(), commands: recorder.commands, keyframes: [],
  keyframeInterval: 10, createdAt: "2026-01-01T00:00:00Z",
  assets: authCore.assets.bundle(),
});
assert(files["assets.jsonl"].length > 0, "assets.jsonl is empty (asset bytes did not ride the export)");
const assetLine = JSON.parse(files["assets.jsonl"].split("\n")[0]) as { id: string; hash: string; b64: string };
assert(assetLine.id === ASSET && assetLine.hash === r1.hash && assetLine.b64.length > 0, "assets.jsonl missing base64 bytes");
// The heavy bytes live ONLY in assets.jsonl, never the command log.
assert(!files["log.jsonl"].includes(assetLine.b64.slice(0, 48)), "asset bytes leaked into the command log (must be request-only)");

// 5. REAL round-trip: reload from the SERIALIZED package, NOT the native root ------
const loaded = loadExport(files, ops);
assert(loaded.assets.length === 1, "export did not round-trip the asset bytes");
const back = loaded.assets[0];
assert(back.id === ASSET && back.hash === r1.hash && back.bytes.length === r1.bytes.length, "round-tripped asset bytes/hash wrong");
let bytesIdentical = true;
for (let i = 0; i < r1.bytes.length; i++) if (r1.bytes[i] !== back.bytes[i]) { bytesIdentical = false; break; }
assert(bytesIdentical, "round-tripped asset bytes are not byte-identical");

// A guard host: reading the native asset root during replay is a HARD ERROR, so a
// successful replay PROVES the bytes came from the serialized package, not op_read_asset.
const guardOps: EngineOps = new Proxy(ops, {
  get(t, p, r) {
    if (p === "op_read_asset") return (id: string) => { throw new Error(`p11: native asset root must not be read on replay (id=${id})`); };
    return Reflect.get(t, p, r);
  },
}) as EngineOps;

// Replay the recorded command into a fresh world whose ONLY asset source is the
// package bundle (built from the round-tripped bytes).
async function replayFromPackage(commands: SkillCommand[], tracer: LiminaTracer): Promise<MCPResponse | undefined> {
  let last: MCPResponse | undefined;
  await replayCommands(commands, {
    makeWorld: () => makeWorld(guardOps),
    makeRegistry: (tr) => {
      const r = new SkillRegistry(tr as LiminaTracer);
      const pkgReg = AssetRegistry.fromBundle(exportAssetBundle(loaded), guardOps);
      registerCoreSkills(r, { assets: pkgReg });
      // capture the asset.place result for assertions (replayCommands ignores it)
      const inner = r.invoke.bind(r);
      r.invoke = (n, i, b) => inner(n, i, b).then((res) => { if (n === "asset.place") last = res; return res; });
      return r;
    },
    tracer,
  });
  return last;
}
const rt1 = new LiminaTracer("ses_p11_replay1");
const replayRes = await replayFromPackage(recorder.commands, rt1);
assert(replayRes !== undefined && replayRes.success, `replay-from-package asset.place failed: ${JSON.stringify(replayRes?.error)}`);
const replayedResource = ok(replayRes).resource as Record<string, unknown>;
assert(replayedResource.hash === r1.hash, "replayed asset has the wrong content hash");
assert((replayedResource.meshCount as number) >= 1 && replayedResource.assetId === ASSET, "replayed asset metadata missing (did not load from package bytes)");
// Deterministic: a second fresh replay yields the same entity id + hash.
const replayRes2 = ok((await replayFromPackage(recorder.commands, new LiminaTracer("ses_p11_replay2")))!);
assert(replayRes2.entity === ok(replayRes).entity && replayRes2.hash === r1.hash, "nondeterministic replay (entity/hash)");

// 6. Replay VERIFIES the committed hash — a swapped asset is rejected --------------
const pkgReg = AssetRegistry.fromBundle(exportAssetBundle(loaded), guardOps);
const goodReg = new SkillRegistry(new LiminaTracer("ses_p11_pin"));
registerCoreSkills(goodReg, { assets: pkgReg });
// Correct committed hash -> loads.
const pinOk = await goodReg.invoke("asset.place", { ...placeArgs, hash: r1.hash }, { agentId: "a", sessionId: "s", permissions: BUILDER, tick: 0, world: makeWorld(guardOps) });
assert(pinOk.success, `pinned replay with the correct hash should load: ${JSON.stringify(pinOk.error)}`);
// Wrong committed hash -> REJECTED (this is what pins authored identity on replay).
// FALSIFIABLE — removing the handler's hash check makes this succeed.
const pinBad = await goodReg.invoke("asset.place", { ...placeArgs, hash: glbHash }, { agentId: "a", sessionId: "s", permissions: BUILDER, tick: 0, world: makeWorld(guardOps) });
assert(!pinBad.success && JSON.stringify(pinBad.error).includes("content hash mismatch"), "replay did NOT verify the committed hash (a swapped asset would load)");

// 7. loadExport + verifyExportAssets recompute from round-tripped bytes -----------
const bundleOf = (id: string): Uint8Array => exportAssetBundle(loaded).find((e) => e.id === id)!.bytes;
const verified = verifyExportAssets(loaded.manifest, bundleOf, ops);
assert(verified === 1, `expected 1 verified export asset, got ${verified}`);
// A tampered manifest hash is rejected.
let manifestRejected = false;
const badManifest = { ...loaded.manifest, assets: loaded.manifest.assets.map((a) => ({ ...a, hash: "sha256:deadbeef" })) };
try { verifyExportAssets(badManifest, bundleOf, ops); } catch { manifestRejected = true; }
assert(manifestRejected, "verifyExportAssets accepted a manifest hash mismatch");
// A tampered assets.jsonl (flip a base64 char) is rejected at loadExport.
let assetBytesRejected = false;
const obj = JSON.parse(files["assets.jsonl"].split("\n")[0]) as { id: string; hash: string; b64: string };
obj.b64 = (obj.b64[0] === "A" ? "B" : "A") + obj.b64.slice(1);
const tornFiles = { ...files, "assets.jsonl": JSON.stringify(obj) + "\n" };
try { loadExport(tornFiles, ops); } catch { assetBytesRejected = true; }
assert(assetBytesRejected, "loadExport accepted a corrupted assets.jsonl (no byte integrity)");

ops.op_log(`p11_asset_place OK: registry content-addresses assets (${r1.hash}); recorder commits the hash to the log (pinned); export serializes ${loaded.assets.length} asset's bytes (assets.jsonl); replay reloads from the SERIALIZED package (guarded vs native root) with correct metadata + deterministically; replay rejects a swapped/pinned-mismatch asset; loadExport+verifyExportAssets reject manifest + byte tampers.`);
