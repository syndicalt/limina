import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { canonicalHash, type JsonValue } from "../../js/src/authoring/canonical.ts";
import {
  createBuildingArticulationCpuProxy,
  createFb4V3ArticulationFunctionalClosure,
  DEFAULT_BUILDING_ARTICULATION_PROXY_POLICY,
  FB4_V3_BUILDING_ARTICULATION_PROXY_POLICY,
  validateBuildingArticulationCpuProxy,
} from "../../js/src/architecture/building-articulation-cpu-proxy.ts";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";
import { sha256 } from "../../js/src/world/sha256.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const MODULE_PATH = "js/src/architecture/building-articulation-cpu-proxy.ts";
const TOOL_PATH = "tools/architecture/build-building-articulation-cpu-proxy.ts";
const HASH = /^sha256:[0-9a-f]{64}$/;

const raw = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const portable = (absolute: string) => relative(ROOT, absolute).split(sep).join("/");
const exact = async (path: string, expectedSha256?: string, expectedContentHash?: string) => {
  const absolute = resolve(ROOT, path); if (portable(absolute) !== path) throw new Error(`articulation proxy path is not canonical: ${path}`);
  const bytes = await readFile(absolute), sha = raw(bytes), contentHash = portableAssetContentHash(bytes);
  if (expectedSha256 !== undefined && sha !== expectedSha256) throw new Error(`articulation proxy exact bytes drifted: ${path}`);
  if (expectedContentHash !== undefined && contentHash !== expectedContentHash) throw new Error(`articulation proxy engine content hash drifted: ${path}`);
  return { path, bytes, sha256: sha, contentHash, byteLength: bytes.byteLength };
};
const glbJson = (bytes: Uint8Array) => {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); if (data.getUint32(0, true) !== 0x46546c67 || data.getUint32(4, true) !== 2) throw new Error("articulation proxy production asset is not GLB 2.0");
  const length = data.getUint32(12, true), kind = data.getUint32(16, true); if (kind !== 0x4e4f534a || 20 + length > bytes.byteLength) throw new Error("articulation proxy GLB JSON chunk is invalid");
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)).trimEnd());
};
const identity = (file: Awaited<ReturnType<typeof exact>>) => Object.freeze({ path: file.path, sha256: file.sha256, contentHash: file.contentHash, bytes: file.byteLength });
const parseArgs = () => {
  let candidateRoot = "", output: string | undefined;
  for (let index = 2; index < process.argv.length; index++) {
    const argument = process.argv[index];
    if (argument === "--candidate-root") candidateRoot = process.argv[++index] ?? "";
    else if (argument === "--out") output = process.argv[++index] ?? "";
    else throw new Error(`unknown articulation proxy argument '${argument}'`);
  }
  if (!candidateRoot || (output !== undefined && !output)) throw new Error("articulation proxy requires explicit --candidate-root; --out is optional and must name a new append-only file");
  return { candidateRoot, output };
};

const { candidateRoot, output } = parseArgs(), manifestPath = `${candidateRoot}/candidate-manifest.json`, manifestFile = await exact(manifestPath), manifest = JSON.parse(manifestFile.bytes.toString("utf8")), isV3 = manifest.schema === "limina.fb4-multi-room-production-candidate/v3";
if (!(["limina.fb4-multi-room-production-candidate/v2", "limina.fb4-multi-room-production-candidate/v3"].includes(manifest.schema)) || manifest.status !== "cpu-verified-human-pending" || manifest.gpuCaptureAtBuild !== false || manifest.cpuProxyEvidenceAtBuild !== false || manifest.visualApprovalClaimed !== false || !HASH.test(manifest.compiler?.specHash) || !HASH.test(manifest.compiler?.irHash)) throw new Error("articulation proxy candidate is not a bounded V2/V3 CPU-only authority");
const fileByRole = new Map((manifest.files ?? []).map((entry: any) => [entry.role, entry]));
const architectureRecord: any = fileByRole.get("architectureSpec"), productionRecord: any = fileByRole.get("productionGlb"), synthesisRecord: any = fileByRole.get("architectureProgramSynthesis");
if (!architectureRecord || !productionRecord || !synthesisRecord) throw new Error("articulation proxy candidate lacks architecture/spec/synthesis closure");

const [programFile, visualFile, cueFile, architectureFile, productionFile, synthesisFile, moduleFile, toolFile] = await Promise.all([
  exact(manifest.programAuthority.path, manifest.programAuthority.sha256), exact(manifest.visualDesign.path, manifest.visualDesign.sha256), exact(manifest.cueProfile.path, manifest.cueProfile.sha256),
  exact(architectureRecord.path, architectureRecord.sha256, architectureRecord.contentHash), exact(productionRecord.path, productionRecord.sha256, productionRecord.contentHash), exact(synthesisRecord.path, synthesisRecord.sha256, synthesisRecord.contentHash), exact(MODULE_PATH), exact(TOOL_PATH),
]);
const architectureIrFile = isV3 ? await exact(`${productionRecord.path}.architecture.json`) : undefined;
const architecture = JSON.parse(architectureFile.bytes.toString("utf8")), document = glbJson(productionFile.bytes), semanticIds = (document.nodes ?? []).map((node: any) => node.extras?.limina?.id ?? node.extras?.["limina.id"]).filter((id: unknown): id is string => typeof id === "string");
if (new Set(semanticIds).size !== semanticIds.length) throw new Error("articulation proxy production GLB duplicates semantic identities");

const compiled = manifest.synthesis?.compiledArticulation,
  dormer = isV3 ? architecture.dormers?.[0] : architecture.dormers?.find((entry: any) => entry.id === compiled?.dormerId),
  canopy = isV3 ? architecture.entranceCanopies?.[0] : architecture.entranceCanopies?.find((entry: any) => entry.id === compiled?.entranceCanopyId),
  chimney = isV3 ? architecture.roofPenetrations?.[0] : architecture.roofPenetrations?.find((entry: any) => entry.id === compiled?.roofPenetrationId);
if (!dormer || !canopy || !chimney || (!isV3 && dormer.windowId !== compiled.dormerWindowId)
  || (isV3 && (architecture.dormers.length !== 1 || architecture.entranceCanopies.length !== 1 || architecture.roofPenetrations.length !== 1 || architecture.attachedBays?.length !== 1
    || architecture.attachedBays[0].id !== manifest.synthesis?.compiledMassing?.attachedBayId))) throw new Error("articulation proxy compiled articulation does not resolve in the exact architecture spec");
const volume = architecture.volumes?.[0], entrance = architecture.entrances?.find((entry: any) => entry.id === canopy.entranceId), opening = volume?.openings?.find((entry: any) => entry.id === entrance?.openingId);
if (!volume || !entrance || !opening || opening.edgeIndex !== 0) throw new Error("articulation proxy requires a resolved front-facade canopy entrance");
const facadeMinimumX = Math.min(...volume.footprint.map((point: number[]) => point[0])), facadeMaximumX = Math.max(...volume.footprint.map((point: number[]) => point[0])), facadeCenterX = (facadeMinimumX + facadeMaximumX) / 2, facadeHalfWidth = (facadeMaximumX - facadeMinimumX) / 2;
const select = (predicate: (id: string) => boolean) => semanticIds.filter(predicate).sort();
const dormerIds = select((id) => id.startsWith(`${dormer.id}/`) || id.startsWith(`roof-weather/${dormer.id}/`) || id.startsWith(`wall/${dormer.id}/`) || id.startsWith(`${dormer.windowId}/`));
const canopyIds = select((id) => id.startsWith(`entrance-canopy/${canopy.id}/`) || id === `roof/entrance-canopy/${canopy.id}` || id.startsWith(`roof-flashing/entrance-canopy/${canopy.id}/`));
const chimneyIds = select((id) => id.startsWith(`${chimney.id}/`));
if (dormerIds.length < 12 || canopyIds.length < 5 || chimneyIds.length < 12 || !canopyIds.some((id) => id.endsWith("/post-0")) || !canopyIds.some((id) => id.endsWith("/post-1"))) throw new Error("articulation proxy resolved an incomplete production semantic inventory");

const policy = isV3 ? FB4_V3_BUILDING_ARTICULATION_PROXY_POLICY : DEFAULT_BUILDING_ARTICULATION_PROXY_POLICY;
const analysis = createBuildingArticulationCpuProxy({ productionGlb: productionFile.bytes, policy,
  elements: [{ id: "dormer", semanticNodeIds: dormerIds }, { id: "canopy", semanticNodeIds: canopyIds }, { id: "chimney", semanticNodeIds: chimneyIds }],
  facade: { centerX: facadeCenterX, halfWidth: facadeHalfWidth, dormerCenterX: dormer.alongCenter, canopyCenterX: opening.offset },
});
const functionalClosure = isV3 ? createFb4V3ArticulationFunctionalClosure(productionFile.bytes, architectureIrFile!.bytes) : undefined;
const { proxyHash: analysisHash, ...analysisCore } = analysis;
const evidenceCore = Object.freeze({ ...analysisCore,
  authority: Object.freeze({
    candidateManifest: Object.freeze({ ...identity(manifestFile), candidateId: manifest.candidateId, schema: manifest.schema, status: manifest.status }),
    program: Object.freeze({ ...identity(programFile), programHash: manifest.programAuthority.programHash }),
    visualDesign: Object.freeze({ ...identity(visualFile), contractHash: manifest.visualDesign.contractHash, status: manifest.visualDesign.status }),
    cueProfile: Object.freeze({ ...identity(cueFile), profileHash: manifest.cueProfile.profileHash, cueIds: Object.freeze([...manifest.cueProfile.cueIds]) }),
    synthesisEvidence: identity(synthesisFile), architectureSpec: identity(architectureFile), ...(architectureIrFile ? { architectureIr: identity(architectureIrFile) } : {}),
    compiler: Object.freeze({ schema: manifest.compiler.schema, specHash: manifest.compiler.specHash, irHash: manifest.compiler.irHash }), productionGlb: identity(productionFile),
  }),
  implementation: Object.freeze({ algorithmSource: identity(moduleFile), generator: identity(toolFile), analysisHash }),
  policy, policyHash: canonicalHash(sha256, policy as unknown as JsonValue),
  ...(functionalClosure ? { functionalClosure } : {}),
  reviewBoundary: Object.freeze({ unlocks: "v3-site-review-generation-only", mutatesCandidateManifest: false, changesCandidateStatus: false, grantsGpuEligibility: false, grantsVisualApproval: false, siteReviewMustIndependentlyProve: Object.freeze(["terrain-line-of-sight", "vegetation-corridors", "camera-corridors", "placement-transform"]) }),
});
const evidence = validateBuildingArticulationCpuProxy(Object.freeze({ ...evidenceCore, proxyHash: canonicalHash(sha256, evidenceCore as unknown as JsonValue) }));
const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
if (output !== undefined) await writeFile(resolve(output), serialized, { flag: "wx", mode: 0o600 }); else process.stdout.write(serialized);
