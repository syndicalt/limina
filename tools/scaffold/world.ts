// ════════════════════════════════════════════════════════════════════════════
//  world.ts — your agent-authorable Limina world.
//
//  This is the ONE file you edit. Everything here is authored through typed,
//  permissioned skills (`registry.invoke(...)`) — no hand-rolled geometry, no
//  manual mesh loops. An LLM agent edits this exact surface.
//
//  Build it into a playable browser bundle with:   npm run export
//  Then play it in a tab with:                      npm run serve
//
//  The `import type` below is for editor autocomplete only; it is erased at
//  runtime, so you do NOT need any package installed to run this file.
// ════════════════════════════════════════════════════════════════════════════

import type { BuildWorld } from "limina";

/** Deterministic world seed. Change it to reshape the terrain + scatter. */
export const SEED = 1234;

/** A small island world: textured terrain, depth-aware water, biome scatter,
 *  and one interactive treasure marker — built from four skill calls. */
export const buildWorld: BuildWorld = async ({ registry, base }) => {
  // A helper that invokes a skill and throws with context if it fails — never a
  // silent stub.
  const invoke = async (tool: string, input: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const res = await registry.invoke(tool, input, base);
    if (!res.success) throw new Error(`${tool} failed: ${JSON.stringify(res.error)}`);
    return (res.result ?? {}) as Record<string, unknown>;
  };

  // The terrain region: a 4×4-tile island (~192 m across). `terrainTypeHints`
  // is baked into the exporter, so here we just pass the shape knobs directly.
  const TILE = 48;
  const BOUNDS = { minTx: 0, minTz: 0, maxTx: 3, maxTz: 3 };
  const half = ((BOUNDS.maxTx - BOUNDS.minTx + 1) * TILE) / 2;
  const cx = ((BOUNDS.minTx + BOUNDS.maxTx + 1) / 2) * TILE;
  const cz = ((BOUNDS.minTz + BOUNDS.maxTz + 1) / 2) * TILE;
  const span = (BOUNDS.maxTx - BOUNDS.minTx + 1) * TILE;

  // 1. GROUND + SURFACE — colliders AND the visible procedural-PBR terrain mesh.
  //    `seaFraction` floods the low 18 % of the relief; the skill returns the
  //    resolved sea level + relief so we never have to survey anything.
  const gen = await invoke("world.generateRegion", {
    seed: SEED,
    bounds: BOUNDS,
    lod: 0,
    type: "mountains",
    hints: {
      // A dramatic eroded island that tapers cleanly under the sea.
      amp: 4.5,
      erode: 1,
      islandCx: cx,
      islandCz: cz,
      islandRadius: half * 0.4,
      islandFalloff: half * 0.62,
    },
    surface: { mode: "pbr", seaFraction: 0.18, waterline: { wetBand: 1.4, foam: 0.5 } },
  });
  const regionId = gen.regionId as string;
  const seaLevel = gen.seaLevel as number;
  const relief = gen.relief as { minY: number; maxY: number };

  // 2. SEA — a depth-aware water plane at the resolved sea level.
  await invoke("world.addWater", {
    level: seaLevel,
    color: 0x2e6f8e,
    size: span * 3,
    region: { seed: SEED, type: "mountains", bounds: BOUNDS },
  });

  // 3. CONTENT — biome-correct scatter: pines below the tree-line, boulders on
  //    the high flanks, nothing at/below the shoreline. One call surveys + places.
  const pop = await invoke("world.populateBiome", {
    regionId,
    type: "mountains",
    waterLevel: seaLevel,
    waterMargin: 2.5,
  });
  const props = (pop.instances as number) ?? 0;

  // 4. AN INTERACTIVE THING — a glowing treasure marker the player can pick up.
  //    This is where your game starts: add NPCs, quests, triggers, a player…
  const peakY = relief.maxY;
  const treasure = await invoke("scene.createEntity", {
    shape: "sphere",
    size: 0.8,
    color: 0xffcc33,
    position: [cx, peakY + 1.2, cz],
  });
  await invoke("interaction.register", {
    entity: treasure.entity,
    prompt: "Take the treasure",
    maxRange: 4,
    type: "pickup",
  });

  // Camera framing for the browser player (an orbit around the island).
  const cy = seaLevel + (relief.maxY - seaLevel) * 0.45;
  return {
    view: {
      center: [cx, cy, cz],
      radius: Math.round(span * 0.85),
      height: Math.round((relief.maxY - seaLevel) * 0.9 + 6),
      maxRadius: Math.round(span * 1.6),
      maxHeight: Math.round(relief.maxY - seaLevel + span * 0.4),
      far: Math.round(span * 6),
    },
    summary: `mountains island, sea ${seaLevel.toFixed(1)} m, relief ${relief.minY.toFixed(1)}..${relief.maxY.toFixed(1)} m, ${props} biome props + 1 treasure`,
  };
};
