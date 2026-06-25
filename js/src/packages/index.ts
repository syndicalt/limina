// limina PACKAGE SKILLS (Phase 4b / M9) — the `package.*` capabilities that
// expose the versioned registry/loader through the same SkillRegistry surface
// every other capability uses. `registerPackageSkills` binds them to a concrete
// PackageRegistry; registerCoreSkills wires a default instance so the skills
// exist out of the box, and a runtime/test can rebind to its own (policy-attached)
// PackageRegistry by calling registerPackageSkills again (register replaces by name).

import { z } from "../../build/zod.bundle.mjs";
import type { SkillRegistry } from "../skills/registry.ts";
import { PackageRegistry } from "./registry.ts";

export { PackageRegistry } from "./registry.ts";
export type { InstalledPackage, LoadResult, PackageLoadContext, LoadRejectReason, CompatCheck } from "./registry.ts";
export { ENGINE_VERSION, manifestSchema, parseManifest, packageRef, PACKAGE_KINDS } from "./manifest.ts";
export type { PackageManifest, PackageKind } from "./manifest.ts";
export { satisfies, parseSemver, compareSemver, compareVersions, isSemver } from "./semver.ts";

export function registerPackageSkills(registry: SkillRegistry, packages: PackageRegistry): void {
  registry.register({
    name: "package.list",
    version: "1.0.0",
    description: "List installed packages with their manifest provenance: ref (name@version), kind, declared capabilities, engine-compat range, content hash, and whether the package is attested.",
    category: "system",
    permissions: [],
    input: z.object({ name: z.string().optional() }),
    output: z.object({
      packages: z.array(z.object({
        ref: z.string(),
        name: z.string(),
        version: z.string(),
        kind: z.string(),
        declaredCapabilities: z.array(z.string()),
        engineCompat: z.string(),
        contentHash: z.string(),
        attested: z.boolean(),
      })),
    }),
    handler: (input) => {
      const pkgs = packages.list().filter((p) => input.name === undefined || p.manifest.name === input.name);
      return {
        packages: pkgs.map((p) => ({
          ref: p.ref,
          name: p.manifest.name,
          version: p.manifest.version,
          kind: p.manifest.kind,
          declaredCapabilities: p.manifest.declaredCapabilities,
          engineCompat: p.manifest.engineCompat,
          contentHash: p.contentHash,
          attested: p.manifest.attestation !== undefined,
        })),
      };
    },
  });

  registry.register({
    name: "package.load",
    version: "1.0.0",
    description: "Load an installed package (by name@version ref) under a profile: validates the manifest, checks engine-compat (out-of-bounds rejected), gates declared-vs-granted capabilities via the policy engine (over-claim denied), and loads the untrusted entry into the M6 sandbox. Returns the load decision + provenance event id.",
    category: "system",
    permissions: ["agent.write"],
    input: z.object({
      ref: z.string(),
      agentId: z.string(),
      sessionId: z.string(),
      profile: z.string(),
    }),
    output: z.object({
      ok: z.boolean(),
      ref: z.string(),
      agentId: z.string().nullable(),
      rule: z.string().nullable(),
      rejectReason: z.string().nullable(),
      reason: z.string().nullable(),
      loadEventId: z.string().nullable(),
    }),
    handler: (input, ctx) => {
      const res = packages.load(input.ref, {
        agentId: input.agentId,
        sessionId: input.sessionId,
        profile: input.profile,
        tick: ctx.tick,
      });
      return {
        ok: res.ok,
        ref: res.ref,
        agentId: res.agentId ?? null,
        rule: res.decision?.rule ?? null,
        rejectReason: res.rejectReason ?? null,
        reason: res.reason ?? null,
        loadEventId: res.loadEventId ?? null,
      };
    },
  });
}
