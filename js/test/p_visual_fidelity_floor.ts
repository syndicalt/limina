import {
  VISUAL_FIDELITY_FLOOR_SCHEMA,
  VISUAL_FIDELITY_REFERENCES,
  VISUAL_FIDELITY_REFERENCE_SET_ID,
  VISUAL_FIDELITY_REQUIRED_FACETS,
  evaluateVisualFidelityEvidence,
  type VisualFidelityEvidence,
  type VisualFidelityFacet,
} from "../src/render/visual-fidelity-floor.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`p_visual_fidelity_floor FAIL: ${message}`);
}

const all = (facets: readonly VisualFidelityFacet[]): Partial<Record<VisualFidelityFacet, boolean>> =>
  Object.fromEntries(facets.map((facet) => [facet, true]));
const evidence = (overrides: Partial<VisualFidelityEvidence> = {}): VisualFidelityEvidence => ({
  schema: VISUAL_FIDELITY_FLOOR_SCHEMA,
  referenceSetId: VISUAL_FIDELITY_REFERENCE_SET_ID,
  lane: "nature",
  captureClass: "production-engine",
  nativeBackend: true,
  fixedCameraRoute: true,
  facets: all(VISUAL_FIDELITY_REQUIRED_FACETS.nature),
  humanReview: { approved: false },
  ...overrides,
});

assert(VISUAL_FIDELITY_REFERENCES.length === 9 && new Set(VISUAL_FIDELITY_REFERENCES.map((entry) => entry.sha256)).size === 9,
  "the supplied reference set is incomplete or duplicated");
assert(Object.isFrozen(VISUAL_FIDELITY_REFERENCES) && Object.isFrozen(VISUAL_FIDELITY_REQUIRED_FACETS.built),
  "the release floor is mutable");

const diagnostic = evaluateVisualFidelityEvidence(evidence({ captureClass: "diagnostic" }));
assert(!diagnostic.eligibleForHumanReview && diagnostic.violations.some((entry) => /diagnostic/.test(entry)),
  "a diagnostic capture became eligible for visual review");
const missingWater = evaluateVisualFidelityEvidence(evidence({ facets: { ...all(VISUAL_FIDELITY_REQUIRED_FACETS.nature), waterDepthAndShore: false } }));
assert(!missingWater.eligibleForHumanReview && missingWater.violations.some((entry) => /waterDepthAndShore/.test(entry)),
  "an unproven required facet passed");
const awaitingHuman = evaluateVisualFidelityEvidence(evidence());
assert(awaitingHuman.eligibleForHumanReview && !awaitingHuman.releasePassed && awaitingHuman.violations.some((entry) => /human/.test(entry)),
  "automated evidence bypassed final human reference review");
const released = evaluateVisualFidelityEvidence(evidence({ humanReview: { approved: true, reviewer: "owner" } }));
assert(released.releasePassed && released.violations.length === 0, "complete nature evidence did not pass");
const builtWithoutArchitecture = evaluateVisualFidelityEvidence(evidence({ lane: "built" }));
assert(!builtWithoutArchitecture.eligibleForHumanReview && builtWithoutArchitecture.violations.some((entry) => /authoredArchitecture/.test(entry)),
  "built-environment lane passed without authored architecture");

console.log("p_visual_fidelity_floor OK: diagnostics rejected, nine references locked, lane facets required, and human approval remains the final release gate");
