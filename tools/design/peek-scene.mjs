// peek-scene.mjs — the 3D-peek scene builder (Painter P5).
//
// Seam: compileDesignMap's WorldMap IR in → an authored-scene JSON out (the
// tools/preview/engine-authored.mjs contract: { commands, camera, renderBaseline }).
// PURE — no I/O, no clock, no randomness — so the mapstudio gate can prove what a peek
// renders (and prove the absence cases) without a GPU. serve-design.mjs owns the I/O:
// writing the worldmap asset + scene file and spawning the engine-shots render job.
//
// Everything the author painted must appear in the peek: terrain (painted elevation +
// biomes), forests/swamps as scatter confined to the painted polygons, the sea + drawn
// rivers, and the stamped catalog assets (anchors with an assetId). A peek that omits a
// painted layer reads as "the tool lost my work".

/** Point-in-ring test (even-odd), ring = [[x,z], ...]. */
function inRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Build the peek scene for a compiled WorldMap.
 * @param {object} worldMap  compiled WorldMap IR (land/biomes/waterways/anchors/seaLevel/...)
 * @param {object} opts      { project, mapAssetId, vantage? } — vault project slug + the worldmap
 *                           asset id (already written under assets/ by the caller). `vantage`,
 *                           when present ({ pos:[x,z], yaw, eyeHeight? }), replaces the overview
 *                           orbit with a positioned camera looking FROM a point on the map (Places
 *                           Stage 2). Default (no vantage) = the overview turntable.
 * @returns {{ scene: object, sceneName: string, span: number }}
 */
export function buildPeekScene(worldMap, { project = "project", mapAssetId, vantage } = {}) {
  const assetParts = typeof mapAssetId === "string" ? mapAssetId.split("/") : [];
  if (assetParts[0] !== "maps" || assetParts.some((part) => part === "" || part === "." || part === "..")
      || mapAssetId.includes("\\") || mapAssetId.includes("\0") || !mapAssetId.endsWith(".worldmap.json")) {
    throw new TypeError("peek worldmap asset id must be a canonical maps/...worldmap.json path");
  }
  // Frame the camera on the compiled land.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const l of worldMap.land) for (const [x, z] of l.points) {
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (minX === Infinity) { minX = -100; maxX = 100; minZ = -100; maxZ = 100; }
  const span = Math.max(maxX - minX, maxZ - minZ, 100);
  // The peek is a single-tile quick-proof, not the streamed/LOD build path. terrain.create
  // caps `size` at 8192 (js/src/skills/terrain-edit.ts) — beyond that a painted span would
  // make terrain.create zod-reject and the whole render exit with a blank error instead of a
  // picture. Clamp to the cap so a very large map still renders (coarser, one tile) rather
  // than failing opaquely; `clampedToTileCap` lets the caller warn the author that a
  // >~6.5km painted world exceeds the single-tile peek and wants the streamed build.
  const TERRAIN_SIZE_CAP = 8192;
  const rawSize = Math.ceil(span * 1.25 / 50) * 50;
  const size = Math.min(rawSize, TERRAIN_SIZE_CAP);
  const clampedToTileCap = rawSize > TERRAIN_SIZE_CAP;

  // Confine the peek's forest to the PAINTED forest polygons: disc-cover each polygon on a
  // grid (the vegetation.scatter inclusion gate takes discs) so trees stand where the
  // author painted woods and nowhere else.
  const discStep = Math.max(18, Math.round(span * 0.02));
  const biomeDiscs = (kind) => {
    const discs = [];
    for (const b of worldMap.biomes || []) {
      if (b.biome !== kind) continue;
      let bMinX = Infinity, bMaxX = -Infinity, bMinZ = Infinity, bMaxZ = -Infinity;
      for (const [x, z] of b.points) {
        if (x < bMinX) bMinX = x; if (x > bMaxX) bMaxX = x; if (z < bMinZ) bMinZ = z; if (z > bMaxZ) bMaxZ = z;
      }
      for (let z = bMinZ; z <= bMaxZ; z += discStep) {
        for (let x = bMinX; x <= bMaxX; x += discStep) {
          if (inRing(x, z, b.points)) discs.push({ x: Math.round(x), z: Math.round(z), r: Math.round(discStep * 0.72) });
        }
      }
    }
    return discs;
  };
  const forestDiscs = biomeDiscs("forest");
  const swampDiscs = biomeDiscs("swamp");

  const scene = {
    // Overview turntable of the whole map → runLive skips eye-level grass blades (thousands of
    // sub-pixel instanced chunks on a km-scale slab); the painted ground tint reads the grass.
    peek: true,
    commands: [
      { kind: "physics", op: "op_physics_create_world", args: [-9.81] },
      { kind: "skill", tool: "terrain.create", input: {
        // Resolution scales with the painted span to hold ~6 m terrain cells (clamped 129..513: a
        // small map isn't over-tessellated, a km-scale one stays a single buildable slab). A fixed
        // 385 made EVERY map above 600 m the same grid, so big maps came out coarse — a 3.5 km island
        // was ~9 m cells, visibly stepped. ~6 m cells also stay under a span-scaled river's half-width
        // so the carve doesn't alias away (the old 257 grid's ~7 m cells swallowed drawn rivers).
        size, resolution: Math.min(513, Math.max(129, Math.round(size / 6))), origin: [0, 0, 0], color: 5926970,
        // Amplitude scales with the painted span: a fixed 12 m reads as relief on a ~600 m hamlet
        // but crushes a multi-km island (mountains flattened to a sliver) into a flat sheet at sea
        // level. Span-proportional relief keeps big painted worlds legibly above the water.
        generate: { source: "map", mapAssetId, seed: 11, amplitude: Math.max(12, Math.round(span * 0.03)) },
      } },
      ...(forestDiscs.length > 0 ? [{ kind: "skill", tool: "vegetation.scatter", input: {
        // ~8m candidate spacing regardless of tile size — painted woods read as CANOPY
        // from the orbit, not a dozen specks (the density knob is per-axis over the tile).
        // slopeMax 1.4: painted forest often climbs the mountain flanks — the default
        // 0.85 slope gate stripped those candidates and left a thin line at the base.
        species: ["pine", "spruce", "birch"], density: Math.min(192, Math.max(32, Math.round(size / 6))),
        // The tree floor is RELATIVE TO THE MAP'S SEA LEVEL (its job is keeping trees out
        // of the water), never an absolute Y: the sea is an Atlas control (map.seaLevel),
        // and an absolute floor silently culls every tree on land that sits above the
        // water but below the number. Both forest outages were this bug: 1.0 vs the
        // seaLevel+0.8 land floor, then 0.5 vs an authored seaLevel of -11.5.
        coverage: 0.9, cluster: 0.45, seed: 11, slopeMax: 1.4, sizeRange: [0.95, 1.6],
        elevationMin: (worldMap.seaLevel ?? 0) + 0.5, inclusions: forestDiscs,
      } }] : []),
      // Swamp: SPARSE trees scattered between the standing-water pools the rasterizer
      // dapples through the biome — sparse stands + mottled water = the marsh read.
      ...(swampDiscs.length > 0 ? [{ kind: "skill", tool: "vegetation.scatter", input: {
        species: ["birch", "spruce"], density: Math.min(192, Math.max(32, Math.round(size / 8))),
        coverage: 0.3, cluster: 0.6, seed: 23, slopeMax: 1.4, sizeRange: [0.7, 1.15],
        elevationMin: (worldMap.seaLevel ?? 0) + 0.4, inclusions: swampDiscs,
      } }] : []),
      // 4x: the plane must reach past the orbit camera's horizon in every yaw or its edge
      // reads as a sparkling seam against the void.
      { kind: "skill", tool: "world.addWater", input: { level: worldMap.seaLevel ?? 0, size: Math.round(size * 4), color: 2841970 } },
      // Terrain-following river ribbons along each waterway (deduped — a doc can carry
      // exact-duplicate river features). Slightly narrower than the carve so the edges
      // tuck into the banks.
      ...[...new Map((worldMap.waterways || []).map((w) => [JSON.stringify(w.points), w])).values()]
        .filter((w) => w.points.length >= 2)
        // 1.7x the channel width: the carve's smoothstepped banks slope outward, so the
        // near-rim water surface must overshoot the floor width to meet them — edges tuck
        // into the bank slope instead of leaving dry shoulders.
        .map((w) => ({ kind: "skill", tool: "world.addRiver", input: {
          points: w.points, widthM: Math.max(4, (w.widthM || 6) * 1.7), color: 2841970,
        } })),
      // Painted stamps: every asset-anchor is placed on the terrain, grounded — the
      // painted village must appear in the peek, not only in build-world. Stamp rot is a
      // yaw (radians); stamp scale is uniform (asset.place takes a Vec3).
      ...(worldMap.anchors || [])
        .filter((a) => a.assetId)
        .map((a) => ({ kind: "skill", tool: "asset.place", input: {
          assetId: a.assetId, position: [a.position[0], 0, a.position[1]],
          rotation: [0, a.rot ?? 0, 0],
          ...(a.scale ? { scale: [a.scale, a.scale, a.scale] } : {}),
          ground: true,
        } })),
      // RENDER-ONLY post stack (last, after the scene is fully built): a real depth+normal
      // pre-pass → GTAO contact AO (nestles trees/rocks into the ground, deepens ridge + dune
      // relief) → highlight bloom → gentle HDR grade. The peek is a fixed-pose turntable of
      // screenshots — exactly the static/cinematic case render.enablePost supports (live editor
      // nav stays on the bare renderer). runLive drives world.post.render() in place of the bare
      // present. Radius/intensity nudged above the eye-level default so contact AO still reads at
      // orbit distance on a km-scale slab.
      { kind: "skill", tool: "render.enablePost", input: {
        ao: { enabled: true, intensity: 0.85, radius: 1.2, scale: 1.6, samples: 16 },
        bloom: { enabled: true },
        grade: { enabled: true },
        // A gentle full-scene Sobel edge — ink lines on the coastline, waterways and stamped
        // assets. The peek is a MAP, so the illustrated-cartography read suits it; kept moderate
        // (0.7) so it reads as linework, not a heavy cel border.
        outline: { enabled: true, strength: 0.7 },
      } },
    ],
    // The map's sea level is the ground reference the harness uses to lift a vantage camera to
    // eye height (no terrain-height lookup in the offline harness — see engine-authored.html).
    seaLevel: worldMap.seaLevel ?? 0,
    // Camera: a positioned VANTAGE when requested (look FROM a point on the map, single frame),
    // otherwise the overview turntable. Overview is the default.
    //
    // Overview: engine-shots.mjs drives the orbit to EXACT yaw angles (i/N x 360° via the
    // __setYaw hook) so the frame set always closes the full loop — autoSpin is 0, timing-based
    // capture under-rotated on heavy scenes and the scrub jumped at the seam. 0.62/0.38 span
    // frames the WHOLE island; the explicit far plane + FogExp2 density scaled 1/distance keep
    // it vivid (far shore dissolving — the house look).
    camera: vantage
      ? {
        mode: "vantage",
        pos: [Math.round(vantage.pos[0]), Math.round(vantage.pos[1])],
        yaw: vantage.yaw ?? 0,
        eyeHeight: vantage.eyeHeight ?? 1.7,
        // A vantage stands ON the map: the far plane must still reach the far shore.
        far: Math.round(span * 2.5),
      }
      : {
        center: [(minX + maxX) / 2, 0, (minZ + maxZ) / 2],
        radius: Math.round(span * 0.62), height: Math.round(span * 0.38),
        far: Math.round(span * 2.5), autoSpin: 0,
      },
    renderBaseline: {
      exposure: 1.05,
      sun: { color: 16770744, intensity: 4.6, direction: [-52, 34, 22] },
      hemisphere: { skyColor: 12374271, groundColor: 4872752, intensity: 1.8 },
      ambientIntensity: 0.66, ambientColor: 7036501,
      // `atmosphere.density` is the baseline's REAL haze knob (a `fog:` key is silently
      // ignored by the deep-partial merge — the default 0.0011 haze then drowns the whole
      // island at orbit distance). 0.5/span: ~88% clarity at the camera, far shore at
      // ~65% — aerial depth without the milk. FogExp2: transmittance = exp(-(d*density)²).
      atmosphere: { density: Math.round(0.5 / span * 1e6) / 1e6 },
    },
  };
  return { scene, sceneName: `peek-${project}-${worldMap.id}`, span, clampedToTileCap };
}
