import { FUNCTIONAL_BUILDING_VISUAL_CONTRACT, parseFunctionalBuildingVisualContract } from "../src/assets/functional-building-visual-contract.ts";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(`p_functional_building_visual_contract FAIL: ${message}`); }
function rejects(fn: () => unknown, pattern: RegExp, message: string): void {
  let caught: unknown; try { fn(); } catch (error) { caught = error; }
  assert(caught instanceof Error && pattern.test(caught.message), `${message}: ${caught instanceof Error ? caught.message : "did not reject"}`);
}
const nodeIds = ["building/root", "window/a/glass", "window/a/reveal-left", "window/a/reveal-right", "window/a/reveal-top", "window/a/reveal-bottom",
  "window/a/frame-left","window/a/frame-right","window/a/frame-top","window/a/frame-bottom","window/a/mullion","window/a/came-1","window/a/came-2",
  "door/front", "portal/exterior/reveal-left", "portal/exterior/reveal-right", "portal/exterior/reveal-top", "portal/exterior/reveal-bottom",
  "door/plank-1","door/plank-2","door/plank-3","door/hinge-1","door/hinge-2","door/latch",
  "interior/floor", "interior/ceiling", "shell/front-left", "shell/front-right","furnishing/table","furnishing/bench","furnishing/hearth","furnishing/cupboard","furnishing/shelf"];
const materialRoleIds = ["foundation", "mortar-reveal", "wall-exterior", "wall-interior", "structure-trim", "door-surface", "roof", "glazing", "door-hardware", "hearth-masonry"];
const materials = materialRoleIds.map((role) => role === "glazing"
  ? { name: `${role}-material`, alphaMode: "BLEND", pbrMetallicRoughness: { baseColorFactor: [.12,.20,.22,.24], metallicFactor: 0, roughnessFactor: .22 } }
  : { name: `${role}-material`, normalTexture: { index: 0 }, pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 0 } } });
const authority = {
  schema: FUNCTIONAL_BUILDING_VISUAL_CONTRACT,
  openings: [
    { id: "window/a", kind: "window", facade: "south", aperture: { center: [-2, 1.5, -3], halfExtents: [.7, .7, .2] },
      glazingNodeId: "window/a/glass", revealNodeIds: ["window/a/reveal-left", "window/a/reveal-right", "window/a/reveal-top", "window/a/reveal-bottom"],
      frameNodeIds:["window/a/frame-left","window/a/frame-right","window/a/frame-top","window/a/frame-bottom"],mullionNodeIds:["window/a/mullion"],cameNodeIds:["window/a/came-1","window/a/came-2"] },
    { id: "portal/exterior", kind: "door", facade: "south", aperture: { center: [0, 1.2, -3], halfExtents: [.7, 1.2, .2] },
      leafNodeId: "door/front", revealNodeIds: ["portal/exterior/reveal-left", "portal/exterior/reveal-right", "portal/exterior/reveal-top", "portal/exterior/reveal-bottom"],
      plankNodeIds:["door/plank-1","door/plank-2","door/plank-3"],ironworkNodeIds:["door/hinge-1","door/hinge-2","door/latch"] },
  ],
  materialRoles: materialRoleIds.map((role) => ({ role, materialName: `${role}-material` })),
  interior: { walkableNodeIds: ["interior/floor"], ceilingNodeIds: ["interior/ceiling"], shellNodeIds: ["shell/front-left", "shell/front-right"],
    furnishingNodeIds:["furnishing/table","furnishing/bench","furnishing/hearth","furnishing/cupboard","furnishing/shelf"],clearAisle:{from:[0,0,-3],to:[0,0,3],halfWidth:.55,minClearHeight:2} },
  lod: { identity: "cottage/test/lod-v1", lod0RootNodeId: "building/root", triangleBudget: 10000, drawBudget: 100, lod1TriangleBudget: 4000, lod2TriangleBudget: 1000 },
};
function glb(visual: unknown): Uint8Array {
  const doc = { asset: { version: "2.0", extras: { liminaFunctionalBuildingVisual: visual } },
    nodes: nodeIds.map((id) => ({ extras: { limina: { id } } })), materials };
  const source = new TextEncoder().encode(JSON.stringify(doc));
  const padded = new Uint8Array((source.length + 3) & ~3); padded.fill(0x20); padded.set(source);
  const out = new Uint8Array(20 + padded.length), view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, out.length, true);
  view.setUint32(12, padded.length, true); view.setUint32(16, 0x4e4f534a, true); out.set(padded, 20); return out;
}
const parsed = parseFunctionalBuildingVisualContract(glb(authority));
assert(parsed.openings.length === 2 && parsed.openings[0].kind === "window" && parsed.openings[1].kind === "door", "valid opening authority drifted");
assert(parsed.lod.triangleBudget === 10000 && parsed.interior.shellNodeIds.length === 2, "valid interior/LOD authority drifted");
rejects(() => parseFunctionalBuildingVisualContract(glb({ ...authority, openings: [{ ...authority.openings[0], revealNodeIds: authority.openings[0].revealNodeIds.slice(0, 3) }, authority.openings[1]] })),
  /must contain 4 ids/, "three-sided fake reveal passed");
rejects(() => parseFunctionalBuildingVisualContract(glb({ ...authority, openings: [authority.openings[0], { ...authority.openings[1], kind: "window", glazingNodeId: "window/a/glass" }] })),
  /cannot carry a door leaf|exactly one exterior door/, "asset without exterior door authority passed");
rejects(() => parseFunctionalBuildingVisualContract(glb({ ...authority, openings: [{ ...authority.openings[0], glazingNodeId: "missing/glass" }, authority.openings[1]] })),
  /unresolved node/, "unresolved glazing identity passed");
rejects(() => parseFunctionalBuildingVisualContract(glb({ ...authority, lod: { ...authority.lod, lod2TriangleBudget: 5000 } })),
  /strictly descend/, "non-descending LOD budgets passed");
rejects(() => parseFunctionalBuildingVisualContract(glb({ ...authority, materialRoles: authority.materialRoles.filter((entry) => entry.role !== "roof") })),
  /required material role roof/, "missing roof PBR authority passed");
console.log("p_functional_building_visual_contract OK: stable opening/reveal/leaf identities, mapped material roles, interior authority, and descending LOD budgets fail closed without subjective scoring");
