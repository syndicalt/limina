// Reasoning-tree assembly. Engine events carry `causedBy[]` (and `parentEventId`);
// along an agent step the chain runs agent.perception.updated -> agent.decision.made
// -> agent.tool_result / agent.toolcall.rejected, and a gated edit threads
// skill.approval.pending -> skill.approval.granted|denied -> skill.executed.
//
// We fold the flat trace.tail stream into a causal FOREST: a node is a root when
// none of its causal parents are present in the current event set; every other
// node hangs under its parent(s). This is generic over event types, so it renders
// whatever causal structure the engine actually recorded (no hard-coded shape).

/** @typedef {{id:string,type:string,actorId:string,causedBy:string[],parentEventId:string|null,payload:any,timestamp:string}} Ev */

/** Classify an event type into a coarse kind for styling/grouping. */
export function eventKind(type) {
  if (type.startsWith("agent.perception")) return "perception";
  if (type.startsWith("agent.decision")) return "decision";
  if (type === "agent.tool_result" || type === "skill.executed") return "action";
  if (type === "agent.toolcall.rejected") return "rejected";
  if (type.startsWith("skill.approval")) return "approval";
  if (type.startsWith("policy.")) return "policy";
  if (type.startsWith("security.")) return "security";
  return "event";
}

/** The causal parents of an event that are present in `byId`. */
function presentParents(ev, byId) {
  const ids = ev.parentEventId === null ? ev.causedBy : [ev.parentEventId, ...ev.causedBy];
  const out = [];
  for (const id of new Set(ids)) if (byId.has(id) && id !== ev.id) out.push(id);
  return out;
}

/**
 * Build the causal forest for a set of events.
 * @param {Ev[]} events
 * @returns {{roots: TreeNode[], byId: Map<string, Ev>}}
 * @typedef {{event: Ev, kind: string, children: TreeNode[]}} TreeNode
 */
export function buildForest(events) {
  const byId = new Map();
  for (const e of events) byId.set(e.id, e);

  const childrenOf = new Map();
  const hasPresentParent = new Set();
  for (const e of events) {
    const parents = presentParents(e, byId);
    if (parents.length > 0) hasPresentParent.add(e.id);
    for (const p of parents) {
      const arr = childrenOf.get(p) || [];
      arr.push(e.id);
      childrenOf.set(p, arr);
    }
  }

  const seq = (id) => {
    const m = /_(\d{12})_/.exec(id);
    return m ? Number(m[1]) : 0;
  };
  const built = new Map();
  const build = (id, guard) => {
    if (built.has(id)) return built.get(id);
    const ev = byId.get(id);
    /** @type {TreeNode} */
    const node = { event: ev, kind: eventKind(ev.type), children: [] };
    built.set(id, node);
    const kids = (childrenOf.get(id) || []).filter((k) => !guard.has(k));
    kids.sort((a, b) => seq(a) - seq(b));
    for (const k of kids) {
      const childGuard = new Set(guard);
      childGuard.add(id);
      node.children.push(build(k, childGuard));
    }
    return node;
  };

  const roots = events
    .filter((e) => !hasPresentParent.has(e.id))
    .sort((a, b) => seq(a.id) - seq(b.id))
    .map((e) => build(e.id, new Set([e.id])));

  return { roots, byId };
}

/** Group a forest's roots by actor (agentId) for the per-agent Reasoning panel. */
export function groupByActor(roots) {
  const byActor = new Map();
  for (const root of roots) {
    const actor = root.event.actorId;
    const arr = byActor.get(actor) || [];
    arr.push(root);
    byActor.set(actor, arr);
  }
  return byActor;
}
