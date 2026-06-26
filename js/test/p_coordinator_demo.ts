// coordinator-demo — headless verification of the web client's VIEW-MODEL builders.
//
// The in-tab WebGPU render + the visual polish of coordinator-demo/ are UAT (no GPU
// here). The DATA WIRING is not: the pure builders in coordinator-demo/src/viewmodel.js
// fold the engine's verified data contract into the exact shapes the three surfaces
// render, and we exercise them against AUTHENTIC engine data — the real cottage build
// (setupCoordinatorCottage), the real approval.list payload, and a real inspector.
// snapshot — NOT hand-mocked fixtures. We assert:
//   (a) trace array            -> org-chart (coordinator + 3 workers, bundles, statuses)
//   (b) approval.list payload  -> review-queue cards (worker, skill, parsed position)
//   (c) inspector.snapshot     -> renderable entity list (+ ghost list from pending)
//   (d) status TRANSITIONS as held edits are granted (review -> applied) and the
//       world model gains the granted entities while denied props stay ghost-then-gone.
//
// Run: ./target/release/limina js/test/p_coordinator_demo.ts

import { ops } from "../src/engine.ts";
import { setupCoordinatorCottage, BEACH_SEED } from "../src/demos/coordinator_cottage.ts";
import { resolveProfile } from "../src/skills/permissions.ts";
import {
  buildOrgChart,
  buildReviewQueue,
  buildWorldModel,
  buildTraceRibbon,
  parsePlacement,
  regionCenter,
  TILE_SIZE,
} from "../../coordinator-demo/src/viewmodel.js";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p_coordinator_demo FAIL: " + msg);
}

interface PendingView {
  approvalId: string;
  skill: string;
  agentId: string;
  profile: string | null;
  tick: number;
  input: unknown;
}

ops.op_physics_create_world(0);

const c = setupCoordinatorCottage("ses_demo_vm");
// A read base with the inspector.snapshot permission set (reads are never gated).
const snapPerms = resolveProfile("system.readonly");
const snapBase = (tick: number) => ({
  agentId: "agt_inspector",
  sessionId: "ses_demo_vm",
  permissions: snapPerms,
  profile: "system.readonly",
  tick,
  world: c.world,
});
const traceEvents = () => c.tracer.replay().events as unknown as Array<{ type: string; actorId: string; payload: { kind?: string } }>;
const listPending = async (tick: number): Promise<PendingView[]> => {
  const r = await c.registry.invoke("approval.list", {}, c.coordBase(tick));
  assert(r.success, "approval.list failed");
  return (r.result as { pending: PendingView[] }).pending;
};
const snapshot = async (tick: number) => {
  const r = await c.registry.invoke("inspector.snapshot", { limit: 200 }, snapBase(tick));
  assert(r.success, "inspector.snapshot failed: " + JSON.stringify(r.error));
  return r.result as { entities: Array<{ entity: string; transform: { position: number[] }; tags: string[] }> };
};

// ---- run the real build (3 workers delegated; 5 mutating edits HELD) -------
const built = await c.runCottageBuild(1);
assert(built.workers.length === 3, "expected 3 delegated workers");

// === (a) ORG-CHART from the authentic trace ================================
const org0 = buildOrgChart(traceEvents());
assert(org0.coordinator.id === "agt_coord", "coordinator id wrong: " + org0.coordinator.id);
assert(org0.coordinator.goal === "a cottage on the beach", "coordinator goal lost: " + org0.coordinator.goal);
assert(org0.workers.length === 3, "org-chart should have 3 workers, got " + org0.workers.length);
assert(
  org0.workers.map((w) => w.workerId).join(",") === "agt_coord.w1,agt_coord.w2,agt_coord.w3",
  "worker order/ids wrong: " + org0.workers.map((w) => w.workerId).join(","),
);
assert(
  org0.workers.map((w) => w.role).join(",") === "Terraform,Builder,Decorator",
  "worker roles wrong: " + org0.workers.map((w) => w.role).join(","),
);
// bundle chips survive, and only Terraform carries terrain.generate.
assert(org0.workers[0].bundle.includes("terrain.generate"), "Terraform missing terrain.generate chip");
assert(org0.workers.slice(1).every((w) => !w.bundle.includes("terrain.generate")), "a scene worker over-granted terrain.generate");
// every worker's edits are HELD pre-review -> status "review".
assert(org0.workers.every((w) => w.status === "review"), "pre-review every worker should be awaiting review: " + JSON.stringify(org0.workers.map((w) => w.status)));
assert(org0.workers[0].counts.proposed === 1 && org0.workers[2].counts.proposed === 3, "held-edit counts wrong per worker: " + JSON.stringify(org0.workers.map((w) => w.counts.proposed)));

// === (b) REVIEW QUEUE from the authentic approval.list payload =============
const pending = await listPending(2);
assert(pending.length === 5, "expected 5 held edits, got " + pending.length);
const queue = buildReviewQueue({ pending });
assert(queue.count === 5 && queue.cards.length === 5, "queue should have 5 cards");

const tfCard = queue.cards.find((c2) => c2.skill === "world.generateRegion");
const cottageCard = queue.cards.find((c2) => c2.workerId === "agt_coord.w2" && c2.skill === "scene.createEntity");
const propCards = queue.cards.filter((c2) => c2.workerId === "agt_coord.w3");
assert(tfCard !== undefined && cottageCard !== undefined && propCards.length === 3, "queue did not surface terrain + cottage + 3 props");

// parsed placements: cottage at its authored spot, terrain region centred from bounds.
assert(
  Array.isArray(cottageCard.position) && cottageCard.position[0] === 0 && cottageCard.position[1] === 1.5 && cottageCard.position[2] === 0,
  "cottage card position not parsed from input: " + JSON.stringify(cottageCard.position),
);
assert(cottageCard.kind === "structure" && cottageCard.size === 3, "cottage card kind/size wrong: " + cottageCard.kind + "/" + cottageCard.size);
assert(tfCard.kind === "ground" && Array.isArray(tfCard.position), "terrain card kind/position wrong");
// the 2x2 region (minTx0..maxTx1) centres at (TILE_SIZE, 0, TILE_SIZE).
assert(tfCard.position[0] === TILE_SIZE && tfCard.position[2] === TILE_SIZE, "terrain region centre wrong: " + JSON.stringify(tfCard.position));
assert(propCards.every((p) => p.kind === "prop" && Array.isArray(p.position)), "prop cards not parsed as positioned props");
// every card carries the worker + skill + a human label.
assert(queue.cards.every((c2) => typeof c2.workerId === "string" && typeof c2.skill === "string" && typeof c2.label === "string" && c2.label.length > 0), "a queue card is missing worker/skill/label");

// pure-fn spot checks (independent of the live run).
const rc = regionCenter({ minTx: 0, minTz: 0, maxTx: 1, maxTz: 1 });
assert(rc.tiles === 4 && rc.span === 2 * TILE_SIZE, "regionCenter math wrong: " + JSON.stringify(rc));
const pp = parsePlacement("scene.createEntity", { shape: "box", size: 1, color: 0x2e8b57, position: [4, 1, 2] });
assert(pp.kind === "prop" && pp.color === 0x2e8b57 && pp.position[0] === 4, "parsePlacement prop wrong: " + JSON.stringify(pp));

// === (c) WORLD MODEL from a real snapshot + pending ghosts ==================
const snap0 = await snapshot(3);
const world0 = buildWorldModel(snap0, pending);
// pre-grant: only the 3 bootstrap-free? setup world starts EMPTY -> 0 solid entities,
// 5 held edits -> 5 ghosts (all have a position: 1 terrain region + cottage + 3 props).
assert(world0.entities.length === 0, "fresh cottage world should have 0 solid entities, got " + world0.entities.length);
assert(world0.ghosts.length === 5, "expected 5 positioned ghost markers, got " + world0.ghosts.length);
assert(world0.ghosts.some((g) => g.kind === "ground") && world0.ghosts.some((g) => g.kind === "structure") && world0.ghosts.filter((g) => g.kind === "prop").length === 3, "ghost kinds wrong: " + JSON.stringify(world0.ghosts.map((g) => g.kind)));

// === (d) GRANT the beach + cottage, DENY the props; re-derive everything ====
const tfApproval = pending.find((p) => p.skill === "world.generateRegion")!;
const cottageApproval = pending.find((p) => p.agentId === "agt_coord.w2")!;
const propApprovals = pending.filter((p) => p.agentId === "agt_coord.w3");
assert((await c.registry.invoke("approval.grant", { approvalId: tfApproval.approvalId }, c.coordBase(4))).success, "grant terrain failed");
assert((await c.registry.invoke("approval.grant", { approvalId: cottageApproval.approvalId }, c.coordBase(5))).success, "grant cottage failed");
for (const p of propApprovals) {
  assert((await c.registry.invoke("approval.deny", { approvalId: p.approvalId, reason: "keep it sparse" }, c.coordBase(6))).success, "deny prop failed");
}

const pendingAfter = await listPending(7);
assert(pendingAfter.length === 0, "no edits should remain held after grant/deny, got " + pendingAfter.length);

// org-chart status TRANSITION: Terraform + Builder applied, Decorator rejected.
const org1 = buildOrgChart(traceEvents());
const byId = Object.fromEntries(org1.workers.map((w) => [w.workerId, w]));
assert(byId["agt_coord.w1"].status === "applied" && byId["agt_coord.w2"].status === "applied", "granted workers should read 'applied': " + JSON.stringify([byId["agt_coord.w1"].status, byId["agt_coord.w2"].status]));
assert(byId["agt_coord.w3"].status === "rejected" && byId["agt_coord.w3"].counts.denied === 3, "denied worker should read 'rejected' (3 denied): " + JSON.stringify(byId["agt_coord.w3"]));

// world model now: granted beach (4 tiles) + cottage (1) = 5 solid entities, 0 ghosts.
const snap1 = await snapshot(8);
const world1 = buildWorldModel(snap1, pendingAfter);
assert(world1.entities.length === 5, "granted world should have 5 solid entities (4 tiles + cottage), got " + world1.entities.length);
assert(world1.ghosts.length === 0, "no ghosts should remain after all edits resolved, got " + world1.ghosts.length);

// === trace ribbon reaches "apply" ==========================================
const ribbon = buildTraceRibbon(traceEvents());
assert(ribbon.current === "apply", "ribbon should have reached the apply phase, got " + ribbon.current);
const phaseCount = (k: string) => ribbon.phases.find((p) => p.key === k)!.count;
assert(phaseCount("decompose") === 1 && phaseCount("delegate") === 3, "ribbon decompose/delegate counts wrong");
assert(phaseCount("propose") === 5 && phaseCount("review") === 5 && phaseCount("apply") === 2, "ribbon propose/review/apply counts wrong: " + JSON.stringify(ribbon.phases.map((p) => p.count)));

ops.op_log(
  `p_coordinator_demo OK: view-model builders verified against AUTHENTIC engine data ` +
  `(seed ${BEACH_SEED}). (a) org-chart: coordinator agt_coord + 3 workers ` +
  `[Terraform/Builder/Decorator] with least-privilege bundle chips + live statuses; ` +
  `(b) review queue: 5 cards w/ worker+skill+parsed position (cottage @0,1.5,0; region @${TILE_SIZE},0,${TILE_SIZE}); ` +
  `(c) world model: 0 solid/5 ghosts pre-review; (d) after grant beach+cottage / deny props -> ` +
  `5 solid entities, 0 ghosts, statuses applied/applied/rejected, ribbon -> apply.`,
);
