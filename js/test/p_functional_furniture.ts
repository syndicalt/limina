import { readFile } from "node:fs/promises";
import { strict as assert } from "node:assert";
import { furnitureDesignContractHash } from "../src/architecture/furniture-design-contract.ts";
import { parseFunctionalFurnitureContract } from "../src/assets/furniture-functional-contract.ts";
import { AssetRegistry } from "../src/asset-registry.ts";
import { EntityTable, type EngineOps } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { SkillRegistry, type WorldContext } from "../src/skills/registry.ts";
import { registerFurnitureSkills } from "../src/skills/furniture.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { teardownEntity } from "../src/skills/entity-teardown.ts";

const assetId = "buildings/authoring/furniture/hearth-settle-v2-r2/hearth-settle-v2-r2.glb";
const bytes = new Uint8Array(await readFile(new URL("../../assets/buildings/authoring/furniture/hearth-settle-v2-r2/hearth-settle-v2-r2.glb", import.meta.url)));
function documentOf(source: Uint8Array): Record<string, any> {
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength), length = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(source.subarray(20, 20 + length)).trim());
}
function glb(document: unknown): Uint8Array {
  const raw = new TextEncoder().encode(JSON.stringify(document)), padded = (raw.length + 3) & ~3;
  const out = new Uint8Array(20 + padded); out.fill(0x20, 20); out.set(raw, 20);
  const view = new DataView(out.buffer); view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, out.length, true); view.setUint32(12, padded, true); view.setUint32(16, 0x4e4f534a, true); return out;
}

const parsed = parseFunctionalFurnitureContract(bytes), source = documentOf(bytes);
assert.equal(parsed.partIds.length, source.asset.extras.liminaFurnitureContract.parts.length, "parser hardcoded the approved asset's current part count");
assert.equal(parsed.sockets.length, source.asset.extras.liminaFurnitureContract.sockets.length);
assert.equal(parsed.colliders.length, source.asset.extras.liminaFurnitureContract.colliders.length);

const drift = structuredClone(source); drift.asset.extras.liminaFurnitureContractHash = "sha256:" + "0".repeat(64);
assert.throws(() => parseFunctionalFurnitureContract(glb(drift)), /embedded contract hash mismatch/);
const unresolved = structuredClone(source), missingId = unresolved.asset.extras.liminaFurnitureContract.parts[0].id;
unresolved.nodes = unresolved.nodes.filter((node: any) => node.extras?.["limina.id"] !== missingId);
assert.throws(() => parseFunctionalFurnitureContract(glb(unresolved)), new RegExp(`part ${missingId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is unresolved`));
const socketDrift = structuredClone(source), socketNode = socketDrift.nodes.find((node: any) => node.extras?.["limina.role"] === "socket"); socketNode.extras["limina.position"][0] += 0.1;
assert.throws(() => parseFunctionalFurnitureContract(glb(socketDrift)), /node metadata drifted from its pinned contract/);
const whole = structuredClone(source), allParts = whole.asset.extras.liminaFurnitureContract.parts.map((part: any) => part.id);
whole.asset.extras.liminaFurnitureContract.colliders[0].covers = allParts;
whole.nodes.find((node: any) => node.extras?.["limina.id"] === whole.asset.extras.liminaFurnitureContract.colliders[0].id).extras["limina.covers"] = allParts;
whole.asset.extras.liminaFurnitureContractHash = furnitureDesignContractHash(whole.asset.extras.liminaFurnitureContract);
assert.throws(() => parseFunctionalFurnitureContract(glb(whole)), /generic whole-object collider is forbidden/);

function runtime(failTransformAt = Infinity): { world: WorldContext; added: number[]; removed: number[] } {
  let nextBody = 1, transforms = 0; const added: number[] = [], removed: number[] = [];
  const worldOps = {
    op_physics_add_static_box() { const id = nextBody++; added.push(id); return id; },
    op_physics_set_body_transform() { if (++transforms === failTransformAt) throw new Error("injected collider transform failure"); },
    op_physics_remove_body(id: number) { removed.push(id); },
  } as unknown as EngineOps;
  const ecs = createEcsWorld();
  const world = { ecs, entities: new EntityTable(), tags: new Map(), scene: { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null }, camera: { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} }, ops: worldOps, simWorker: true, mode: "headless" } as unknown as WorldContext;
  return { world, added, removed };
}
const assetOps = { op_read_asset: () => bytes, op_sha256: () => "" } as unknown as EngineOps;
const tracer = new LiminaTracer("functional-furniture-test");
const assets = new AssetRegistry(assetOps), registry = new SkillRegistry(tracer); registerFurnitureSkills(registry, assets);
const invoke = (world: WorldContext, input: Record<string, unknown>) => registry.invoke("furniture.placeFunctional", input, { agentId: "test", sessionId: "furniture", permissions: new Set(["scene.write"]), tick: 1, world });
const success = runtime(), yaw = Math.PI / 2, position: [number, number, number] = [5, 1, 7];
const response = await invoke(success.world, { assetId, position, yaw }); assert.equal(response.success, true);
const result = response.result as { root: string; colliders: string[]; sockets: { id: string; position: number[]; facing: number[] }[]; hash: string; contractHash: string };
assert.equal(result.colliders.length, parsed.colliders.length); assert.equal(success.world.entities.childrenOf(result.root).length, parsed.colliders.length);
const left = result.sockets.find((socket) => socket.id === "occupancy/left")!, authored = parsed.sockets.find((socket) => socket.id === "occupancy/left")!;
assert.deepEqual(left.position.map((n) => Math.round(n * 1e9) / 1e9), [position[0] + authored.position[2], position[1] + authored.position[1], position[2] - authored.position[0]].map((n) => Math.round(n * 1e9) / 1e9));
assert.deepEqual(left.facing.map((n) => Math.round(n * 1e9) / 1e9), [authored.facing[2], authored.facing[1], -authored.facing[0]]);
assert.equal(result.contractHash, parsed.contractHash); assert.equal((success.world.entities.resolve(result.root)!.origin!.input as any).contractHash, parsed.contractHash);
teardownEntity(success.world, result.root); assert.equal(success.world.entities.ids().length, 0); assert.deepEqual(success.removed.sort(), success.added.sort(), "root teardown leaked child physics bodies");

const restored = runtime(), restoredResponse = await invoke(restored.world, { assetId, position, yaw, hash: assets.hashOf(assetId), contractHash: parsed.contractHash });
assert.equal(restoredResponse.success, true); const restoredResult = restoredResponse.result as typeof result;
restored.world.entities.resolve(restoredResult.root)!.runtimeDispose = undefined; // snapshots do not serialize closures
const destroyed = await registry.invoke("furniture.destroyFunctional", { root: restoredResult.root }, { agentId: "test", sessionId: "furniture", permissions: new Set(["scene.write"]), tick: 2, world: restored.world });
assert.equal(destroyed.success, true); const destroyedResult = destroyed.result as { removed: string[]; removedEids: number[] };
assert.equal(destroyedResult.removed.length, parsed.colliders.length + 1); assert.equal(new Set(destroyedResult.removedEids).size, parsed.colliders.length + 1);
assert.equal(restored.world.entities.ids().length, 0); assert.deepEqual(restored.removed.sort(), restored.added.sort(), "snapshot-safe destroy leaked compound collider bodies");

const failed = runtime(2), failedResponse = await invoke(failed.world, { assetId, hash: assets.hashOf(assetId), contractHash: parsed.contractHash });
assert.equal(failedResponse.success, false); assert.equal(failed.world.entities.ids().length, 0, "failed placement leaked entities"); assert.deepEqual(failed.removed.sort(), failed.added.sort(), "failed placement leaked physics bodies");
// A mismatched CONTRACT hash still throws: furnitureDesignContractHash is a pure-JS sha256 over
// canonical JSON (host-independent), so a mismatch there is genuine contract drift, never a
// cross-host artifact.
const pinResponse = await invoke(runtime().world, { assetId, contractHash: "sha256:" + "f".repeat(64) }); assert.equal(pinResponse.success, false);
// A mismatched committed ASSET hash WARNS AND CONTINUES (failure mode #12): resolved hashes come
// from op_sha256, which is host-dependent, so a cross-host replay of a healthy placement can
// mismatch — the placement must succeed and surface exactly ONE furniture.hash_mismatch event.
// FALSIFIABLE both ways: every matching/absent-hash invoke above emitted ZERO mismatch events,
// and removing the handler's hash check makes the event below disappear.
assert.equal(tracer.trace("test").filter((e) => e.type === "furniture.hash_mismatch").length, 0,
  "matching/absent committed hashes must not emit furniture.hash_mismatch");
const swappedHash = "sha256:" + "e".repeat(64);
const bytePinResponse = await invoke(runtime().world, { assetId, hash: swappedHash, contractHash: parsed.contractHash });
assert.equal(bytePinResponse.success, true, `a committed-hash mismatch must warn-and-continue, not abort the replay: ${JSON.stringify(bytePinResponse.error)}`);
const mismatchEvents = tracer.trace("test").filter((e) => e.type === "furniture.hash_mismatch");
assert.equal(mismatchEvents.length, 1, `a swapped committed hash MUST surface exactly one furniture.hash_mismatch event (got ${mismatchEvents.length})`);
const mismatchPayload = mismatchEvents[0].payload as { assetId?: string; committed?: string; resolved?: string };
assert.equal(mismatchPayload.assetId, assetId); assert.equal(mismatchPayload.committed, swappedHash); assert.equal(mismatchPayload.resolved, assets.hashOf(assetId));

console.log(`p_functional_furniture OK: exact contract ${parsed.contractHash}, ${parsed.partIds.length} semantic parts, ${parsed.sockets.length} transformed sockets, ${parsed.colliders.length} compound bodies; teardown and rollback exact; committed-asset-hash mismatch warns-and-continues (1 furniture.hash_mismatch event), contract-hash mismatch still throws`);
