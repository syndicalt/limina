import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  assertApprovedFunctionalSettlementFurnishingAuthority,
  functionalSettlementFurnishingClosureHash,
  loadApprovedFunctionalSettlementFurnishingAuthority,
  resolveApprovedFunctionalSettlementFurnishing,
} from "../src/assets/functional-settlement-furnishing.mjs";
import { loadApprovedFunctionalSettlementRelease } from "../src/assets/functional-settlement-release.mjs";
import { canonicalCompilerJson } from "../src/world/compiler/canonical.mjs";
import { createFurnishedReleasedFunctionalSettlementRuntimeResidency } from "../src/skills/functional-settlement-runtime-residency.ts";
import { buildFunctionalSettlementFurnishingAuthority } from "../../tools/architecture/build-fb5-functional-settlement-furnishing.ts";

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(path));
const release = loadApprovedFunctionalSettlementRelease(read("assets/settlements/functional-hall-r1/release.json"), read) as any;
const authorityPath = "assets/settlements/functional-hall-r1/furnishing-authority-r1.json", authorityBytes = read(authorityPath);
assert.equal(createHash("sha256").update(authorityBytes).digest("hex"), "efdcce983e3a828d312c4879255ef814ef2292cbb77ba5239267ca094c6c6708", "raw furnishing authority drifted");
const loaded = loadApprovedFunctionalSettlementFurnishingAuthority(authorityBytes, release, read) as any;
assert.equal(loaded.authority.closureHash, "sha256:4a7c2abac628db794ab4357871642107e59d72220f8ad1974db821bd9dd9c917");
assert.equal(loaded.authority.visualPolicy.activation, "dormant-authoring-sidecar");
assert.equal(loaded.authority.visualPolicy.runtimeVisual, false); assert.equal(loaded.authority.visualPolicy.runtimeCollision, false);
assert.equal(loaded.release.publication.catalog.entries.length, 1, "arrangement variants must not impersonate plural building variants");

const assignments = release.plan.placements.map((placement: any) => resolveApprovedFunctionalSettlementFurnishing(loaded, placement.placementId));
assert.deepEqual(assignments.map((entry: any) => entry.variantId).sort(), ["furnishing/balanced-hall", "furnishing/dining-service", "furnishing/hearth-social"]);
assert.deepEqual(assignments.map((entry: any) => entry.bindings.length).sort((a: number, b: number) => a - b), [2, 5, 6]);
assert(assignments.every((entry: any) => entry.bindings.every((binding: any) => binding.library.contract.contractHash === binding.library.contractHash)), "assignment lost exact functional furniture contracts");
assert.throws(() => assertApprovedFunctionalSettlementFurnishingAuthority(JSON.parse(JSON.stringify(loaded))), /not a verified in-process/);
const independentlyLoadedRelease = loadApprovedFunctionalSettlementRelease(read("assets/settlements/functional-hall-r1/release.json"), read);
assert.throws(() => createFurnishedReleasedFunctionalSettlementRuntimeResidency({} as any, {} as any, {
  namespace: "hostile/cross-release", release: independentlyLoadedRelease, furnishingAuthority: loaded, invokeBase: (() => { throw new Error("must not execute"); }) as any,
}), /not verified against this exact in-process release/, "cross-release branded sidecar pairing was accepted");

const generated = await buildFunctionalSettlementFurnishingAuthority("assets/settlements/functional-hall-r1/furnishing-recipe-r1.json");
assert.equal(canonicalCompilerJson(generated), canonicalCompilerJson(loaded.authority), "CPU builder did not reproduce the published authority");
assert.equal(functionalSettlementFurnishingClosureHash(generated), loaded.authority.closureHash);

function hostile(mutate: (value: any) => void): Uint8Array {
  const value = JSON.parse(new TextDecoder().decode(authorityBytes)); mutate(value); value.closureHash = functionalSettlementFurnishingClosureHash(value);
  return new TextEncoder().encode(JSON.stringify(value));
}
assert.throws(() => loadApprovedFunctionalSettlementFurnishingAuthority(hostile((value) => { value.library[0].asset.sha256 = `sha256:${"0".repeat(64)}`; }), release, read), /asset exact bytes drifted/);
assert.throws(() => loadApprovedFunctionalSettlementFurnishingAuthority(hostile((value) => { value.library[1].approvalDecision.sha256 = `sha256:${"1".repeat(64)}`; }), release, read), /approvalDecision exact bytes drifted/);
assert.throws(() => loadApprovedFunctionalSettlementFurnishingAuthority(hostile((value) => { value.sockets.find((socket: any) => socket.socketId === "socket/service/storage").position[0] = 100; }), release, read), /leaves its bound functional room/);
assert.throws(() => loadApprovedFunctionalSettlementFurnishingAuthority(hostile((value) => { const sockets = value.sockets; sockets.find((socket: any) => socket.socketId === "socket/dining/chair-east").position = [...sockets.find((socket: any) => socket.socketId === "socket/dining/table").position]; }), release, read), /collides with/);
assert.throws(() => loadApprovedFunctionalSettlementFurnishingAuthority(hostile((value) => { value.assignment.placements[0].variantId = "furnishing/dining-service"; }), release, read), /not the deterministic release assignment/);
assert.throws(() => loadApprovedFunctionalSettlementFurnishingAuthority(hostile((value) => { value.visualPolicy.runtimeCollision = true; }), release, read), /keep visuals\/collision dormant/);

console.log("p_fb5_functional_settlement_furnishing OK: exact CPU-reproducible 4-asset library, 7 sockets, 3 deterministic arrangement variants; hostile drift rejected; visual/collision activation remains dormant");
