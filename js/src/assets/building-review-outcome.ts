import {
  assertBuildingArtifactReviewable,
  validateBuildingHitlDecision,
  validateBuildingStageArtifact,
} from "./staged-building-pipeline.mjs";
import { validateFb4CaptureProvenance } from "../render/fb4-capture-provenance.ts";
import { portableAssetContentHash } from "../world/asset-content-hash.mjs";
import { sha256 } from "../world/sha256.mjs";

type Hash = `sha256:${string}`;
export type BuildingReviewDecision = "approved" | "rejected" | "rejected-before-hitl" | "central-pass";

export interface ExactBuildingReviewFile {
  readonly path: string;
  readonly sha256: Hash;
  readonly contentHash: Hash;
}

type ReviewEvent = Readonly<
  | {
      readonly kind: "central-visual-review";
      readonly record: ExactBuildingReviewFile & { readonly schema: "limina.fb4-central-visual-review/v1" };
    }
  | {
      readonly kind: "hitl-decision";
      readonly presentationArtifact: ExactBuildingReviewFile;
      readonly record: ExactBuildingReviewFile & { readonly schema: "limina.building-hitl-decision/v2" };
    }
>;

export interface BuildingReviewOutcome {
  readonly schema: "limina.building-review-ledger-entry/v1";
  readonly sequence: number;
  readonly entryId: string;
  readonly previous: ExactBuildingReviewFile | null;
  readonly subject: {
    readonly candidateId: string;
    readonly candidateManifest: ExactBuildingReviewFile;
    readonly reviewAuthority: ExactBuildingReviewFile;
    readonly captureEvidence: ExactBuildingReviewFile;
    readonly captureProvenance: (ExactBuildingReviewFile & { readonly coverage: "complete" }) | null;
  };
  readonly event: ReviewEvent;
}

export interface BuildingReviewLedgerRecord {
  readonly path: string;
  readonly bytes: Uint8Array;
}
export interface VerifiedBuildingReviewEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly entry: BuildingReviewOutcome;
  readonly decision: BuildingReviewDecision;
}
export interface ResolvedBuildingReviewState {
  readonly candidateId: string;
  readonly buildStatus: string;
  readonly reviewStatus: "legacy-untracked" | BuildingReviewDecision;
  readonly hitlEligible: boolean;
  readonly outcome?: BuildingReviewOutcome;
}

const HASH = /^sha256:[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9._/-]{2,180}$/;
const raw = (bytes: Uint8Array): Hash => `sha256:${sha256(bytes)}`;
const decode = (bytes: Uint8Array, label: string): any => {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8 JSON`, { cause: error });
  }
};
const exactKeys = (value: unknown, keys: readonly string[], label: string): void => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const actual = Object.keys(value);
  if (actual.some((key) => !keys.includes(key)) || keys.some((key) => !actual.includes(key)))
    throw new Error(`${label} keys drifted`);
};
const exactFile: (
  value: unknown,
  label: string,
  extras?: readonly string[],
) => asserts value is ExactBuildingReviewFile = (value, label, extras = []) => {
  exactKeys(value, ["path", "sha256", "contentHash", ...extras], label);
  const file = value as ExactBuildingReviewFile;
  if (
    !file.path ||
    file.path.startsWith("/") ||
    file.path.includes("\\") ||
    file.path.split("/").includes("..") ||
    !HASH.test(file.sha256) ||
    !HASH.test(file.contentHash)
  )
    throw new Error(`${label} is not an exact workspace file`);
};

export function validateBuildingReviewOutcome(input: unknown): BuildingReviewOutcome {
  exactKeys(input, ["schema", "sequence", "entryId", "previous", "subject", "event"], "building review ledger entry");
  const value = input as BuildingReviewOutcome;
  if (
    value.schema !== "limina.building-review-ledger-entry/v1" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    !ID.test(value.entryId)
  )
    throw new Error("building review ledger identity is invalid");
  if (value.previous !== null) exactFile(value.previous, "previous");
  exactKeys(
    value.subject,
    ["candidateId", "candidateManifest", "reviewAuthority", "captureEvidence", "captureProvenance"],
    "subject",
  );
  if (!ID.test(value.subject.candidateId)) throw new Error("building review candidate id is invalid");
  exactFile(value.subject.candidateManifest, "subject.candidateManifest");
  exactFile(value.subject.reviewAuthority, "subject.reviewAuthority");
  exactFile(value.subject.captureEvidence, "subject.captureEvidence");
  if (value.subject.captureProvenance !== null) {
    exactFile(value.subject.captureProvenance, "subject.captureProvenance", ["coverage"]);
    if (value.subject.captureProvenance.coverage !== "complete")
      throw new Error("capture provenance coverage must be complete");
  }
  if (value.event?.kind === "central-visual-review") {
    exactKeys(value.event, ["kind", "record"], "event");
    exactFile(value.event.record, "event.record", ["schema"]);
    if (value.event.record.schema !== "limina.fb4-central-visual-review/v1")
      throw new Error("central review event schema is invalid");
  } else if (value.event?.kind === "hitl-decision") {
    exactKeys(value.event, ["kind", "presentationArtifact", "record"], "event");
    exactFile(value.event.presentationArtifact, "event.presentationArtifact");
    exactFile(value.event.record, "event.record", ["schema"]);
    if (value.event.record.schema !== "limina.building-hitl-decision/v2")
      throw new Error("HITL event must reuse the exact v2 building decision schema");
  } else throw new Error("building review event kind is unsupported");
  return Object.freeze(value);
}

function exactBytes(file: ExactBuildingReviewFile, read: (path: string) => Uint8Array, label: string): Uint8Array {
  const bytes = read(file.path);
  if (raw(bytes) !== file.sha256 || portableAssetContentHash(bytes) !== file.contentHash)
    throw new Error(`${label} exact bytes drifted`);
  return bytes;
}

function verifyCentralReview(value: any, entry: BuildingReviewOutcome): BuildingReviewDecision {
  exactKeys(
    value,
    [
      "schema",
      "status",
      "candidateId",
      "captureEvidence",
      "gpuSafety",
      "reviewBridgeStaged",
      "visualFloor",
      "findings",
      "retainedProof",
    ],
    "central visual review",
  );
  if (
    value.schema !== "limina.fb4-central-visual-review/v1" ||
    value.candidateId !== entry.subject.candidateId ||
    value.captureEvidence?.path !== entry.subject.captureEvidence.path ||
    value.captureEvidence?.sha256 !== entry.subject.captureEvidence.sha256
  )
    throw new Error("central review does not bind the ledger subject and capture");
  if (
    value.gpuSafety?.timestampQueriesEnabled !== false ||
    value.gpuSafety?.xidObserved !== false ||
    value.reviewBridgeStaged !== false
  )
    throw new Error("central review lost its private timestamp-disabled safety boundary");
  if (value.visualFloor?.referenceSetId !== "project-gorgon/house/v1" || typeof value.visualFloor?.passed !== "boolean")
    throw new Error("central review visual-floor authority is invalid");
  if (!Array.isArray(value.findings) || !Array.isArray(value.retainedProof))
    throw new Error("central review findings are incomplete");
  if (value.status === "rejected-before-hitl" && value.visualFloor.passed === false && value.findings.length > 0)
    return "rejected-before-hitl";
  if (
    value.status === "passed-to-hitl" &&
    value.visualFloor.passed === true &&
    value.findings.every((finding: any) => finding?.severity !== "blocking")
  )
    return "central-pass";
  throw new Error("central review status is inconsistent with its visual-floor findings");
}

function verifyEntry(entry: BuildingReviewOutcome, read: (path: string) => Uint8Array): BuildingReviewDecision {
  const manifest = decode(
    exactBytes(entry.subject.candidateManifest, read, "candidate manifest"),
    "candidate manifest",
  );
  const authority = decode(exactBytes(entry.subject.reviewAuthority, read, "review authority"), "review authority");
  const capture = decode(exactBytes(entry.subject.captureEvidence, read, "capture evidence"), "capture evidence");
  if (manifest.candidateId !== entry.subject.candidateId)
    throw new Error("review ledger candidate id drifted from its manifest");
  if (
    authority.candidate?.manifest?.path !== entry.subject.candidateManifest.path ||
    authority.candidate?.manifest?.sha256 !== entry.subject.candidateManifest.sha256
  )
    throw new Error("review authority does not bind the ledger candidate manifest");
  if (
    capture.authority?.path !== entry.subject.reviewAuthority.path ||
    capture.authority?.sha256 !== entry.subject.reviewAuthority.sha256 ||
    capture.candidate?.manifest?.path !== entry.subject.candidateManifest.path ||
    capture.candidate?.manifest?.sha256 !== entry.subject.candidateManifest.sha256
  )
    throw new Error("capture evidence does not bind the ledger authority and candidate");
  if (entry.subject.captureProvenance !== null) {
    const provenance = validateFb4CaptureProvenance(
      decode(exactBytes(entry.subject.captureProvenance, read, "capture provenance"), "capture provenance"),
    );
    const same = (
      a: ExactBuildingReviewFile,
      b: { readonly path: string; readonly sha256: Hash; readonly contentHash?: Hash },
    ) => a.path === b.path && a.sha256 === b.sha256 && (b.contentHash === undefined || a.contentHash === b.contentHash);
    const verifyProvenanceFile = (file: ExactBuildingReviewFile & { readonly bytes?: number }, label: string) => {
      const bytes = read(file.path);
      if (
        raw(bytes) !== file.sha256 ||
        portableAssetContentHash(bytes) !== file.contentHash ||
        (file.bytes !== undefined && bytes.byteLength !== file.bytes)
      )
        throw new Error(`capture provenance ${label} exact bytes drifted`);
    };
    if (
      !same(provenance.captureEvidence, entry.subject.captureEvidence) ||
      provenance.subject.candidateId !== entry.subject.candidateId ||
      !same(provenance.subject.manifest, entry.subject.candidateManifest) ||
      !same(provenance.subject.reviewAuthority, entry.subject.reviewAuthority) ||
      provenance.subject.irHash !== authority.candidate?.irHash ||
      !same(provenance.subject.glb, authority.candidate?.glb) ||
      !same(provenance.environment.authority, authority.environment?.authority) ||
      !same(provenance.environment.runtimeBundle, authority.environment?.runtimeBundle)
    )
      throw new Error("capture provenance does not completely bind the ledger subject, authority, and environment");
    for (const [file, label] of [
      [provenance.subject.glb, "subject GLB"],
      [provenance.environment.authority, "environment authority"],
      [provenance.environment.runtimeBundle, "runtime bundle"],
    ] as const)
      verifyProvenanceFile(file, label);
    const capturedOutputs = new Map((capture.outputs ?? []).map((output: any) => [output.id, output]));
    if (capturedOutputs.size !== provenance.outputs.length)
      throw new Error("capture provenance output set drifted from capture evidence");
    for (const output of provenance.outputs) {
      const captured: any = capturedOutputs.get(output.id);
      if (
        !captured ||
        captured.path !== output.path ||
        captured.width !== output.width ||
        captured.height !== output.height ||
        captured.pngSha256 !== output.pngSha256 ||
        captured.pngByteLength !== output.pngByteLength ||
        captured.rgbaContentHash !== output.rgbaContentHash
      )
        throw new Error(`capture provenance output drifted: ${output.id}`);
      const bytes = read(output.path);
      if (bytes.byteLength !== output.pngByteLength || raw(bytes) !== output.pngSha256)
        throw new Error(`capture provenance PNG bytes drifted: ${output.id}`);
    }
  }
  if (entry.event.kind === "central-visual-review")
    return verifyCentralReview(decode(exactBytes(entry.event.record, read, "central review"), "central review"), entry);
  const artifact = validateBuildingStageArtifact(
    decode(exactBytes(entry.event.presentationArtifact, read, "presentation artifact"), "presentation artifact"),
  );
  const decision = validateBuildingHitlDecision(
    decode(exactBytes(entry.event.record, read, "HITL decision"), "HITL decision"),
  );
  assertBuildingArtifactReviewable(artifact, decision, [artifact]);
  if (entry.subject.captureProvenance === null) throw new Error("legacy-unbound capture cannot enter HITL");
  return decision.decision === "approve" ? "approved" : "rejected";
}

export function verifyBuildingReviewOutcomeClosure(
  input: unknown,
  read: (path: string) => Uint8Array,
): BuildingReviewOutcome {
  const entry = validateBuildingReviewOutcome(input);
  if (entry.sequence !== 1 || entry.previous !== null)
    throw new Error("standalone review closure must be the first ledger entry");
  verifyEntry(entry, read);
  return entry;
}

export function verifyBuildingReviewLedger(
  records: readonly BuildingReviewLedgerRecord[],
  read: (path: string) => Uint8Array,
): readonly VerifiedBuildingReviewEntry[] {
  const parsed = records.map((record) => ({
      record,
      entry: validateBuildingReviewOutcome(decode(record.bytes, `review ledger ${record.path}`)),
    })),
    groups = new Map<string, typeof parsed>();
  for (const item of parsed) {
    const group = groups.get(item.entry.subject.candidateId) ?? [];
    group.push(item);
    groups.set(item.entry.subject.candidateId, group);
  }
  const verified: VerifiedBuildingReviewEntry[] = [];
  for (const candidateId of [...groups.keys()].sort()) {
    const ordered = groups
      .get(candidateId)!
      .sort((a, b) => a.entry.sequence - b.entry.sequence || a.record.path.localeCompare(b.record.path));
    let previous: VerifiedBuildingReviewEntry | undefined;
    for (let index = 0; index < ordered.length; index++) {
      const { record, entry } = ordered[index];
      if (entry.sequence !== index + 1)
        throw new Error(`review ledger '${candidateId}' sequence must be contiguous and one-based`);
      if (
        previous === undefined
          ? entry.previous !== null
          : entry.previous?.path !== previous.path ||
            entry.previous?.sha256 !== raw(previous.bytes) ||
            entry.previous?.contentHash !== portableAssetContentHash(previous.bytes)
      )
        throw new Error(`review ledger '${candidateId}' previous-entry chain drifted`);
      const decision = verifyEntry(entry, read);
      if (decision === "central-pass" && entry.subject.captureProvenance === null)
        throw new Error("central pass requires complete capture provenance");
      if (entry.event.kind === "hitl-decision" && previous?.decision !== "central-pass")
        throw new Error("HITL decision requires the immediately preceding central pass");
      previous = Object.freeze({ path: record.path, bytes: record.bytes, entry, decision });
      verified.push(previous);
    }
  }
  return Object.freeze(verified);
}

export function resolveBuildingReviewState(
  manifest: Readonly<{ candidateId: string; status: string }>,
  verified: readonly VerifiedBuildingReviewEntry[],
): ResolvedBuildingReviewState {
  if (!manifest.candidateId || !manifest.status)
    throw new Error("candidate discovery requires an identified build manifest");
  const matching = verified.filter((record) => record.entry.subject.candidateId === manifest.candidateId),
    latest = matching.at(-1);
  return Object.freeze({
    candidateId: manifest.candidateId,
    buildStatus: manifest.status,
    reviewStatus: latest?.decision ?? "legacy-untracked",
    hitlEligible:
      latest?.decision === "central-pass" && latest.entry.subject.captureProvenance?.coverage === "complete",
    ...(latest ? { outcome: latest.entry } : {}),
  });
}
