#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { runAssetQcGate } from "../../gates/design/asset-qc-gate.mjs";
import { inspectGlbAsset, sha256, upsertAssetCandidate } from "./asset-manifest.mjs";

function value(args, name) { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; }
function all(args, name) { const values = []; for (let index = 0; index < args.length; index++) if (args[index] === name) values.push(args[index + 1]); return values; }
function required(args, name) { const result = value(args, name); if (!result) throw new Error(`missing ${name}`); return result; }
function rel(root, path) { const result = relative(root, path).split(sep).join("/"); if (result === "" || result === ".." || result.startsWith("../")) throw new Error(`${path} escapes asset root`); return result; }
function lodArg(value) {
  const split = value.lastIndexOf(":");
  if (split < 1) throw new Error(`invalid --lod '${value}', expected path:distanceM`);
  const distanceM = Number(value.slice(split + 1));
  if (!Number.isFinite(distanceM) || !(distanceM > 0)) throw new Error(`invalid LOD distance '${value}'`);
  return { path: value.slice(0, split), distanceM };
}

const args = process.argv.slice(2);
try {
  const root = resolve(required(args, "--asset-root"));
  const manifestPath = resolve(required(args, "--manifest"));
  const floor = JSON.parse(await readFile(resolve(required(args, "--floor")), "utf8"));
  const id = required(args, "--id");
  const modelPath = resolve(required(args, "--model"));
  const evidencePath = resolve(required(args, "--evidence"));
  const contactPath = resolve(required(args, "--contact-sheet"));
  const modelBytes = await readFile(modelPath), contactBytes = await readFile(contactPath);
  const metrics = inspectGlbAsset(modelBytes);
  const verdict = runAssetQcGate(modelBytes, { floor, class: "vegetation" });
  if (!verdict.pass) throw new Error(`model fails mechanical fidelity floor: ${verdict.failures.map((failure) => `${failure.gate}: ${failure.detail}`).join("; ")}`);
  const lods = [];
  let priorTriangles = metrics.triangleCount, priorDistance = 0;
  for (const spec of all(args, "--lod").map(lodArg)) {
    const path = resolve(spec.path), bytes = await readFile(path), lodMetrics = inspectGlbAsset(bytes);
    if (!(spec.distanceM > priorDistance)) throw new Error("LOD distances must be strictly increasing");
    if (!(lodMetrics.triangleCount < priorTriangles)) throw new Error(`${path} does not reduce triangle count`);
    lods.push({ level: lods.length + 1, path: rel(root, path), sha256: sha256(bytes), distanceM: spec.distanceM, metrics: lodMetrics });
    priorTriangles = lodMetrics.triangleCount; priorDistance = spec.distanceM;
  }
  if (lods.length < 1) throw new Error("vegetation candidate requires at least one --lod");
  const evidence = {
    schema: "limina.asset-qc-evidence/1",
    id,
    model: { path: rel(root, modelPath), sha256: sha256(modelBytes), metrics },
    lods,
    contactSheet: { path: rel(root, contactPath), sha256: sha256(contactBytes) },
    mechanicalFloor: verdict,
    generator: required(args, "--generator"),
  };
  const temporary = `${evidencePath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  await rename(temporary, evidencePath);
  const evidenceBytes = await readFile(evidencePath);
  const candidate = {
    id,
    status: "candidate-awaiting-human-qc-and-impostor",
    class: "vegetation",
    model: { path: rel(root, modelPath), sha256: sha256(modelBytes) },
    provenance: {
      source: required(args, "--source"),
      sourceUrl: required(args, "--source-url"),
      licenseSpdx: required(args, "--license"),
      attribution: required(args, "--attribution"),
    },
    metrics,
    lods,
    qc: {
      gateVersion: "limina.asset-qc/2",
      mechanicalEvidence: { path: rel(root, evidencePath), sha256: sha256(evidenceBytes) },
      humanVisualApproval: null,
    },
    internalContactSheet: { path: rel(root, contactPath), sha256: sha256(contactBytes) },
  };
  upsertAssetCandidate(manifestPath, candidate);
  console.log(JSON.stringify({ id, model: candidate.model, lods: lods.map(({ path, sha256, distanceM }) => ({ path, sha256, distanceM })), evidence: candidate.qc.mechanicalEvidence }));
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
}
