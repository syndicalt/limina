// DESIGN AGENT TEAM — the expert agents that staff the Design Space, each wired with
// FULL context for its role. A design turn needs the agent to know four things before it
// speaks: WHO it is (persona), WHAT it owns + depends on (document-aware), WHERE the maker
// is looking (screen-aware), and what a change would RIPPLE into (cascade-aware). This
// module assembles that context; runChatTurn (in the kernel) runs it against a provider.
//
// The 5 domain experts reuse the DESIGN_STUDIOS personas (role/systemPrompt/tools). The
// Architect is the 6th agent — it sees every document, keeps the whole coherent, and routes
// cascades between the domain experts.

import { DESIGN_STUDIOS, type DesignStudio } from "./design-studio.ts";
import {
  DESIGN_ARTIFACT_KINDS,
  type DesignArtifactKind,
  type DesignArtifactStore,
} from "../world/design-artifacts.ts";

export type DesignAgentId = DesignStudio["id"] | "architect";

export interface DesignAgent {
  id: DesignAgentId;
  role: string;
  title: string;
  /** "domain" experts own one artifact; the "global" architect watches all. */
  scope: "domain" | "global";
  /** The artifact this agent owns (undefined for the global architect). */
  artifactKind?: DesignArtifactKind;
  upstreamKinds: readonly DesignArtifactKind[];
  /** Artifacts that DEPEND on this agent's artifact — what a change here can cascade into. */
  downstreamKinds: readonly DesignArtifactKind[];
  systemPromptBase: string;
  tools: readonly string[];
}

/** What the maker is currently looking at, passed with each turn (screen-awareness). */
export interface ScreenContext {
  /** The document the maker has open (e.g. "world-bible.md" or a kind). */
  openDoc?: string;
  /** Text the maker has selected / is asking about. */
  selectionText?: string;
  /** The agent the maker is talking to. */
  activeAgent?: DesignAgentId;
  /** Recent design edits, newest last (short human strings). */
  recentEdits?: string[];
}

/** Artifacts that depend on `kind` (its downstream), derived from studio upstreamKinds. */
function downstreamOf(kind: DesignArtifactKind): DesignArtifactKind[] {
  return DESIGN_STUDIOS.filter((s) => s.upstreamKinds.includes(kind)).map((s) => s.artifactKind);
}

const ARCHITECT: DesignAgent = {
  id: "architect",
  role: "Architect",
  title: "Architect",
  scope: "global",
  artifactKind: undefined,
  upstreamKinds: DESIGN_ARTIFACT_KINDS,
  downstreamKinds: DESIGN_ARTIFACT_KINDS,
  systemPromptBase:
    "Architect: you hold the whole design coherent. You see every document — concept, art " +
    "direction, world, cast, and storyboard — and the dependencies between them. When one " +
    "document changes you identify which downstream documents are affected and route the work " +
    "to the right domain expert, surfacing the cascade for the maker to review. Act as a " +
    "collaborator and coordinator; propose how to keep the whole consistent; never the ultimate " +
    "decider unless explicitly asked.",
  tools: ["design.get", "design.set", "design.patch"],
};

export const DESIGN_AGENTS: readonly DesignAgent[] = [
  ...DESIGN_STUDIOS.map((s): DesignAgent => ({
    id: s.id,
    role: s.expert.role,
    title: s.title,
    scope: "domain",
    artifactKind: s.artifactKind,
    upstreamKinds: s.upstreamKinds,
    downstreamKinds: downstreamOf(s.artifactKind),
    systemPromptBase: s.expert.systemPrompt,
    tools: s.expert.tools,
  })),
  ARCHITECT,
];

const AGENTS_BY_ID = new Map(DESIGN_AGENTS.map((a) => [a.id, a]));

export function getDesignAgent(id: string): DesignAgent {
  const a = AGENTS_BY_ID.get(id as DesignAgentId);
  if (a === undefined) throw new Error(`unknown design agent "${id}"`);
  return a;
}

export interface AssembledContext {
  agentId: DesignAgentId;
  role: string;
  title: string;
  /** The full system prompt: persona + document context + screen context + cascade note. */
  systemPrompt: string;
  tools: readonly string[];
  /** Which artifact kinds were folded into the context (own + upstream, or all for architect). */
  contextKinds: DesignArtifactKind[];
}

function summarizeArtifact(store: DesignArtifactStore, kind: DesignArtifactKind, limit = 1400): string {
  const value = store.artifacts.get(kind);
  if (value === undefined) return `${kind}: (not yet authored)`;
  const json = JSON.stringify(value);
  return `${kind}: ${json.length > limit ? json.slice(0, limit) + "…(truncated)" : json}`;
}

/** Assemble the FULL role context for an agent: persona, the documents it owns + depends on,
 *  what the maker is looking at, and the cascade it must watch. This is what makes the agent
 *  document- and screen-aware before runChatTurn runs it. */
export function assembleAgentContext(
  agentId: string,
  store: DesignArtifactStore,
  screen: ScreenContext = {},
): AssembledContext {
  const agent = getDesignAgent(agentId);
  const contextKinds: DesignArtifactKind[] =
    agent.scope === "global"
      ? [...DESIGN_ARTIFACT_KINDS]
      : [...new Set<DesignArtifactKind>([...(agent.artifactKind ? [agent.artifactKind] : []), ...agent.upstreamKinds])];

  const parts: string[] = [];
  parts.push(agent.systemPromptBase);
  parts.push(`\nYOU ARE the ${agent.role} on the design team for this game.`);

  // Document-awareness.
  if (agent.scope === "global") {
    parts.push("\nYOU SEE EVERY DOCUMENT (current content):");
    for (const kind of DESIGN_ARTIFACT_KINDS) parts.push("  - " + summarizeArtifact(store, kind));
  } else {
    parts.push(`\nYOU OWN the '${agent.artifactKind}' document. Its current content:`);
    parts.push("  " + summarizeArtifact(store, agent.artifactKind!));
    if (agent.upstreamKinds.length > 0) {
      parts.push("\nUPSTREAM documents you depend on (do not contradict them):");
      for (const kind of agent.upstreamKinds) parts.push("  - " + summarizeArtifact(store, kind));
    }
  }

  // Screen-awareness.
  if (screen.openDoc || screen.selectionText) {
    parts.push(
      `\nRIGHT NOW the maker is viewing ${screen.openDoc ?? "a document"}` +
        (screen.selectionText ? `, with this selected: "${screen.selectionText}"` : "") +
        ". Ground your response in what they are looking at.",
    );
  } else {
    parts.push("\nThe maker has not indicated a specific focus; help with the whole of your domain.");
  }
  if (screen.recentEdits && screen.recentEdits.length > 0) {
    parts.push("Recent design edits (newest last): " + screen.recentEdits.slice(-5).join("; ") + ".");
  }

  // Cascade-awareness.
  if (agent.downstreamKinds.length > 0) {
    parts.push(
      `\nCASCADE: a change here can ripple into [${agent.downstreamKinds.join(", ")}]. If you propose a ` +
        "change that affects them, NAME what is affected — the system surfaces cascades for the maker to " +
        "review; never let downstream documents drift silently.",
    );
  }

  // Tools.
  parts.push(
    `\nTOOLS: you may read design state (design.get) and PROPOSE edits (design.set / design.patch)` +
      (agent.tools.length > 3 ? ` plus ${agent.tools.slice(3).join(", ")}` : "") +
      ". Proposals are surfaced for the maker's review, not applied silently.",
  );

  return {
    agentId: agent.id,
    role: agent.role,
    title: agent.title,
    systemPrompt: parts.join("\n"),
    tools: agent.tools,
    contextKinds,
  };
}
