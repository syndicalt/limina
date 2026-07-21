import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BUILDING_HITL_DECISION_SCHEMA_V2, validateBuildingHitlDecision, validateBuildingStageArtifact, assertBuildingArtifactReviewable } from "../../js/src/assets/staged-building-pipeline.mjs";

const GATE_BY_KIND = Object.freeze({
  brief: "B0-brief", shell: "A1-shell", "material-palette": "M1-materials", "interior-plan": "I1-layout",
  "furniture-pack": "F1-asset", "prop-pack": "F1-asset", "fire-runtime": "V1-vfx",
  composition: "C1-composition", "production-package": "R1-release", "presentation-review": "R1-release",
});
const args = process.argv.slice(2);
const at = (flag) => { const index = args.indexOf(flag); if (index < 0 || !args[index + 1]) throw new Error("usage: node tools/architecture/record-building-stage-review-decision.mjs --candidate <json> --out <json> --decision approve|revise|reject [--finding <text>] [--observation <text>] [--instruction <text>] [--return-to-gate <gate>]"); return args[index + 1]; };
const optional = (flag) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const all = (flag) => args.flatMap((entry, index) => entry === flag && args[index + 1] ? [args[index + 1]] : []);
const candidatePath = resolve(at("--candidate")), out = resolve(at("--out")), decision = at("--decision"), dependencyPaths = all("--dependency").map((path) => resolve(path));
if (!new Set(["approve", "revise", "reject"]).has(decision)) throw new Error("decision must be approve, revise, or reject");
const candidate = validateBuildingStageArtifact(JSON.parse(await readFile(candidatePath, "utf8"))), gate = GATE_BY_KIND[candidate.kind];
if (!gate) throw new Error(`no HITL gate is declared for ${candidate.kind}`);
const dependencies = await Promise.all(dependencyPaths.map(async (path) => validateBuildingStageArtifact(JSON.parse(await readFile(path, "utf8")))));
const returning = decision !== "approve", findings = all("--finding"), instruction = optional("--instruction"), returnToGate = optional("--return-to-gate");
const record = validateBuildingHitlDecision({
  schema: BUILDING_HITL_DECISION_SCHEMA_V2, decisionId: `${candidate.artifactId}/${decision}-user-r${candidate.revision}`,
  gate, artifactId: candidate.artifactId, contractHash: candidate.contractHash, contentHash: candidate.contentHash,
  reviewer: "user", timestamp: new Date().toISOString(), decision,
  evidenceBindings: candidate.evidence.map(({ evidenceId, contentHash }) => ({ evidenceId, contentHash })),
  blockingFindings: returning ? (findings.length ? findings : ["The exact candidate requires revision before this gate can pass."]) : [],
  observations: all("--observation"), markedRegions: [],
  ...(returning ? { instruction: instruction ?? "Revise the named facet and return a new exact candidate to this gate." } : {}),
  ...(decision === "reject" ? { returnToGate: returnToGate ?? gate } : {}),
});
assertBuildingArtifactReviewable(candidate, record, [...dependencies, candidate]);
await mkdir(dirname(out), { recursive: true, mode: 0o700 }); await writeFile(out, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ decisionId: record.decisionId, gate: record.gate, decision: record.decision, evidenceBindings: record.evidenceBindings }, null, 2));
