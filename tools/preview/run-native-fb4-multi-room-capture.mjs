import { createHash, randomUUID } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "../../js/node_modules/sharp/lib/index.js";
import { buildFb4CaptureProvenance } from "../../js/src/render/fb4-capture-provenance.ts";
import { validateReviewPixels } from "../../js/src/render/review-pixel-sanity.mjs";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";
import {
  archiveGuardedCaptureSources,
  runGuardedCaptureWithSourceClosure,
  verifyGuardedCaptureEvidence,
} from "./guarded-capture-publication.mjs";

export const FB4_CAPTURE = Object.freeze({
  binary: "target/release/limina",
  module: "js/src/demos/building_multi_room_review_window.ts",
  sourcePaths: Object.freeze([
    "js/src/render/building-multi-room-review-scene.ts",
    "js/src/demos/building_multi_room_review_window.ts",
    "js/src/render/review-pixel-sanity.mjs",
    "tools/preview/run-native-fb4-multi-room-capture.mjs",
  ]),
  authorityEnvironment: "LIMINA_FB4_MULTI_ROOM_REVIEW_AUTHORITY",
  traceEnvironment: "LIMINA_FB4_MULTI_ROOM_REVIEW_TRACE",
  traceDirectory: "traces",
  tracePrefix: "fb4-multi-room-native-capture",
  lock: "traces/fb4-multi-room-native-capture.lock",
  privateRoot: "assets/qc/internal/fb4-multi-room",
  reviewRoot: ".limina/review-artifacts",
  reviewBindHost: "127.0.0.1",
  viewIds: Object.freeze([
    "exterior-entry",
    "exterior-rear",
    "gable-elevation",
    "frame-entry-window-detail",
    "ground-rooms-passage",
    "stair-opening",
    "upper-room",
    "lod-25m",
  ]),
});
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const raw = (b) => `sha256:${createHash("sha256").update(b).digest("hex")}`,
  portable = (repo, path) => relative(repo, path).split(sep).join("/"),
  inside = (base, target) => {
    const r = relative(base, target);
    return r !== "" && r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r);
  };
const absent = async (path, label) => {
  try {
    await lstat(path);
    throw new Error(`append-only ${label} already exists: ${path}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
};
function pixels(rgba, width, height) {
  return validateReviewPixels(rgba, width, height, {
    label: "FB-4",
    policy: {
      minimumDynamicRange: 24,
      minimumStandardDeviation: 1.5,
      maximumBlackCrushFraction: 0.45,
      maximumWhiteClipFraction: 0.12,
    },
  });
}
function validateNativeArtifact(artifact, authority, doorPosePlan) {
  if (
    artifact.schema !== "limina.fb4-multi-room-native-review-set/v1" ||
    artifact.backend !== "native-webgpu" ||
    artifact.captureClass !== "production-engine" ||
    artifact.timingPolicy?.timestampQueriesEnabled !== false ||
    artifact.timingPolicy?.gpuTimestampMode !== "disabled" ||
    artifact.captures?.length !== authority.evidenceViews.length
  )
    throw new Error("FB-4 native trace identity drifted");
  if (
    JSON.stringify(artifact.functionalPlacement?.reviewDoorPosePlan) !== JSON.stringify(doorPosePlan) ||
    !Array.isArray(artifact.functionalPlacement?.semanticDoorIds) ||
    artifact.functionalPlacement.semanticDoorIds.length !== authority.topologyProof.expectedDoors
  )
    throw new Error("FB-4 native trace lost exact semantic door-pose authority");
  for (let i = 0; i < authority.evidenceViews.length; i++) {
    const expected = authority.evidenceViews[i],
      expectedPose = doorPosePlan[i],
      capture = artifact.captures[i];
    if (
      capture.id !== expected.id ||
      capture.role !== expected.role ||
      JSON.stringify(capture.camera) !== JSON.stringify(expected.camera) ||
      capture.width !== authority.presentation.minimumResolution[0] ||
      capture.height !== authority.presentation.minimumResolution[1] ||
      expectedPose?.reviewViewId !== expected.id ||
      JSON.stringify(capture.openDoorIds) !== JSON.stringify(expectedPose.openDoorIds)
    )
      throw new Error(`FB-4 native trace camera/role/door-pose/resolution drifted: ${expected.id}`);
  }
  const envelope = authority.siteReviewEnvelope,
    proof = artifact.site?.reviewEnvelope,
    cameras = proof?.cameraEvidence?.views;
  if (
    proof?.populationMaximumHorizontalReachM !== envelope.populationMaximumHorizontalReachM ||
    !Array.isArray(cameras) ||
    cameras.map(({ id }) => id).join(",") !== authority.evidenceViews.map(({ id }) => id).join(",")
  )
    throw new Error("FB-4 native trace lacks site-review envelope proof");
  const exterior = new Set(envelope.discretePopulationExclusion.exteriorViewIds),
    interior = new Set(envelope.cameraChecks.interiorViewIds),
    full = new Set(envelope.cameraChecks.fullSubjectViewIds);
  for (const camera of cameras) {
    if (
      camera.minimumTerrainClearanceM < envelope.cameraChecks.minimumTerrainClearanceM ||
      (exterior.has(camera.id) &&
        (camera.projectedAreaFraction < envelope.cameraChecks.minimumProjectedAreaFraction ||
          camera.projectedHeightFraction < envelope.cameraChecks.minimumProjectedHeightFraction)) ||
      (full.has(camera.id) &&
        (camera.fullSubjectFramed !== true ||
          camera.rawProjectedHeightFraction > envelope.cameraChecks.maximumFullSubjectHeightFraction)) ||
      (interior.has(camera.id) && camera.interiorContained !== true)
    )
      throw new Error(`FB-4 native trace site-review camera failed: ${camera.id}`);
  }
}
export async function runFb4Capture(options = {}) {
  const repo = resolve(options.repoRoot ?? root),
    authorityPath = options.authorityPath;
  if (!authorityPath) throw new Error("--authority is required");
  const authorityAbsolute = resolve(repo, authorityPath);
  if (!inside(repo, authorityAbsolute)) throw new Error("FB-4 authority escaped repository");
  const authorityBytes = await readFile(authorityAbsolute),
    retirementPath = resolve(dirname(authorityAbsolute), "retirement.json");
  try {
    const retirement = JSON.parse(await readFile(retirementPath, "utf8"));
    if (
      retirement?.authority?.path === portable(repo, authorityAbsolute) &&
      retirement.authority.sha256 === raw(authorityBytes) &&
      String(retirement.status).startsWith("retired-")
    )
      throw new Error(`FB-4 authority is retired and cannot launch GPU capture: ${portable(repo, retirementPath)}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const {
      validateMultiRoomReviewAuthority,
      assertMultiRoomReviewCaptureReady,
      verifyMultiRoomReviewV4Closure,
      resolveFb4V4ReviewDoorPosePlan,
    } = await import("../../js/src/render/building-multi-room-review-scene.ts"),
    authority = assertMultiRoomReviewCaptureReady(validateMultiRoomReviewAuthority(JSON.parse(authorityBytes))),
    readExact = (path) => new Uint8Array(readFileSync(resolve(repo, path)));
  verifyMultiRoomReviewV4Closure(authority, readExact);
  const doorPosePlan = resolveFb4V4ReviewDoorPosePlan(authority, readExact),
    manifestBytes = await readFile(resolve(repo, authority.candidate.manifest.path)),
    manifest = JSON.parse(manifestBytes);
  const out = resolve(repo, options.outDir ?? "");
  if (!inside(resolve(repo, FB4_CAPTURE.privateRoot), out))
    throw new Error("FB-4 private output must be a new child of the dedicated private root");
  await absent(out, "FB-4 output directory");
  const prefix = options.reviewPrefix;
  if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(prefix ?? "")) throw new Error("FB-4 review prefix is unsafe");
  if (options.fullscreen !== undefined && typeof options.fullscreen !== "boolean")
    throw new Error("FB-4 fullscreen option must be boolean");
  const traceRoot = resolve(repo, FB4_CAPTURE.traceDirectory),
    lockPath = resolve(repo, FB4_CAPTURE.lock);
  await mkdir(traceRoot, { recursive: true, mode: 0o700 });
  let lock;
  try {
    lock = await open(
      lockPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("guarded FB-4 capture lock already exists");
    throw error;
  }
  try {
    const traceName = `${FB4_CAPTURE.tracePrefix}-${randomUUID()}.json`,
      environment = {
        ...process.env,
        LIMINA_ASSET_ROOT: repo,
        [FB4_CAPTURE.authorityEnvironment]: portable(repo, authorityAbsolute),
        [FB4_CAPTURE.traceEnvironment]: traceName,
      };
    for (const key of Object.keys(environment)) if (/TIMESTAMP/i.test(key)) delete environment[key];
    const engineArgs = [
        "--window",
        ...(options.fullscreen ? ["--fullscreen"] : []),
        "--width",
        String(authority.presentation.minimumResolution[0]),
        "--height",
        String(authority.presentation.minimumResolution[1]),
        "--frames",
        "1",
        FB4_CAPTURE.module,
      ],
      captureSession = await runGuardedCaptureWithSourceClosure({
        repoRoot: repo,
        runnerUrl: import.meta.url,
        modulePath: FB4_CAPTURE.module,
        runtimeBinary: FB4_CAPTURE.binary,
        command: resolve(repo, FB4_CAPTURE.binary),
        args: engineArgs,
        cwd: repo,
        environment,
        failureLabel: "guarded FB-4 capture",
      }),
      bootId = captureSession.guardEvidence.bootId;
    const tracePath = resolve(traceRoot, traceName),
      traceBytes = await readFile(tracePath),
      artifact = JSON.parse(traceBytes.toString("utf8"));
    await unlink(tracePath);
    validateNativeArtifact(artifact, authority, doorPosePlan);
    await mkdir(dirname(out), { recursive: true, mode: 0o700 });
    await chmod(dirname(out), 0o700);
    const staging = `${out}.staging-${process.pid}`;
    await mkdir(staging, { recursive: false, mode: 0o700 });
    try {
      const publicationEvidence = await archiveGuardedCaptureSources({
          capture: captureSession,
          evidenceRoot: staging,
        }),
        outputs = [];
      for (const capture of artifact.captures) {
        const submission = capture.renderSubmission,
          resources = capture.rendererResources;
        if (
          submission?.scope !== "single-production-frame-all-passes" ||
          submission.drawCalls <= 1 ||
          submission.triangles <= 1 ||
          resources?.scope !== "renderer-live-after-production-frame"
        )
          throw new Error(`FB-4 ${capture.id} lacks whole-scene telemetry`);
        const rgba = Buffer.from(capture.rgbaBase64, "base64");
        if (portableAssetContentHash(rgba) !== capture.rgbaContentHash)
          throw new Error(`FB-4 ${capture.id} RGBA hash drifted`);
        const sanity = pixels(rgba, capture.width, capture.height),
          png = await sharp(rgba, { raw: { width: capture.width, height: capture.height, channels: 4 } })
            .png({ compressionLevel: 9, adaptiveFiltering: true })
            .toBuffer();
        if (!png.subarray(0, 8).equals(PNG)) throw new Error("FB-4 PNG encoding failed");
        const privatePath = resolve(staging, `${capture.id}.png`);
        await writeFile(privatePath, png, { flag: "wx", mode: 0o600 });
        outputs.push({
          id: capture.id,
          path: portable(repo, resolve(out, `${capture.id}.png`)),
          width: capture.width,
          height: capture.height,
          pngSha256: raw(png),
          pngByteLength: png.length,
          rgbaContentHash: capture.rgbaContentHash,
          pixelSanity: sanity,
        });
      }
      const evidence = {
          ...artifact,
          captures: artifact.captures.map(({ rgbaBase64, ...capture }) => capture),
          ...publicationEvidence,
          reviewBridge: {
            artifactDirectory: FB4_CAPTURE.reviewRoot,
            bindHost: FB4_CAPTURE.reviewBindHost,
            public: false,
            staged: false,
            candidatePrefix: prefix,
          },
          outputs,
        },
        evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`),
        evidencePath = portable(repo, resolve(out, "capture-evidence.json"));
      await verifyGuardedCaptureEvidence({ capture: captureSession, evidenceRoot: staging, evidence });
      await writeFile(resolve(staging, "capture-evidence.json"), evidenceBytes, { flag: "wx", mode: 0o600 });
      const exact = async (entry) => {
          const bytes = await readFile(resolve(repo, entry.path));
          return { ...entry, contentHash: portableAssetContentHash(bytes) };
        },
        provenance = buildFb4CaptureProvenance({
          captureEvidence: {
            path: evidencePath,
            sha256: raw(evidenceBytes),
            contentHash: portableAssetContentHash(evidenceBytes),
          },
          trace: { sha256: raw(traceBytes), byteLength: traceBytes.length },
          subject: {
            candidateId: manifest.candidateId,
            manifest: {
              path: authority.candidate.manifest.path,
              sha256: authority.candidate.manifest.sha256,
              contentHash: portableAssetContentHash(manifestBytes),
            },
            glb: authority.candidate.glb,
            reviewAuthority: {
              path: portable(repo, authorityAbsolute),
              sha256: raw(authorityBytes),
              contentHash: portableAssetContentHash(authorityBytes),
            },
            irHash: authority.candidate.irHash,
          },
          environment: {
            authority: await exact(authority.environment.authority),
            runtimeBundle: await exact(authority.environment.runtimeBundle),
            shot: authority.environment.shot,
            context: authority.environment.context,
          },
          execution: captureSession.execution,
          gpuSafety: {
            bootId,
            timestampQueriesEnabled: false,
            xidObserved: false,
            preflightSource: "journalctl-kernel-current-boot",
            liveFollower: "journalctl-kernel-follow-current-boot",
            redundantPollMs: 250,
            postflightSource: "journalctl-kernel-current-boot",
          },
          outputs: outputs.map(({ pixelSanity, ...output }) => output),
        });
      await writeFile(resolve(staging, "capture-provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      await rename(staging, out);
      return {
        evidencePath,
        provenancePath: portable(repo, resolve(out, "capture-provenance.json")),
        outputs,
        reviewBindHost: FB4_CAPTURE.reviewBindHost,
        staged: false,
      };
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => {});
  }
}
const value = (args, flag) => {
  const i = args.indexOf(flag);
  if (i < 0 || !args[i + 1])
    throw new Error(
      "usage: bun tools/preview/run-native-fb4-multi-room-capture.mjs --authority <json> --out-dir <new-dir> --review-prefix <prefix>",
    );
  return args[i + 1];
};
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  console.log(
    JSON.stringify(
      await runFb4Capture({
        authorityPath: value(args, "--authority"),
        outDir: value(args, "--out-dir"),
        reviewPrefix: value(args, "--review-prefix"),
        fullscreen: args.includes("--fullscreen"),
      }),
      null,
      2,
    ),
  );
}
