import { canonicalStringify } from "../authoring/canonical.ts";
import { sha256 } from "../world/sha256.mjs";

const HASH = /^sha256:[0-9a-f]{64}$/,
  ID = /^[a-z0-9][a-z0-9._/-]{0,159}$/;
const OWNERS = [
  "rulebook.articulation.secondary-silhouette-elements",
  "compiler.dormer.weather-layer",
  "compiler.entrance-canopy",
  "compiler.roof-penetration",
  "program.requirements.daylight",
] as const;
const VERIFICATION = ["compiler", "cpu-proxy-and-human"] as const;
export interface BuildingCueProfile {
  readonly schema: "limina.building-cue-profile/v1";
  readonly id: string;
  readonly visualDesignContractHash: string;
  readonly programPath: string;
  readonly mappings: readonly {
    readonly cueId: string;
    readonly owner: (typeof OWNERS)[number];
    readonly verification: (typeof VERIFICATION)[number];
  }[];
}
const object = (value: unknown, label: string): Record<string, unknown> => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error(`${label} must be a plain object`);
  return value as Record<string, unknown>;
};
const exact = (value: Record<string, unknown>, keys: readonly string[], label: string) => {
  if (Object.keys(value).sort().join("|") !== [...keys].sort().join("|"))
    throw new Error(`${label} fields are not exact`);
};
const id = (value: unknown, label: string) => {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(`${label} must be a stable id`);
  return value;
};
export function validateBuildingCueProfile(value: unknown, visualCueIds?: readonly string[]): BuildingCueProfile {
  const root = object(value, "building cue profile");
  exact(root, ["schema", "id", "visualDesignContractHash", "programPath", "mappings"], "building cue profile");
  if (root.schema !== "limina.building-cue-profile/v1") throw new Error("unsupported building cue profile");
  id(root.id, "profile id");
  if (typeof root.visualDesignContractHash !== "string" || !HASH.test(root.visualDesignContractHash))
    throw new Error("cue profile visual contract hash is invalid");
  if (
    typeof root.programPath !== "string" ||
    root.programPath.startsWith("/") ||
    root.programPath.split("/").includes("..") ||
    !root.programPath.endsWith(".json")
  )
    throw new Error("cue profile programPath must be repository-relative JSON");
  if (!Array.isArray(root.mappings) || root.mappings.length !== OWNERS.length)
    throw new Error("cue profile must close every V2 architecture cue exactly once");
  const cueIds = new Set<string>(),
    owners = new Set<string>();
  for (const [index, item] of root.mappings.entries()) {
    const mapping = object(item, `mappings[${index}]`);
    exact(mapping, ["cueId", "owner", "verification"], `mappings[${index}]`);
    const cue = id(mapping.cueId, `mappings[${index}].cueId`);
    if (cueIds.has(cue)) throw new Error("cue profile cue ids must be unique");
    cueIds.add(cue);
    if (!OWNERS.includes(mapping.owner as (typeof OWNERS)[number]) || owners.has(mapping.owner as string))
      throw new Error("cue profile owners must be exact and unique");
    owners.add(mapping.owner as string);
    if (!VERIFICATION.includes(mapping.verification as (typeof VERIFICATION)[number]))
      throw new Error("cue profile verification is unsupported");
  }
  if (visualCueIds && [...cueIds].sort().join("|") !== [...visualCueIds].sort().join("|"))
    throw new Error("cue profile does not exactly map the visual design cues");
  const serialized = canonicalStringify(root);
  if (/sourceUrl|localPath|referenceImage|pixel|imageBytes/.test(serialized))
    throw new Error("cue profile must remain source-neutral");
  return Object.freeze(root as unknown as BuildingCueProfile);
}
export function buildingCueProfileHash(value: unknown, visualCueIds?: readonly string[]): string {
  return `sha256:${sha256(canonicalStringify(validateBuildingCueProfile(value, visualCueIds)))}`;
}

/**
 * Additive V2 cue binding for production buildings. V1 is retained for replay,
 * while V2 binds the exact program bytes/hash and turns every visual cue into
 * a check against compiler/synthesis facts instead of an owner label alone.
 */
export const BUILDING_CUE_PROFILE_V2 = "limina.building-cue-profile/v2" as const;
const OWNERS_V2 = [
  "rulebook.massing.functional-cross-gable",
  "compiler.attached-bay.roof-wall-abutment",
  "compiler.attached-bay.foundation",
  "compiler.entrance-canopy.joinery",
  "compiler.roof-penetration",
  "program.requirements.daylight",
  "review.semantic-evidence",
] as const;
const VERIFICATION_V2 = ["compiler", "compiler-and-cpu", "cpu-and-human"] as const;
const OPERATORS_V2 = ["equals", "minimum"] as const;
type CueScalar = string | number | boolean;

export interface BuildingCueProfileV2 {
  readonly schema: typeof BUILDING_CUE_PROFILE_V2;
  readonly id: string;
  readonly visualDesign: { readonly path: string; readonly sha256: string; readonly contractHash: string };
  readonly program: { readonly path: string; readonly sha256: string; readonly programHash: string };
  readonly mappings: readonly {
    readonly cueId: string;
    readonly owner: (typeof OWNERS_V2)[number];
    readonly verification: (typeof VERIFICATION_V2)[number];
    readonly assertions: readonly {
      readonly fact: string;
      readonly operator: (typeof OPERATORS_V2)[number];
      readonly value: CueScalar;
    }[];
  }[];
}

function relativeJsonPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.startsWith("/") || value.split("/").includes("..") || !value.endsWith(".json"))
    throw new Error(`${label} must be a repository-relative JSON path`);
  return value;
}
function exactHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} must be a lowercase sha256`);
  return value;
}
function scalar(value: unknown, label: string): CueScalar {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
    throw new Error(`${label} must be scalar`);
  return value;
}

export function validateBuildingCueProfileV2(value: unknown, visualCueIds?: readonly string[]): BuildingCueProfileV2 {
  const root = object(value, "building cue profile v2");
  exact(root, ["schema", "id", "visualDesign", "program", "mappings"], "building cue profile v2");
  if (root.schema !== BUILDING_CUE_PROFILE_V2) throw new Error("unsupported building cue profile v2");
  id(root.id, "profile v2 id");
  const visual = object(root.visualDesign, "visualDesign");
  exact(visual, ["path", "sha256", "contractHash"], "visualDesign");
  relativeJsonPath(visual.path, "visualDesign.path");
  exactHash(visual.sha256, "visualDesign.sha256");
  exactHash(visual.contractHash, "visualDesign.contractHash");
  const program = object(root.program, "program");
  exact(program, ["path", "sha256", "programHash"], "program");
  relativeJsonPath(program.path, "program.path");
  exactHash(program.sha256, "program.sha256");
  exactHash(program.programHash, "program.programHash");
  if (!Array.isArray(root.mappings) || root.mappings.length !== OWNERS_V2.length)
    throw new Error("cue profile v2 must close every production architecture cue exactly once");
  const cueIds = new Set<string>(),
    owners = new Set<string>(),
    facts = new Set<string>();
  for (const [mappingIndex, item] of root.mappings.entries()) {
    const mapping = object(item, `mappings[${mappingIndex}]`);
    exact(mapping, ["cueId", "owner", "verification", "assertions"], `mappings[${mappingIndex}]`);
    const cue = id(mapping.cueId, `mappings[${mappingIndex}].cueId`);
    if (cueIds.has(cue)) throw new Error("cue profile v2 cue ids must be unique");
    cueIds.add(cue);
    if (!OWNERS_V2.includes(mapping.owner as (typeof OWNERS_V2)[number]) || owners.has(mapping.owner as string))
      throw new Error("cue profile v2 owners must be exact and unique");
    owners.add(mapping.owner as string);
    if (!VERIFICATION_V2.includes(mapping.verification as (typeof VERIFICATION_V2)[number]))
      throw new Error("cue profile v2 verification is unsupported");
    if (!Array.isArray(mapping.assertions) || mapping.assertions.length < 1 || mapping.assertions.length > 8)
      throw new Error("cue profile v2 mappings require bounded machine assertions");
    for (const [assertionIndex, item] of mapping.assertions.entries()) {
      const assertion = object(item, `mappings[${mappingIndex}].assertions[${assertionIndex}]`);
      exact(assertion, ["fact", "operator", "value"], `mappings[${mappingIndex}].assertions[${assertionIndex}]`);
      const fact = id(assertion.fact, `mappings[${mappingIndex}].assertions[${assertionIndex}].fact`);
      if (facts.has(fact)) throw new Error(`cue profile v2 fact '${fact}' is asserted more than once`);
      facts.add(fact);
      if (!OPERATORS_V2.includes(assertion.operator as (typeof OPERATORS_V2)[number]))
        throw new Error("cue profile v2 assertion operator is unsupported");
      const expected = scalar(assertion.value, `mappings[${mappingIndex}].assertions[${assertionIndex}].value`);
      if (assertion.operator === "minimum" && typeof expected !== "number")
        throw new Error("cue profile v2 minimum assertions require numeric values");
    }
  }
  if (visualCueIds && [...cueIds].sort().join("|") !== [...visualCueIds].sort().join("|"))
    throw new Error("cue profile v2 does not exactly map the visual design cues");
  return Object.freeze(root as unknown as BuildingCueProfileV2);
}

export function verifyBuildingCueProfileV2Facts(
  profileValue: unknown,
  factValues: Readonly<Record<string, CueScalar>>,
  visualCueIds?: readonly string[],
): BuildingCueProfileV2 {
  const profile = validateBuildingCueProfileV2(profileValue, visualCueIds);
  const expectedFacts = profile.mappings
    .flatMap((mapping) => mapping.assertions.map((assertion) => assertion.fact))
    .sort();
  const suppliedFacts = Object.keys(factValues).sort();
  if (expectedFacts.join("|") !== suppliedFacts.join("|"))
    throw new Error("cue profile v2 fact inventory is not exact");
  for (const mapping of profile.mappings)
    for (const assertion of mapping.assertions) {
      const actual = factValues[assertion.fact];
      if (typeof actual === "number" && !Number.isFinite(actual))
        throw new Error(`cue profile v2 fact '${assertion.fact}' is non-finite`);
      if (assertion.operator === "equals" && actual !== assertion.value)
        throw new Error(`cue profile v2 fact '${assertion.fact}' does not equal its authority`);
      if (
        assertion.operator === "minimum" &&
        (typeof actual !== "number" || typeof assertion.value !== "number" || actual < assertion.value)
      )
        throw new Error(`cue profile v2 fact '${assertion.fact}' falls below its authority`);
    }
  return profile;
}

export function buildingCueProfileV2Hash(value: unknown, visualCueIds?: readonly string[]): string {
  return `sha256:${sha256(canonicalStringify(validateBuildingCueProfileV2(value, visualCueIds)))}`;
}
