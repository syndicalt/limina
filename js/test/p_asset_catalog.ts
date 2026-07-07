// p_asset_catalog — asset.catalog / catalog.publish are REAL, agent-callable, replay-safe engine
// skills: a browsable index of curated, QC-approved assets (seed catalog + this-session publishes),
// read-only for asset.catalog (never held by the review gate) and recorded for catalog.publish (a
// real write, so newly authored entries flow through the same approval path as any other content).

import { ops, EntityTable, type WorldContext } from "../src/engine.ts";
import { createEcsWorld } from "../src/ecs/world.ts";
import { createTransformStorage } from "../src/ecs/facade.ts";
import { UniformGridSpatialIndex } from "../src/spatial/index.ts";
import { SkillRegistry } from "../src/skills/registry.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import { LiminaTracer } from "../src/observability/event.ts";
import { registerAssetCatalogSkills, type CatalogEntry } from "../src/skills/asset-catalog.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p_asset_catalog: " + msg);
}

function makeHeadlessWorld(): WorldContext {
  const ecs = createEcsWorld();
  const scene = { add() {}, remove() {}, position: { set() {}, x: 0, y: 0, z: 0 }, background: null as unknown };
  const camera = { position: { set() {} }, aspect: 1, lookAt() {}, updateProjectionMatrix() {} };
  return {
    ecs, transforms: createTransformStorage(ecs), spatial: new UniformGridSpatialIndex(),
    entities: new EntityTable(), tags: new Map(), scene, camera, ops, mode: "headless",
  };
}

const perms = resolveProfile("builder.readWrite");

const STONE_WELL: CatalogEntry = {
  id: "gate-test-well.glb",
  title: "Stone well",
  category: "prop",
  boundsM: [1.4, 1.6, 1.4],
  authoredBy: "claude-test-model", // provenance must round-trip to the reviewer + catalog
  qcTurntable: ["qc/gate-test-well-a0.png", "qc/gate-test-well-a1.png"], // task #66: turntable frames must round-trip too
  tags: ["prop", "medieval"],
};

// A fresh registry + catalog state, wired to a headless world. Returns everything a scenario needs
// to invoke asset.catalog / catalog.publish.
function freshCatalog(session: string): { registry: SkillRegistry; at: (tick: number) => Parameters<SkillRegistry["invoke"]>[2] } {
  const world = makeHeadlessWorld();
  const registry = new SkillRegistry(new LiminaTracer(session));
  registerAssetCatalogSkills(registry);
  const at = (tick: number) => ({ agentId: "agt_catalog", sessionId: session, permissions: perms, tick, world });
  return { registry, at };
}

async function readCatalog(registry: SkillRegistry, at: (tick: number) => Parameters<SkillRegistry["invoke"]>[2], tick: number): Promise<CatalogEntry[]> {
  const rc = await registry.invoke("asset.catalog", {}, at(tick));
  assert(rc.success, `asset.catalog must succeed: ${JSON.stringify(rc.error)}`);
  return (rc.result as { entries: CatalogEntry[] }).entries;
}

// 1. asset.catalog returns the seed entries from assets/catalog.json — the four originals must be
//    present (the manifest GROWS as approved session publishes are promoted into it; the gate is
//    relative to the file, not a frozen count).
const CORE_SEED_IDS = ["cottage-authored.glb", "watchtower-authored.glb", "norman-manor-building.glb", "norman-church.glb"];
let seedCount = 0;
{
  const { registry, at } = freshCatalog("ses_catalog_seed");
  const entries = await readCatalog(registry, at, 1);
  seedCount = entries.length;
  assert(seedCount >= 4, `seed catalog must have at least the 4 core entries (got ${seedCount})`);
  assert(CORE_SEED_IDS.every((id) => entries.some((e) => e.id === id)), `core seed ids missing from assets/catalog.json (got ${entries.map((e) => e.id).join(", ")})`);
  assert(new Set(entries.map((e) => e.id)).size === seedCount, "seed ids must be unique");
}

// 2. catalog.publish of a new entry -> asset.catalog now returns 5, with the new entry's fields intact.
{
  const { registry, at } = freshCatalog("ses_catalog_publish");
  const pub = await registry.invoke("catalog.publish", STONE_WELL, at(1));
  assert(pub.success, `catalog.publish must succeed: ${JSON.stringify(pub.error)}`);
  assert((pub.result as { published: boolean }).published, "catalog.publish must report published:true");
  assert((pub.result as { count: number }).count === seedCount + 1, `catalog.publish count must be seed+1 (got ${(pub.result as { count: number }).count})`);

  const entries = await readCatalog(registry, at, 2);
  assert(entries.length === seedCount + 1, `catalog must have seed+1 entries after publish (got ${entries.length})`);
  const well = entries.find((e) => e.id === "gate-test-well.glb");
  assert(well !== undefined, "the published entry must appear in asset.catalog");
  assert(well!.title === STONE_WELL.title && well!.category === STONE_WELL.category, "published entry's fields must be intact");
  assert(well!.authoredBy === "claude-test-model", "authoredBy provenance must survive publish → catalog");
  assert(well!.boundsM[0] === STONE_WELL.boundsM[0] && well!.boundsM[2] === STONE_WELL.boundsM[2], "published entry's boundsM must be intact");
  assert(Array.isArray(well!.qcTurntable) && well!.qcTurntable.length === 2 && well!.qcTurntable[0] === "qc/gate-test-well-a0.png",
    `qcTurntable frames must survive publish → catalog (got ${JSON.stringify(well!.qcTurntable)})`);
}

// 3. Idempotency: publishing the same id again with a changed title -> still 5 entries, title updated.
{
  const { registry, at } = freshCatalog("ses_catalog_idempotent");
  await registry.invoke("catalog.publish", STONE_WELL, at(1));
  const renamed: CatalogEntry = { ...STONE_WELL, title: "Old stone well" };
  const rep = await registry.invoke("catalog.publish", renamed, at(2));
  assert(rep.success, `re-publish must succeed: ${JSON.stringify(rep.error)}`);
  assert((rep.result as { count: number }).count === seedCount + 1, `re-publish must NOT duplicate (got ${(rep.result as { count: number }).count})`);

  const entries = await readCatalog(registry, at, 3);
  assert(entries.length === seedCount + 1, `catalog must still have seed+1 entries after re-publish (got ${entries.length})`);
  const matches = entries.filter((e) => e.id === "gate-test-well.glb");
  assert(matches.length === 1, `re-publishing must replace, not duplicate (found ${matches.length} entries for gate-test-well.glb)`);
  assert(matches[0].title === "Old stone well", `re-publish must update the title (got '${matches[0].title}')`);
}

// 4. Determinism: the same publish sequence in a FRESH registry/state yields an identical entries array.
{
  const seqA = freshCatalog("ses_catalog_det_a");
  await seqA.registry.invoke("catalog.publish", STONE_WELL, seqA.at(1));
  await seqA.registry.invoke("catalog.publish", { ...STONE_WELL, title: "Renamed well" }, seqA.at(2));
  const entriesA = await readCatalog(seqA.registry, seqA.at, 3);

  const seqB = freshCatalog("ses_catalog_det_b");
  await seqB.registry.invoke("catalog.publish", STONE_WELL, seqB.at(1));
  await seqB.registry.invoke("catalog.publish", { ...STONE_WELL, title: "Renamed well" }, seqB.at(2));
  const entriesB = await readCatalog(seqB.registry, seqB.at, 3);

  assert(
    JSON.stringify(entriesA) === JSON.stringify(entriesB),
    "the same publish sequence over a fresh registry/state must reproduce a byte-identical entries array",
  );
}

// 5. Review-gate sanity: catalog.publish declares a non-".read" capability (so a review profile HOLDS
//    it), asset.catalog declares a ".read" one (so the review gate never holds it — mirrors worldlog.tail).
{
  const registry = new SkillRegistry(new LiminaTracer("ses_catalog_perms"));
  registerAssetCatalogSkills(registry);
  const catalogDef = registry.describe("asset.catalog");
  const publishDef = registry.describe("catalog.publish");
  assert(catalogDef !== undefined && publishDef !== undefined, "both asset.catalog and catalog.publish must be registered");
  assert(catalogDef!.permissions.every((p) => p.endsWith(".read")), `asset.catalog must declare only .read permissions (got ${catalogDef!.permissions.join(", ")})`);
  assert(publishDef!.permissions.some((p) => !p.endsWith(".read")), `catalog.publish must declare a non-.read permission so the review gate holds it (got ${publishDef!.permissions.join(", ")})`);
}

// 6. ＋New build requests: asset.request records a request with a DETERMINISTIC id; asset.requests
//    lists them in order; the same request sequence in a fresh state reproduces identical records.
{
  const seqA = freshCatalog("ses_request_a");
  const r1 = await seqA.registry.invoke("asset.request", { description: "A stone village well with a timber winch", category: "prop" }, seqA.at(7));
  assert(r1.success, `asset.request must succeed: ${JSON.stringify(r1.error)}`);
  assert((r1.result as { requestId: string }).requestId === "req_7_0", `requestId must be deterministic tick+ordinal (got ${(r1.result as { requestId: string }).requestId})`);
  await seqA.registry.invoke("asset.request", { description: "A hay cart", category: "prop" }, seqA.at(9));
  const listA = await seqA.registry.invoke("asset.requests", {}, seqA.at(10));
  assert(listA.success, "asset.requests must succeed");
  const reqsA = (listA.result as { requests: { requestId: string; description: string }[] }).requests;
  assert(reqsA.length === 2 && reqsA[0].requestId === "req_7_0" && reqsA[1].requestId === "req_9_1", `requests must list in order with deterministic ids (got ${reqsA.map((r) => r.requestId).join(", ")})`);

  const seqB = freshCatalog("ses_request_b");
  await seqB.registry.invoke("asset.request", { description: "A stone village well with a timber winch", category: "prop" }, seqB.at(7));
  await seqB.registry.invoke("asset.request", { description: "A hay cart", category: "prop" }, seqB.at(9));
  const listB = await seqB.registry.invoke("asset.requests", {}, seqB.at(10));
  const stripAgent = (rs: unknown) => JSON.stringify(rs);
  assert(stripAgent((listB.result as { requests: unknown }).requests) === stripAgent(reqsA), "the same request sequence in a fresh state must reproduce byte-identical records");

  // Gate semantics: asset.request is a real write (held under review), asset.requests is read-only.
  const reqDef = seqA.registry.describe("asset.request");
  const listDef = seqA.registry.describe("asset.requests");
  assert(reqDef !== undefined && reqDef.permissions.some((p) => !p.endsWith(".read")), "asset.request must declare a non-.read permission");
  assert(listDef !== undefined && listDef.permissions.every((p) => p.endsWith(".read")), "asset.requests must declare only .read permissions");
}

ops.op_log("[js] p_asset_catalog OK: asset.catalog browses the seed catalog (assets/catalog.json) merged with this-session catalog.publish entries (published wins on id collision, idempotent upsert, deterministic seed-then-publish ordering); catalog.publish declares scene.write (held under builder.review) while asset.catalog declares catalog.read (never held); asset.request records ＋New build requests with deterministic replay-safe ids and asset.requests lists them — a real, agent-callable, replay-safe asset index + request queue.");
