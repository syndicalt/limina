// BEACON RUN — the SHARED dressed-world definition. ONE source of truth for the scene, consumed by
// BOTH the playable native build (js/src/demos/beacon_run_window.ts, rendered live with controls) AND
// the headless record+export builder (games/beacon-quest/build/scene.ts, packaged into the web
// release). This is what makes "the game you play" and "the release the pipeline ships" the same
// dressed scene — not two hand-authored layouts that drift apart.
//
// The prop field is pure data (no THREE) so the headless exporter can replay it byte-for-byte. The
// ground gradient is render-time params the live build uses; the export falls back to a flat ground
// (replay can't reproduce a vertex-colored gradient) — an honest, documented gap, not a hidden one.

import type { ContentPlacement } from "../content.ts";

/** The blight-gradient ground (healthy olive west → dead grey east), for the live build's vertex
 *  colors. The headless export can't reproduce this; it grounds the field on the baseline plane. */
export const BEACON_GROUND = {
  size: 300,
  segments: 24,
  healthy: 0x47512f,
  blight: 0x2b2a25,
  gradientStartX: -28, // x at which the gradient begins (healthy side)
  gradientSpanX: 80, // x-span over which it reaches full blight
} as const;

export interface BeaconLayoutInput {
  beaconXZ: readonly [number, number];
  blightXZ: readonly [number, number];
  blightRadius: number;
}

/** The deterministic prop field: a west camp (campfire + barrels), the beacon signal-pile, living
 *  pines/broadleaf west, brush + rocks throughout (off-blight, off the run-path), dead trees east.
 *  A fixed LCG seed makes it byte-identical every run, so the live build and the export agree. */
export function beaconField(b: BeaconLayoutInput): ContentPlacement[] {
  const [bx, bz] = b.beaconXZ;
  const [gx, gz] = b.blightXZ;
  let _s = 20260630;
  const rnd = (): number => { _s = (_s * 1664525 + 1013904223) >>> 0; return _s / 4294967296; };
  const onPath = (x: number, z: number): boolean => Math.abs(x) < 3 && z < 1.5 && z > -13.5; // the run to the beacon
  // sqrt: IEEE correctly-rounded, bit-stable (Math.hypot is not)
  const inBlight = (x: number, z: number): boolean => Math.sqrt((x - gx) * (x - gx) + (z - gz) * (z - gz)) < b.blightRadius + 1.5;

  const out: ContentPlacement[] = [
    // The CAMP / watch-hub (start, west healthy): a cottage, watchtower, well + tent give
    // the start a sense of PLACE (a settlement you set out from), not a bare campfire.
    { assetId: "building-medieval-house-1.glb", position: [-9, 8], height: 4.6, rotY: 0.5 },
    { assetId: "building-wooden-watchtower-1.glb", position: [-12, 1], height: 7.2, rotY: -0.3 },
    { assetId: "prop-water-well-1.glb", position: [-6, 3], height: 1.7 },
    // (camping tent removed — its GLB was quarantined for a broken authoring scale; see /quarantine)
    { assetId: "prop-campfire-1.glb", position: [-4, 4], height: 0.8 },
    { assetId: "prop-barrel-1.glb", position: [-3, 5.2], height: 0.9 },
    { assetId: "prop-barrel-1.glb", position: [-2.2, 6.1], height: 0.9, rotY: 0.7 },
    { assetId: "prop-stone-pillar-1.glb", position: [-7, 10], height: 2.4 },
    // The BEACON base — a stacked signal-fire pile (the live blaze + light sit on top in the build).
    { assetId: "prop-campfire-1.glb", position: [bx, bz], height: 1.7 },
  ];

  // Scatter with real-world SCALE (height in metres) and DENSITY that fills the frame:
  // sparse tall canopy, a thick low ground carpet underneath (grass/ferns/flowers), so
  // the flat baseline plane is hidden and the eye reads layered depth (canopy → mid → ground).
  // Keep a CLEARING in front of the hero camera (it looks down -Z from ~z=10) so no tall
  // trunk blocks the lens and the eye reads through to the hub + beacon (forest.html's trick).
  const camCorridor = (x: number, z: number): boolean => Math.abs(x) < 6.5 && z > -10 && z < 13;
  const scatter = (asset: string, count: number, xMin: number, xMax: number, hMin: number, hMax: number, skipBlight = true, keepFrontClear = false): void => {
    let made = 0, guard = 0;
    while (made < count && guard++ < count * 12) {
      const x = xMin + rnd() * (xMax - xMin);
      const z = -30 + rnd() * 60;
      if (onPath(x, z)) continue;
      if (keepFrontClear && camCorridor(x, z)) continue; // don't block the lens
      if (skipBlight && inBlight(x, z)) continue;
      out.push({ assetId: asset, position: [x, z], height: hMin + rnd() * (hMax - hMin), rotY: rnd() * Math.PI * 2 });
      made++;
    }
  };
  // CANOPY — sparse + tall, mixed species for a natural treeline (west + throughout, off-blight).
  scatter("vegetation-pine-tree-1.glb", 22, -30, 30, 6.0, 9.0, true, true);
  scatter("vegetation-pine-tree-5.glb", 16, -30, 30, 5.5, 8.5, true, true);
  scatter("vegetation-spruce-tree-3.glb", 16, -30, 30, 6.0, 9.5, true, true);
  scatter("vegetation-fir-tree-3.glb", 12, -30, 30, 5.5, 8.5, true, true);
  scatter("broadleaf.glb", 12, -30, -4, 4.5, 6.5, true, true);
  scatter("vegetation-fir-tree-3.glb", 18, -30, 30, 1.8, 3.0); // young firs (was quarantined sapling GLB)
  // MID — bushes, shrubs, rocks break up the ground line.
  scatter("vegetation-shrub-bush-3.glb", 34, -30, 30, 0.6, 1.3);
  scatter("bush.glb", 26, -30, 30, 0.5, 1.1);
  scatter("rock.glb", 22, -30, 30, 0.4, 1.4);
  // GROUND CARPET — dense + small, correct scale (a tuft is knee-high, a flower ankle-high).
  // This is the layer that turns "a plane with props" into "a forest floor".
  scatter("vegetation-small-plant-leaves-5.glb", 95, -30, 30, 0.3, 0.6); // low ground tufts (was quarantined grass-tuft GLB)
  scatter("vegetation-fern-3.glb", 40, -30, 30, 0.4, 0.8);
  scatter("vegetation-bracken-fern-leaves-5.glb", 34, -30, 30, 0.35, 0.7);
  scatter("vegetation-small-plant-leaves-5.glb", 44, -30, 30, 0.2, 0.45);
  scatter("vegetation-wildflowers-5.glb", 40, -30, 30, 0.2, 0.4);
  scatter("prop-mushroom-3.glb", 16, -30, 6, 0.15, 0.35);
  // EAST — the blight: dead trees + fallen logs, no living ground cover (the corruption line).
  scatter("vegetation-dead-tree-1.glb", 20, 6, 30, 5.0, 7.5, false);
  scatter("prop-log-fallen-tree-trunk-3.glb", 8, 6, 30, 0.6, 1.0, false);
  return out;
}
