// coordinator-demo view-model builders — PURE, host-agnostic, no THREE, no DOM,
// no `Deno`. These fold the engine's verified data contract (trace.tail events,
// approval.list payloads, inspector.snapshot) into the exact shapes the three
// surfaces render: the agent ORG-CHART (left), the REVIEW QUEUE (right), the live
// WORLD MODEL + ghost markers (the viewport), and the TRACE RIBBON (bottom).
//
// They are intentionally separated from the renderer/DOM so they can be unit-
// tested headlessly against authentic engine data (js/test/p_coordinator_demo.ts)
// and bundled for any platform (js/scripts/check-coordinator-demo.mjs).

// Terrain tiles are TILE_SIZE world-units square with origin at the tile centre:
//   origin = [tx*TILE_SIZE + TILE_SIZE/2, 0, tz*TILE_SIZE + TILE_SIZE/2]
// (mirrors js/src/terrain/procedural.ts TILE_SIZE). Used to place the ground
// region's representative marker for a held `world.generateRegion`.
export const TILE_SIZE = 48;

// Palette (0xRRGGBB) for kinds the snapshot/ghosts render. Cosmetic; the renderer
// may override. Kept here so the queue cards + ghost markers agree on colour.
export const KIND_COLOR = {
  ground: 0xc2b280, // sand
  structure: 0x8b5a2b, // cottage brown
  prop: 0x2e8b57, // foliage green
  object: 0x6c8ebf, // neutral blue
  edit: 0x9aa0a6, // unknown edit grey
};

/** Parse the trailing `.wN` worker counter out of a deterministic worker id. */
function workerSeq(workerId) {
  const m = /\.w(\d+)$/.exec(String(workerId || ""));
  return m ? Number(m[1]) : 0;
}

/** Lower-cased tag membership test. */
function hasTag(tags, set) {
  for (const t of tags) if (set.has(String(t).toLowerCase())) return true;
  return false;
}

const GROUND_TAGS = new Set(["ground", "terrain", "sand", "tile", "beach", "spawn"]);
const STRUCTURE_TAGS = new Set(["cottage", "building", "house", "structure", "wall", "roof"]);
const PROP_TAGS = new Set(["prop", "crate", "barrel", "palm", "tree", "driftwood", "rock", "grass"]);

/** Classify a snapshot entity into a render kind from its tags (best-effort). */
export function classifyEntity(tags) {
  const t = tags || [];
  if (hasTag(t, GROUND_TAGS)) return "ground";
  if (hasTag(t, STRUCTURE_TAGS)) return "structure";
  if (hasTag(t, PROP_TAGS)) return "prop";
  return "object";
}

/** World-space centre + square span of a terrain region given its tile bounds. */
export function regionCenter(bounds) {
  const b = bounds || { minTx: 0, minTz: 0, maxTx: 0, maxTz: 0 };
  const cx = ((b.minTx + b.maxTx + 1) / 2) * TILE_SIZE;
  const cz = ((b.minTz + b.maxTz + 1) / 2) * TILE_SIZE;
  const span = Math.max(b.maxTx - b.minTx + 1, b.maxTz - b.minTz + 1) * TILE_SIZE;
  const tiles = (b.maxTx - b.minTx + 1) * (b.maxTz - b.minTz + 1);
  return { center: [cx, 0, cz], span, tiles };
}

/**
 * Parse a held edit's typed input into a renderable PLACEMENT (kind + position +
 * shape/size/colour + human label). Covers the two skills the cottage build
 * proposes; falls back to a position-less "edit" for anything else.
 */
export function parsePlacement(skill, input) {
  const inp = input || {};
  if (skill === "world.generateRegion") {
    const { center, span, tiles } = regionCenter(inp.bounds);
    const b = inp.bounds || {};
    return {
      kind: "ground",
      shape: "region",
      position: center,
      size: span,
      color: KIND_COLOR.ground,
      label: `region (${b.minTx ?? "?"},${b.minTz ?? "?"})→(${b.maxTx ?? "?"},${b.maxTz ?? "?"})`,
      summary: `world.generateRegion · ${tiles} tiles · seed ${inp.seed ?? "?"}`,
    };
  }
  if (skill === "scene.createEntity") {
    const position = Array.isArray(inp.position) ? inp.position.slice(0, 3) : null;
    const size = typeof inp.size === "number" ? inp.size : 1;
    const color = typeof inp.color === "number" ? inp.color : KIND_COLOR.object;
    const shape = inp.shape || "box";
    const kind = size >= 2 ? "structure" : "prop";
    return {
      kind,
      shape,
      position,
      size,
      color,
      label: position ? `${shape} ${size} @ (${position.map(round2).join(", ")})` : `${shape} ${size}`,
      summary: `scene.createEntity · ${kind}`,
    };
  }
  return {
    kind: "edit",
    shape: "marker",
    position: Array.isArray(inp.position) ? inp.position.slice(0, 3) : null,
    size: 1,
    color: KIND_COLOR.edit,
    label: skill,
    summary: skill,
  };
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

// ---------------------------------------------------------------------------
// (a) ORG-CHART — coordinator + the delegated workers, from the trace alone.
// ---------------------------------------------------------------------------

/** Role label for a worker, derived from its bundle (+ scene-writer order). */
function roleFor(bundle, nextSceneIdx) {
  if (bundle.includes("terrain.generate")) return "Terraform";
  const i = nextSceneIdx();
  return ["Builder", "Decorator"][i] || `Worker ${i + 1}`;
}

/** Roll up one worker's lifecycle from its own thread events. */
function summarizeWorker(events, workerId) {
  let proposed = 0, granted = 0, denied = 0, executed = 0;
  for (const e of events) {
    if (e.actorId !== workerId) continue;
    if (e.type === "skill.approval.pending") proposed++;
    else if (e.type === "skill.approval.granted") granted++;
    else if (e.type === "skill.approval.denied") denied++;
    else if (e.type === "skill.executed" && e.payload && e.payload.skill !== "delegate") executed++;
  }
  const awaiting = Math.max(0, proposed - granted - denied);
  let status, label;
  if (awaiting > 0) { status = "review"; label = `Awaiting review · ${awaiting}`; }
  else if (granted > 0 && denied > 0) { status = "partial"; label = `${granted} applied · ${denied} rejected`; }
  else if (granted > 0) { status = "applied"; label = `Applied · ${granted}`; }
  else if (denied > 0) { status = "rejected"; label = `Rejected · ${denied}`; }
  else if (proposed > 0) { status = "review"; label = "Proposing"; }
  else { status = "delegated"; label = "Delegated"; }
  return { status, label, counts: { proposed, granted, denied, awaiting, executed } };
}

/**
 * Build the org-chart view-model from a flat trace array:
 *   { coordinator: {id, goal, profile}, workers: [{workerId, role, task, bundle, status, label, counts}] }
 * Workers are ordered by their deterministic `.wN` id.
 */
export function buildOrgChart(events) {
  const evs = events || [];
  const delegated = evs.filter((e) => e.type === "agent.delegated");
  const decompose = evs.find((e) => e.type === "agent.decision.made" && e.payload && e.payload.kind === "decompose");
  const coordId = delegated.length
    ? delegated[0].actorId
    : (evs.find((e) => e.type === "agent.decision.made")?.actorId ?? null);

  const sorted = [...delegated].sort((a, b) => workerSeq(a.payload?.workerId) - workerSeq(b.payload?.workerId));
  let sceneIdx = 0;
  const nextSceneIdx = () => sceneIdx++;
  const workers = sorted.map((ev) => {
    const p = ev.payload || {};
    const bundle = Array.isArray(p.bundle) ? p.bundle : [];
    const life = summarizeWorker(evs, p.workerId);
    return {
      workerId: p.workerId,
      role: roleFor(bundle, nextSceneIdx),
      task: p.task ?? "",
      bundle,
      reason: p.reason ?? null,
      ...life,
    };
  });

  return {
    coordinator: {
      id: coordId,
      goal: decompose?.payload?.goal ?? "a cottage on the beach",
      profile: "reviewer.coordinator",
    },
    workers,
  };
}

// ---------------------------------------------------------------------------
// (b) REVIEW QUEUE — held edits from an approval.list payload.
// ---------------------------------------------------------------------------

/**
 * Build the review-queue view-model from an `approval.list` payload
 * ({ pending: [...] }). Each card carries the worker, skill, the parsed
 * placement (kind/position/shape/size/colour) and a human label/summary.
 */
export function buildReviewQueue(payload) {
  const pending = (payload && payload.pending) || [];
  const cards = pending.map((p) => {
    const placement = parsePlacement(p.skill, p.input);
    return {
      approvalId: p.approvalId,
      workerId: p.agentId,
      skill: p.skill,
      profile: p.profile ?? null,
      tick: p.tick,
      input: p.input,
      ...placement,
    };
  });
  return { count: cards.length, cards };
}

// ---------------------------------------------------------------------------
// (c) WORLD MODEL — renderable entities from a snapshot + ghosts from pending.
// ---------------------------------------------------------------------------

/**
 * Build the world view-model from an inspector.snapshot and the pending-approval
 * list: the SOLID entities currently in the world (positions/scale/tags → kind),
 * plus translucent GHOST markers for every held edit that has a position.
 */
export function buildWorldModel(snapshot, pending) {
  const ents = (snapshot && snapshot.entities) || [];
  const entities = ents.map((e) => ({
    id: e.entity,
    position: e.transform.position,
    rotation: e.transform.rotation,
    scale: e.transform.scale,
    tags: e.tags || [],
    kind: classifyEntity(e.tags || []),
  }));
  const queue = buildReviewQueue({ pending: pending || [] });
  const ghosts = queue.cards
    .filter((c) => Array.isArray(c.position))
    .map((c) => ({
      approvalId: c.approvalId,
      skill: c.skill,
      kind: c.kind,
      position: c.position,
      shape: c.shape,
      size: c.size,
      color: c.color,
      label: c.label,
    }));
  return { entities, ghosts };
}

// ---------------------------------------------------------------------------
// (d) TRACE RIBBON — decompose → delegate → propose → review → apply.
// ---------------------------------------------------------------------------

export const RIBBON_PHASES = [
  { key: "decompose", label: "Decompose" },
  { key: "delegate", label: "Delegate" },
  { key: "propose", label: "Propose" },
  { key: "review", label: "Review" },
  { key: "apply", label: "Apply" },
];

/**
 * Build the trace-ribbon view-model from the trace array: a count per phase and
 * which phase the build has reached (the furthest non-empty phase is `current`).
 */
export function buildTraceRibbon(events) {
  const evs = events || [];
  let decompose = 0, delegate = 0, propose = 0, review = 0, apply = 0;
  for (const e of evs) {
    if (e.type === "agent.decision.made" && e.payload && e.payload.kind === "decompose") decompose++;
    else if (e.type === "agent.delegated") delegate++;
    else if (e.type === "skill.approval.pending") propose++;
    else if (e.type === "skill.approval.granted" || e.type === "skill.approval.denied") review++;
    // "apply" = a previously-HELD edit that actually landed: a non-delegate
    // skill.executed on a WORKER thread (".wN"). This excludes the coordinator's
    // own delegate/approval/inspect executions, which are not world edits.
    else if (e.type === "skill.executed" && e.payload && e.payload.skill !== "delegate" && /\.w\d+$/.test(String(e.actorId))) apply++;
  }
  const counts = { decompose, delegate, propose, review, apply };
  const phases = RIBBON_PHASES.map((p) => ({ ...p, count: counts[p.key], active: counts[p.key] > 0 }));
  let current = null;
  for (const p of phases) if (p.active) current = p.key;
  return { phases, current };
}
