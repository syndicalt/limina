// limina VERSIONED PACKAGE REGISTRY + LOADER (Phase 4b / M9) — the layer that
// makes third-party skill/scene/agent packages distributable WITHOUT bypassing
// the engine's capability boundaries. It COMPOSES M6/M7/M8, it does not
// reimplement them:
//
//   install(manifest)        validate the Zod manifest, key it by name@version,
//                            hash its entry for provenance, audit the install.
//   resolve(name, range?)    pick the HIGHEST installed version satisfying a
//                            semver range (package-level versioning).
//   load(ref, ctx)           the governed load pipeline:
//     (a) resolve the installed package (honest not_found);
//     (b) SEMVER COMPAT CHECK — engineCompat vs the engine version; an
//         out-of-bounds version is REJECTED here, before anything else;
//     (c) M7 admitPackageLoad — DECLARED vs GRANTED capabilities + package
//         revocation; an OVER-CLAIM (or revoked package) is DENIED + audited and
//         the package does NOT load;
//     (d) for a skill/agent package, load its untrusted ENTRY into the M6
//         SandboxedSkillHost so it runs ISOLATED, every later capability crossing
//         going through the M7-checked SkillRegistry.invoke;
//     (e) emit the M8 `package.loaded` provenance event, linked (causedBy) to the
//         admit decision so audit.explain walks load -> decision -> provenance.
//   revoke(ref)              route to the M7 revokePackage path (a later load is denied).
//
// The grant defaults to the load profile's permission set (resolveProfile), so a
// package's declared capabilities are gated against the SAME permission strings
// the registry enforces at every runtime crossing.

import { ops } from "../engine.ts";
import type { SkillRegistry } from "../skills/registry.ts";
import type { SandboxBudgets, SandboxedSkillHost } from "../sandbox/host.ts";
import type { LiminaTracer } from "../observability/event.ts";
import type { PolicyDecision, PolicyEngine } from "../policy/engine.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { ENGINE_VERSION, packageRef, parseManifest, type PackageManifest } from "./manifest.ts";
import { compareVersions, satisfies } from "./semver.ts";

export interface InstalledPackage {
  ref: string;
  manifest: PackageManifest;
  /** sha256 of the entry source — the package's content-addressed provenance. */
  contentHash: string;
  installedAt: string;
}

export interface InstallResult {
  ok: boolean;
  ref?: string;
  error?: string;
}

export interface PackageLoadContext {
  /** Sandbox/agent identity the untrusted entry runs under (host-bound attribution). */
  agentId: string;
  sessionId: string;
  /** Permission profile the package runs under; its grant is the over-claim baseline. */
  profile: string;
  /** Override the granted capability set (defaults to the profile's permissions). */
  grantedCaps?: readonly string[];
  /** M6 sandbox budgets (cpu/mem/stack) for the loaded entry. */
  budgets?: SandboxBudgets;
  tick?: number;
}

export type LoadRejectReason =
  | "not_found"
  | "engine.incompat"
  | "package.overclaim"
  | "package.revoked"
  | "load.error";

export interface CompatCheck {
  ok: boolean;
  reason?: string;
}

export interface LoadResult {
  ok: boolean;
  ref: string;
  /** Sandbox agentId the untrusted entry was loaded under (skill/agent kinds). */
  agentId?: string;
  /** The M7 package-load decision (present once the compat check passed). */
  decision?: PolicyDecision;
  rejectReason?: LoadRejectReason;
  reason?: string;
  /** The `package.loaded` audit event id (M8 provenance), present on success. */
  loadEventId?: string;
}

export class PackageRegistry {
  private readonly installed = new Map<string, InstalledPackage>();

  constructor(
    private readonly registry: SkillRegistry,
    private readonly host: SandboxedSkillHost,
    private readonly tracer: LiminaTracer,
    private readonly engineVersion: string = ENGINE_VERSION,
    /** The M7 engine, used for package revocation; gating runs via the registry. */
    private readonly policy?: PolicyEngine,
  ) {}

  /** Validate + register a package. Idempotent per `name@version` (a re-install
   *  replaces the record). The entry is content-hashed for provenance. */
  install(rawManifest: unknown): InstallResult {
    const parsed = parseManifest(rawManifest);
    if (!parsed.ok || parsed.manifest === undefined) return { ok: false, error: parsed.error };
    const manifest = parsed.manifest;
    const ref = packageRef(manifest);
    const contentHash = "sha256:" + ops.op_sha256(manifest.entry);
    this.installed.set(ref, { ref, manifest, contentHash, installedAt: new Date().toISOString() });
    this.tracer.emit({
      type: "package.installed",
      actorId: manifest.name,
      threadId: ref,
      parentEventId: null,
      causedBy: [],
      payload: {
        package: ref,
        name: manifest.name,
        version: manifest.version,
        kind: manifest.kind,
        declaredCapabilities: manifest.declaredCapabilities,
        assetRefs: manifest.assetRefs,
        engineCompat: manifest.engineCompat,
        contentHash,
        attested: manifest.attestation !== undefined,
        signer: manifest.attestation?.signer ?? null,
      },
    });
    return { ok: true, ref };
  }

  list(): InstalledPackage[] {
    return [...this.installed.values()];
  }

  get(ref: string): InstalledPackage | undefined {
    return this.installed.get(ref);
  }

  /** Resolve a package by name and an optional semver range to the HIGHEST
   *  installed satisfying version. */
  resolve(name: string, range?: string): InstalledPackage | undefined {
    const candidates = this.list().filter((p) => p.manifest.name === name);
    const matching = range === undefined
      ? candidates
      : candidates.filter((p) => satisfies(p.manifest.version, range));
    if (matching.length === 0) return undefined;
    matching.sort((a, b) => compareVersions(b.manifest.version, a.manifest.version));
    return matching[0];
  }

  /** The engine-compat gate: whether the running engine satisfies the manifest's
   *  `engineCompat` range. The loader rejects a package that fails this. */
  checkCompat(manifest: PackageManifest): CompatCheck {
    if (satisfies(this.engineVersion, manifest.engineCompat)) return { ok: true };
    return {
      ok: false,
      reason: `package '${packageRef(manifest)}' requires engine '${manifest.engineCompat}' but engine is ${this.engineVersion}`,
    };
  }

  /** Revoke a package via the M7 engine; a subsequent load is denied (package.revoked). */
  revoke(ref: string): boolean {
    if (this.policy === undefined) return false;
    this.policy.revokePackage(ref);
    this.tracer.emit({
      type: "package.revoked",
      actorId: "engine",
      threadId: ref,
      parentEventId: null,
      causedBy: [],
      payload: { package: ref },
    });
    return true;
  }

  /** The governed load pipeline (see file header). Returns an honest result;
   *  `ok === false` means the package did NOT load (and, for skill/agent kinds,
   *  no sandbox context was created). */
  load(ref: string, ctx: PackageLoadContext): LoadResult {
    const installed = this.installed.get(ref);
    if (installed === undefined) {
      return { ok: false, ref, rejectReason: "not_found", reason: `package not installed: ${ref}` };
    }
    const manifest = installed.manifest;
    const grantedCaps = ctx.grantedCaps ?? [...resolveProfile(ctx.profile)];

    // (b) SEMVER COMPAT CHECK — out-of-bounds engine version is rejected here.
    const compat = this.checkCompat(manifest);
    if (!compat.ok) {
      this.tracer.emit({
        type: "package.load.rejected",
        actorId: ctx.agentId,
        threadId: ctx.sessionId,
        parentEventId: null,
        causedBy: [],
        payload: {
          package: ref,
          rejectReason: "engine.incompat",
          reason: compat.reason,
          engineCompat: manifest.engineCompat,
          engineVersion: this.engineVersion,
          tick: ctx.tick ?? null,
        },
      });
      return { ok: false, ref, rejectReason: "engine.incompat", reason: compat.reason };
    }

    // (c) M7 admitPackageLoad — declared-vs-granted over-claim + package revocation.
    //     This call AUDITS the decision (policy.decision / policy.denied with the
    //     package provenance) on the trace chain.
    const decision = this.registry.admitPackageLoad({
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      pkg: ref,
      declaredCaps: manifest.declaredCapabilities,
      grantedCaps,
      tick: ctx.tick,
    });
    if (!decision.allow) {
      return {
        ok: false,
        ref,
        decision,
        rejectReason: decision.rule === "package.revoked" ? "package.revoked" : "package.overclaim",
        reason: decision.reason,
      };
    }

    // (d) load the untrusted entry under M6 isolation (skill/agent kinds).
    if (manifest.kind === "skill" || manifest.kind === "agent") {
      try {
        this.host.create(
          { agentId: ctx.agentId, sessionId: ctx.sessionId, profile: ctx.profile, code: manifest.entry },
          ctx.budgets ?? {},
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.tracer.emit({
          type: "package.load.rejected",
          actorId: ctx.agentId,
          threadId: ctx.sessionId,
          parentEventId: null,
          causedBy: [],
          payload: { package: ref, rejectReason: "load.error", reason: message, tick: ctx.tick ?? null },
        });
        return { ok: false, ref, decision, rejectReason: "load.error", reason: message };
      }
    }

    // (e) M8 audit: package.loaded provenance, linked to the admit decision so
    //     audit.explain walks load -> governing decision -> provenance.
    const admitEventId = this.findAdmitEventId(ctx.agentId, ref);
    const loadEventId = this.tracer.emit({
      type: "package.loaded",
      actorId: ctx.agentId,
      threadId: ctx.sessionId,
      parentEventId: null,
      causedBy: admitEventId !== undefined ? [admitEventId] : [],
      payload: {
        package: ref,
        name: manifest.name,
        version: manifest.version,
        kind: manifest.kind,
        declaredCapabilities: manifest.declaredCapabilities,
        grantedCapabilities: [...grantedCaps],
        contentHash: installed.contentHash,
        attested: manifest.attestation !== undefined,
        signer: manifest.attestation?.signer ?? null,
        engineVersion: this.engineVersion,
        engineCompat: manifest.engineCompat,
        tick: ctx.tick ?? null,
      },
    });

    const sandboxed = manifest.kind === "skill" || manifest.kind === "agent";
    return { ok: true, ref, agentId: sandboxed ? ctx.agentId : undefined, decision, loadEventId };
  }

  /** The admit decision admitPackageLoad just emitted is the latest policy event
   *  on this agent's thread for this package — find its id to link provenance. */
  private findAdmitEventId(agentId: string, ref: string): string | undefined {
    const events = this.tracer.trace(agentId);
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.type !== "policy.decision" && ev.type !== "policy.denied") continue;
      const p = ev.payload;
      if (p !== null && typeof p === "object" && "package" in p && p.package === ref) return ev.id;
    }
    return undefined;
  }
}
