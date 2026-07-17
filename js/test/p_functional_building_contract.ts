import { FUNCTIONAL_BUILDING_CONTRACT, parseFunctionalBuildingContract } from "../src/assets/functional-building-contract.ts";

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`p_functional_building_contract FAIL: ${message}`); }
const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const node = (id: string, role: string, data: Record<string, unknown> = {}) => ({ extras: { limina: { id, role, ...data } } });
const authority: any = {
  asset: { version: "2.0", extras: { liminaFunctionalBuilding: {
    schema: FUNCTIONAL_BUILDING_CONTRACT, units: "meter", up: "Y", buildingId: "cottage/one-room/v1",
    rootNodeId: "building/root", roomIds: ["room/main"], portalIds: ["portal/exterior"], entryAnchor: [0, 0, -2.8],
  } } },
  nodes: [
    node("building/root", "root"), node("room/main", "room"), node("portal/exterior", "portal"),
    ...["floor", "north", "east", "west", "south-left", "south-right", "lintel"].map((id) =>
      node(`collider/${id}`, "collider", { shape: "box", center: [0, 1, 0], halfExtents: [1, 1, 0.1] })),
    node("door/front", "door", { roomId: "room/main", portalId: "portal/exterior", hinge: [-0.55, 0, -2],
      center: [0.55, 1.05, 0], halfExtents: [0.55, 1.05, 0.06], closedYaw: 0, openYaw: -1.5707963267948966 }),
  ],
  animations: [{ name: "door/front/open", channels: [{ sampler: 0, target: { node: 10, path: "rotation" } }], samplers: [{}] }],
};
authority.nodes[0].children = authority.nodes.slice(1).map((_: unknown, index: number) => index + 1);
authority.scenes = [{ nodes: [0] }];
authority.scene = 0;
const parsed = parseFunctionalBuildingContract(enc(authority));
assert(parsed.buildingId === "cottage/one-room/v1" && parsed.colliders.length === 7 && parsed.doors.length === 1, "valid contract did not parse");
const furnished = structuredClone(authority);
furnished.nodes.push({ scale: [0.8, 1.2, 0.6], extras: { "limina.id": "furniture/chair/visual", "limina.role": "furniture-part" } });
furnished.nodes[0].children.push(furnished.nodes.length - 1);
const furnishedParsed = parseFunctionalBuildingContract(enc(furnished));
assert(furnishedParsed.colliders.length === 7 && furnishedParsed.doors.length === 1,
  "non-articulated dressing scale polluted the functional building contract");

const rejects = (mutate: (value: any) => void, pattern: RegExp): void => {
  const value = structuredClone(authority); mutate(value);
  let error = ""; try { parseFunctionalBuildingContract(enc(value)); } catch (cause) { error = String(cause); }
  assert(pattern.test(error), `expected ${pattern}, got ${error}`);
};
rejects((v) => { delete v.asset.extras.liminaFunctionalBuilding; }, /liminaFunctionalBuilding/);
rejects((v) => { v.nodes[1].extras.limina.id = "building\/root"; }, /duplicate node id/);
rejects((v) => { v.nodes = v.nodes.filter((n: any) => n.extras.limina.role !== "door");v.nodes[0].children=v.nodes.slice(1).map((_:unknown,index:number)=>index+1); }, /operable door/);
rejects((v) => { v.nodes = v.nodes.filter((n: any) => n.extras.limina.role !== "collider");v.nodes[0].children=v.nodes.slice(1).map((_:unknown,index:number)=>index+1); }, /decomposed shell/);
rejects((v) => { v.nodes.at(-1).scale = [1, 2, 1]; }, /articulated-unsafe scale/);
rejects((v) => { v.nodes.at(-1).extras.limina.portalId = "node-index-4"; }, /unresolved room\/portal/);
rejects((v) => { v.animations = []; }, /missing canonical clip/);
rejects((v) => { v.animations[0].channels[0].target.node = 0; }, /does not rotate its semantic leaf/);
rejects((v) => { v.scenes[0].nodes = [0, 1]; }, /sole scene root/);
rejects((v) => { v.nodes[0].children = v.nodes[0].children.filter((index: number) => index !== 1); }, /outside the building root/);
console.log("p_functional_building_contract OK: semantic GLB authority accepts a real shell and rejects decorative fakes");
