// M5 (part 1) — the DIAGNOSTICS GLOBAL contract. Proves the publish/read bridge the browser gate
// relies on: a snapshot published to the well-known global round-trips, and the key matches the
// constant the Playwright inspector reads.
//
// Run: ./target/release/limina js/test/p24_diagnostics.ts   (exit 0 = pass)

import { DIAGNOSTICS_KEY, publishDiagnostics, readDiagnostics, type Diagnostics } from "../src/game/diagnostics.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p24_diagnostics FAIL: " + msg);
}

assert(readDiagnostics() === undefined, "no diagnostics published yet → undefined");
assert(DIAGNOSTICS_KEY === "__LIMINA_DIAGNOSTICS__", "the well-known key must match what the inspector reads");

const snap: Diagnostics = {
  frame: 42,
  gameState: "won",
  counters: { relics: 3 },
  complete: true,
  player: { x: 1.5, z: -8 },
};
publishDiagnostics(snap);

const read = readDiagnostics();
assert(read !== undefined, "diagnostics must be readable after publish");
assert(read!.frame === 42 && read!.gameState === "won" && read!.complete === true, "scalar fields round-trip");
assert(read!.counters.relics === 3, "counters round-trip");
assert(read!.player!.x === 1.5 && read!.player!.z === -8, "player position round-trips");
// The global is reachable under the literal key (how the browser inspector reads it).
assert((globalThis as Record<string, unknown>)[DIAGNOSTICS_KEY] === read, "the global key holds the published snapshot");

// A later publish replaces the snapshot.
publishDiagnostics({ frame: 43, gameState: "running", counters: {}, complete: false });
assert(readDiagnostics()!.frame === 43 && readDiagnostics()!.gameState === "running", "a later publish replaces the snapshot");

console.log("p24_diagnostics OK: the diagnostics global publishes/reads under __LIMINA_DIAGNOSTICS__ (frame, gameState, counters, complete, player) — the browser tier-2 gate's bridge.");
