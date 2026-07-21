import { NavmeshManager } from "../src/skills/navmesh.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`p_navmesh_dynamic_portal FAIL: ${message}`);
}

const nav = new NavmeshManager();
assert(nav.build({
  bounds: { minX: 0, minZ: 0, maxX: 7, maxZ: 3 }, cellSize: 1,
  blockedCells: [[3, 0], [3, 2]],
}).ok, "corridor grid did not build");

const start: [number, number, number] = [0.5, 0, 1.5];
const goal: [number, number, number] = [6.5, 0, 1.5];
const portal = { minX: 3, minZ: 1, maxX: 4, maxZ: 2 };
const builtRevision = nav.getRevision();

for (const [id, bounds] of [
  ["   ", portal],
  ["portal/nan", { ...portal, minX: Number.NaN }],
  ["portal/infinity", { ...portal, maxZ: Number.POSITIVE_INFINITY }],
] as const) assert(!nav.registerPortal(id, bounds), `invalid portal ${id} was accepted`);
assert(nav.getRevision() === builtRevision, "rejected invalid portal changed revision");

assert(nav.registerPortal("portal/cottage/front", portal), "stable portal did not register");
assert(nav.getRevision() === builtRevision + 1, "register did not advance revision exactly once");
assert(!nav.registerPortal("portal/cottage/front", portal), "duplicate portal identity was accepted");
assert(nav.getRevision() === builtRevision + 1, "rejected duplicate changed revision");
assert(nav.isPortalOpen("portal/cottage/front") === true, "portal did not register open");
assert(nav.isReachable(start, goal), "open portal did not connect corridor");

assert(nav.planPath("npc/one", start, goal), "initial cached route was not planned");
const agent = nav.getAgent("npc/one")!;
const openPath = agent.path;
const openRevision = agent.pathRevision;

assert(nav.setPortalOpen("portal/cottage/front", false), "portal did not close");
assert(nav.getRevision() === openRevision + 1, "close did not advance revision exactly once");
assert(nav.isPortalOpen("portal/cottage/front") === false, "closed state was not observable");
assert(!nav.isReachable(start, goal) && nav.findPath(start, goal).length === 0, "closed portal left cross-portal route reachable");
assert(!nav.planPath("npc/one", start, goal), "cached open route survived portal closure");
assert(agent.path.length === 0 && agent.path !== openPath, "failed replan did not clear stale route");

const closedRevision = nav.getRevision();
assert(nav.setPortalOpen("portal/cottage/front", false), "idempotent close reported missing portal");
assert(nav.getRevision() === closedRevision, "idempotent state write changed revision");
assert(!nav.setPortalOpen("portal/missing", true), "missing portal state write succeeded");

// Two closed portals over the same cell retain closure until both reference counts leave.
assert(nav.registerPortal("portal/overlap/a", portal, false), "first overlapping portal did not register");
assert(nav.registerPortal("portal/overlap/b", portal, false), "second overlapping portal did not register");
assert(!nav.isReachable(start, goal), "overlapping closed portals did not close shared cell");
assert(nav.setPortalOpen("portal/overlap/a", true), "first overlapping portal did not open");
assert(!nav.isReachable(start, goal), "opening one overlapping portal lost the other closure reference");
assert(nav.unregisterPortal("portal/overlap/b"), "second overlapping portal did not unregister");
assert(!nav.isReachable(start, goal), "primary closed portal unexpectedly stopped closing the shared cell");

const beforeReopen = nav.getRevision();
assert(nav.setPortalOpen("portal/cottage/front", true), "portal did not reopen");
assert(nav.getRevision() === beforeReopen + 1, "reopen did not advance revision exactly once");
assert(nav.isReachable(start, goal), "reopened portal did not restore route");
assert(nav.planPath("npc/one", start, goal), "route was not replanned after reopening");
assert(agent.pathRevision === nav.getRevision() && agent.path.length > 0, "restored route was not revision-bound");

// A base-grid rebuild changes cell indexing and must recompute every portal mapping/refcount.
assert(nav.registerPortal("portal/rebuild", portal, false), "rebuild portal did not register");
const beforeRebuild = nav.getRevision();
assert(nav.build({
  bounds: { minX: -1, minZ: 0, maxX: 7, maxZ: 3 }, cellSize: 1,
  blockedCells: [[4, 0], [4, 2]],
}).ok, "shifted grid rebuild failed");
assert(nav.getRevision() === beforeRebuild + 1, "grid rebuild did not advance revision exactly once");
assert(!nav.isReachable(start, goal), "closed portal mapping/refcount was lost across shifted grid rebuild");
assert(nav.setPortalOpen("portal/rebuild", true), "rebuilt portal did not open");
assert(nav.isReachable(start, goal), "opening rebuilt portal did not restore shifted-grid route");
assert(nav.unregisterPortal("portal/rebuild"), "rebuilt portal did not unregister");

const reopenedRevision = nav.getRevision();
assert(nav.unregisterPortal("portal/cottage/front"), "portal did not unregister");
assert(nav.getRevision() === reopenedRevision + 1, "unregister did not advance revision exactly once");
assert(nav.isPortalOpen("portal/cottage/front") === undefined, "unregistered portal remained observable");
assert(!nav.unregisterPortal("portal/cottage/front"), "second unregister succeeded");
assert(nav.getRevision() === reopenedRevision + 1, "failed unregister changed revision");

console.log("p_navmesh_dynamic_portal OK: stable portal registration, idempotent state, monotonic revisions, cached-route invalidation, close-unreachable, and reopen-restored hold");
