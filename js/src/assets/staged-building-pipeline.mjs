export const BUILDING_STAGE_ARTIFACT_SCHEMA = "limina.building-stage-artifact/v1";
export const BUILDING_HITL_DECISION_SCHEMA = "limina.building-hitl-decision/v1";
export const BUILDING_HITL_DECISION_SCHEMA_V2 = "limina.building-hitl-decision/v2";

export const BUILDING_STAGE_KINDS = Object.freeze([
  "brief", "shell", "material-palette", "interior-plan", "furniture-pack", "prop-pack",
  "fire-runtime", "composition", "production-package", "presentation-review",
]);
export const BUILDING_REVIEW_GATES = Object.freeze([
  "B0-brief", "A1-shell", "M1-materials", "I1-layout", "F1-asset", "V1-vfx", "C1-composition", "R1-release",
]);
export const BUILDING_STAGE_FACETS = Object.freeze({
  brief: ["requirements", "visual-cues", "performance-budget"],
  shell: ["exterior-envelope", "interior-envelope", "support-sockets", "portal-articulation", "hearth-flue-sockets", "collision-traversal", "surface-mapping", "material-role-slots", "runtime-geometry", "lod-contract"],
  "material-palette": ["role-contract", "source-lock", "surface-parameters", "runtime-textures", "encoding-budget"],
  "interior-plan": ["activity-zones", "placements", "circulation", "sightlines", "support-bindings", "vfx-intent"],
  "furniture-pack": ["placement-contract", "interaction-sockets", "joinery-contract", "collision", "material-role-slots", "runtime-geometry", "lod-contract"],
  "prop-pack": ["placement-contract", "support-socket", "interaction-sockets", "material-role-slots", "runtime-geometry", "lod-contract"],
  "fire-runtime": ["socket-requirements", "state-machine", "authoritative-parameters", "runtime-visuals", "light-exposure", "performance-lifecycle"],
  composition: ["instance-set", "resolved-transforms", "interaction-bindings", "runtime-bindings", "material-bindings", "runtime-closure", "lod-closure"],
  "production-package": ["asset-closure", "semantic-closure", "texture-closure", "lod-closure", "runtime-closure"],
  "presentation-review": ["scene-authority", "environment", "cameras", "post", "evidence-contract"],
});
const INTERIOR_PLACEMENT_FACETS = new Set(["dining-table", "dining-chair", "hearth-settle", "storage-shelf"].map((role)=>`placements/proxy/${role}`));
const facetAllowed=(kind,scope)=>BUILDING_STAGE_FACETS[kind].includes(scope)||(kind==="interior-plan"&&INTERIOR_PLACEMENT_FACETS.has(scope));

const HASH = /^sha256:[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9._/-]{0,159}$/;
const STAGES = new Set(BUILDING_STAGE_KINDS);
const GATES = new Set(BUILDING_REVIEW_GATES);
const ARTIFACT_STATES = new Set(["draft", "candidate", "approved", "rejected"]);
const DECISIONS = new Set(["approve", "revise", "reject"]);

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
function text(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value;
}
function id(value, label) {
  text(value, label); if (!ID.test(value)) throw new Error(`${label} must be a stable lowercase id`); return value;
}
function hash(value, label) {
  if (!HASH.test(value)) throw new Error(`${label} must be lowercase sha256`); return value;
}
function exactKeys(value, required, optional, label) {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!(key in value)) throw new Error(`${label}.${key} is required`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label}.${key} is unsupported`);
}
function unique(values, label) {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`);
}

export function validateBuildingStageArtifact(value) {
  const artifact = object(value, "building stage artifact");
  exactKeys(artifact,
    ["schema", "artifactId", "kind", "revision", "status", "contractHash", "contentHash", "facets", "inputs", "evidence"],
    ["supersedes", "metadata"], "building stage artifact");
  if (artifact.schema !== BUILDING_STAGE_ARTIFACT_SCHEMA) throw new Error("unsupported building stage artifact schema");
  id(artifact.artifactId, "artifactId");
  if (!STAGES.has(artifact.kind)) throw new Error("building stage artifact kind is unsupported");
  if (!Number.isSafeInteger(artifact.revision) || artifact.revision < 1) throw new Error("building stage artifact revision must be positive");
  if (!ARTIFACT_STATES.has(artifact.status)) throw new Error("building stage artifact status is unsupported");
  hash(artifact.contractHash, "contractHash"); hash(artifact.contentHash, "contentHash");
  if (!Array.isArray(artifact.facets) || artifact.facets.length === 0) throw new Error("building stage artifact facets must be a non-empty array");
  const facetScopes = [], allowedFacets = new Set(BUILDING_STAGE_FACETS[artifact.kind]);
  for (const [index, raw] of artifact.facets.entries()) {
    const facet = object(raw, `facets[${index}]`); exactKeys(facet, ["scope", "hash"], [], `facets[${index}]`);
    text(facet.scope, `facets[${index}].scope`); hash(facet.hash, `facets[${index}].hash`);
    if (!facetAllowed(artifact.kind,facet.scope)) throw new Error(`facet '${facet.scope}' is not declared for ${artifact.kind}`);
    facetScopes.push(facet.scope);
  }
  unique(facetScopes, "building stage artifact facet scopes");
  if (artifact.supersedes !== undefined) id(artifact.supersedes, "supersedes");
  if (!Array.isArray(artifact.inputs)) throw new Error("building stage artifact inputs must be an array");
  const inputKeys = [];
  for (const [index, raw] of artifact.inputs.entries()) {
    const input = object(raw, `inputs[${index}]`);
    exactKeys(input, ["artifactId", "kind", "facets"], [], `inputs[${index}]`);
    id(input.artifactId, `inputs[${index}].artifactId`);
    if (!STAGES.has(input.kind)) throw new Error(`inputs[${index}].kind is unsupported`);
    if (!Array.isArray(input.facets) || input.facets.length === 0) throw new Error(`inputs[${index}].facets must be non-empty`);
    const dependencyScopes=[], dependencyAllowed=new Set(BUILDING_STAGE_FACETS[input.kind]);
    for(const [facetIndex,rawFacet] of input.facets.entries()){
      const facet=object(rawFacet,`inputs[${index}].facets[${facetIndex}]`);exactKeys(facet,["scope","hash"],[],`inputs[${index}].facets[${facetIndex}]`);
      text(facet.scope,`inputs[${index}].facets[${facetIndex}].scope`);hash(facet.hash,`inputs[${index}].facets[${facetIndex}].hash`);
      if(!facetAllowed(input.kind,facet.scope))throw new Error(`dependency facet '${facet.scope}' is not declared for ${input.kind}`);
      dependencyScopes.push(facet.scope);
    }
    unique(dependencyScopes,`inputs[${index}] facet scopes`);
    if (input.artifactId === artifact.artifactId) throw new Error("building stage artifact cannot depend on itself");
    inputKeys.push(input.artifactId);
  }
  unique(inputKeys, "building stage artifact input ids");
  if (!Array.isArray(artifact.evidence)) throw new Error("building stage artifact evidence must be an array");
  const evidenceIds = [];
  for (const [index, raw] of artifact.evidence.entries()) {
    const evidence = object(raw, `evidence[${index}]`);
    exactKeys(evidence, ["evidenceId", "kind", "contentHash"], ["width", "height", "timestamp"], `evidence[${index}]`);
    id(evidence.evidenceId, `evidence[${index}].evidenceId`); text(evidence.kind, `evidence[${index}].kind`);
    hash(evidence.contentHash, `evidence[${index}].contentHash`);
    if ((evidence.width === undefined) !== (evidence.height === undefined)) throw new Error("evidence dimensions must be paired");
    for (const field of ["width", "height"]) if (evidence[field] !== undefined && (!Number.isSafeInteger(evidence[field]) || evidence[field] < 1)) throw new Error(`evidence ${field} must be positive`);
    if (evidence.timestamp !== undefined && !Number.isFinite(Date.parse(evidence.timestamp))) throw new Error("evidence timestamp must be ISO-parseable");
    evidenceIds.push(evidence.evidenceId);
  }
  unique(evidenceIds, "building stage artifact evidence ids");
  if (artifact.metadata !== undefined) object(artifact.metadata, "metadata");
  return Object.freeze(artifact);
}

export function validateBuildingHitlDecision(value) {
  const record = object(value, "building HITL decision");
  const v2 = record.schema === BUILDING_HITL_DECISION_SCHEMA_V2;
  exactKeys(record,
    ["schema", "decisionId", "gate", "artifactId", "contractHash", "contentHash", "reviewer", "timestamp", "decision", v2 ? "evidenceBindings" : "evidenceHashes", "blockingFindings", "observations", "markedRegions"],
    ["instruction", "returnToGate", "acceptedDeviations"], "building HITL decision");
  if (record.schema !== BUILDING_HITL_DECISION_SCHEMA && !v2) throw new Error("unsupported building HITL decision schema");
  id(record.decisionId, "decisionId"); id(record.artifactId, "artifactId");
  if (!GATES.has(record.gate)) throw new Error("building HITL gate is unsupported");
  hash(record.contractHash, "contractHash"); hash(record.contentHash, "contentHash");
  text(record.reviewer, "reviewer");
  if (typeof record.timestamp !== "string" || !Number.isFinite(Date.parse(record.timestamp))) throw new Error("decision timestamp must be ISO-parseable");
  if (!DECISIONS.has(record.decision)) throw new Error("decision must be approve, revise, or reject");
  if (v2) {
    if (!Array.isArray(record.evidenceBindings) || record.evidenceBindings.length === 0) throw new Error("decision requires exact evidence bindings");
    const evidenceIds = [];
    for (const [index, raw] of record.evidenceBindings.entries()) {
      const binding = object(raw, `evidenceBindings[${index}]`);
      exactKeys(binding, ["evidenceId", "contentHash"], [], `evidenceBindings[${index}]`);
      id(binding.evidenceId, `evidenceBindings[${index}].evidenceId`); hash(binding.contentHash, `evidenceBindings[${index}].contentHash`);
      evidenceIds.push(binding.evidenceId);
    }
    unique(evidenceIds, "decision evidence binding ids");
  } else {
    if (!Array.isArray(record.evidenceHashes) || record.evidenceHashes.length === 0) throw new Error("decision requires exact evidence hashes");
    record.evidenceHashes.forEach((value, index) => hash(value, `evidenceHashes[${index}]`)); unique(record.evidenceHashes, "decision evidence hashes");
  }
  for (const field of ["blockingFindings", "observations", "markedRegions", "acceptedDeviations"]) {
    if (record[field] !== undefined && !Array.isArray(record[field])) throw new Error(`${field} must be an array`);
  }
  for (const [index, finding] of record.blockingFindings.entries()) text(finding, `blockingFindings[${index}]`);
  for (const [index, observation] of record.observations.entries()) text(observation, `observations[${index}]`);
  for (const [index, raw] of record.markedRegions.entries()) {
    const region = object(raw, `markedRegions[${index}]`);
    exactKeys(region, [...(v2 ? ["evidenceId"] : []), "evidenceHash", "x01", "y01", "width01", "height01", "note"], ["semanticId"], `markedRegions[${index}]`);
    hash(region.evidenceHash, `markedRegions[${index}].evidenceHash`);
    if (v2) {
      id(region.evidenceId, `markedRegions[${index}].evidenceId`);
      if (!record.evidenceBindings.some((binding) => binding.evidenceId === region.evidenceId && binding.contentHash === region.evidenceHash)) throw new Error("marked region references unreviewed evidence");
    } else if (!record.evidenceHashes.includes(region.evidenceHash)) throw new Error("marked region references unreviewed evidence");
    for (const field of ["x01", "y01", "width01", "height01"]) if (!Number.isFinite(region[field]) || region[field] < 0 || region[field] > 1) throw new Error(`marked region ${field} must be normalized`);
    if (region.width01 <= 0 || region.height01 <= 0 || region.x01 + region.width01 > 1 || region.y01 + region.height01 > 1) throw new Error("marked region must fit inside evidence");
    text(region.note, `markedRegions[${index}].note`); if (region.semanticId !== undefined) id(region.semanticId, `markedRegions[${index}].semanticId`);
  }
  if (record.decision === "approve") {
    if (record.blockingFindings.length !== 0) throw new Error("approval cannot carry blocking findings");
    if (record.instruction !== undefined || record.returnToGate !== undefined) throw new Error("approval cannot carry revision routing");
  } else {
    if (record.blockingFindings.length === 0) throw new Error(`${record.decision} requires blocking findings`);
    if ((record.markedRegions.length === 0) && (typeof record.instruction !== "string" || record.instruction.trim() === "")) throw new Error(`${record.decision} requires a marked region or instruction`);
    if (record.decision === "reject") {
      if (!GATES.has(record.returnToGate)) throw new Error("reject requires a valid upstream returnToGate");
    } else if (record.returnToGate !== undefined) throw new Error("revise remains at its current gate");
  }
  return Object.freeze(record);
}

/** Returns deterministic, transitive stale records without mutating the graph. */
export function buildingArtifactInvalidation(artifacts) {
  if (!Array.isArray(artifacts)) throw new Error("building artifacts must be an array");
  const valid = artifacts.map(validateBuildingStageArtifact), byId = new Map();
  for (const artifact of valid) {
    if (byId.has(artifact.artifactId)) throw new Error(`duplicate building artifact ${artifact.artifactId}`);
    byId.set(artifact.artifactId, artifact);
  }
  const visiting=new Set(),visited=new Set(),visit=(artifact)=>{if(visiting.has(artifact.artifactId))throw new Error(`building artifact dependency cycle includes ${[...visiting,artifact.artifactId].sort().join(",")}`);if(visited.has(artifact.artifactId))return;visiting.add(artifact.artifactId);for(const input of artifact.inputs){const producer=byId.get(input.artifactId);if(producer)visit(producer);}visiting.delete(artifact.artifactId);visited.add(artifact.artifactId);};
  for(const artifact of [...valid].sort((a,b)=>a.artifactId.localeCompare(b.artifactId)))visit(artifact);
  const stale = new Map();
  let changed = true;
  while (changed) {
    changed = false;
    for (const artifact of [...valid].sort((a, b) => a.artifactId.localeCompare(b.artifactId))) {
      if (stale.has(artifact.artifactId)) continue;
      for (const input of artifact.inputs) {
        const current = byId.get(input.artifactId);
        let reason = current === undefined ? "missing-input"
          : stale.has(input.artifactId) ? "transitive-input"
            : current.kind !== input.kind ? "kind-mismatch" : undefined;
        let scope;
        if(reason===undefined){const actual=new Map(current.facets.map(facet=>[facet.scope,facet.hash]));for(const facet of input.facets){if(actual.get(facet.scope)!==facet.hash){reason="facet-hash-mismatch";scope=facet.scope;break;}}}
        if (reason !== undefined) {
          stale.set(artifact.artifactId, Object.freeze({ artifactId: artifact.artifactId, inputArtifactId: input.artifactId, reason, ...(scope===undefined?{}:{scope}) }));
          changed = true; break;
        }
      }
    }
  }
  return Object.freeze([...stale.values()].sort((a, b) => a.artifactId.localeCompare(b.artifactId)));
}

export function assertBuildingArtifactReviewable(artifact, decision, artifacts) {
  const validArtifact = validateBuildingStageArtifact(artifact), validDecision = validateBuildingHitlDecision(decision);
  if (validArtifact.status !== "candidate") throw new Error("only a candidate building artifact is reviewable");
  if (validDecision.artifactId !== validArtifact.artifactId || validDecision.contractHash !== validArtifact.contractHash || validDecision.contentHash !== validArtifact.contentHash) throw new Error("HITL decision does not bind the exact building artifact");
  if (validDecision.schema === BUILDING_HITL_DECISION_SCHEMA_V2) {
    const expected = validArtifact.evidence.map(({ evidenceId, contentHash }) => `${evidenceId}\0${contentHash}`).sort();
    const actual = validDecision.evidenceBindings.map(({ evidenceId, contentHash }) => `${evidenceId}\0${contentHash}`).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("HITL decision does not bind the complete evidence set");
  } else {
    const evidenceHashes = [...new Set(validArtifact.evidence.map((entry) => entry.contentHash))].sort();
    if (JSON.stringify([...validDecision.evidenceHashes].sort()) !== JSON.stringify(evidenceHashes)) throw new Error("HITL decision does not bind the complete evidence set");
  }
  const invalidated = buildingArtifactInvalidation(artifacts);
  if (invalidated.some((entry) => entry.artifactId === validArtifact.artifactId)) throw new Error("stale building artifact cannot enter HITL review");
  return Object.freeze({ artifact: validArtifact, decision: validDecision });
}
