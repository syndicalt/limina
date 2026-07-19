import { buildFb4CaptureProvenance, validateFb4CaptureProvenance } from "../src/render/fb4-capture-provenance.ts";

const H = `sha256:${"1".repeat(64)}` as const,
  exact = (path: string) => ({ path, sha256: H, contentHash: H });
const input = {
  captureEvidence: exact("assets/qc/internal/capture-evidence.json"),
  trace: { sha256: H, byteLength: 42 },
  subject: {
    candidateId: "functional-hall-house/fb4/test",
    manifest: exact("assets/candidate-manifest.json"),
    glb: { ...exact("assets/building.glb"), bytes: 100 },
    reviewAuthority: exact("assets/review-authority.json"),
    irHash: H,
  },
  environment: {
    authority: exact("art-direction/scene.json"),
    runtimeBundle: exact("assets/runtime/bundle.json"),
    shot: "river-leading-line",
    context: "approved-temperate-production",
  },
  execution: {
    binary: { ...exact("target/release/limina"), bytes: 100 },
    orchestrator: { kind: "bun" as const, version: "1.3.14", sha256: H, bytes: 100 },
    entrySources: ["a.ts", "b.ts", "c.mjs"],
    sources: [
      { ...exact("a.ts"), bytes: 1 },
      { ...exact("b.ts"), bytes: 1 },
      { ...exact("c.mjs"), bytes: 1 },
    ],
    argv: ["target/release/limina", "--window"],
    platform: { arch: "arm64", os: "linux" },
    timestampEnvironmentKeys: [] as const,
  },
  gpuSafety: {
    bootId: "11111111-1111-1111-1111-111111111111",
    timestampQueriesEnabled: false as const,
    xidObserved: false as const,
    preflightSource: "journalctl-kernel-current-boot" as const,
    liveFollower: "journalctl-kernel-follow-current-boot" as const,
    redundantPollMs: 250 as const,
    postflightSource: "journalctl-kernel-current-boot" as const,
  },
  outputs: [
    {
      id: "exterior",
      path: "assets/qc/internal/exterior.png",
      width: 1920,
      height: 1080,
      pngSha256: H,
      pngByteLength: 100,
      rgbaContentHash: H,
    },
  ],
};
const value = buildFb4CaptureProvenance(input);
validateFb4CaptureProvenance(value);
const fail = (mutation: any) => {
  let rejected = false;
  try {
    validateFb4CaptureProvenance(mutation);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("p_fb4_capture_provenance FAIL: mutation did not fail closed");
};
fail({ ...value, closureHash: H });
fail({ ...value, execution: { ...value.execution, timestampEnvironmentKeys: ["WGPU_TIMESTAMP_RISK_ACK"] } });
fail({ ...value, gpuSafety: { ...value.gpuSafety, xidObserved: true } });
fail({ ...value, execution: { ...value.execution, platform: { arch: "x64", os: "linux" } } });
console.log(
  "p_fb4_capture_provenance OK: ARM64 producer/source/binary/trace/output closure is exact and timestamp/Xid unsafe states fail closed",
);
