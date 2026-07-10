import { ops } from "../src/engine.ts";
import { ATLAS_DESIGN_REF_SCHEMA } from "../src/world/design-ref.mjs";
import { WorldMapSchema, stableStringifyWorldMap, verifyWorldMap, worldMapContentHash } from "../src/world/worldmap.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("p_design_ref_worldmap FAIL: " + message);
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const base: any = {
  version: 1,
  id: "primary",
  unitsPerMeter: 1,
  origin: [0, 0],
  extent: { w: 10, h: 10 },
  seaLevel: 0,
  land: [], relief: [], biomes: [], waterways: [], routes: [],
  anchors: [{ id: "church", kind: "asset", position: [2, 3], assetId: "church.glb", source: "map" }],
  provenance: { tool: "design-space", sourceHash: "a".repeat(64), contentHash: "" },
};
base.provenance.contentHash = worldMapContentHash(base);
const legacyBytes = stableStringifyWorldMap(base);
assert(!legacyBytes.includes("designRef") && !legacyBytes.includes("designIndex"), "legacy canonical bytes materialized absent design fields");
assert(verifyWorldMap(WorldMapSchema.parse(base)).ok, "legacy ref-free WorldMap no longer verifies");

const ref = { schema: ATLAS_DESIGN_REF_SCHEMA, mapId: "primary", kind: "stamp", id: "church" };
const withRef: any = clone(base);
withRef.anchors[0].designRef = ref;
withRef.designIndex = [{ designRef: ref, position: [2, 3], radiusM: 12 }];
withRef.provenance.contentHash = worldMapContentHash(withRef);
const parsed = WorldMapSchema.parse(withRef);
assert(verifyWorldMap(parsed).ok, "WorldMap with design provenance does not verify");
assert(parsed.anchors[0].designRef?.id === "church" && parsed.designIndex?.[0].designRef.kind === "stamp",
  "WorldMap schema stripped design provenance");

const tampered: any = clone(withRef);
tampered.designIndex[0].designRef.id = "other";
assert(!verifyWorldMap(tampered).ok, "designRef tamper did not change the WorldMap hash");

const duplicate: any = clone(withRef);
duplicate.designIndex.push(clone(duplicate.designIndex[0]));
let duplicateRejected = false;
try { WorldMapSchema.parse(duplicate); } catch { duplicateRejected = true; }
assert(duplicateRejected, "duplicate designIndex identity was accepted");

ops.op_log("p_design_ref_worldmap OK: strict Atlas refs hash deterministically; legacy ref-free bytes remain unchanged; duplicate index identities are rejected.");
