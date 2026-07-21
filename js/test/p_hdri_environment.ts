import * as THREE from "../build/three.bundle.mjs";
import { applyRenderBaseline } from "../src/render-baseline.ts";
import { HdrEnvironmentCache } from "../src/render/environment-hdri.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p_hdri_environment FAIL: ${message}`);
}

const hashes = ["1", "2", "3"].map((digit) => `sha256:${digit.repeat(64)}`);
let decodes = 0;
let sourceDisposals = 0;
let targetDisposals = 0;

const cache = new HdrEnvironmentCache({}, {
  maxEntries: 2,
  maxSourceBytes: 8,
  decode(bytes) {
    decodes++;
    const texture = new THREE.DataTexture(new Float32Array([bytes[0], 0, 0, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    texture.dispose = () => { sourceDisposals++; };
    return texture;
  },
  buildPmrem() {
    const texture = new THREE.Texture();
    return { texture, dispose: () => { targetDisposals++; texture.dispose(); } };
  },
});

const first = cache.acquire("environment/a.hdr", hashes[0], new Uint8Array([1, 2]));
const sameContent = cache.acquire("environment/alias-a.hdr", hashes[0], new Uint8Array([1, 2]));
assert(decodes === 1, "same content hash decoded twice");
assert(first.environment === sameContent.environment && first.background === sameContent.background, "same hash did not share cached GPU resources");
assert(cache.stats().activeLeases === 2, "lease count did not include both acquisitions");
first.release();
first.release();
sameContent.release();
assert(cache.stats().activeLeases === 0, "lease release was not idempotent");

const second = cache.acquire("environment/b.hdr", hashes[1], new Uint8Array([2, 3]));
second.release();
const third = cache.acquire("environment/c.hdr", hashes[2], new Uint8Array([3, 4]));
assert(cache.stats().entries === 2 && cache.stats().evictions === 1, "bounded cache did not evict the least-recent idle entry");
assert(sourceDisposals === 1 && targetDisposals === 1, "eviction did not dispose both source and PMREM target exactly once");

const retainedForWorld = third.retain();
third.release();
const scene = new THREE.Scene();
const previousBackground = new THREE.Color(0x102030);
const previousEnvironment = new THREE.Texture();
scene.background = previousBackground;
scene.environment = previousEnvironment;
scene.backgroundIntensity = 0.4;
scene.environmentIntensity = 0.3;
scene.backgroundRotation.set(0.1, 0.2, 0.3);
scene.environmentRotation.set(0.4, 0.5, 0.6);

const baseline = applyRenderBaseline({ scene }, {
  ground: { enabled: false },
  backgroundIntensity: 0.75,
  backgroundRotation: [0, 1.25, 0],
  environmentIntensity: 1.4,
  environmentRotation: [0, -0.5, 0],
}, undefined, retainedForWorld);

assert(baseline.environmentMode === "hdri", "baseline did not report the HDRI environment mode");
assert(scene.background === retainedForWorld.background && scene.environment === retainedForWorld.environment, "baseline did not install the HDR source and PMREM textures");
assert(scene.backgroundIntensity === 0.75 && scene.environmentIntensity === 1.4, "explicit HDR background/environment intensities were ignored");
assert(scene.backgroundRotation.y === 1.25 && scene.environmentRotation.y === -0.5, "explicit HDR background/environment rotations were ignored");
assert(cache.stats().activeLeases === 1, "baseline did not retain exactly one active world lease");

baseline.dispose();
baseline.dispose();
assert(cache.stats().activeLeases === 0, "baseline teardown did not release its HDR lease exactly once");
assert(scene.background === previousBackground && scene.environment === previousEnvironment, "baseline teardown did not restore prior scene textures");
assert(scene.backgroundIntensity === 0.4 && scene.environmentIntensity === 0.3, "baseline teardown did not restore prior intensities");
assert(scene.backgroundRotation.y === 0.2 && scene.environmentRotation.y === 0.5, "baseline teardown did not restore prior rotations");

cache.dispose();
cache.dispose();
assert(cache.stats().entries === 0 && sourceDisposals === 3 && targetDisposals === 3, "cache teardown did not release every remaining resource exactly once");
let rejected = false;
try { cache.acquire("environment/d.hdr", hashes[0], new Uint8Array([1])); } catch { rejected = true; }
assert(rejected, "disposed cache accepted a new environment");

console.log("p_hdri_environment OK: content-addressed HDR decode/PMREM cache is bounded; active leases pin resources; eviction and teardown are exact; render baseline installs/restores HDR background+IBL with explicit intensity and rotation.");
