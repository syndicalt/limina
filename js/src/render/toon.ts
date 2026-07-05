// Cel-shading (toon) render style — a RENDER-LAYER transform, not a per-asset property. Cel-shading is
// dominantly a shading-model swap: convert the scene's lit PBR materials to MeshToonNodeMaterial with a
// hard-stepped gradient ramp, REUSING each material's baked albedo map + colour. This makes authored
// building GLBs (baked MeshStandardMaterial) read as cel-shaded for free — no re-authoring — and keeps
// the style in the engine's render layer where a `direction.artStyle` can drive it, not baked into assets.
//
// SCOPE: converts standard/PBR meshes (buildings, ground). Skips InstancedMesh (grass/tree/scatter carry
// bespoke TSL node materials — wind animation etc. — that a blind swap would break); those keep their own
// already-stylised look. Runs SYNCHRONOUSLY (builds one DataTexture, swaps materials) so it is safe to call
// after authoring and before the first render on the forceWebGL backend (no macrotask → no init-collapse).

import * as THREE from "../../build/three.bundle.mjs";

/** Build a hard-stepped greyscale gradient ramp (dark→light) → the cel bands. NearestFilter = no
 *  interpolation between steps, so lighting reads as discrete tones instead of a smooth falloff. */
function toonRamp(bands: number): THREE.DataTexture {
  const n = Math.max(2, bands);
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    // floor tone 0.22 (shadow side clearly darker → visible band step) → 1.0, in `n` equal hard steps.
    const v = Math.round(255 * (0.22 + 0.78 * (i / (n - 1))));
    data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

export interface ToonStyleOptions {
  /** Number of light bands (>=2). 3 is a lively storybook read; 2 is a starker comic look. */
  bands?: number;
  /** Multiply every converted albedo/colour toward more saturation/pop (1 = leave as authored). */
  saturate?: number;
}

interface MatLike {
  isMeshStandardMaterial?: boolean;
  isMeshToonMaterial?: boolean;
  map?: { isTexture?: boolean } | null; color?: THREE.Color; vertexColors?: boolean;
  transparent?: boolean; opacity?: number; alphaTest?: number; side?: number; name?: string;
}

/** Convert the scene's TEXTURED PBR meshes (buildings + textured ground) to cel-shaded materials in
 *  place. Returns the count converted. Idempotent. Conservative on purpose: only materials that carry a
 *  real albedo `map` are swapped — terrain/grass ground-tint and other bespoke node materials (custom
 *  colorNode / vertex colours / wind) are left untouched, so the swap can't strip their look or trip the
 *  TSL texture pipeline. Built via the constructor params path (the shape three's node system expects). */
export function applyToonStyle(scene: unknown, opts: ToonStyleOptions = {}): number {
  const ramp = toonRamp(opts.bands ?? 3);
  const sat = opts.saturate ?? 1;
  const Toon = (THREE as unknown as { MeshToonNodeMaterial: new (p: Record<string, unknown>) => MatLike }).MeshToonNodeMaterial;
  let converted = 0;

  const convert = (m: MatLike | undefined | null): MatLike | undefined | null => {
    if (!m) return m;
    if (m.isMeshToonMaterial === true) return m;                 // already cel
    if (m.isMeshStandardMaterial !== true) return m;             // bespoke node material — leave it
    if (!(m.map && m.map.isTexture === true)) return m;          // only cel-ify TEXTURED surfaces
    const col = m.color ? m.color.clone() : new THREE.Color(0xffffff);
    if (sat !== 1) { const hsl = { h: 0, s: 0, l: 0 }; col.getHSL(hsl); col.setHSL(hsl.h, Math.min(1, hsl.s * sat), hsl.l); }
    const params: Record<string, unknown> = { color: col, map: m.map, gradientMap: ramp };
    if (m.transparent) { params.transparent = true; params.opacity = m.opacity ?? 1; }
    if (m.alphaTest) params.alphaTest = m.alphaTest;
    if (m.side !== undefined) params.side = m.side;
    converted++;
    return new Toon(params);
  };

  (scene as { traverse?: (cb: (o: unknown) => void) => void }).traverse?.((o: unknown) => {
    const mesh = o as { isMesh?: boolean; isInstancedMesh?: boolean; material?: MatLike | MatLike[] };
    if (mesh.isMesh !== true || mesh.isInstancedMesh === true) return; // skip instanced veg (bespoke shaders)
    if (Array.isArray(mesh.material)) mesh.material = mesh.material.map(convert) as MatLike[];
    else mesh.material = convert(mesh.material) as MatLike;
  });
  return converted;
}
