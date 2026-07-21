import { buildFb4CaptureProvenance } from "../../src/render/fb4-capture-provenance.ts";
import {
  deriveApprovedFunctionalBuildingPublication,
  loadApprovedFunctionalBuildingPublication,
} from "../../src/assets/functional-building-publication.mjs";
import { portableAssetContentHash } from "../../src/world/asset-content-hash.mjs";
import { sha256 } from "../../src/world/sha256.mjs";

type ExactFile = Readonly<{ path: string; sha256: string; contentHash: string; bytes: number }>;
export interface ApprovedFunctionalBuildingPublicationFixtureInput {
  readonly fixtureId: string;
  readonly buildingBytes: Uint8Array;
  readonly candidateId: string;
  readonly publicationId: string;
  readonly catalogId: string;
  readonly entryId: string;
  readonly familyId: string;
  readonly variantId: string;
}

/** Test-only complete central/HITL ledger around caller-supplied real functional package bytes. */
export function buildApprovedFunctionalBuildingPublicationFixture(
  input: ApprovedFunctionalBuildingPublicationFixtureInput,
) {
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(input.fixtureId))
    throw new TypeError("approved publication fixtureId is unsafe");
  const files = new Map<string, Uint8Array>(),
    encoder = new TextEncoder();
  const encode = (value: unknown) => encoder.encode(`${JSON.stringify(value)}\n`);
  const put = (name: string, value: unknown | Uint8Array): ExactFile => {
    const bytes = value instanceof Uint8Array ? value : encode(value),
      path = `fixtures/approved-publication/${input.fixtureId}/${name}`;
    files.set(path, bytes);
    return Object.freeze({
      path,
      sha256: `sha256:${sha256(bytes)}`,
      contentHash: portableAssetContentHash(bytes),
      bytes: bytes.byteLength,
    });
  };
  const short = (file: ExactFile) => ({ path: file.path, sha256: file.sha256, contentHash: file.contentHash });
  const read = (path: string): Uint8Array => {
    const bytes = files.get(path);
    if (bytes === undefined) throw new Error(`missing approved publication fixture '${path}'`);
    return bytes;
  };
  const glb = put("building.gltf", input.buildingBytes);
  const manifest = put("candidate-manifest.json", {
    schema: "limina.fb4-multi-room-production-candidate/v3",
    candidateId: input.candidateId,
    status: "cpu-verified-human-pending",
    visualApprovalClaimed: false,
    gpuCaptureAtBuild: false,
    placementSkill: "building.placeFunctional",
    files: [{ role: "lodGlb", ...glb }],
  });
  const environment = put("environment.json", { schema: "fixture.environment/v1" }),
    runtime = put("runtime.js", encoder.encode("export const runtime=true;\n")),
    binary = put("limina", new Uint8Array([1, 2, 3, 4]));
  const sources = [
      put("source-a.ts", new Uint8Array([1])),
      put("source-b.ts", new Uint8Array([2])),
      put("source-c.ts", new Uint8Array([3])),
    ],
    png = put("exterior.png", new Uint8Array([137, 80, 78, 71]));
  const reviewAuthority = put("review-authority.json", {
    candidate: { manifest: short(manifest), glb: short(glb), irHash: `sha256:${"1".repeat(64)}` },
    environment: { authority: short(environment), runtimeBundle: short(runtime) },
  });
  const capture = put("capture.json", {
    authority: short(reviewAuthority),
    candidate: { manifest: short(manifest) },
    outputs: [
      {
        id: "exterior",
        path: png.path,
        width: 1,
        height: 1,
        pngSha256: png.sha256,
        pngByteLength: png.bytes,
        rgbaContentHash: `sha256:${"2".repeat(64)}`,
      },
    ],
  });
  const provenance = put(
    "capture-provenance.json",
    buildFb4CaptureProvenance({
      captureEvidence: short(capture),
      trace: { sha256: `sha256:${"3".repeat(64)}`, byteLength: 1 },
      subject: {
        candidateId: input.candidateId,
        manifest: short(manifest),
        glb: { ...short(glb), bytes: glb.bytes },
        reviewAuthority: short(reviewAuthority),
        irHash: `sha256:${"1".repeat(64)}`,
      },
      environment: {
        authority: short(environment),
        runtimeBundle: short(runtime),
        shot: "fixture",
        context: "approved-runtime-proof",
      },
      execution: {
        binary: { ...short(binary), bytes: binary.bytes },
        orchestrator: { kind: "bun", version: "1.3.0", sha256: `sha256:${"4".repeat(64)}`, bytes: 1 },
        entrySources: sources.map((file) => file.path),
        sources,
        argv: ["limina", "fixture"],
        platform: { arch: "arm64", os: "linux" },
        timestampEnvironmentKeys: [],
      },
      gpuSafety: {
        bootId: "12345678-1234-1234-1234-123456789abc",
        timestampQueriesEnabled: false,
        xidObserved: false,
        preflightSource: "journalctl-kernel-current-boot",
        liveFollower: "journalctl-kernel-follow-current-boot",
        redundantPollMs: 250,
        postflightSource: "journalctl-kernel-current-boot",
      },
      outputs: [
        {
          id: "exterior",
          path: png.path,
          width: 1,
          height: 1,
          pngSha256: png.sha256,
          pngByteLength: png.bytes,
          rgbaContentHash: `sha256:${"2".repeat(64)}`,
        },
      ],
    }),
  );
  const central = put("central-review.json", {
    schema: "limina.fb4-central-visual-review/v1",
    status: "passed-to-hitl",
    candidateId: input.candidateId,
    captureEvidence: { path: capture.path, sha256: capture.sha256 },
    gpuSafety: { timestampQueriesEnabled: false, xidObserved: false },
    reviewBridgeStaged: false,
    visualFloor: { referenceSetId: "project-gorgon/house/v1", passed: true },
    findings: [],
    retainedProof: [],
  });
  const presentationBody = {
      schema: "limina.building-stage-artifact/v1",
      artifactId: `presentation/${input.fixtureId}/r1`,
      kind: "presentation-review",
      revision: 1,
      status: "candidate",
      contractHash: `sha256:${"5".repeat(64)}`,
      contentHash: `sha256:${"6".repeat(64)}`,
      facets: [{ scope: "evidence-contract", hash: `sha256:${"7".repeat(64)}` }],
      inputs: [],
      evidence: [
        {
          evidenceId: "exterior",
          kind: "engine-capture",
          contentHash: `sha256:${"2".repeat(64)}`,
          width: 1,
          height: 1,
        },
      ],
    },
    presentation = put("presentation.json", presentationBody);
  const decision = put("hitl-decision.json", {
    schema: "limina.building-hitl-decision/v2",
    decisionId: `decision/${input.fixtureId}/r1`,
    gate: "R1-release",
    artifactId: presentationBody.artifactId,
    contractHash: presentationBody.contractHash,
    contentHash: presentationBody.contentHash,
    reviewer: "owner",
    timestamp: "2026-07-17T12:00:00.000Z",
    decision: "approve",
    evidenceBindings: [{ evidenceId: "exterior", contentHash: `sha256:${"2".repeat(64)}` }],
    blockingFindings: [],
    observations: [],
    markedRegions: [],
  });
  const subject = {
    candidateId: input.candidateId,
    candidateManifest: short(manifest),
    reviewAuthority: short(reviewAuthority),
    captureEvidence: short(capture),
    captureProvenance: { ...short(provenance), coverage: "complete" },
  };
  const centralEntry = put("ledger-01-central.json", {
    schema: "limina.building-review-ledger-entry/v1",
    sequence: 1,
    entryId: `review/${input.fixtureId}/central-r1`,
    previous: null,
    subject,
    event: {
      kind: "central-visual-review",
      record: { ...short(central), schema: "limina.fb4-central-visual-review/v1" },
    },
  });
  const approvedEntry = put("ledger-02-approved.json", {
    schema: "limina.building-review-ledger-entry/v1",
    sequence: 2,
    entryId: `review/${input.fixtureId}/approved-r1`,
    previous: short(centralEntry),
    subject,
    event: {
      kind: "hitl-decision",
      presentationArtifact: short(presentation),
      record: { ...short(decision), schema: "limina.building-hitl-decision/v2" },
    },
  });
  const publication = deriveApprovedFunctionalBuildingPublication(
    {
      publicationId: input.publicationId,
      catalogId: input.catalogId,
      catalogRevision: 1,
      entryId: input.entryId,
      familyId: input.familyId,
      variantId: input.variantId,
      candidateManifest: manifest,
      approvedReviewOutcome: approvedEntry,
      reviewLedger: [centralEntry, approvedEntry].sort((left, right) => left.path.localeCompare(right.path)),
    },
    read,
  );
  const persistedBytes = encode(publication),
    reloaded = loadApprovedFunctionalBuildingPublication(persistedBytes, read);
  return Object.freeze({ publication, reloaded, persistedBytes, read, files });
}
