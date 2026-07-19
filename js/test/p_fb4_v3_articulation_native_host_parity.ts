import { canonicalHash, type JsonValue } from "../src/authoring/canonical.ts";
import { createBuildingArticulationCpuProxy } from "../src/architecture/building-articulation-cpu-proxy.ts";
import { ops } from "../src/engine.ts";
import { sha256 } from "../src/world/sha256.mjs";

const root = "buildings/authoring/functional-hall-house-v4/fb4-multi-room-candidate-v3-1f375ec3abe1";
const evidence = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(ops.op_read_asset(`${root}/articulation-cpu-proxy-v1.json`)));
const productionGlb = ops.op_read_asset(evidence.authority.productionGlb.path.replace(/^assets\//, ""));
const elements = evidence.inventory.elements.map((entry: any) => ({ id: entry.id, semanticNodeIds: entry.semanticNodeIds }));
const facade = {
  centerX: evidence.asymmetry.facadeCenterX,
  halfWidth: evidence.asymmetry.facadeHalfWidth,
  dormerCenterX: evidence.asymmetry.dormerCenterX,
  canopyCenterX: evidence.asymmetry.canopyCenterX,
};
const computed = createBuildingArticulationCpuProxy({ productionGlb, policy: evidence.policy, elements, facade });
const { proxyHash: analysisHash, ...computedCore } = computed;
const { authority: _authority, implementation, policy: _policy, policyHash: _policyHash, reviewBoundary: _boundary, functionalClosure: _functionalClosure, proxyHash: _evidenceHash, ...recordedCore } = evidence;
const computedHash = canonicalHash(sha256, computedCore as unknown as JsonValue);
const recordedHash = canonicalHash(sha256, recordedCore as JsonValue);

if (analysisHash !== implementation.analysisHash || computedHash !== recordedHash) {
  const differences: string[] = [];
  const compare = (a: any, b: any, path: string): void => {
    if (differences.length >= 24) return;
    if (Object.is(a, b)) return;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") { differences.push(`${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); return; }
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const key of keys) compare(a[key], b[key], `${path}.${key}`);
  };
  compare(computedCore, recordedCore, "proxy");
  throw new Error(`p_fb4_v3_articulation_native_host_parity FAIL: analysis=${analysisHash}/${implementation.analysisHash} core=${computedHash}/${recordedHash}\n${differences.join("\n")}`);
}

console.log(`p_fb4_v3_articulation_native_host_parity OK: ${analysisHash}`);
