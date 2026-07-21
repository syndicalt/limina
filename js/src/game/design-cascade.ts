// DESIGN CASCADE — the impact engine. A change in one document can ripple: move the
// Watchtower and the NPC who lives there, the beat that happens there, and the build
// placement all reference it. This computes that blast radius over the design graph so it
// can be SURFACED for the maker to review — never silently drift.
//
// The mind-map IS the impact graph. The vault's typed edges (npc lives-in location, beat
// occurs-at location, location in region) are dependency edges: whoever points AT the
// changed node is affected. On top of the fine-grained entity graph sits the coarse
// artifact DAG (a worldBible change ripples to cast + storyboard) and the doc->build links.

import { vaultGraph, type VaultDoc } from "./design-vault.ts";
import { getDesignAgent, type DesignAgentId } from "./design-agents.ts";
import { type DesignArtifactKind } from "../world/design-artifacts.ts";

/** Which artifact (and therefore which expert) owns each graph node type. */
const TYPE_ARTIFACT: Record<string, DesignArtifactKind> = {
  region: "worldBible", location: "worldBible",
  player: "cast", npc: "cast", creature: "cast",
  beat: "storyboard",
};
const ARTIFACT_AGENT: Record<string, DesignAgentId> = {
  gds: "concept", artDirection: "artDirection", worldBible: "world", cast: "cast", storyboard: "storyboard",
};

export interface DesignChange {
  /** The changed entity id (a location/cast/beat id), e.g. "watchtower". */
  entityId?: string;
  /** Or a coarse artifact-level change (e.g. the whole worldBible). */
  artifact?: DesignArtifactKind;
  op: "modified" | "removed" | "added";
  note?: string;
}

export interface ImpactedItem {
  id: string;
  name: string;
  type: string;
  /** How it references the changed thing (the edge label: lives-in, occurs-at, in…). */
  relation: string;
  artifact: DesignArtifactKind;
  expertId: DesignAgentId;
  expertRole: string;
  reason: string;
}

export interface CascadeExpert {
  id: DesignAgentId;
  role: string;
  artifacts: DesignArtifactKind[];
}

export interface CascadeImpact {
  change: DesignChange;
  source?: { id: string; name: string; type: string; artifact: DesignArtifactKind };
  /** Entities that reference the changed thing and need review. */
  affected: ImpactedItem[];
  /** Downstream artifacts a change here ripples into (coarse DAG). */
  downstreamArtifacts: DesignArtifactKind[];
  /** The experts to route the review to. */
  experts: CascadeExpert[];
  /** Build ids that move / change as a result. */
  buildPlacements: string[];
  summary: string;
}

function artifactOf(type: string): DesignArtifactKind | undefined { return TYPE_ARTIFACT[type]; }
function agentForArtifact(kind: DesignArtifactKind): { id: DesignAgentId; role: string } {
  const a = getDesignAgent(ARTIFACT_AGENT[kind] ?? "architect");
  return { id: a.id, role: a.role };
}
function placementId(type: string, id: string): string {
  return type === "location" || type === "region" ? `location-${id}` : `entity-${id}`;
}

/** Compute the cascade impact of a change over the vault's design graph. */
export function computeImpact(docs: VaultDoc[], change: DesignChange): CascadeImpact {
  const graph = vaultGraph(docs);
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const affected: ImpactedItem[] = [];
  const buildPlacements = new Set<string>();
  const downstream = new Set<DesignArtifactKind>();

  let source: CascadeImpact["source"];

  if (change.entityId) {
    const node = nodeById.get(change.entityId);
    if (node) {
      const srcArtifact = artifactOf(node.type) ?? "worldBible";
      source = { id: node.id, name: node.label, type: node.type, artifact: srcArtifact };
      if (change.op !== "removed") buildPlacements.add(placementId(node.type, node.id));
      // The source artifact's coarse downstream.
      for (const d of getDesignAgent(ARTIFACT_AGENT[srcArtifact]).downstreamKinds) downstream.add(d);

      // Referrers: any node with an edge pointing AT the changed node depends on it.
      for (const e of graph.edges) {
        if (e.to !== node.id) continue;
        const ref = nodeById.get(e.from);
        if (!ref) continue;
        const artifact = artifactOf(ref.type) ?? srcArtifact;
        const agent = agentForArtifact(artifact);
        const verb = change.op === "removed" ? "loses its target — it" : "references it and";
        affected.push({
          id: ref.id, name: ref.label, type: ref.type, relation: e.label,
          artifact, expertId: agent.id, expertRole: agent.role,
          reason: `${ref.label} ${e.label} ${node.label}; ${verb} may need updating.`,
        });
        downstream.add(artifact);
        buildPlacements.add(placementId(ref.type, ref.id));
      }
    }
  } else if (change.artifact) {
    source = undefined;
    for (const d of getDesignAgent(ARTIFACT_AGENT[change.artifact]).downstreamKinds) downstream.add(d);
  }

  // The expert(s) to route to: the owners of every downstream artifact (+ any affected artifact).
  const expertMap = new Map<DesignAgentId, CascadeExpert>();
  const addExpert = (kind: DesignArtifactKind) => {
    const a = agentForArtifact(kind);
    const cur = expertMap.get(a.id) ?? { id: a.id, role: a.role, artifacts: [] };
    if (!cur.artifacts.includes(kind)) cur.artifacts.push(kind);
    expertMap.set(a.id, cur);
  };
  for (const item of affected) addExpert(item.artifact);
  for (const d of downstream) addExpert(d);

  const experts = [...expertMap.values()];
  const changedName = source?.name ?? change.artifact ?? "(unknown)";
  const summary =
    affected.length === 0
      ? `${change.op} ${changedName}: no downstream references found${downstream.size ? `; still review ${[...downstream].join(", ")}` : ""}.`
      : `${change.op} ${changedName} affects ${affected.length} item(s): ` +
        affected.map((a) => `${a.name} (${a.relation})`).join(", ") +
        ` — review with ${experts.map((e) => e.role).join(", ")}.`;

  return {
    change,
    source,
    affected,
    downstreamArtifacts: [...downstream],
    experts,
    buildPlacements: [...buildPlacements],
    summary,
  };
}
