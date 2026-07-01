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
    // The CAMP (start, west healthy): a campfire + the watcher's barrels.
    { assetId: "prop-campfire-1.glb", position: [-4, 4], height: 0.8 },
    { assetId: "prop-barrel-1.glb", position: [-3, 5.2], height: 0.9 },
    { assetId: "prop-barrel-1.glb", position: [-2.2, 6.1], height: 0.9, rotY: 0.7 },
    // The BEACON base — a stacked signal-fire pile (the live blaze + light sit on top in the build).
    { assetId: "prop-campfire-1.glb", position: [bx, bz], height: 1.7 },
  ];

  const scatter = (asset: string, count: number, xMin: number, xMax: number, hMin: number, hMax: number, skipBlight = true): void => {
    let made = 0, guard = 0;
    while (made < count && guard++ < count * 12) {
      const x = xMin + rnd() * (xMax - xMin);
      const z = -30 + rnd() * 60;
      if (onPath(x, z)) continue;
      if (skipBlight && inBlight(x, z)) continue;
      out.push({ assetId: asset, position: [x, z], height: hMin + rnd() * (hMax - hMin), rotY: rnd() * Math.PI * 2 });
      made++;
    }
  };
  scatter("vegetation-pine-tree-1.glb", 10, -30, -4, 5.5, 8.0); // living pines, west
  scatter("broadleaf.glb", 7, -30, -6, 4.0, 6.0); // broadleaf, west
  scatter("bush.glb", 14, -30, 30, 0.5, 1.1); // brush, everywhere (off-blight)
  scatter("rock.glb", 10, -30, 30, 0.5, 1.5); // rocks, everywhere (off-blight)
  scatter("vegetation-dead-tree-1.glb", 12, 6, 30, 5.0, 7.5, false); // dead trees, east (incl. the blight)
  return out;
}
