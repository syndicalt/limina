// limina PACKAGE MANIFEST (Phase 4b / M9) — the distributable unit's declaration.
//
// A package = a MANIFEST + an untrusted ENTRY. The manifest names the package,
// its package-level semver VERSION, its KIND (skill | scene | agent), the
// CAPABILITIES it declares it needs (matched against the loader's grant by the M7
// admitPackageLoad over-claim gate), its ASSET REFS, and its ENGINE-COMPAT range
// (a semver range checked against the engine version — out-of-bounds is rejected
// at load). `entry` is the package's code/source: for a skill/agent package this
// is the untrusted decision code that runs in the M6 QuickJS sandbox (it must
// define a global `decide()`). An optional `attestation` records who signed the
// package (provenance surfaced to the M8 audit).
//
// This is the "Package manifest + attestation model" the ecosystem integrates
// against (the locked hard-to-reverse decision), so the shape is validated by Zod
// and changing it is a breaking ecosystem change.

import { z } from "../../build/zod.bundle.mjs";
import { isSemver } from "./semver.ts";

// The engine's package-compatibility version. No single engine semver was exposed
// before M9 (the world log carries LOG_VERSION=1, the wire carries a dated
// protocolVersion); packages need a SEMVER to bound against, so the platform
// (Phase 4) declares engine 1.0.0 here and the loader checks `engineCompat`
// ranges against it. Bumping this is how a breaking engine change invalidates
// packages whose compat range no longer admits the running engine.
export const ENGINE_VERSION = "1.0.0";

export const PACKAGE_KINDS = ["skill", "scene", "agent"] as const;
export type PackageKind = (typeof PACKAGE_KINDS)[number];

/** Optional signed attestation (provenance). Signature verification is a future
 *  hardening step; the presence + signer are recorded for the M8 audit today. */
export const attestationSchema = z.object({
  signer: z.string().min(1),
  signature: z.string().min(1),
  algorithm: z.string().default("ed25519"),
});

export const manifestSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, "package name must be a lowercase id-safe slug"),
  version: z.string().refine(isSemver, { message: "version must be a valid semver (x.y.z)" }),
  kind: z.enum(PACKAGE_KINDS),
  declaredCapabilities: z.array(z.string()).default([]),
  assetRefs: z.array(z.string()).default([]),
  /** A semver RANGE the running engine must satisfy (see ./semver.ts grammar). */
  engineCompat: z.string().min(1),
  /** The package's code/source. Untrusted for skill/agent kinds (runs in M6). */
  entry: z.string(),
  attestation: attestationSchema.optional(),
});

export type PackageManifest = z.infer<typeof manifestSchema>;

export interface ManifestParseResult {
  ok: boolean;
  manifest?: PackageManifest;
  error?: string;
}

export function parseManifest(raw: unknown): ManifestParseResult {
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  return { ok: true, manifest: parsed.data };
}

/** The canonical `name@version` identity used as the registry key + audit pkg id. */
export function packageRef(m: { name: string; version: string }): string {
  return `${m.name}@${m.version}`;
}
