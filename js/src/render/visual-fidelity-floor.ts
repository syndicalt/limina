/**
 * Release-level visual fidelity contract.
 *
 * This is deliberately separate from pixel/readback correctness fixtures. A frame can prove that
 * water changed pixels or that a shader compiled and still be wholly unfit for visual review.
 * Only production-engine captures that satisfy every automated facet become eligible for human
 * comparison against the user-supplied reference set. Human approval is the final release gate.
 */

export const VISUAL_FIDELITY_FLOOR_SCHEMA = "limina.visual-fidelity-floor/v1" as const;
export const VISUAL_FIDELITY_REFERENCE_SET_ID = "project-gorgon-floor-20260711" as const;

export const VISUAL_FIDELITY_REFERENCES = Object.freeze([
  Object.freeze({ file: "adventures-through-project-gorgon-screenshots-from-my-v0-2mc6ecn2hssf1.webp", sha256: "22670bfc17aeaa77eace8b2fa13f3e1f9d84b5e79c07fec7f4ab9d7eb734fa9b" }),
  Object.freeze({ file: "adventures-through-project-gorgon-screenshots-from-my-v0-58d3pxwdgssf1.webp", sha256: "d4a063fee863f1748cd1999f094987cc01e79bad2542b065c8f2286e44fd708f" }),
  Object.freeze({ file: "adventures-through-project-gorgon-screenshots-from-my-v0-borr14hvfssf1.webp", sha256: "848eaef60ae7d04c128494c7b965f5038763240fabb52194c78b93fac47190a9" }),
  Object.freeze({ file: "adventures-through-project-gorgon-screenshots-from-my-v0-fdp0qaqzfssf1.webp", sha256: "3c3f0adedc464d2b591d61cb7f30df3d0cbe942506386c80876d6d8a44f0ccd4" }),
  Object.freeze({ file: "adventures-through-project-gorgon-screenshots-from-my-v0-jv0dra3mgssf1.webp", sha256: "68e1e004fbdb31784f6d0a5e33f913f7b818a1a1294aecb23d00479f86a800b1" }),
  Object.freeze({ file: "adventures-through-project-gorgon-screenshots-from-my-v0-oar1vbhvfssf1.webp", sha256: "a7f34f2d8762d25abc89a122dc5e406080d26e92b535e6812aad801f5c6a461d" }),
  Object.freeze({ file: "adventures-through-project-gorgon-screenshots-from-my-v0-sfhr4mpzfssf1.webp", sha256: "780806b319ba62d4e572dee94be984bbddf170cafd7fa712d524bf52d730168e" }),
  Object.freeze({ file: "adventures-through-project-gorgon-screenshots-from-my-v0-sxin2uwdgssf1.webp", sha256: "fe69540e40500b7e7921995f006003c439b5d76a4bd7844b9fa427b1dff9fc42" }),
  Object.freeze({ file: "adventures-through-project-gorgon-screenshots-from-my-v0-xdlyr2hvfssf1.webp", sha256: "c8e53c529b8006f03b2d5c6648701937c12f71a9c1192fa6842f52a788ae3f1f" }),
] as const);

export type VisualFidelityLane = "nature" | "built";
export type VisualFidelityFacet =
  | "pbrTerrain"
  | "terrainMacroDetail"
  | "waterDepthAndShore"
  | "vegetationDensityAndVariety"
  | "atmosphereAndSky"
  | "lightingAndShadows"
  | "authoredArchitecture"
  | "assetProvenance"
  | "visualRegression"
  | "lifecycle"
  | "targetHardwarePerformance";

const COMMON_REQUIRED_FACETS: readonly VisualFidelityFacet[] = Object.freeze([
  "pbrTerrain",
  "terrainMacroDetail",
  "waterDepthAndShore",
  "vegetationDensityAndVariety",
  "atmosphereAndSky",
  "lightingAndShadows",
  "assetProvenance",
  "visualRegression",
  "lifecycle",
  "targetHardwarePerformance",
]);

export const VISUAL_FIDELITY_REQUIRED_FACETS: Readonly<Record<VisualFidelityLane, readonly VisualFidelityFacet[]>> = Object.freeze({
  nature: COMMON_REQUIRED_FACETS,
  built: Object.freeze<VisualFidelityFacet[]>([...COMMON_REQUIRED_FACETS, "authoredArchitecture"]),
});

export interface VisualFidelityEvidence {
  readonly schema: typeof VISUAL_FIDELITY_FLOOR_SCHEMA;
  readonly referenceSetId: typeof VISUAL_FIDELITY_REFERENCE_SET_ID;
  readonly lane: VisualFidelityLane;
  /** Debug, fixture, shader-probe, and editor-diagnostic captures are never review candidates. */
  readonly captureClass: "production-engine" | "diagnostic" | "fixture";
  readonly nativeBackend: boolean;
  readonly fixedCameraRoute: boolean;
  readonly facets: Readonly<Partial<Record<VisualFidelityFacet, boolean>>>;
  readonly humanReview: Readonly<{ approved: boolean; reviewer?: string }>;
}

export interface VisualFidelityEvaluation {
  readonly eligibleForHumanReview: boolean;
  readonly releasePassed: boolean;
  readonly violations: readonly string[];
}

export function evaluateVisualFidelityEvidence(evidence: Readonly<VisualFidelityEvidence>): VisualFidelityEvaluation {
  const violations: string[] = [];
  if (evidence.schema !== VISUAL_FIDELITY_FLOOR_SCHEMA) violations.push("unsupported visual-fidelity schema");
  if (evidence.referenceSetId !== VISUAL_FIDELITY_REFERENCE_SET_ID) violations.push("wrong visual reference set");
  if (evidence.lane !== "nature" && evidence.lane !== "built") violations.push("unsupported visual-fidelity lane");
  if (evidence.captureClass !== "production-engine") violations.push("diagnostic and fixture captures are not visual-review candidates");
  if (!evidence.nativeBackend) violations.push("capture did not use the native production renderer");
  if (!evidence.fixedCameraRoute) violations.push("capture did not use the fixed acceptance camera route");
  const required = VISUAL_FIDELITY_REQUIRED_FACETS[evidence.lane] ?? [];
  for (const facet of required) if (evidence.facets[facet] !== true) violations.push(`visual facet '${facet}' is unproven`);
  const eligibleForHumanReview = violations.length === 0;
  const releasePassed = eligibleForHumanReview && evidence.humanReview.approved === true
    && typeof evidence.humanReview.reviewer === "string" && evidence.humanReview.reviewer.trim().length > 0;
  return Object.freeze({
    eligibleForHumanReview,
    releasePassed,
    violations: Object.freeze(releasePassed || !eligibleForHumanReview
      ? violations
      : [...violations, "human reference review is not approved"]),
  });
}
