// First-class design artifacts carried on WorldContext and reconstructed by the
// normal SkillCommand replay path. The artifacts are siblings to ECS/physics state:
// they compile into a GDS-driven world, but are not stuffed inside the GDS.

import { z } from "../../build/zod.bundle.mjs";
import {
  GameDesignSpecSchema,
  validateGDS,
  type GameDesignSpec,
} from "../game/gds.ts";
import {
  DEFAULT_DESIGN_DIRECTION,
  DesignDirectionSchema,
  canonicalizeDesignDirection,
  validateDesignDirection,
  type DesignDirection,
} from "../game/design-direction.ts";

export const DESIGN_ARTIFACT_KINDS = [
  "gds",
  "artDirection",
  "worldBible",
  "cast",
  "storyboard",
] as const;

export type DesignArtifactKind = (typeof DESIGN_ARTIFACT_KINDS)[number];
export type StudioArtifact = Record<string, unknown>;
export type DesignArtifactValue = GameDesignSpec | DesignDirection | StudioArtifact;

export interface DesignArtifactStore {
  artifacts: Map<DesignArtifactKind, DesignArtifactValue>;
}

interface ArtifactSpec<T extends DesignArtifactValue = DesignArtifactValue> {
  schema?: z.ZodType<T>;
  defaultValue?: T;
  canonicalize(value: unknown): T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function plainObject(value: unknown, label: string): StudioArtifact {
  if (!isPlainObject(value)) throw new Error(`${label} must be a plain object`);
  return cloneJson(value);
}

function canonicalizeGds(value: unknown): GameDesignSpec {
  const validation = validateGDS(value);
  if (!validation.ok || validation.data === undefined) {
    const details = validation.issues.map((issue) => `${issue.path || "<root>"}: ${issue.message}`).join("; ");
    throw new Error(`gds validation failed${details.length > 0 ? `: ${details}` : ""}`);
  }
  return GameDesignSpecSchema.parse(cloneJson(validation.data));
}

function canonicalizeArtDirection(value: unknown): DesignDirection {
  const validation = validateDesignDirection(value);
  if (!validation.ok || validation.data === undefined) {
    const details = validation.issues.map((issue) => `${issue.path || "<root>"}: ${issue.message}`).join("; ");
    throw new Error(`artDirection validation failed${details.length > 0 ? `: ${details}` : ""}`);
  }
  return canonicalizeDesignDirection(validation.data);
}

export const DESIGN_ARTIFACT_REGISTRY: Record<DesignArtifactKind, ArtifactSpec> = {
  gds: {
    schema: GameDesignSpecSchema,
    canonicalize: canonicalizeGds,
  },
  artDirection: {
    schema: DesignDirectionSchema,
    defaultValue: DEFAULT_DESIGN_DIRECTION,
    canonicalize: canonicalizeArtDirection,
  },
  worldBible: {
    canonicalize: (value) => plainObject(value, "worldBible"),
  },
  cast: {
    canonicalize: (value) => plainObject(value, "cast"),
  },
  storyboard: {
    canonicalize: (value) => plainObject(value, "storyboard"),
  },
};

const DESIGN_ARTIFACT_SET = new Set<string>(DESIGN_ARTIFACT_KINDS);

export function parseDesignArtifactKind(value: string): DesignArtifactKind {
  if (!DESIGN_ARTIFACT_SET.has(value)) {
    throw new Error(`unknown design artifact "${value}" (expected one of ${DESIGN_ARTIFACT_KINDS.join(", ")})`);
  }
  return value as DesignArtifactKind;
}

export function createDesignArtifactStore(): DesignArtifactStore {
  return { artifacts: new Map() };
}

export function canonicalizeDesignArtifact(artifact: DesignArtifactKind, value: unknown): DesignArtifactValue {
  return DESIGN_ARTIFACT_REGISTRY[artifact].canonicalize(value);
}

export function defaultDesignArtifactValue(artifact: DesignArtifactKind): DesignArtifactValue | undefined {
  const value = DESIGN_ARTIFACT_REGISTRY[artifact].defaultValue;
  return value === undefined ? undefined : cloneJson(value);
}

export function cloneDesignArtifactValue<T extends DesignArtifactValue>(value: T): T {
  return cloneJson(value);
}

export function deepMergeDesignPatch(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) throw new Error("patch must be a plain object");
  if (!isPlainObject(base)) return cloneJson(patch);
  const out: Record<string, unknown> = cloneJson(base);
  for (const [key, patchValue] of Object.entries(patch)) {
    const currentValue = out[key];
    if (isPlainObject(currentValue) && isPlainObject(patchValue)) {
      out[key] = deepMergeDesignPatch(currentValue, patchValue);
    } else {
      out[key] = cloneJson(patchValue);
    }
  }
  return out;
}
