export const FUNCTIONAL_BUILDING_ITERATION_SCHEMA = "limina.functional-building-iteration/v1";
const HASH = /^sha256:[0-9a-f]{64}$/;
const STATES = new Set(["briefing", "asset-ready", "engine-review", "rejected", "approved"]);

const requiredText = (value, label) => {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`functional building iteration: ${label} is required`);
  return value;
};
const requiredHash = (value, label) => {
  if (!HASH.test(value)) throw new Error(`functional building iteration: ${label} must be sha256:<64 lowercase hex>`);
  return value;
};

export function validateFunctionalBuildingIteration(value) {
  if (value?.schema !== FUNCTIONAL_BUILDING_ITERATION_SCHEMA) throw new Error("functional building iteration: unsupported schema");
  requiredText(value.iterationId, "iterationId"); requiredText(value.subject, "subject");
  if (!STATES.has(value.status)) throw new Error("functional building iteration: invalid status");
  if (!Array.isArray(value.referenceCues) || value.referenceCues.length === 0) throw new Error("functional building iteration: reference cues are required");
  for (const [i, cue] of value.referenceCues.entries()) {
    requiredText(cue.id, `referenceCues[${i}].id`); requiredText(cue.source, `referenceCues[${i}].source`);
    if (cue.sourceArtifact !== undefined) {
      requiredText(cue.sourceArtifact.path, `referenceCues[${i}].sourceArtifact.path`);
      requiredHash(cue.sourceArtifact.sha256, `referenceCues[${i}].sourceArtifact.sha256`);
      if (cue.sourceArtifact.role !== "modeling-cue-only") throw new Error(`functional building iteration: referenceCues[${i}] role may not imply acceptance evidence`);
      requiredText(cue.conceptPromptProvenance?.tool, `referenceCues[${i}].conceptPromptProvenance.tool`);
      if (cue.conceptPromptProvenance?.modelVersion !== "not-exposed") throw new Error(`functional building iteration: referenceCues[${i}] must record the non-exposed model honestly`);
      requiredText(cue.conceptPromptProvenance?.exactPrompt, `referenceCues[${i}].conceptPromptProvenance.exactPrompt`);
    }
    if (!Array.isArray(cue.cues) || cue.cues.length === 0 || cue.cues.some((item) => typeof item !== "string" || item === "")) throw new Error(`functional building iteration: referenceCues[${i}].cues are required`);
  }
  requiredText(value.prompt?.text, "prompt.text"); requiredText(value.prompt?.intent, "prompt.intent");
  if (!Array.isArray(value.prompt?.constraints) || value.prompt.constraints.length === 0) throw new Error("functional building iteration: prompt constraints are required");
  if (!Array.isArray(value.targetEngineViews) || value.targetEngineViews.length < 3) throw new Error("functional building iteration: at least three target engine views are required");
  const viewIds = new Set();
  for (const view of value.targetEngineViews) { requiredText(view.id, "target view id"); requiredText(view.purpose, "target view purpose"); if (viewIds.has(view.id)) throw new Error("functional building iteration: duplicate target view id"); viewIds.add(view.id); }
  if (!Array.isArray(value.cycles)) throw new Error("functional building iteration: cycles must be an array");
  const cycles = new Map();
  for (const cycle of value.cycles) {
    if (!Number.isSafeInteger(cycle.cycle) || cycle.cycle < 1 || cycles.has(cycle.cycle)) throw new Error("functional building iteration: cycle ids must be unique positive integers");
    requiredText(cycle.constructionResponse?.summary, `cycle ${cycle.cycle} construction response`);
    if (!Array.isArray(cycle.constructionResponse?.changes)) throw new Error(`functional building iteration: cycle ${cycle.cycle} changes are required`);
    requiredText(cycle.artifact?.assetId, `cycle ${cycle.cycle} assetId`); requiredHash(cycle.artifact?.rawSha256, `cycle ${cycle.cycle} raw hash`); requiredHash(cycle.artifact?.engineContentHash, `cycle ${cycle.cycle} engine hash`);
    if (!Array.isArray(cycle.critiqueFindings)) throw new Error(`functional building iteration: cycle ${cycle.cycle} critique must be an array`);
    for (const finding of cycle.critiqueFindings) { requiredText(finding.facet, "critique facet"); requiredText(finding.finding, "critique finding"); if (!viewIds.has(finding.evidenceView)) throw new Error("functional building iteration: critique references unknown engine view"); }
    requiredText(cycle.decision?.outcome, `cycle ${cycle.cycle} decision`); requiredText(cycle.decision?.reason, `cycle ${cycle.cycle} decision reason`);
    if (!STATES.has(cycle.status)) throw new Error(`functional building iteration: invalid cycle ${cycle.cycle} status`);
    cycles.set(cycle.cycle, cycle);
  }
  if (value.selectedCycle !== null && (!Number.isSafeInteger(value.selectedCycle) || !cycles.has(value.selectedCycle))) throw new Error("functional building iteration: selectedCycle does not resolve");
  if ((value.status === "engine-review" || value.status === "approved") && value.selectedCycle === null) throw new Error("functional building iteration: review/approval requires selectedCycle");
  return Object.freeze(value);
}

export function selectedFunctionalBuildingCycle(manifest) {
  const valid = validateFunctionalBuildingIteration(manifest);
  if (valid.selectedCycle === null) throw new Error("functional building iteration: no cycle is selected for engine review");
  const cycle = valid.cycles.find((entry) => entry.cycle === valid.selectedCycle);
  if (valid.status !== "engine-review" && valid.status !== "approved") throw new Error("functional building iteration: selected manifest is not authorized for engine review");
  return cycle;
}

export function verifyFunctionalBuildingReferenceSources(manifest, readBytes, rawSha256) {
  const valid = validateFunctionalBuildingIteration(manifest);
  for (const cue of valid.referenceCues) {
    if (cue.sourceArtifact === undefined) continue;
    if (rawSha256(readBytes(cue.sourceArtifact.path)) !== cue.sourceArtifact.sha256) throw new Error(`functional building iteration: reference source '${cue.id}' hash drifted`);
  }
  // Cycle artifacts are intentionally superseded in place as the production
  // asset advances. Historical cycles retain the hashes that explained their
  // decision, while only the selected cycle's live source paths can and must
  // close against current workspace bytes.
  const selected = valid.cycles.find((cycle) => cycle.cycle === valid.selectedCycle);
  for (const cycle of selected === undefined ? [] : [selected]) {
    for (const [name, source] of Object.entries(cycle.provenance ?? {})) {
      requiredText(source.path, `cycle ${cycle.cycle} provenance ${name} path`); requiredHash(source.sha256, `cycle ${cycle.cycle} provenance ${name} hash`);
      if (rawSha256(readBytes(source.path)) !== source.sha256) throw new Error(`functional building iteration: cycle ${cycle.cycle} provenance '${name}' hash drifted`);
    }
  }
  return valid;
}
