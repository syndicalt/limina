import {
  deriveCommandCameraFrame,
  DerivedTerrainResidencyTracker,
} from "../src/browser/camera-framing.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_camera_framing FAIL: ${message}`);
}

const ordinary = deriveCommandCameraFrame([
  { kind: "skill", tool: "terrain.create", input: { size: 500, generate: { source: "procedural" } } },
]);
assert(!ordinary.largeMapTerrain && ordinary.target[0] === 0 && ordinary.target[1] === 1
  && ordinary.orbitRadiusM === 16 && ordinary.farM === 200, "ordinary world defaults changed");

const localMap = deriveCommandCameraFrame([{
  kind: "skill",
  tool: "terrain.create",
  input: { size: 200, origin: [9_000_000, 40, -9_000_000], generate: { source: "map", amplitude: 20 } },
}]);
assert(localMap.largeMapTerrain, "map-generated terrain was not classified as a large map world");
assert(localMap.target[0] === 9_000_000 && localMap.target[1] === 45 && localMap.target[2] === -9_000_000,
  "map frame did not target the authored off-origin terrain center");
assert(localMap.orbitRadiusM === 70 && localMap.orbitHeightM === 36,
  `200m map did not receive a useful local frame (${localMap.orbitRadiusM}/${localMap.orbitHeightM})`);
assert(localMap.farM >= 1500 && localMap.atmosphereDensity === 1 / 600, "large map far/fog policy is invalid");

const continent = deriveCommandCameraFrame([{
  kind: "skill",
  tool: "terrain.create",
  input: { size: 10_000, origin: [10_000_000, 0, 10_000_000], generate: { source: "map" } },
}]);
assert(continent.orbitRadiusM === 192 && continent.orbitHeightM === 96,
  "continent framing attempted a whole-world overview instead of a bounded local view");
assert(continent.controls.maxDistanceM <= 576 && continent.farM >= 1500,
  "continent controls/far plane are not production bounded");
assert(continent.atmosphereDensity === 1 / 1200, "continent atmosphere was not scaled to its frame");

const trackerErrors: unknown[] = [];
const tracker = new DerivedTerrainResidencyTracker({
  center: [9_000_000, -9_000_000],
  radius: 7,
  thresholdChunks: 2,
  onListenerError: (error) => trackerErrors.push(error),
});
const initial = tracker.current();
tracker.setGrid({ origin: [8_999_968, -9_000_032], chunkSizeM: 64 });
let emissions = 0;
let observed = initial;
const unsubscribe = tracker.subscribe((residency) => { emissions++; observed = residency; });
tracker.subscribe(() => { throw new Error("listener failure"); });
assert(emissions === 0, "subscription emitted the current residency immediately");
assert(!tracker.update(9_000_128, -9_000_000) && tracker.current() === initial,
  "tracker emitted at the Chebyshev two-chunk boundary");
assert(tracker.update(9_000_192, -9_000_000), "tracker did not emit beyond the two-chunk threshold");
assert(emissions === 1 && observed === tracker.current() && observed !== initial,
  "tracker emission/current identity is incoherent");
assert(trackerErrors.length === 1, "listener failure was not isolated");
assert(tracker.update(9_000_448, -9_000_000), "tracker dropped a final anchor beyond the threshold");
unsubscribe();
assert(tracker.update(9_000_704, -9_000_000) && emissions === 2,
  "synchronous unsubscribe did not remove the listener");
tracker.dispose();
assert(!tracker.update(9_001_000, -9_000_000), "disposed tracker still updated");
let subscribeFailure: unknown;
try { tracker.subscribe(() => {}); } catch (error) { subscribeFailure = error; }
assert(subscribeFailure instanceof Error, "disposed tracker accepted a listener");

console.log("[js] p_camera_framing OK: off-origin map classification, bounded local frame, far/fog scaling, controls, stable manifest-grid residency threshold, final-anchor delivery, listener isolation, unsubscribe, and teardown proven");
