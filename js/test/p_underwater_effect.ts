import * as THREE from "../build/three.bundle.mjs";
import {
  UNDERWATER_BACKGROUND_COLOR,
  UNDERWATER_FOG_DENSITY,
  UnderwaterEffect,
} from "../src/render/underwater.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_underwater_effect FAIL: ${message}`);
}

function verifyBaseline(
  scene: THREE.Scene & { fogNode?: unknown },
  background: THREE.Scene["background"],
  fog: THREE.Scene["fog"],
  fogNode: unknown,
  label: string,
): void {
  assert(scene.background === background, `${label}: background reference was not restored`);
  assert(scene.fog === fog, `${label}: fog reference was not restored`);
  assert(scene.fogNode === fogNode, `${label}: fogNode reference was not restored`);
}

// Construction and dry updates are exact no-ops, including a fully null scene.
{
  const scene = new THREE.Scene() as THREE.Scene & { fogNode?: unknown };
  const effect = new UnderwaterEffect(scene);
  effect.update(false);
  effect.update(false);
  verifyBaseline(scene, null, null, undefined, "null dry path");
  effect.dispose();
  effect.dispose();
  verifyBaseline(scene, null, null, undefined, "null idempotent dispose");
  assert(effect.disposed && !effect.submerged, "disposed state flags incorrect");
}

// Authored Color/Fog/fogNode identities survive transitions; repeated updates do not replace
// the preallocated owned resources and do not mutate caller-owned values.
{
  const scene = new THREE.Scene() as THREE.Scene & { fogNode?: unknown };
  const background = new THREE.Color(0x9fc5df);
  const fog = new THREE.FogExp2(0xdce8ef, 0.004);
  const fogNode = { authored: "height-haze" };
  scene.background = background;
  scene.fog = fog;
  scene.fogNode = fogNode;
  const originalBackgroundHex = background.getHex();
  const originalFogHex = fog.color.getHex();
  const originalFogDensity = fog.density;
  const effect = new UnderwaterEffect(scene);

  effect.update(true);
  const ownedBackground = scene.background;
  const ownedFog = scene.fog;
  assert(effect.submerged, "enter did not set submerged state");
  assert(ownedBackground instanceof THREE.Color && ownedBackground.getHex() === UNDERWATER_BACKGROUND_COLOR,
    "enter did not install the bounded teal background");
  assert(ownedFog instanceof THREE.FogExp2 && ownedFog.color.getHex() === UNDERWATER_BACKGROUND_COLOR
    && Object.is(ownedFog.density, UNDERWATER_FOG_DENSITY), "enter did not install the expected exponential fog");
  assert(scene.fogNode === null, "classic underwater fog did not suspend the authored fog node");
  effect.update(true);
  assert(scene.background === ownedBackground && scene.fog === ownedFog, "repeated enter replaced owned resources");

  effect.update(false);
  verifyBaseline(scene, background, fog, fogNode, "authored baseline surfacing");
  assert(background.getHex() === originalBackgroundHex && fog.color.getHex() === originalFogHex && fog.density === originalFogDensity,
    "effect mutated caller-owned Color/Fog resources");
  effect.update(false);
  verifyBaseline(scene, background, fog, fogNode, "repeated surfacing");

  effect.update(true);
  assert(scene.background === ownedBackground && scene.fog === ownedFog, "second entry allocated replacement resources");
  effect.dispose();
  verifyBaseline(scene, background, fog, fogNode, "dispose while submerged");
  effect.update(true);
  verifyBaseline(scene, background, fog, fogNode, "post-dispose update");
}

// A Texture background is borrowed, never disposed, and a baseline changed after construction
// but before entry is the exact reference restored on surfacing.
{
  const scene = new THREE.Scene() as THREE.Scene & { fogNode?: unknown };
  const stale = new THREE.Color(0x112233);
  scene.background = stale;
  const effect = new UnderwaterEffect(scene);
  const texture = new THREE.Texture();
  let textureDisposals = 0;
  texture.dispose = (): void => { textureDisposals++; };
  const fog = new THREE.Fog(0xbadbed, 2, 100);
  scene.background = texture;
  scene.fog = fog;
  effect.update(true);
  effect.update(false);
  verifyBaseline(scene, texture, fog, undefined, "late texture baseline");
  effect.dispose();
  assert(textureDisposals === 0, "effect disposed caller-owned texture background");
}

// Repeated sessions on the same scene restore before the next run captures its baseline.
{
  const scene = new THREE.Scene() as THREE.Scene & { fogNode?: unknown };
  const baseline = new THREE.Color(0x4d7391);
  scene.background = baseline;
  for (let run = 0; run < 20; run++) {
    const effect = new UnderwaterEffect(scene);
    effect.update(true);
    effect.dispose();
    verifyBaseline(scene, baseline, null, undefined, `repeated run ${run}`);
  }
}

// Cleanup remains load-bearing when an unrelated teardown operation throws first.
{
  const scene = new THREE.Scene() as THREE.Scene & { fogNode?: unknown };
  const background = new THREE.Color(0x7799bb);
  const fog = new THREE.FogExp2(0xaaccdd, 0.002);
  scene.background = background;
  scene.fog = fog;
  const effect = new UnderwaterEffect(scene);
  effect.update(true);
  const failures: unknown[] = [];
  for (const operation of [
    (): void => { throw new Error("injected sibling disposer failure"); },
    (): void => effect.dispose(),
  ]) {
    try { operation(); } catch (error) { failures.push(error); }
  }
  assert(failures.length === 1, "fault fixture did not preserve the sibling cleanup failure");
  verifyBaseline(scene, background, fog, undefined, "fault-tolerant cleanup");
}

console.log("p_underwater_effect OK: dry no-op; preallocated transition resources; exact Color/Texture/Fog/fogNode restoration; caller ownership; repeated runs; submerged/fault cleanup; idempotent dispose.");
