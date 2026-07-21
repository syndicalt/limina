import {
  DESIGN_ARTIFACT_KINDS,
  type DesignArtifactKind,
  type DesignArtifactStore,
} from "../world/design-artifacts.ts";

export type DesignStudioId = "concept" | "artDirection" | "world" | "cast" | "storyboard";
export type DesignStudioStatus = "blocked" | "ready" | "filled";

export interface DesignStudio {
  id: DesignStudioId;
  title: string;
  artifactKind: DesignArtifactKind;
  upstreamKinds: readonly DesignArtifactKind[];
  expert: {
    role: string;
    systemPrompt: string;
    tools: readonly string[];
  };
}

export interface DesignStudioReadiness {
  studioId: DesignStudioId;
  status: DesignStudioStatus;
  missingUpstreams: DesignArtifactKind[];
}

export interface DesignStudioProgress {
  studios: DesignStudioReadiness[];
  filledCount: number;
  nextActionable: DesignStudioId | null;
}

const ARTIFACT_KIND_SET: ReadonlySet<string> = new Set(DESIGN_ARTIFACT_KINDS);

function studioTools(extraTools: readonly string[]): readonly string[] {
  return ["design.get", "design.set", "design.patch", ...extraTools] as const;
}

export const DESIGN_STUDIOS = [
  {
    id: "concept",
    title: "Concept Studio",
    artifactKind: "gds",
    upstreamKinds: [],
    expert: {
      role: "Game Designer",
      systemPrompt:
        "Game Designer: act as a collaborator and trusted partner while the maker shapes the game concept. Proactively surface playable examples through concept generation and design RAG, propose options and tradeoffs, and never the ultimate decider unless explicitly asked.",
      tools: studioTools(["concept.generate.examples", "design.rag.examples"]),
    },
  },
  {
    id: "artDirection",
    title: "Art Direction Studio",
    artifactKind: "artDirection",
    upstreamKinds: ["gds"],
    expert: {
      role: "Art Director",
      systemPrompt:
        "Art Director: act as a collaborator and trusted partner while the maker develops the visual language. Proactively surface key-art generations and reference-library matches, propose palettes and style options, and never the ultimate decider unless explicitly asked.",
      tools: studioTools(["art.generate.keyArt", "art.referenceLibrary.search"]),
    },
  },
  {
    id: "world",
    title: "World Studio",
    artifactKind: "worldBible",
    upstreamKinds: ["gds", "artDirection"],
    expert: {
      role: "Worldbuilder",
      systemPrompt:
        "Worldbuilder: act as a collaborator and trusted partner while the maker defines regions, factions, biomes, and lore. Proactively surface terrain and biome previews plus worldbuilding RAG examples, propose cohesive options, and never the ultimate decider unless explicitly asked.",
      tools: studioTools(["world.preview.terrainBiome", "world.rag.examples"]),
    },
  },
  {
    id: "cast",
    title: "Cast Studio",
    artifactKind: "cast",
    upstreamKinds: ["gds", "artDirection", "worldBible"],
    expert: {
      role: "Casting Director",
      systemPrompt:
        "Casting Director: act as a collaborator and trusted partner while the maker builds the player and NPC cast. Proactively surface character generations and casting-reference matches, propose silhouettes, roles, and relationships, and never the ultimate decider unless explicitly asked.",
      tools: studioTools(["character.generate", "cast.referenceLibrary.search"]),
    },
  },
  {
    id: "storyboard",
    title: "Storyboard Studio",
    artifactKind: "storyboard",
    upstreamKinds: ["gds", "artDirection", "worldBible", "cast"],
    expert: {
      role: "Narrative Designer",
      systemPrompt:
        "Narrative Designer: act as a collaborator and trusted partner while the maker sequences beats and interactive moments. Proactively surface storyboard, encounter, and narrative-structure examples through generation and RAG, propose alternatives, and never the ultimate decider unless explicitly asked.",
      tools: studioTools(["storyboard.generate.beats", "narrative.rag.examples"]),
    },
  },
] as const satisfies readonly DesignStudio[];

const STUDIOS_BY_ID: ReadonlyMap<DesignStudioId, DesignStudio> = new Map(
  DESIGN_STUDIOS.map((studio) => [studio.id, studio]),
);

for (const studio of DESIGN_STUDIOS) {
  if (!ARTIFACT_KIND_SET.has(studio.artifactKind)) {
    throw new Error(`DesignStudio ${studio.id} uses unknown artifact kind ${studio.artifactKind}`);
  }
  for (const upstreamKind of studio.upstreamKinds) {
    if (!ARTIFACT_KIND_SET.has(upstreamKind)) {
      throw new Error(`DesignStudio ${studio.id} uses unknown upstream artifact kind ${upstreamKind}`);
    }
  }
}

export function getStudio(id: string): DesignStudio {
  const studio = STUDIOS_BY_ID.get(id as DesignStudioId);
  if (studio === undefined) {
    throw new Error(`unknown design studio "${id}"`);
  }
  return studio;
}

export function studioReadiness(store: DesignArtifactStore): DesignStudioReadiness[] {
  return DESIGN_STUDIOS.map((studio) => {
    const missingUpstreams = studio.upstreamKinds.filter((artifactKind) => !store.artifacts.has(artifactKind));
    const status: DesignStudioStatus =
      missingUpstreams.length > 0
        ? "blocked"
        : store.artifacts.has(studio.artifactKind)
          ? "filled"
          : "ready";

    return {
      studioId: studio.id,
      status,
      missingUpstreams,
    };
  });
}

export function overallProgress(store: DesignArtifactStore): DesignStudioProgress {
  const studios = studioReadiness(store);
  const filledCount = studios.filter((studio) => studio.status === "filled").length;
  const next = studios.find((studio) => studio.status === "ready");

  return {
    studios,
    filledCount,
    nextActionable: next === undefined ? null : next.studioId,
  };
}
