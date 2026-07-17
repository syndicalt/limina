import { FunctionalBuildingLodController, parseFunctionalBuildingStaticBatch, resolveFunctionalBuildingLodRoots, type FunctionalBuildingLodNode } from "../src/skills/functional-building-lod.ts";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`p_functional_building_lod FAIL: ${message}`); }
type Node = FunctionalBuildingLodNode & { children: Node[] };
function node(level?: number, semanticId?: string, children: Node[] = []): Node {
  const value: Node = { visible: true, children, userData: { ...(level === undefined ? {} : { liminaLod: { level } }), ...(semanticId === undefined ? {} : { limina: { id: semanticId } }) } };
  value.traverse = (visit) => { visit(value); for (const child of children) child.traverse?.(visit); };
  return value;
}
function glb(document: unknown): Uint8Array {
  const source = new TextEncoder().encode(JSON.stringify(document));
  const length = Math.ceil(source.length / 4) * 4;
  const bytes = new Uint8Array(20 + length); bytes.fill(0x20, 20); bytes.set(source, 20);
  const view = new DataView(bytes.buffer); view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.length, true); view.setUint32(12, length, true); view.setUint32(16, 0x4e4f534a, true);
  return bytes;
}

const manifest = parseFunctionalBuildingStaticBatch(glb({ asset: { extras: { liminaStaticBatch: { schema: "limina.static-batch/1", lodRoots: [41, 42, 43], doorRoot: 17 } } } }));
assert(manifest?.lodRoots.join(",") === "41,42,43" && manifest.doorRoot === 17, "authoritative static-batch manifest was not parsed");
assert(parseFunctionalBuildingStaticBatch(glb({ asset: {} })) === undefined, "unpackaged asset acquired a static-batch manifest");
let malformedManifestRejected = false;
try { parseFunctionalBuildingStaticBatch(glb({ asset: { extras: { liminaStaticBatch: { schema: "limina.static-batch/1", lodRoots: [1, 1, 2], doorRoot: 4 } } } })); }
catch (error) { malformedManifestRejected = String(error).includes("invalid limina.static-batch"); }
assert(malformedManifestRejected, "duplicate manifest LOD roots were accepted");

const doorId = "door/front/leaf";
const lod0 = node(0, undefined, [node(undefined, "wall/main")]);
const lod1 = node(1, undefined, [node(undefined, "roof/main")]);
const lod2 = node(2, undefined, [node(undefined, "foundation/main")]);
const authoredDoor = node(undefined, doorId);
const root = node(undefined, undefined, [authoredDoor, lod2, lod0, lod1]);
const roots = resolveFunctionalBuildingLodRoots(root, new Set([doorId]));
assert(roots.length === 3 && roots[0] === lod0 && roots[1] === lod1 && roots[2] === lod2, "semantic roots were not resolved in level order");

const controller = new FunctionalBuildingLodController(roots, { anchor: [10, 2, -5], distances: [28, 72], hysteresis: 0.1 });
const camera = { position: { x: 10, y: 2, z: -5 } } as never;
assert(controller.level === 0 && lod0.visible && !lod1.visible && !lod2.visible, "LOD0 was not the deterministic initial state");
camera.position.z = 26; controller.update(camera); // 31m: beyond 28 * 1.1
assert(controller.level === 1 && lod1.visible && !lod0.visible && !lod2.visible, "outward LOD0 transition failed");
camera.position.z = 24; controller.update(camera); // 29m: within hysteresis band
assert(controller.level === 1, "outward transition thrashed inside the hysteresis band");
camera.position.z = 19; controller.update(camera); // 24m: below 28 * 0.9
assert(controller.level === 0, "inward LOD0 transition failed");
camera.position.z = 80; controller.update(camera); // 85m: can cross multiple thresholds in one frame
assert(controller.level === 2 && lod2.visible && !lod0.visible && !lod1.visible, "far camera did not select only LOD2");
camera.position.z = 55; controller.update(camera); // 60m: below 72 * 0.9, still above near return
assert(controller.level === 1, "LOD2 inward hysteresis transition failed");
controller.apply(0);
assert(controller.level === 0 && lod0.visible && !lod1.visible && !lod2.visible, "explicit evidence selection was not absolute");

let embeddedDoorRejected = false;
try { resolveFunctionalBuildingLodRoots(node(undefined, undefined, [node(0, undefined, [node(undefined, doorId)]), node(1), node(2)]), new Set([doorId])); }
catch (error) { embeddedDoorRejected = String(error).includes("articulated door"); }
assert(embeddedDoorRejected, "a door embedded in a static LOD batch was accepted");

let gapRejected = false;
try { resolveFunctionalBuildingLodRoots(node(undefined, undefined, [node(0), node(2)]), new Set()); }
catch (error) { gapRejected = String(error).includes("contiguous"); }
assert(gapRejected, "non-contiguous LOD roots were accepted");

console.log("p_functional_building_lod OK: ordered semantic roots, exclusive visibility, multi-band camera switching, hysteresis, explicit capture selection, and articulated-door exclusion proven");
