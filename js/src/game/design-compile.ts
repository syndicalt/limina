// Compile sibling design artifacts into the existing GameDesignSpec.
//
// worldBible / cast / storyboard are first-class sibling artifacts in the design store. This module
// projects them into the canonical GDS spine so the existing planner, content pipeline, and
// world-compile path can consume the result. It is intentionally pure and deterministic: no IO,
// clock, randomness, or LLM calls.

import {
  validateGDS,
  type Assertion,
  type DoDAssertion,
  type Entity,
  type GameDesignSpec,
  type Mechanic,
  type Placement,
  type WorldSlice,
} from "./gds.ts";
import type { Cast, CastNpc } from "./cast.ts";
import type { Storyboard, StoryboardQuestStep } from "./storyboard.ts";
import type { WorldBible, WorldBibleLocation } from "./world-bible.ts";
import type { DesignArtifactKind, DesignArtifactStore, DesignArtifactValue } from "../world/design-artifacts.ts";

export interface DesignCompileIssue {
  path: string;
  message: string;
}

export interface DesignCompileResult {
  gds?: GameDesignSpec;
  issues: DesignCompileIssue[];
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function byId<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

function upsertById<T extends { id: string }>(items: readonly T[], next: T): T[] {
  const out = items.filter((item) => item.id !== next.id);
  out.push(next);
  return byId(out);
}

function positionForLocation(location?: WorldBibleLocation): [number, number, number] {
  if (location?.position === undefined) return [0, 0, 0];
  return [location.position[0], 0, location.position[1]];
}

function locationPrompt(location: WorldBibleLocation, regionName: string, biome: string): string {
  return `${location.kind} environment asset for ${location.name} in ${regionName} (${biome}): ${location.description}`;
}

function characterPrompt(name: string, archetype: string, role?: string): string {
  return role === undefined
    ? `game-ready character asset for ${name}, ${archetype}`
    : `game-ready character asset for ${name}, ${archetype}, ${role}`;
}

function projectWorldBible(gds: GameDesignSpec, bible: WorldBible): GameDesignSpec {
  const regionsById = new Map(bible.regions.map((region) => [region.id, region] as const));
  let content = gds.content;
  const placements: Placement[] = [];

  for (const location of byId(bible.locations)) {
    const region = regionsById.get(location.regionId);
    const regionName = region?.name ?? location.regionId;
    const biome = region?.biome ?? "temperate-forest";
    const contentId = `location-${location.id}`;
    content = upsertById(content, {
      id: contentId,
      kind: "environment",
      prompt: locationPrompt(location, regionName, biome),
      source: "generate",
      tier: `location-${location.kind}`,
      readContract: `reads as ${location.kind}`,
    });
    placements.push({
      id: `location-${location.id}`,
      content: contentId,
      transform: { position: positionForLocation(location), rotation: [0, 0, 0], scale: [1, 1, 1] },
    });
  }

  const firstRegion = byId(bible.regions)[0];
  const terrain = firstRegion === undefined ? gds.world?.terrain : { ...gds.world?.terrain, region: firstRegion.biome };
  const world: WorldSlice = {
    ...(gds.world ?? {}),
    ...(terrain !== undefined ? { terrain } : {}),
    placements: mergePlacements([...(gds.world?.placements ?? []), ...placements]),
  };

  return { ...gds, content, world };
}

function castLocation(castMember: CastNpc, bible: WorldBible | undefined): WorldBibleLocation | undefined {
  if (castMember.locationId === undefined || bible === undefined) return undefined;
  return bible.locations.find((location) => location.id === castMember.locationId);
}

function projectCast(gds: GameDesignSpec, cast: Cast, bible: WorldBible | undefined): GameDesignSpec {
  let entities = gds.entities.filter((entity) => entity.role !== "player" || entity.id === cast.player.id);
  let content = gds.content;
  const placements: Placement[] = [];

  const player: Entity = {
    id: cast.player.id,
    name: cast.player.name,
    role: "player",
    states: ["idle"],
  };
  entities = upsertById(entities, player);
  content = upsertById(content, {
    id: `character-${cast.player.id}`,
    kind: "character",
    prompt: characterPrompt(cast.player.name, String(cast.player.archetype)),
    source: "generate",
    tier: "player",
    readContract: "reads as the playable character",
  });

  const playerLocation = byId(bible?.locations ?? [])[0];
  placements.push({
    id: `entity-${cast.player.id}`,
    entity: cast.player.id,
    transform: { position: positionForLocation(playerLocation), rotation: [0, 0, 0], scale: [1, 1, 1] },
  });

  for (const npc of byId(cast.npcs)) {
    entities = upsertById(entities.filter((entity) => entity.id !== npc.id), {
      id: npc.id,
      name: npc.name,
      role: "npc",
      states: ["idle"],
    });
    content = upsertById(content, {
      id: `character-${npc.id}`,
      kind: "character",
      prompt: characterPrompt(npc.name, String(npc.archetype), npc.role),
      source: "generate",
      tier: "npc",
      readContract: `reads as ${npc.role}`,
    });
    placements.push({
      id: `entity-${npc.id}`,
      entity: npc.id,
      transform: { position: positionForLocation(castLocation(npc, bible)), rotation: [0, 0, 0], scale: [1, 1, 1] },
    });
  }

  return {
    ...gds,
    entities: byId(entities),
    content,
    world: {
      ...(gds.world ?? {}),
      placements: mergePlacements([...(gds.world?.placements ?? []), ...placements]),
    },
  };
}

function assertionForStep(step: StoryboardQuestStep, bible: WorldBible | undefined): Assertion {
  switch (step.kind) {
    case "flag":
      return {
        check: step.value === "false" ? "flagFalse" : "flagTrue",
        target: step.target ?? step.id,
        ...(step.value !== undefined ? { value: step.value === "false" ? false : true } : {}),
      };
    case "counter":
      return { check: "counterAtLeast", target: step.target ?? step.id, value: typeof step.value === "number" ? step.value : 1 };
    case "reach": {
      const location = bible?.locations.find((candidate) => candidate.id === step.target);
      const [x, , z] = positionForLocation(location);
      return { check: "playerReachedXZ", target: `${x},${z}` };
    }
    case "talk":
      return { check: "flagTrue", target: `talked:${step.target ?? step.id}`, value: true };
    case "collect":
      return { check: "flagTrue", target: `collected:${step.target ?? step.id}`, value: true };
  }
}

function mechanicForStep(step: StoryboardQuestStep): Mechanic {
  switch (step.kind) {
    case "flag":
      return { id: "quest-flags", name: "Quest flags", skill: "game.flag" };
    case "counter":
      return { id: "quest-counters", name: "Quest counters", skill: "game.counter" };
    case "reach":
      return { id: "quest-reach", name: "Reach objective", skill: "player.move" };
    case "talk":
      return { id: "quest-talk", name: "Talk objective", skill: "npc.dialogue" };
    case "collect":
      return { id: "quest-collect", name: "Collect objective", skill: "interaction.pickup" };
  }
}

function projectStoryboard(gds: GameDesignSpec, storyboard: Storyboard, bible: WorldBible | undefined): GameDesignSpec {
  let dod = gds.dod;
  let mechanics = gds.mechanics;

  for (const quest of byId(storyboard.quests)) {
    for (const step of byId(quest.steps)) {
      const assertion = assertionForStep(step, bible);
      const projected: DoDAssertion = {
        id: `story-${quest.id}-${step.id}`,
        statement: step.objective,
        kind: "state-transition",
        drives: {
          description: `${quest.name}: ${step.objective}`,
          steps: [{ forward: 1 }],
          assert: [assertion],
        },
      };
      dod = upsertById(dod, projected);
      mechanics = upsertById(mechanics, mechanicForStep(step));
    }
  }

  return { ...gds, mechanics, dod: byId(dod) };
}

function mergePlacements(placements: readonly Placement[]): Placement[] {
  const byPlacementId = new Map<string, Placement>();
  for (const placement of placements) byPlacementId.set(placement.id, placement);
  return [...byPlacementId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function artifact<T extends DesignArtifactValue>(store: DesignArtifactStore, key: DesignArtifactKind): T | undefined {
  return store.artifacts.get(key) as T | undefined;
}

export function compileDesignToGds(store: DesignArtifactStore): DesignCompileResult {
  const base = artifact<GameDesignSpec>(store, "gds");
  if (base === undefined) return { issues: [{ path: "gds", message: "concept GDS required" }] };

  let gds = cloneJson(base);
  const bible = artifact<WorldBible>(store, "worldBible");
  const cast = artifact<Cast>(store, "cast");
  const storyboard = artifact<Storyboard>(store, "storyboard");

  if (bible !== undefined) gds = projectWorldBible(gds, bible);
  if (cast !== undefined) gds = projectCast(gds, cast, bible);
  if (storyboard !== undefined) gds = projectStoryboard(gds, storyboard, bible);

  const validation = validateGDS(gds);
  if (!validation.ok || validation.data === undefined) return { issues: validation.issues };
  return { gds: validation.data, issues: [] };
}
