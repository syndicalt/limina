import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import test from "node:test";
import sharp from "../../js/node_modules/sharp/lib/index.js";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";
import { PRODUCTION_R1_CAPTURE, runBuildingProductionR1Capture, validateProductionReviewPixels, verifyFrozenBuildingProductionReviewAuthority } from "./run-native-building-production-r1-capture.mjs";

const WORKSPACE = resolve(import.meta.dirname, "../.."), raw = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`, portable = (root, path) => relative(root, path).split(sep).join("/");
const runnerSource = await readFile(new URL("./run-native-building-production-r1-capture.mjs", import.meta.url), "utf8");
const [demoSource, sceneSource, authoritySource] = await Promise.all([
  readFile(new URL("../../js/src/demos/building_production_review_window.ts", import.meta.url), "utf8"),
  readFile(new URL("../../js/src/render/building-production-review-scene.ts", import.meta.url), "utf8"),
  readFile(new URL("../../js/src/render/building-production-review-authority.ts", import.meta.url), "utf8"),
]);

test("R1 runner statically pins the only native path, private/loopback outputs, Xid guards, and no timestamp acknowledgement", () => {
  assert.equal(PRODUCTION_R1_CAPTURE.binary, "target/release/limina");
  assert.equal(PRODUCTION_R1_CAPTURE.module, "js/src/demos/building_production_review_window.ts");
  assert.equal(PRODUCTION_R1_CAPTURE.reviewBindHost, "127.0.0.1");
  assert.equal(PRODUCTION_R1_CAPTURE.reviewArtifactRoot, ".limina/review-artifacts");
  assert.equal(PRODUCTION_R1_CAPTURE.traceEnvironment, "LIMINA_BUILDING_PRODUCTION_REVIEW_TRACE");
  assert.match(runnerSource, /current boot already contains an NVIDIA Xid/);
  assert.match(runnerSource, /journalctl.*-f.*-n.*0/s);
  assert.match(runnerSource, /live Xid monitor exited before capture completion/);
  assert.match(runnerSource, /setInterval\(.*kernelLog.*250/s);
  assert.match(runnerSource, /NVIDIA Xid detected after capture; stop immediately/);
  assert.match(runnerSource, /delete environment\.LIMINA_GPU_TIMESTAMP_RISK_ACK/);
  assert.match(runnerSource, /for \(const key of Object\.keys\(environment\)\) if \(\/TIMESTAMP\/i\.test\(key\)\) delete environment\[key\]/);
  assert.doesNotMatch(runnerSource, /requiredFeatures.*timestamp-query/);
});

test("R1 demo performs only guarded production-engine capture with presented readback and strict whole-scene telemetry", () => {
  assert.match(sceneSource, /mountBuildingProductionPackage\(world,closure\.manifest,closure\.candidate,\{position:/);
  assert.match(sceneSource, /production\.fire\.advanceTicks\(authority\.fire\.advanceTicks\)/);
  assert.match(demoSource, /createEngine\(\{[\s\S]*gpuTimestampMode: "disabled"[\s\S]*gpuTextureCompression: "bc-required"[\s\S]*renderBaseline: false/);
  assert.match(demoSource, /isSoftwareAdapter\(engine\.gpuAdapter\)/); assert.match(demoSource, /renderer\.info\.autoReset = false/);
  assert.match(demoSource, /withPresentedNativeSurfaceFrame\([\s\S]*op_surface_present[\s\S]*readNativeSurfaceRgba/);
  assert.match(demoSource, /submission\.renderCalls <= 1 \|\| submission\.drawCalls <= 1 \|\| submission\.triangles <= 1/);
  assert.match(demoSource, /gpuTimestampMode: "disabled"[\s\S]*timestampQueriesEnabled: false[\s\S]*gpuTextureCompression: "bc-required"[\s\S]*renderBaseline: false/);
  const productionPrewarm=demoSource.indexOf("await prewarmGltfScene(productionAssetId"),fuelPrewarm=demoSource.indexOf("await prewarmGltfScene(fuelAssetId"),environmentMount=demoSource.indexOf("environment = await mountTemperateFidelityScene");assert.ok(productionPrewarm>0&&fuelPrewarm>productionPrewarm&&environmentMount>fuelPrewarm,"exact building and fire fuel must be resident before environment beginWorld");
  assert.match(demoSource, /must be a bare \.json filename/); assert.doesNotMatch(demoSource, /GPU_TIMESTAMP_RISK_ACK|requiredFeatures[^\n]*timestamp-query/);
  assert.match(authoritySource, /approvalPolicy\.timestampQueriesEnabled !== false/); assert.match(authoritySource, /belowFloorPresentationProhibited !== true/);
});

async function fixture(t) {
  const repo = await mkdtemp(resolve(WORKSPACE, ".limina/r1-capture-fake-")); t.after(() => rm(repo, { recursive: true, force: true }));
  for (const path of [...PRODUCTION_R1_CAPTURE.sourcePaths, PRODUCTION_R1_CAPTURE.binary, "assets/buildings/authority.json", ".limina/review-artifacts", "traces"]) {
    const absolute = resolve(repo, path); await mkdir(path.endsWith(".json") || path.endsWith(".ts") || path.endsWith(".mjs") || path.endsWith("limina") ? resolve(absolute, "..") : absolute, { recursive: true });
    if (path.endsWith(".ts") || path.endsWith(".mjs") || path.endsWith("limina")) await writeFile(absolute, `source:${path}`);
  }
  const camera={position:[1,2,3],target:[4,5,6],fovDeg:45,near:.1,far:100};
  const environment={context:"approved-temperate-production"};
  const authority = { environment,presentation: { minimumResolution: [1920, 1080],fixedTimeSeconds:12,warmupFrames:4, cameraVerticalBasis:"terrain-root-relative" }, approvalPolicy: { timestampQueriesEnabled: false, humanDecision: "pending", visualApprovalClaimed: false }, evidenceViews: PRODUCTION_R1_CAPTURE.viewIds.map((id) => ({ id, camera })) };
  const authorityPath = "assets/buildings/authority.json", authorityBytes = Buffer.from(JSON.stringify(authority)); await writeFile(resolve(repo, authorityPath), authorityBytes);
  const source = [];
  for (const path of PRODUCTION_R1_CAPTURE.sourcePaths) { const bytes = await readFile(resolve(repo, path)); source.push({ path, sha256: raw(bytes), contentHash: portableAssetContentHash(bytes) }); }
  const rgba = Buffer.alloc(1920 * 1080 * 4);for(let y=0;y<1080;y++)for(let x=0;x<1920;x++){const offset=(y*1920+x)*4,value=(x+y)%256;rgba[offset]=value;rgba[offset+1]=(value*3)%256;rgba[offset+2]=(value*7)%256;rgba[offset+3]=255;}const rgbaBase64 = rgba.toString("base64"), rgbaContentHash = portableAssetContentHash(rgba);
  const counts = { geometries: 1, textures: 1, programs: 1, calls: 1, triangles: 1, points: 0 }, bytes = { geometries: 1, textures: 1, buffers: 1, total: 3, transient: 0, resident: 3 };
  const resolvedCamera={...camera,position:[1,9,3],target:[4,12,6],verticalBasis:"world"};
  const artifact = { schema: PRODUCTION_R1_CAPTURE.schema, backend: "native-webgpu", captureClass: "production-engine", adapter: { name: "fake discrete hardware" }, timingPolicy: { gpuTimestampMode: "disabled", timestampQueriesEnabled: false, gpuTextureCompression: "bc-required", renderBaseline: false }, authority: { path: authorityPath, sha256: raw(authorityBytes), contentHash: portableAssetContentHash(authorityBytes) }, source,environment,presentation:{fixedTimeSeconds:12,warmupFrames:4,cameraVerticalBasis:"terrain-root-relative"}, mounted: { productionBuilding: 1,site:{rootWorldY:7} }, lifecycle: { baselineEntities: 2, afterDisposeEntities: 2, disposed: true }, captures: PRODUCTION_R1_CAPTURE.viewIds.map((id, index) => ({ id, camera,authorityCamera:camera,resolvedCamera, width: 1920, height: 1080, surfaceFormat: "rgba8unorm", rgbaBase64, rgbaByteLength: rgba.length, rgbaContentHash, renderSubmission: { schema: "limina.three-render-submission/v2", source: "three-webgpu-renderer-info", scope: "single-production-frame-all-passes", instanceAccounting: "full-draw-instance-count", frameId: index + 1, renderCalls: 2, drawCalls: 2, triangles: 2, cpuEncodeMs: 0 }, rendererResources: { schema: "limina.three-render-resources/v1", source: "three-webgpu-renderer-info", scope: "renderer-live-after-production-frame", counts, bytes } })) };
  return { repo, authorityPath, artifact, authorityTools: { validate: (value) => value, verify: () => true } };
}

test("fake native runner writes exactly five complete PNGs plus private evidence and scrubs timestamp-risk environment", async (t) => {
  const f = await fixture(t), kernelReads = [], invocations = [];
  const privateRoot = resolve(f.repo, PRODUCTION_R1_CAPTURE.privateRoot);
  await assert.rejects(lstat(privateRoot), /ENOENT/);
  const result = await runBuildingProductionR1Capture({ repoRoot: f.repo, authorityPath: f.authorityPath, outDir: "assets/qc/internal/production-r1/fake-v1", reviewPrefix: "production-r1-fake-v1" }, {
    authorityTools: f.authorityTools, accessBinary: async () => {}, bootId: "fake-boot", environment: { LIMINA_GPU_TIMESTAMP_RISK_ACK: "yes", LIMINA_GPU_TIMESTAMP_MODE: "risk", SOMETHING_TIMESTAMP_ELSE: "1", SAFE: "yes" }, kernelLog: () => { kernelReads.push(true); return "clean"; },
    traceId: "success", runGuarded: async (binary, args, environment) => { invocations.push({ binary, args, environment }); await writeFile(resolve(f.repo, "traces", environment[PRODUCTION_R1_CAPTURE.traceEnvironment]), JSON.stringify(f.artifact)); },
    encodePng: async (rgba, width, height) => sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer(),
  });
  assert.equal(kernelReads.length, 2); assert.equal(invocations.length, 1); assert.equal(invocations[0].binary, resolve(f.repo, PRODUCTION_R1_CAPTURE.binary));
  assert.ok(invocations[0].args.includes(PRODUCTION_R1_CAPTURE.module)); assert.equal(invocations[0].environment.SAFE, "yes"); assert.deepEqual(Object.keys(invocations[0].environment).filter((key) => /TIMESTAMP/i.test(key)), []);
  assert.equal(result.outputs.length, 5); assert.equal(result.reviewBindHost, "127.0.0.1");
  const privateRootStat = await lstat(privateRoot); assert.equal(privateRootStat.isDirectory(), true); assert.equal(privateRootStat.isSymbolicLink(), false); assert.equal(privateRootStat.mode & 0o777, 0o700);
  const evidence = JSON.parse(await readFile(resolve(f.repo, result.evidencePath))); assert.equal(evidence.outputs.length, 5); assert.equal(evidence.guardEvidence.live.xidObserved, false); assert.equal(evidence.reviewBridge.public, false);
  assert.ok(evidence.outputs.every(({pixelSanity})=>pixelSanity?.schema==="limina.rgba-luminance-sanity/v1"&&pixelSanity.dynamicRange>=4));
  for (const output of evidence.outputs) { const [privatePng, reviewPng] = await Promise.all([readFile(resolve(f.repo, output.path)), readFile(resolve(f.repo, output.reviewArtifactPath))]); assert.ok(privatePng.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))); assert.deepEqual(privatePng, reviewPng); assert.equal(raw(privatePng), output.pngSha256); }
  await assert.rejects(runBuildingProductionR1Capture({ repoRoot: f.repo, authorityPath: f.authorityPath, outDir: "assets/qc/internal/production-r1/fake-v1", reviewPrefix: "production-r1-fake-v1" }, { authorityTools: f.authorityTools, traceId: "repeat" }), /append-only/);
});

test("pixel sanity accepts varied imagery and rejects blank, crushed, and clipped frames",()=>{const varied=Buffer.from([0,0,0,255,64,80,96,255,180,160,140,255,255,255,255,255]);assert.ok(validateProductionReviewPixels(varied,4,1).dynamicRange>=4);for(const value of [0,24,255])assert.throws(()=>validateProductionReviewPixels(Buffer.alloc(64, value),4,4),/blank|black crush|white clipping/);});

test("fake runner refuses any preflight or postflight Xid and never publishes captures", async (t) => {
  const pre = await fixture(t);
  await assert.rejects(runBuildingProductionR1Capture({ repoRoot: pre.repo, authorityPath: pre.authorityPath, outDir: "assets/qc/internal/production-r1/pre-xid", reviewPrefix: "pre-xid" }, { authorityTools: pre.authorityTools, accessBinary: async () => {}, bootId: "fake", traceId: "pre", kernelLog: () => "NVRM: Xid 79" }), /reboot before any native capture retry/);
  const post = await fixture(t); let reads = 0;
  await assert.rejects(runBuildingProductionR1Capture({ repoRoot: post.repo, authorityPath: post.authorityPath, outDir: "assets/qc/internal/production-r1/post-xid", reviewPrefix: "post-xid" }, { authorityTools: post.authorityTools, accessBinary: async () => {}, bootId: "fake", traceId: "post", kernelLog: () => ++reads === 1 ? "clean" : "NVRM: Xid 31", runGuarded: async (_binary, _args, environment) => writeFile(resolve(post.repo, "traces", environment[PRODUCTION_R1_CAPTURE.traceEnvironment]), JSON.stringify(post.artifact)) }), /do not retry until reboot/);
  await assert.rejects(readFile(resolve(post.repo, "traces/building-production-r1-native-capture-post.json")), /ENOENT/);
  await assert.rejects(readFile(resolve(post.repo, "assets/qc/internal/production-r1/post-xid/capture-evidence.json")), /ENOENT/);
});

test("loopback write failure rolls back its earlier copies and never publishes the complete private final", async (t) => {
  const f = await fixture(t); let opened = 0;
  await assert.rejects(runBuildingProductionR1Capture({ repoRoot: f.repo, authorityPath: f.authorityPath, outDir: "assets/qc/internal/production-r1/review-fail", reviewPrefix: "review-fail" }, {
    authorityTools: f.authorityTools, accessBinary: async () => {}, bootId: "fake", traceId: "review-fail", kernelLog: () => "clean",
    runGuarded: async (_binary, _args, environment) => writeFile(resolve(f.repo, "traces", environment[PRODUCTION_R1_CAPTURE.traceEnvironment]), JSON.stringify(f.artifact)),
    encodePng: async (rgba, width, height) => sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer(),
    openReview: async (...args) => { if (++opened === 2) { const error = new Error("injected review write failure"); error.code = "EIO"; throw error; } return (await import("node:fs/promises")).open(...args); },
  }), /injected review write failure/);
  await assert.rejects(readFile(resolve(f.repo, "assets/qc/internal/production-r1/review-fail/capture-evidence.json")), /ENOENT/);
  for (const id of PRODUCTION_R1_CAPTURE.viewIds) await assert.rejects(readFile(resolve(f.repo, `.limina/review-artifacts/review-fail-${id}.png`)), /ENOENT/);
});

test("real frozen R1 authority and its complete exact-byte closure pass the runner's CPU-only preparation", async () => {
  const authorityPath = "assets/buildings/authoring/functional-hall-house-v4/production-r1-candidate-9ba6f653/production-review-authority-v5.json";
  const verified = await verifyFrozenBuildingProductionReviewAuthority({ repoRoot: WORKSPACE, authorityPath });
  assert.equal(verified.authority.gate, "R1-release"); assert.equal(verified.authority.approvalPolicy.timestampQueriesEnabled, false);
  assert.equal(verified.authority.approvalPolicy.humanDecision, "pending"); assert.equal(verified.authority.evidenceViews.length, 5);
  assert.equal(verified.authorityPath, authorityPath); assert.ok(verified.closure?.productionBytes?.length > 0);assert.equal(verified.closure.siteFit.fit.terrainRelief,.28095984171);assert.equal(verified.closure.siteFit.cameraDomain.views.length,5);
});
