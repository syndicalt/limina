import fs from "node:fs";
import { canonicalHash } from "../src/authoring/canonical.ts";
import { verifyBuildingArticulationCpuProxyEvidence } from "../src/architecture/building-articulation-cpu-proxy.ts";
import { sha256 } from "../src/world/sha256.mjs";

const root = "assets/buildings/authoring/functional-hall-house-v4/fb4-multi-room-candidate-v3-1f375ec3abe1";
const assert = (value: unknown, message: string): asserts value => { if (!value) throw new Error(`p_fb4_v3_articulation_cpu_proxy FAIL: ${message}`); };
const process = Bun.spawnSync(["bun", "tools/architecture/build-building-articulation-cpu-proxy.ts", "--candidate-root", root], { stdout: "pipe", stderr: "pipe" });
assert(process.exitCode === 0, new TextDecoder().decode(process.stderr));
const evidence = JSON.parse(new TextDecoder().decode(process.stdout));
verifyBuildingArticulationCpuProxyEvidence(evidence, path => fs.readFileSync(path));
assert(evidence.schema === "limina.building-articulation-cpu-proxy/v1" && evidence.algorithm === "semantic-glb-triangle-raycast/v1"
  && evidence.mechanicalVerdict === "mechanically-sufficient-for-v3-site-review" && evidence.failures.length === 0,
  "exact V3 candidate did not retain the backward-compatible passing mechanical verdict");
assert(evidence.authority.candidateManifest.sha256 === "sha256:1539931ba24f0a70b80375d0865dfa478c5b54130efb6e30125cc2489e825425"
  && evidence.authority.productionGlb.sha256 === "sha256:e045c1c59baa9056a4b640f893fd9ddc8bfb80fad8df2ac965629442047368ef"
  && evidence.authority.architectureIr.sha256 === "sha256:630597b0f3f8ac80890f78d9471fba0da7b5f8daa7db545bc6098fbd4d3e2bd6",
  "exact manifest/GLB/architecture-IR authority drifted");
const closure = evidence.functionalClosure;
assert(JSON.stringify(closure.counts) === JSON.stringify({ rooms: 6, portals: 5, doors: 3, spawnAnchors: 6, visibilityCells: 6, verticalLinks: 1, colliders: 98 }),
  "V3 functional inventory drifted (the exact contract has three, not four, operable doors)");
assert(closure.stair.treadColliderIds.length === 20
  && closure.stair.treadColliderIds[0] === "collider/stairs/stairs/primary/flight-0/tread-0"
  && closure.stair.treadColliderIds.at(-1) === "collider/stairs/stairs/primary/flight-1/tread-9"
  && closure.stair.landingColliderIds.includes("collider/stairs/stairs/primary/landing-intermediate-0")
  && closure.stair.visibleTreadColliderCount === 20 && closure.attachedBay.functionalFloorColliderIds.length === 3
  && closure.attachedBay.passageThresholdId === "attached-bay/attached-bay/service-cross-gable/passage-threshold",
  "oriented ramp or attached-bay floor/threshold closure drifted");
assert(evidence.claims.renderingPerformed === false && evidence.claims.gpuUsed === false && evidence.claims.pixelEvidence === false
  && evidence.claims.visualQualityClaimed === false && evidence.claims.humanDecision === "pending",
  "CPU articulation proxy escaped its no-render/no-approval boundary");

const forged = structuredClone(evidence);
forged.functionalClosure.counts.doors = 4;
const { closureHash: _closureHash, ...closureCore } = forged.functionalClosure;
forged.functionalClosure.closureHash = canonicalHash(sha256, closureCore);
const { proxyHash: _proxyHash, ...proxyCore } = forged;
forged.proxyHash = canonicalHash(sha256, proxyCore);
let rejected = false;
try { verifyBuildingArticulationCpuProxyEvidence(forged, path => fs.readFileSync(path)); } catch { rejected = true; }
assert(rejected, "rehashed four-door fabrication did not fail exact GLB/architecture recomputation");

console.log("p_fb4_v3_articulation_cpu_proxy OK: exact V3 manifest/GLB/architecture IR recompute to a CPU-only passing articulation proxy with six rooms, five portals, three doors, six anchors, twenty autostep treads, three landings, and attached-bay floor union");
