import { canonicalStringify } from "../authoring/canonical.ts";
import { sha256 } from "../world/sha256.mjs";

const HASH = /^sha256:[0-9a-f]{64}$/,
  ID = /^[a-z0-9][a-z0-9._/-]{0,159}$/;
export type VisualDesignSubjectKind = "building" | "building-subsystem" | "furniture" | "prop" | "material";
export interface VisualReferenceSource {
  readonly id: string;
  readonly sourceUrl: string;
  readonly creator: string;
  readonly license: string;
  readonly retrievedAt: string;
  readonly localPath: string;
  readonly sha256: string;
  readonly roles: readonly ("silhouette" | "construction" | "joinery" | "material" | "weathering" | "function")[];
}
export interface VisualCueConstraint {
  readonly id: string;
  readonly statement: string;
  readonly sourceIds: readonly string[];
  readonly measurements: readonly {
    name: string;
    unit: "m" | "deg" | "ratio" | "count" | "boolean";
    minimum?: number;
    target?: number;
    maximum?: number;
  }[];
  readonly verification: "compiler" | "blender" | "engine" | "human";
}
export interface VisualDesignContract {
  readonly schema: "limina.visual-design-contract/v1";
  readonly id: string;
  readonly subjectKind: VisualDesignSubjectKind;
  readonly intendedFunction: string;
  readonly prompt: string;
  readonly references: readonly VisualReferenceSource[];
  readonly cues: readonly VisualCueConstraint[];
  readonly avoid: readonly string[];
  readonly requiredViews: readonly string[];
  readonly status: "draft" | "candidate" | "approved";
  readonly approval?: { gate: "B0-brief" | "F1-asset"; decisionHash: string };
}
const record = (value: unknown, label: string): Record<string, unknown> => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error(`${label} must be an object`);
    return value as Record<string, unknown>;
  },
  text = (value: unknown, label: string) => {
    if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
    return value;
  },
  id = (value: unknown, label: string) => {
    text(value, label);
    if (!ID.test(value as string)) throw new Error(`${label} must be a stable lowercase id`);
    return value as string;
  };
export function validateVisualDesignContract(value: unknown): VisualDesignContract {
  const c = record(value, "visual design contract") as unknown as VisualDesignContract;
  if (c.schema !== "limina.visual-design-contract/v1") throw new Error("unsupported visual design contract");
  id(c.id, "visual design contract id");
  if (!["building", "building-subsystem", "furniture", "prop", "material"].includes(c.subjectKind))
    throw new Error("unsupported visual design subject");
  text(c.intendedFunction, "intendedFunction");
  text(c.prompt, "prompt");
  if (!Array.isArray(c.references) || c.references.length === 0)
    throw new Error("visual design contract requires pinned references");
  const sourceIds = new Set<string>();
  for (const [index, source] of c.references.entries()) {
    id(source.id, `references[${index}].id`);
    if (sourceIds.has(source.id)) throw new Error("visual reference ids must be unique");
    sourceIds.add(source.id);
    let url: URL;
    try {
      url = new URL(source.sourceUrl);
    } catch {
      throw new Error(`references[${index}].sourceUrl is invalid`);
    }
    if (url.protocol !== "https:") throw new Error("visual references require HTTPS provenance");
    text(source.creator, `references[${index}].creator`);
    text(source.license, `references[${index}].license`);
    if (!Number.isFinite(Date.parse(source.retrievedAt))) throw new Error("visual reference retrieval date is invalid");
    if (source.localPath.startsWith("/") || source.localPath.split("/").includes(".."))
      throw new Error("visual reference localPath must be repository-relative");
    if (!HASH.test(source.sha256)) throw new Error("visual reference sha256 is invalid");
    if (!Array.isArray(source.roles) || source.roles.length === 0) throw new Error("visual reference requires roles");
  }
  if (!Array.isArray(c.cues) || c.cues.length === 0) throw new Error("visual design contract requires measurable cues");
  const cueIds = new Set<string>();
  for (const [index, cue] of c.cues.entries()) {
    id(cue.id, `cues[${index}].id`);
    if (cueIds.has(cue.id)) throw new Error("visual cue ids must be unique");
    cueIds.add(cue.id);
    text(cue.statement, `cues[${index}].statement`);
    if (
      !Array.isArray(cue.sourceIds) ||
      cue.sourceIds.length === 0 ||
      cue.sourceIds.some((source: string) => !sourceIds.has(source))
    )
      throw new Error("visual cue must cite pinned references");
    if (!Array.isArray(cue.measurements) || cue.measurements.length === 0)
      throw new Error("visual cue must translate into measurements");
    for (const measurement of cue.measurements) {
      text(measurement.name, "measurement name");
      if (!["m", "deg", "ratio", "count", "boolean"].includes(measurement.unit))
        throw new Error("unsupported measurement unit");
      const values = [measurement.minimum, measurement.target, measurement.maximum].filter(
        (v) => v !== undefined,
      ) as number[];
      if (values.length === 0 || values.some((v) => !Number.isFinite(v)))
        throw new Error("measurement requires finite bounds or target");
      if (
        measurement.minimum !== undefined &&
        measurement.maximum !== undefined &&
        measurement.minimum > measurement.maximum
      )
        throw new Error("measurement bounds are inverted");
    }
    if (!["compiler", "blender", "engine", "human"].includes(cue.verification))
      throw new Error("unsupported cue verification route");
  }
  if (!Array.isArray(c.avoid) || c.avoid.length === 0 || c.avoid.some((v) => typeof v !== "string" || !v.trim()))
    throw new Error("visual design contract requires avoid cues");
  if (
    !Array.isArray(c.requiredViews) ||
    c.requiredViews.length < 3 ||
    new Set(c.requiredViews).size !== c.requiredViews.length
  )
    throw new Error("visual design contract requires unique multi-view evidence");
  if (!["draft", "candidate", "approved"].includes(c.status)) throw new Error("unsupported visual design status");
  if (c.status === "approved" && (!c.approval || !HASH.test(c.approval.decisionHash)))
    throw new Error("approved visual design requires exact HITL decision");
  if (c.status !== "approved" && c.approval !== undefined)
    throw new Error("unapproved visual design cannot carry approval");
  return Object.freeze(c);
}
export function visualDesignContractHash(value: unknown): string {
  return `sha256:${sha256(canonicalStringify(validateVisualDesignContract(value)))}`;
}
