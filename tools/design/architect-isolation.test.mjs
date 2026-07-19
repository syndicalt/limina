import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  ARCHITECT_REVIEW_SCHEMA,
  createArchitectStage,
  importReviewedArchitectArtifact,
  runIsolatedExecutionFromSource,
} from "./architect-isolation.mjs";

const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function glbJson(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)).trim());
}

function reviewFor(result, targetAssetId, overrides = {}) {
  return {
    schema: ARCHITECT_REVIEW_SCHEMA,
    decision: "approve",
    manifestSha256: result.sha256,
    artifactSha256: result.manifest.artifact.sha256,
    targetAssetId,
    reviewer: "architect-isolation-test",
    ...overrides,
  };
}

test("staging refuses a symlinked authority root before creating external directories", () => {
  const project = mkdtempSync(join(tmpdir(), "limina-architect-stage-root-"));
  const outside = mkdtempSync(join(tmpdir(), "limina-architect-stage-outside-"));
  symlinkSync(outside, join(project, ".limina"));
  try {
    assert.throws(
      () => createArchitectStage(project, {
        requestId: "symlink-root", description: "safe prop", title: "Safe prop", category: "prop",
      }),
      (error) => error?.code === "UNSAFE_PATH",
    );
    assert.equal(existsSync(join(outside, "architect-staging")), false);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("untrusted Blender source is confined, networkless, credential-free, QC-bound, and review-gated", { timeout: 180_000 }, async () => {
  const project = mkdtempSync(join(tmpdir(), "limina-architect-isolation-"));
  mkdirSync(join(project, "assets"));
  const hostEscape = join(tmpdir(), `limina-architect-host-escape-${process.pid}`);
  rmSync(hostEscape, { force: true });
  const oldSecret = process.env.LIMINA_ARCHITECT_ESCAPE_SECRET;
  process.env.LIMINA_ARCHITECT_ESCAPE_SECRET = "must-not-cross-container-boundary";
  const source = String.raw`
import bpy, json, os, socket, sys

def write_attempt(path):
    try:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("escape")
        return "wrote"
    except Exception as error:
        return type(error).__name__

def connect_attempt():
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(1.0)
    try:
        return sock.connect_ex(("1.1.1.1", 53))
    finally:
        sock.close()

args = sys.argv[sys.argv.index("--") + 1:]
out = args[args.index("--out") + 1]
def oversized_output_attempt():
    try:
        with open(out, "wb") as handle:
            handle.truncate(129 * 1024 * 1024)
        return "wrote"
    except Exception as error:
        return type(error).__name__

probe = {
    "environment": dict(os.environ),
    "repoVisible": os.path.exists(${JSON.stringify(process.cwd())}),
    "homeVisible": os.path.exists(${JSON.stringify(process.env.HOME)}),
    "dockerSocketVisible": os.path.exists("/var/run/docker.sock"),
    "gpuVisible": any(os.path.exists(path) for path in ["/dev/nvidia0", "/dev/nvidiactl", "/dev/dri"]),
    "generationSecretVisible": os.path.exists("/run/secret/anthropic-key"),
    "networkResult": connect_attempt(),
    "rootWrite": write_attempt("/architect-escape"),
    "usrWrite": write_attempt("/usr/architect-escape"),
    "inputWrite": write_attempt("/input/architect-escape"),
    "declaredVolumeWrite": write_attempt("/var/lib/postgresql/data/architect-escape"),
    "hostEscapeWrite": write_attempt(${JSON.stringify(hostEscape)}),
    "oversizedOutputWrite": oversized_output_attempt(),
}
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.ops.mesh.primitive_cube_add(size=2.0, location=(0.0, 0.0, 1.0))
cube = bpy.context.active_object
cube["escapeProbe"] = json.dumps(probe, sort_keys=True)
material = bpy.data.materials.new("IsolatedProbeMaterial")
material.diffuse_color = (0.12, 0.38, 0.72, 1.0)
cube.data.materials.append(material)
bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_apply=True, export_extras=True)
`;

  try {
    const result = await runIsolatedExecutionFromSource({
      projectRoot: project,
      request: {
        requestId: "escape-probe-1",
        description: `malicious $(touch ${hostEscape}) --mount /:/host; ../../assets`,
        title: "Isolation escape probe",
        category: "prop",
      },
      source,
    });

    assert.equal(result.manifest.status, "awaiting-reviewed-import");
    assert.equal(statSync(dirname(result.path)).mode & 0o777, 0o700);
    assert.equal(statSync(result.path).mode & 0o777, 0o600);
    assert.equal(statSync(join(dirname(result.path), "output", "candidate.glb")).mode & 0o777, 0o600);
    assert.equal(result.manifest.isolation.executionNetwork, "none");
    assert.equal(result.manifest.isolation.repositoryMounted, false);
    assert.equal(result.manifest.isolation.homeMounted, false);
    assert.equal(result.manifest.isolation.dockerSocketMounted, false);
    assert.equal(result.manifest.isolation.gpuDevicesMounted, false);
    assert.equal(result.manifest.artifact.sha256, result.manifest.qc.report.sha256);
    assert.deepEqual(result.manifest.qc.canonical.dimensionsM.map((value) => Math.round(value)), [2, 2, 2]);

    const candidateBytes = readFileSync(join(result.path, "..", "output", "candidate.glb"));
    const embeddedProbe = glbJson(candidateBytes).nodes.find((node) => typeof node.extras?.escapeProbe === "string")?.extras.escapeProbe;
    const probe = JSON.parse(embeddedProbe);
    assert.equal(probe.repoVisible, false);
    assert.equal(probe.homeVisible, false);
    assert.equal(probe.dockerSocketVisible, false);
    assert.equal(probe.gpuVisible, false);
    assert.equal(probe.generationSecretVisible, false);
    assert.notEqual(probe.networkResult, 0);
    assert.notEqual(probe.rootWrite, "wrote");
    assert.notEqual(probe.usrWrite, "wrote");
    assert.notEqual(probe.inputWrite, "wrote");
    assert.notEqual(probe.declaredVolumeWrite, "wrote");
    assert.notEqual(probe.oversizedOutputWrite, "wrote");
    assert.equal(probe.environment.LIMINA_ARCHITECT_ESCAPE_SECRET, undefined);
    assert.deepEqual(Object.keys(probe.environment).sort(), ["BLENDER_USER_CONFIG", "HOME", "LANG", "PATH"]);
    assert.equal(existsSync(hostEscape), false);

    const reviewPath = join(project, "review.json");
    writeFileSync(reviewPath, JSON.stringify(reviewFor(result, "isolation-probe.glb")) + "\n", { mode: 0o600 });
    const imported = importReviewedArchitectArtifact({ projectRoot: project, manifestPath: result.path, reviewPath });
    assert.equal(digest(readFileSync(imported.path)), result.manifest.artifact.sha256);
    assert.equal(JSON.parse(readFileSync(imported.provenancePath, "utf8")).reviewer, "architect-isolation-test");
    assert.throws(
      () => importReviewedArchitectArtifact({ projectRoot: project, manifestPath: result.path, reviewPath }),
      (error) => error?.code === "DESTINATION_EXISTS",
    );

    writeFileSync(reviewPath, JSON.stringify(reviewFor(result, "../escape.glb")) + "\n", { mode: 0o600 });
    assert.throws(
      () => importReviewedArchitectArtifact({ projectRoot: project, manifestPath: result.path, reviewPath }),
      (error) => error?.code === "INVALID_REVIEW",
    );

    const artifact = join(result.path, "..", "output", "candidate.glb");
    const originalArtifact = readFileSync(artifact);
    writeFileSync(artifact, Buffer.concat([originalArtifact, Buffer.from("drift")]));
    writeFileSync(reviewPath, JSON.stringify(reviewFor(result, "drift-probe.glb")) + "\n", { mode: 0o600 });
    assert.throws(
      () => importReviewedArchitectArtifact({ projectRoot: project, manifestPath: result.path, reviewPath }),
      (error) => error?.code === "ARTIFACT_DRIFT",
    );
    writeFileSync(artifact, originalArtifact);
    const replacement = join(result.path, "..", "output", "replacement.glb");
    writeFileSync(replacement, readFileSync(artifact));
    rmSync(artifact);
    symlinkSync(replacement, artifact);
    writeFileSync(reviewPath, JSON.stringify(reviewFor(result, "symlink-probe.glb")) + "\n", { mode: 0o600 });
    assert.throws(
      () => importReviewedArchitectArtifact({ projectRoot: project, manifestPath: result.path, reviewPath }),
      (error) => error?.code === "UNSAFE_PATH",
    );
  } finally {
    if (oldSecret === undefined) delete process.env.LIMINA_ARCHITECT_ESCAPE_SECRET;
    else process.env.LIMINA_ARCHITECT_ESCAPE_SECRET = oldSecret;
    rmSync(hostEscape, { force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
