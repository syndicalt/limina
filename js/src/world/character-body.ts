// Character body — a REAL rigged humanoid NPC body (SkinnedMesh + skeleton + animation clips), replacing
// the procedural `spawnHumanoid` box for NPCs. This is the render/animation half of the pluggable Character
// AssetSource (per the AssetSource architecture): the engine stays pure and CONSUMES a rigged humanoid glTF
// (curated library now, generative/marketplace/VRM backend later on the same seam).
//
//   const body = createCharacterBody(THREE, gltf.scene, gltf.animations, { outfitTint, scale });
//   scene.add(body.group);
//   // each frame: body.update(dtSec); body.setLocomotion(speedMetresPerSec); body.setPosition(x,y,z); body.faceDir(dx,dz);
//
// The skeleton contract is a standard humanoid rig (Mixamo-compatible) so shared idle/walk/run clips
// retarget across every character. Clip lookup is case-insensitive with fallbacks so a library asset that
// names its clips differently still animates. THREE is passed in so the module works under either three build.

export interface CharacterBody {
  /** Root object to add to the scene (the skinned humanoid). */
  group: unknown;
  /** Advance the animation mixer by `dtSec` seconds (render-time; cosmetic). */
  update(dtSec: number): void;
  /** Pick the locomotion clip from ground speed (m/s): idle below the threshold, walk above. */
  setLocomotion(speedMetresPerSec: number): void;
  /** Place the body's feet at world (x, y, z). */
  setPosition(x: number, y: number, z: number): void;
  /** Face the body along a world-XZ heading (yaw). */
  faceDir(dx: number, dz: number): void;
  /** The measured standing height (metres) after scaling. */
  height: number;
}

export interface CharacterBodyOptions {
  /** Target standing height in metres (the asset is scaled to match). Default 1.75. */
  targetHeightM?: number;
  /** Whole-body clothing tint (0xRRGGBB) — the fallback when no per-zone `outfit`+`zoneMaterial` map
   *  matches a material. Omit to leave the asset's own texture. */
  outfitTint?: number;
  /** Per-ZONE outfit tint: outfit zone → 0xRRGGBB (from NpcSpec.appearance.outfit). Applied to the
   *  material whose name matches `zoneMaterial[zone]`; zones without a match fall back to `outfitTint`. */
  outfit?: Record<string, number>;
  /** Per-asset ZONE→material-name mapping (a lowercase substring matched against each material/mesh name),
   *  supplied by the Character AssetSource card so a rig's "shirt"/"pants"/"boots" materials map to zones. */
  zoneMaterial?: Record<string, string>;
  /** Blend amount for the tint (0 = keep texture, 1 = flat colour). Default 0.45. */
  tintAmount?: number;
  /** Walk/idle threshold in m/s. Default 0.15. */
  walkThreshold?: number;
}

type MixerLike = { update(dt: number): void; clipAction(clip: unknown): ActionLike };
type ActionLike = { play(): ActionLike; reset(): ActionLike; setEffectiveWeight(w: number): ActionLike; fadeIn(t: number): ActionLike; fadeOut(t: number): ActionLike; enabled: boolean; setEffectiveTimeScale(s: number): ActionLike };

/** Find an animation clip by any of `names` (case-insensitive substring), else the i-th clip. */
function findClip(THREE: unknown, clips: { name: string }[], names: string[], fallbackIndex: number): { name: string } | undefined {
  for (const want of names) {
    const hit = clips.find((c) => c.name.toLowerCase().includes(want));
    if (hit) return hit;
  }
  return clips[fallbackIndex] ?? clips[0];
}

export function createCharacterBody(
  THREE: Record<string, unknown>,
  root: { traverse: (cb: (o: unknown) => void) => void; scale: { setScalar: (s: number) => void }; position: { set: (x: number, y: number, z: number) => void }; rotation: { y: number } },
  animations: { name: string }[],
  opts: CharacterBodyOptions = {},
): CharacterBody {
  const T = THREE as unknown as {
    Box3: new () => { setFromObject: (o: unknown) => { getSize: (v: unknown) => { y: number }; min: { y: number } } };
    Vector3: new () => unknown;
    AnimationMixer: new (root: unknown) => MixerLike;
    Color: new (hex?: number) => { lerp: (c: unknown, a: number) => unknown; clone: () => unknown };
  };

  // Shadows + outfit tint. Per-ZONE tint (outfit + zoneMaterial map) where a material name matches a zone;
  // otherwise the whole-body `outfitTint` fallback. The zone map is asset-specific (from the AssetSource
  // card) — a placeholder rig without named zones just takes the whole-body tint.
  const tintAmt = opts.tintAmount ?? 0.45;
  const bodyTint = opts.outfitTint !== undefined ? new T.Color(opts.outfitTint) : undefined;
  const zoneColor: Record<string, { lerp: (c: unknown, a: number) => unknown }> = {};
  if (opts.outfit) for (const [z, hex] of Object.entries(opts.outfit)) zoneColor[z] = new T.Color(hex) as never;
  const zoneMat = opts.zoneMaterial;
  const tintFor = (matName: string, meshName: string): unknown => {
    if (opts.outfit && zoneMat) {
      const hay = `${matName} ${meshName}`.toLowerCase();
      for (const [z, pat] of Object.entries(zoneMat)) if (zoneColor[z] && hay.includes(pat.toLowerCase())) return zoneColor[z];
    }
    return bodyTint;
  };
  root.traverse((o: unknown) => {
    const n = o as { isMesh?: boolean; name?: string; castShadow?: boolean; receiveShadow?: boolean; frustumCulled?: boolean; material?: unknown };
    if (n.isMesh !== true) return;
    n.castShadow = true; n.receiveShadow = true; n.frustumCulled = false; // skinned bounds move; don't cull
    const mats = Array.isArray(n.material) ? n.material : [n.material];
    for (const m of mats) {
      const mm = m as { name?: string; color?: { lerp: (c: unknown, a: number) => void } };
      if (mm.color === undefined) continue;
      // NEVER tint skin / eyes / hair / brows — outfit tint is CLOTHING only.
      if (/skin|eye|brow|hair|teeth|mouth|lash/i.test(mm.name ?? "")) continue;
      const c = tintFor(mm.name ?? "", n.name ?? "");
      if (c !== undefined) mm.color.lerp(c, tintAmt);
    }
  });

  // Scale to a real human height, then compute a foot offset so the feet sit at the setPosition Y
  // regardless of the source's pivot. A rigged library rig pivots at the feet (offset ~0); a generated
  // (image-to-3D) mesh pivots at its center, so its feet are ~half a body below the origin — without this
  // it would sink to the waist in the ground. footOffset = -(scaled bbox min.y).
  const target = opts.targetHeightM ?? 1.75;
  const box = new T.Box3().setFromObject(root);
  const size = box.getSize(new T.Vector3()) as { y: number };
  const rawH = size.y > 1e-3 ? size.y : 1;
  const scale = target / rawH;
  root.scale.setScalar(scale);
  const footOffset = -box.min.y * scale;

  // Animation: idle + walk actions, crossfaded by speed.
  const mixer = new T.AnimationMixer(root);
  const idleClip = findClip(THREE, animations, ["idle"], 0);
  const walkClip = findClip(THREE, animations, ["walk", "run"], animations.length > 1 ? 1 : 0);
  const idle = idleClip ? mixer.clipAction(idleClip) : undefined;
  const walk = walkClip ? mixer.clipAction(walkClip) : undefined;
  idle?.play().setEffectiveWeight(1);
  walk?.play().setEffectiveWeight(0);
  let walking = false;
  const walkThreshold = opts.walkThreshold ?? 0.15;

  return {
    group: root,
    height: target,
    update(dtSec: number): void { mixer.update(dtSec); },
    setLocomotion(speed: number): void {
      const wantWalk = speed > walkThreshold;
      if (wantWalk === walking) return;
      walking = wantWalk;
      if (idle) idle.setEffectiveWeight(wantWalk ? 0 : 1);
      if (walk) walk.setEffectiveWeight(wantWalk ? 1 : 0);
    },
    setPosition(x: number, y: number, z: number): void { root.position.set(x, y + footOffset, z); },
    faceDir(dx: number, dz: number): void {
      if (dx * dx + dz * dz < 1e-6) return;
      root.rotation.y = Math.atan2(dx, dz);
    },
  };
}
