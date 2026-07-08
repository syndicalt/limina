// build-beacon-world.mjs — author the BEACON QUEST world as a Map Painter vault.
// "Light the Eastern Beacon": a frontier waypost peninsula. The warden's camp sits at
// the settled centre; the beacon crowns a hill to the EAST (toward the Blight); a forest
// ring closes the camp in; a blighted swamp fouls the far east shore; a path runs camp→beacon.
// Authored as painted raster layers (landmass + elevation + biomes) + features + stamps, so
// the whole world is a Map-Painter artifact the peek + build consume — the integration proof.
//
// Reproducible: the painted rasters (landmass + elevation) are opaque base64 in maps.json, so
// this script IS the editable source of the world's shape. Re-run it to regenerate the vault,
// then compile (tools/design serve-design /api/compile-map, or the peek path) to the worldmap.
//
// Usage from repo root:
//   node games/beacon-quest/world.mjs "$PWD" games/beacon-quest/design
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.argv[2];
const OUT = process.argv[3];
const { encodeRasterCells } = await import(join(ROOT, "js/src/world/pipeline/raster-codec.mjs"));
mkdirSync(OUT, { recursive: true });

// ~520 m peninsula on a 640 m rect. World is X=east, Z=north(-z). Camp at origin; beacon east.
const rect = { x0: -320, z0: -320, w: 640, h: 640 };

// --- landmass: a peninsula open to the sea on the east + south (a real coast, not a disc) -----
const LW = 512;
const lm = new Uint8Array(LW * LW);
for (let r = 0; r < LW; r++) {
  for (let c = 0; c < LW; c++) {
    const wx = rect.x0 + (c / (LW - 1)) * rect.w;
    const wz = rect.z0 + (r / (LW - 1)) * rect.h;
    // base radius, pulled in on the east (the sea the beacon looks out over) with coast wobble
    const ang = Math.atan2(wz, wx);
    let radius = 250 + 30 * Math.sin(ang * 3 + 0.6) + 16 * Math.sin(ang * 6 + 1.9);
    // bite the east shore inward so the beacon hill sits on a headland over open water
    if (wx > 120) radius -= (wx - 120) * 0.35;
    lm[r * LW + c] = Math.hypot(wx, wz) <= radius ? 255 : 0;
  }
}

// --- elevation: camp on gentle plain (+3); BEACON HILL east (+34); blight basin SE (~+0.6);
//     a small tarn NW (-3); shore ramp everywhere. north=-z, east=+x --------------------------
const EW = 256;
const minY = -10, maxY = 42;
const el = new Uint8Array(EW * EW);
const gauss = (d, r) => Math.exp(-(d * d) / (2 * r * r));
const BEACON = [150, -20];   // east headland
const CAMP = [-40, 10];      // settled centre, slightly west
const BLIGHT = [175, 120];   // SE dead shore
const TARN = [-150, -120];   // NW tarn
for (let r = 0; r < EW; r++) {
  for (let c = 0; c < EW; c++) {
    const wx = rect.x0 + (c / (EW - 1)) * rect.w;
    const wz = rect.z0 + (r / (EW - 1)) * rect.h;
    const dc = Math.hypot(wx, wz);
    let y = dc > 270 ? -7 : dc > 205 ? -7 + (270 - dc) / 65 * 10 : 3; // shore ramp → +3 plain
    y += 34 * gauss(Math.hypot(wx - BEACON[0], wz - BEACON[1]), 46);  // beacon hill
    y += 6 * gauss(Math.hypot(wx - CAMP[0], wz - CAMP[1]), 70);        // camp knoll (gentle)
    const blightW = gauss(Math.hypot(wx - BLIGHT[0], wz - BLIGHT[1]), 58);
    y = y * (1 - blightW) + 0.6 * blightW;                            // blight basin near sea
    const tarnW = gauss(Math.hypot(wx - TARN[0], wz - TARN[1]), 30);
    y = y * (1 - tarnW) + (-3) * tarnW;                               // NW tarn
    el[r * EW + c] = Math.round(Math.max(0, Math.min(255, ((y - minY) / (maxY - minY)) * 255)));
  }
}
const elevB64 = Buffer.from(el).toString("base64");

const maps = {
  version: 2, activeMapId: "primary", axes: "north-negz",
  maps: [{
    id: "primary", name: "The Eastern Watch — Beacon Quest", scope: "site", parent: null,
    seaLevel: 0,
    units: { kind: "m", unitsPerMeter: 1, origin: [0, 0] },
    rasters: {
      landmass: { w: LW, h: LW, rect, ...encodeRasterCells(lm) },
      elevation: { w: EW, h: EW, rect, minY, maxY, data: elevB64 },
    },
    features: [
      // forest ring closing the camp on the north + west
      { id: "wood-n", type: "area", kind: "biome", biome: "forest", points: [[-150, -190], [70, -190], [70, -70], [-150, -70]] },
      { id: "wood-w", type: "area", kind: "biome", biome: "forest", points: [[-230, -90], [-110, -90], [-110, 90], [-230, 90]] },
      // the beacon headland is bare rock (mountain paint)
      { id: "beacon-rock", type: "area", kind: "biome", biome: "mountain", points: [[110, -70], [200, -70], [200, 30], [110, 30]] },
      // the Blight: a dead swamp fouling the SE shore (near sea → active mottled pools)
      { id: "blight", type: "area", kind: "biome", biome: "swamp", points: [[120, 70], [235, 70], [235, 175], [120, 175]] },
      // the beacon road: camp → east through a gap in the wood → up the headland
      { id: "beacon-road", type: "line", kind: "road", points: [[-40, 10], [10, 0], [70, -10], [120, -18], [150, -20]] },
      // a brook off the tarn running south to the sea
      { id: "brook", type: "line", kind: "river", points: [[-150, -120], [-120, -40], [-90, 60], [-70, 200]], widthM: 5 },
    ],
    // Stamps place the visual assets. Their ids are PREFIXED so they never collide with the
    // world-bible location ids (hall, beacon) — those stay the semantic/quest anchors the game
    // logic keys off; the stamps are the render placement.
    stamps: [
      // the warden's camp at spawn: a hall + two cottages
      { id: "stamp-hall", assetId: "norman-church.glb", x: -40, z: 18 },
      { id: "stamp-cot-1", assetId: "tudor-cottage.glb", x: -62, z: 2, rot: 0.4 },
      { id: "stamp-cot-2", assetId: "tudor-cottage.glb", x: -20, z: 30, rot: -0.7 },
      // the beacon itself: the watchtower on the headland — scaled up so it reads as the
      // quest LANDMARK from across the island (readable target, quality bar #4).
      { id: "stamp-beacon", assetId: "watchtower-authored.glb", x: 150, z: -20, scale: 2.0 },
      // a lantern post marking the trailhead out of camp
      { id: "stamp-trailhead", assetId: "whisperlight-lantern.glb", x: 8, z: 2 },
      // a footbridge over the brook where the road would cross it
      { id: "stamp-brook-bridge", assetId: "a-basic-wooden-bridge.glb", x: -78, z: 40, rot: 1.571 },
    ],
  }],
};
writeFileSync(join(OUT, "maps.json"), JSON.stringify(maps, null, 2));

// world-bible: the Eastern Watch lore, sized for this ~520m peninsula.
const bible = `---
kind: world-bible
setting:
  name: The Eastern Watch
  era: The late Marches, in the years the Blight turned the east road to a dead end.
  premise: The last manned waypost on the frontier. The warden holds the line and needs the eastern beacon lit before dark.
zone:
  size_m: 560
  origin: camp center [0,0]; north = -z (screen-up in the map tool); +x = east (toward the Blight)
regions:
  - id: the-camp
    name: The Warden's Camp
    biome: meadow
    note: The settled centre — a hall and two cottages on a gentle knoll, ringed by wood.
  - id: the-forest-ring
    name: The Forest Ring
    biome: forest
    note: The woods closing the camp on the north and west; the beacon road threads a gap.
  - id: the-beacon-headland
    name: The Beacon Headland
    biome: mountain
    note: A bare rock hill to the east over open water. The beacon crowns it.
  - id: the-blight-edge
    name: The Blight Edge
    biome: blighted
    note: The dead swamp fouling the south-east shore. Standing water and sick ground.
locations:
  - id: hall
    name: The Warden's Hall
    kind: civic
    region: the-camp
    position: [-40, 18]
    build: stamped
    note: The muster hall and the warden's seat — where the quest is given and turned in.
  - id: beacon
    name: The Eastern Beacon
    kind: military
    region: the-beacon-headland
    position: [150, -20]
    build: stamped
    note: The unlit signal tower on the headland. The quest objective.
---

# The Eastern Watch

The last manned waypost on the frontier. Light the Eastern Beacon before dark.
`;
writeFileSync(join(OUT, "world-bible.md"), bible);
console.log("beacon-quest vault written:", OUT);
