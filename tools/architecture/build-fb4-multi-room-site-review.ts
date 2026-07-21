import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFunctionalBuildingContract } from "../../js/src/assets/functional-building-contract.ts";
import { resolveFunctionalBuildingSitePlacement } from "../../js/src/assets/functional-building-site.ts";
import {
  FB4_V4_SEMANTIC_VIEW_MAPPING,
  validateMultiRoomReviewAuthority,
  verifyMultiRoomReviewV4Closure,
} from "../../js/src/render/building-multi-room-review-scene.ts";
import {
  createBuildingSemanticEvidence,
  verifyBuildingSemanticEvidence,
  type ExactSemanticEvidenceFile,
} from "../../js/src/render/building-semantic-evidence.ts";
import { createFb4V3SemanticPolicy } from "../../js/src/render/fb4-v3-semantic-policy.ts";
import {
  derivePopulationMaximumHorizontalReach,
  validateBuildingSiteReviewEnvelope,
  verifySiteReviewCameras,
  verifySiteReviewRuntimePack,
} from "../../js/src/render/building-site-review-envelope.ts";
import { loadTemperateFidelityCandidate } from "../../js/src/render/temperate-fidelity-scene.ts";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";
import { verifyBuildingArticulationCpuProxyEvidence } from "../../js/src/architecture/building-articulation-cpu-proxy.ts";
import { collectCaptureModuleClosure } from "../preview/capture-producer-closure.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENVIRONMENT = Object.freeze({
  authority: "art-direction/temperate-fidelity-scene.json",
  runtimeBundle: "assets/derived/temperate-fidelity/runtime/bundle.json",
  runtimePack: "assets/biomes/temperate-fidelity-runtime-pack.json",
});
const TOOL_ENTRIES = Object.freeze(["tools/architecture/build-fb4-multi-room-site-review.ts"]);
const PLACEMENT = Object.freeze({ position: Object.freeze([106.25, 0, 50.25] as const), yaw: 1.175 });
export const FB4_V4_EVIDENCE_VIEWS = Object.freeze([
  {
    id: "exterior-entry",
    role: "front three-quarter proof of dormer, covered entry, occupied windows, closed envelope, and coherent timber frame expression",
    camera: { position: [81.226, 7.875, 47.11], target: [106.25, 4.5, 50.25], fovDeg: 48, near: 0.1, far: 250 },
  },
  {
    id: "exterior-rear",
    role: "rear three-quarter proof of centerline chimney closure, hall and upper daylight apertures, and frame rhythm",
    camera: { position: [131.274, 7.875, 53.39], target: [106.25, 4.5, 50.25], fovDeg: 48, near: 0.1, far: 250 },
  },
  {
    id: "gable-elevation",
    role: "west-gable proof of compiler-owned closure, rakes, collar, king post, roof clearance, and both upper-storey daylight apertures",
    camera: {
      position: [95.09531, 7, 72.510337],
      target: [102.821594, 4.835, 54.019633],
      fovDeg: 46,
      near: 0.1,
      far: 250,
    },
  },
  {
    id: "frame-entry-window-detail",
    role: "covered-entry and window detail proof of complete canopy support, adjacent aperture clearance, frame joins, threshold, and material depth",
    camera: { position: [96.265, 4.1, 46.705], target: [102.871, 1.7, 49.467], fovDeg: 50, near: 0.08, far: 100 },
  },
  {
    id: "ground-rooms-passage",
    role: "ground hall, kitchen, fireplace structure, and unobstructed shared passage proof",
    camera: { position: [103.634, 1.7, 51.324], target: [107.653, 1.5, 46.891], fovDeg: 66, near: 0.08, far: 100 },
  },
  {
    id: "stair-opening",
    role: "complete wall-adjacent return stair, bottom/turn/top landings, both clear approaches, headroom, and upper-floor opening proof",
    camera: {
      position: [105.98012, 2.1, 50.895883],
      target: [105.85027617181734, 1.68, 46.148826892073075],
      fovDeg: 68,
      near: 0.08,
      far: 100,
    },
  },
  {
    id: "upper-room",
    role: "upper landing, open bedroom access, and west-gable exterior-window proof; stair arrival is independently covered by stair-opening",
    camera: {
      position: [106.407144, 5.15, 45.438617],
      target: [102.821594, 4.835, 54.019633],
      fovDeg: 66,
      near: 0.08,
      far: 100,
    },
  },
  {
    id: "lod-25m",
    role: "distant proof that dormer, canopy, chimney, primary frame expression, and silhouette survive the locked LOD budget",
    camera: { position: [83.183, 10, 40.611], target: [106.25, 4.5, 50.25], fovDeg: 50, near: 0.1, far: 300 },
  },
] as const);
const localFromReviewWorld = (point: readonly [number, number, number]) => {
  const dx = point[0] - PLACEMENT.position[0],
    dz = point[2] - PLACEMENT.position[2],
    c = Math.cos(PLACEMENT.yaw),
    s = Math.sin(PLACEMENT.yaw);
  return [dx * c - dz * s, point[1], dx * s + dz * c] as const;
};
/** Fail closed when a visually plausible camera is aimed at the wrong architectural feature. */
export function assertFb4V4EvidenceCameraIntent(architecture: any): void {
  const byId = new Map(FB4_V4_EVIDENCE_VIEWS.map((view) => [view.id, view])),
    gable = byId.get("gable-elevation")!,
    stair = byId.get("stair-opening")!,
    upper = byId.get("upper-room")!,
    gablePosition = localFromReviewWorld(gable.camera.position),
    gableTarget = localFromReviewWorld(gable.camera.target),
    stairPosition = localFromReviewWorld(stair.camera.position),
    stairTarget = localFromReviewWorld(stair.camera.target),
    upperPosition = localFromReviewWorld(upper.camera.position),
    upperTarget = localFromReviewWorld(upper.camera.target);
  const rooms = architecture?.functionalContract?.rooms,
    portals = architecture?.functionalContract?.portals,
    links = architecture?.functionalContract?.verticalLinks;
  if (!Array.isArray(rooms) || !Array.isArray(portals) || !Array.isArray(links))
    throw new Error("FB-4 camera intent requires functional rooms, portals, and vertical links");
  const groundHall = rooms.find((room: any) => room.id === "room/space/ground-hall"),
    landing = rooms.find((room: any) => room.id === "room/space/upper-landing"),
    portal = portals.find((entry: any) => entry.id === "portal/landing-front"),
    windowGlass = architecture.primitives?.filter((item: any) =>
      /^window\/space\/bedroom-a\/[01]\/glass$/.test(item.id),
    );
  if (!groundHall || !landing || !portal || windowGlass?.length !== 2)
    throw new Error("FB-4 camera intent lost ground hall, upper landing, front portal, or west-gable windows");
  const windowTarget = [
      -4.8,
      windowGlass.reduce((sum: number, item: any) => sum + item.center[1], 0) / 2,
      windowGlass.reduce((sum: number, item: any) => sum + item.center[2], 0) / 2,
    ] as const,
    tolerance = 0.02;
  if (
    gablePosition[0] >= windowTarget[0] - 5 ||
    Math.abs(gablePosition[2] - windowTarget[2]) > 0.1 ||
    Math.hypot(gableTarget[0] - windowTarget[0], gableTarget[1] - windowTarget[1], gableTarget[2] - windowTarget[2]) >
      tolerance
  )
    throw new Error("FB-4 gable camera does not prove the west-gable upper windows");
  const center = landing.bounds.center,
    half = landing.bounds.halfExtents;
  if (
    upperPosition.some((value, index) => value <= center[index] - half[index] || value >= center[index] + half[index])
  )
    throw new Error("FB-4 upper camera is not contained by the upper landing");
  const dx = upperTarget[0] - upperPosition[0],
    t = (portal.center[0] - upperPosition[0]) / dx,
    atPortal = [
      portal.center[0],
      upperPosition[1] + (upperTarget[1] - upperPosition[1]) * t,
      upperPosition[2] + (upperTarget[2] - upperPosition[2]) * t,
    ] as const;
  if (
    t <= 0 ||
    t >= 1 ||
    Math.abs(atPortal[1] - portal.center[1]) > portal.halfExtents[1] ||
    Math.abs(atPortal[2] - portal.center[2]) > portal.halfExtents[2] ||
    Math.hypot(upperTarget[0] - windowTarget[0], upperTarget[1] - windowTarget[1], upperTarget[2] - windowTarget[2]) >
      tolerance
  )
    throw new Error("FB-4 upper camera sightline misses the open front bedroom portal or west-gable windows");
  const primitives = architecture.primitives;
  if (!Array.isArray(primitives)) throw new Error("FB-4 stair camera intent requires architecture primitives");
  const bottom = primitives.find((item: any) => item.id === "stairs/stairs/primary/landing-bottom"),
    turn = primitives.find((item: any) => item.id === "stairs/stairs/primary/landing-intermediate-0"),
    top = primitives.find((item: any) => item.id === "stairs/stairs/primary/landing-top"),
    link = links.find((item: any) => item.id === "stairs/primary");
  if (!bottom || !turn || !top || link?.flights?.length !== 2 || !link.approaches)
    throw new Error("FB-4 stair camera intent lost the return flights, landings, or approaches");
  const hallCenter = groundHall.bounds.center,
    hallHalf = groundHall.bounds.halfExtents;
  if (
    stairPosition.some(
      (value, index) => value <= hallCenter[index] - hallHalf[index] || value >= hallCenter[index] + hallHalf[index],
    )
  )
    throw new Error("FB-4 stair camera is not contained by the ground hall");
  const stairCenter = [
    (bottom.center[0] + top.center[0]) / 2,
    (bottom.center[1] + top.center[1]) / 2,
    (bottom.center[2] + top.center[2]) / 2,
  ] as const;
  if (
    Math.hypot(stairTarget[0] - stairCenter[0], stairTarget[1] - stairCenter[1], stairTarget[2] - stairCenter[2]) > 0.4
  )
    throw new Error("FB-4 stair camera does not target the complete stair");
  const normalize = (value: readonly number[]) => {
      const length = Math.hypot(...value);
      if (length <= 1e-9) throw new Error("FB-4 stair camera has a degenerate sightline");
      return value.map((component) => component / length);
    },
    dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, value, index) => sum + value * b[index], 0),
    forward = normalize(stairTarget.map((value, index) => value - stairPosition[index])),
    right = normalize([forward[2], 0, -forward[0]]),
    cameraUp = normalize([
      right[1] * forward[2] - right[2] * forward[1],
      right[2] * forward[0] - right[0] * forward[2],
      right[0] * forward[1] - right[1] * forward[0],
    ]),
    verticalLimit = Math.tan((stair.camera.fovDeg * Math.PI) / 360),
    horizontalLimit = verticalLimit * (1920 / 1080);
  for (const point of [
    bottom.center,
    turn.center,
    top.center,
    link.approaches.bottom.center,
    link.approaches.top.center,
  ]) {
    const relative = point.map((value: number, index: number) => value - stairPosition[index]),
      depth = dot(relative, forward);
    if (
      depth <= stair.camera.near ||
      Math.abs(dot(relative, cameraUp)) / depth > verticalLimit * 0.9 ||
      Math.abs(dot(relative, right)) / depth > horizontalLimit * 0.9
    )
      throw new Error("FB-4 stair camera does not frame every landing and clear approach");
  }
  const floorFragments = primitives.filter((item: any) =>
      /^volume\/volume\/storey-upper\/floor-fragment-/.test(item.id),
    ),
    insidePolygon = (point: readonly [number, number], boundary: readonly (readonly [number, number])[]) => {
      let inside = false;
      for (let i = 0, j = boundary.length - 1; i < boundary.length; j = i++) {
        const [xi, zi] = boundary[i],
          [xj, zj] = boundary[j];
        if (zi > point[1] !== zj > point[1] && point[0] < ((xj - xi) * (point[1] - zi)) / (zj - zi) + xi)
          inside = !inside;
      }
      return inside;
    },
    openingCenter = link.upperFloorOpening.center;
  if (
    floorFragments.some(
      (item: any) =>
        item.bottomY <= top.center[1] && item.topY >= top.center[1] && insidePolygon(openingCenter, item.boundary),
    )
  )
    throw new Error("FB-4 stair camera intent lost the upper-floor stair opening");
  const segmentHitsBox = (to: readonly number[], box: any) => {
      const yaw = box.yawRadians ?? 0,
        c = Math.cos(yaw),
        s = Math.sin(yaw),
        local = (point: readonly number[]) => {
          const x = point[0] - box.center[0],
            z = point[2] - box.center[2];
          return [x * c - z * s, point[1] - box.center[1], x * s + z * c];
        },
        origin = local(stairPosition),
        target = local(to);
      let minimum = 0,
        maximum = 1;
      for (let axis = 0; axis < 3; axis++) {
        const delta = target[axis] - origin[axis],
          low = -box.halfExtents[axis],
          high = box.halfExtents[axis];
        if (Math.abs(delta) < 1e-9) {
          if (origin[axis] < low || origin[axis] > high) return false;
          continue;
        }
        let a = (low - origin[axis]) / delta,
          b = (high - origin[axis]) / delta;
        if (a > b) [a, b] = [b, a];
        minimum = Math.max(minimum, a);
        maximum = Math.min(maximum, b);
        if (minimum > maximum) return false;
      }
      return maximum > 1e-6 && minimum < 0.999;
    },
    walls = primitives.filter((item: any) => item.kind === "box" && item.id.startsWith("wall-interior/"));
  if (
    [bottom.center, turn.center, stairCenter, top.center].some((point) =>
      walls.some((wall: any) => segmentHitsBox(point, wall)),
    )
  )
    throw new Error("FB-4 stair camera wall sightline is occluded");
}
const raw = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  portable = (path: string) => relative(ROOT, path).split(sep).join("/"),
  round = (value: number) => Number(value.toFixed(12));
const serialize = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`),
  json = (bytes: Uint8Array) => JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
const read = async (path: string) => {
  const bytes = new Uint8Array(await readFile(resolve(ROOT, path)));
  return { path, bytes, sha256: raw(bytes), contentHash: portableAssetContentHash(bytes) };
};
const ref = (entry: { path: string; sha256: string; contentHash: string }) => ({
  path: entry.path,
  sha256: entry.sha256,
  contentHash: entry.contentHash,
});
type V3 = readonly [number, number, number];
function primitivePoints(item: any): V3[] {
  if (item.kind === "box") {
    const [cx, cy, cz] = item.center,
      [hx, hy, hz] = item.halfExtents,
      yaw = item.yawRadians ?? 0,
      c = Math.cos(yaw),
      s = Math.sin(yaw),
      out: V3[] = [];
    for (const x of [-hx, hx])
      for (const y of [-hy, hy]) for (const z of [-hz, hz]) out.push([cx + x * c + z * s, cy + y, cz - x * s + z * c]);
    return out;
  }
  if (item.kind === "plane-slab") {
    const n = item.normal as V3,
      t = item.thickness / 2;
    return item.boundary.flatMap(
      (p: V3) =>
        [
          [p[0] - n[0] * t, p[1] - n[1] * t, p[2] - n[2] * t],
          [p[0] + n[0] * t, p[1] + n[1] * t, p[2] + n[2] * t],
        ] as V3[],
    );
  }
  if (item.kind === "polygon-slab")
    return item.boundary.flatMap(
      ([x, z]: readonly [number, number]) =>
        [
          [x, item.bottomY, z],
          [x, item.topY, z],
        ] as V3[],
    );
  if (item.kind === "linear-member" || item.kind === "oriented-cylinder") {
    const r = item.kind === "linear-member" ? Math.max(item.width, item.depth) / 2 : item.radius;
    return [item.from, item.to].flatMap((p: V3) =>
      [
        [-r, -r, -r],
        [-r, -r, r],
        [-r, r, -r],
        [-r, r, r],
        [r, -r, -r],
        [r, -r, r],
        [r, r, -r],
        [r, r, r],
      ].map(([x, y, z]) => [p[0] + x, p[1] + y, p[2] + z] as V3),
    );
  }
  if (item.kind === "tapered-flame") {
    const a = item.baseCenter as V3,
      b = [a[0] + item.tipOffset[0], a[1] + item.height + item.tipOffset[1], a[2] + item.tipOffset[2]] as V3,
      r = item.baseRadius;
    return [[a[0] - r, a[1], a[2] - r], [a[0] + r, a[1], a[2] + r], b];
  }
  if (item.kind === "lathed-profile") {
    const radius = Math.max(...item.profile.map((p: readonly [number, number]) => Math.abs(p[0]))),
      ys = item.profile.map((p: readonly [number, number]) => p[1]);
    return [
      [item.center[0] - radius, item.center[1] + Math.min(...ys), item.center[2] - radius],
      [item.center[0] + radius, item.center[1] + Math.max(...ys), item.center[2] + radius],
    ];
  }
  throw new Error(`unsupported architecture primitive '${item.kind}'`);
}
function subjectBounds(architecture: any) {
  const excluded = ["foundation/", "collider/", "wall-interior/", "fire/", "light/", "spawn/", "nav/", "room/"],
    points = architecture.primitives
      .filter((item: any) => !excluded.some((prefix) => item.id.startsWith(prefix)))
      .flatMap(primitivePoints);
  if (points.length < 8) throw new Error("FB-4 architecture has no bounded presentation subject");
  const minimum = [Infinity, Infinity, Infinity],
    maximum = [-Infinity, -Infinity, -Infinity];
  for (const p of points)
    for (let i = 0; i < 3; i++) {
      minimum[i] = Math.min(minimum[i], p[i]);
      maximum[i] = Math.max(maximum[i], p[i]);
    }
  return { minimum: minimum.map(round) as unknown as V3, maximum: maximum.map(round) as unknown as V3 };
}

export async function buildFb4MultiRoomSiteReview(
  input: Readonly<{ candidateRoot: string; articulationEvidencePath?: string; outputDirectory: string }>,
) {
  const candidateRoot = input.candidateRoot,
    articulationPath = input.articulationEvidencePath ?? `${candidateRoot}/articulation-cpu-proxy-v7.json`,
    outputDirectory = input.outputDirectory;
  if (!candidateRoot || !outputDirectory)
    throw new Error("FB-4 V4 site review requires explicit append-only --candidate-root and --out authorities");
  const toolPaths = (await collectCaptureModuleClosure(ROOT, TOOL_ENTRIES)).map(({ path }) => path);
  const [
    manifestFile,
    architectureFile,
    glbFile,
    articulationFile,
    environmentFile,
    bundleFile,
    runtimePackFile,
    ...toolFiles
  ] = await Promise.all(
    [
      `${candidateRoot}/candidate-manifest.json`,
      `${candidateRoot}/functional-hall-house-fb4-multi-room.glb.architecture.json`,
      `${candidateRoot}/functional-hall-house-fb4-multi-room.glb`,
      articulationPath,
      ENVIRONMENT.authority,
      ENVIRONMENT.runtimeBundle,
      ENVIRONMENT.runtimePack,
      ...toolPaths,
    ].map(read),
  );
  const manifest = json(manifestFile.bytes),
    architecture = json(architectureFile.bytes),
    syncRead = (path: string) => new Uint8Array(readFileSync(resolve(ROOT, path))),
    articulation = verifyBuildingArticulationCpuProxyEvidence(json(articulationFile.bytes), syncRead);
  if (
    manifest.status !== "cpu-verified-human-pending" ||
    manifest.gpuCaptureAtBuild !== false ||
    manifest.visualApprovalClaimed !== false
  )
    throw new Error("FB-4 candidate escaped CPU-only human-pending status");
  if (
    architecture.irHash !== manifest.compiler.irHash ||
    architecture.specHash !== manifest.compiler.specHash ||
    architecture.functionalContract?.buildingId !== manifest.functional?.buildingId
  )
    throw new Error("FB-4 architecture IR drifted from candidate manifest");
  if (articulation.mechanicalVerdict !== "mechanically-sufficient-for-v3-site-review")
    throw new Error("FB-4 CPU articulation proxy is not mechanically sufficient");
  assertFb4V4EvidenceCameraIntent(architecture);
  const expectedGlb = manifest.files.find((entry: any) => entry.role === "productionGlb");
  if (
    !expectedGlb ||
    expectedGlb.sha256 !== glbFile.sha256 ||
    expectedGlb.contentHash !== glbFile.contentHash ||
    expectedGlb.bytes !== glbFile.bytes.byteLength
  )
    throw new Error("FB-4 production GLB drifted from candidate manifest");
  const exact = (file: Awaited<ReturnType<typeof read>>): ExactSemanticEvidenceFile => ({
      path: file.path,
      sha256: file.sha256,
      contentHash: file.contentHash,
      bytes: file.bytes.byteLength,
    }),
    semantic = createBuildingSemanticEvidence({
      candidateId: manifest.candidateId,
      architectureId: architecture.functionalContract.buildingId,
      candidateManifest: { file: exact(manifestFile), bytes: manifestFile.bytes },
      architectureIr: { file: exact(architectureFile), bytes: architectureFile.bytes },
      productionGlb: { file: exact(glbFile), bytes: glbFile.bytes },
      policy: createFb4V3SemanticPolicy(architecture),
    });
  if (semantic.mechanicalVerdict !== "pass")
    throw new Error(`FB-4 semantic evidence failed: ${semantic.failures.join(", ")}`);
  verifyBuildingSemanticEvidence(semantic, syncRead);
  const semanticBytes = serialize(semantic),
    semanticPath = `${outputDirectory}/semantic-evidence.json`,
    semanticRef = {
      path: semanticPath,
      sha256: raw(semanticBytes),
      contentHash: portableAssetContentHash(semanticBytes),
      bytes: semanticBytes.byteLength,
    };
  const toolClosureFiles = toolFiles.map((entry) => ({
      path: entry.path,
      sha256: entry.sha256,
      bytes: entry.bytes.byteLength,
    })),
    reviewToolClosureHash = raw(new TextEncoder().encode(JSON.stringify(toolClosureFiles))),
    cameraSetHash = raw(new TextEncoder().encode(JSON.stringify(FB4_V4_EVIDENCE_VIEWS)));
  const envelope = validateBuildingSiteReviewEnvelope({
    schema: "limina.building-site-review-envelope/v1",
    runtimePack: ref(runtimePackFile),
    populationMaximumHorizontalReachM: derivePopulationMaximumHorizontalReach(json(runtimePackFile.bytes)),
    discretePopulationExclusion: {
      structure: "authored-footprint-plus-vegetation-clearance-plus-population-reach",
      cameraLineOfSight: "camera-to-subject-footprint-sweep-plus-population-reach",
      exteriorViewIds: ["exterior-entry", "exterior-rear", "gable-elevation", "frame-entry-window-detail", "lod-25m"],
    },
    subjectBounds: subjectBounds(architecture),
    cameraChecks: {
      minimumProjectedAreaFraction: 0.02,
      minimumProjectedHeightFraction: 0.1,
      maximumFullSubjectHeightFraction: 0.95,
      fullSubjectViewIds: ["exterior-entry", "exterior-rear", "gable-elevation", "lod-25m"],
      terrainRaySampleSpacingM: 0.5,
      minimumTerrainClearanceM: 0.1,
      interiorViewIds: ["ground-rooms-passage", "stair-opening", "upper-room"],
    },
  });
  verifySiteReviewRuntimePack(envelope, runtimePackFile.bytes);
  const decoder = new TextDecoder("utf8", { fatal: true }),
    reader = {
      readJson: async (path: string) => JSON.parse(decoder.decode((await read(path)).bytes)),
      readBytes: async (path: string) => (await read(path)).bytes,
    };
  let loaded: Awaited<ReturnType<typeof loadTemperateFidelityCandidate>> | undefined;
  try {
    loaded = await loadTemperateFidelityCandidate({ reader, shot: "river-leading-line" });
    const contract = parseFunctionalBuildingContract(glbFile.bytes),
      sampleHeight = (x: number, z: number) => loaded!.candidate.snapshot.terrain.sampleHeight(x, z) ?? undefined,
      site = resolveFunctionalBuildingSitePlacement({
        contract,
        position: PLACEMENT.position,
        yaw: PLACEMENT.yaw,
        sampleHeight,
        maximumSampleSpacing: 0.5,
      }),
      cameraEvidence = verifySiteReviewCameras({
        envelope,
        position: PLACEMENT.position,
        yaw: PLACEMENT.yaw,
        rootWorldY: site.rootWorldY,
        views: FB4_V4_EVIDENCE_VIEWS,
        width: 1920,
        height: 1080,
        sampleHeight,
      });
    const residentTerrain = [];
    for (const entry of loaded.chunks as any[]) {
      const descriptor = entry.resource.artifacts.terrain,
        index = loaded.bundle.artifactIndex.find((candidate: any) => candidate.contentHash === descriptor.contentHash);
      if (!index) throw new Error(`missing resident terrain ${entry.chunkId}`);
      const file = await read(`assets/${index.assetId}`);
      if (file.bytes.byteLength !== descriptor.byteLength)
        throw new Error(`resident terrain bytes drifted: ${entry.chunkId}`);
      residentTerrain.push({
        chunkId: entry.chunkId,
        tx: entry.chunk.tx,
        tz: entry.chunk.tz,
        path: file.path,
        sha256: file.sha256,
        contentHash: descriptor.contentHash,
        bytes: file.bytes.byteLength,
      });
    }
    const envelopeBytes = serialize(envelope),
      envelopePath = `${outputDirectory}/site-review-envelope.json`,
      envelopeRef = {
        path: envelopePath,
        sha256: raw(envelopeBytes),
        contentHash: portableAssetContentHash(envelopeBytes),
      };
    const siteEvidence = {
      schema: "limina.fb4-multi-room-site-review-evidence/v1",
      verdict: "pass",
      renderingPerformed: false,
      gpuUsed: false,
      visualQualityClaimed: false,
      siteFitClaimed: true,
      humanDecision: "pending",
      inputs: {
        candidateManifest: ref(manifestFile),
        productionGlb: { ...ref(glbFile), bytes: glbFile.bytes.byteLength },
        architectureInput: ref(architectureFile),
        articulationEvidence: ref(articulationFile),
        semanticEvidence: semanticRef,
        environmentAuthority: ref(environmentFile),
        runtimeBundle: ref(bundleFile),
        runtimePack: ref(runtimePackFile),
        siteReviewEnvelope: envelopeRef,
      },
      placement: PLACEMENT,
      cameraSetHash,
      reviewToolClosureHash,
      toolClosureFiles,
      site: {
        rootWorldY: round(site.rootWorldY),
        terrainMinimum: round(site.terrainMinimum),
        terrainMaximum: round(site.terrainMaximum),
        terrainRelief: round(site.terrainRelief),
        sampleCount: site.sampleCount,
        maximumTerrainRelief: contract.site?.maximumTerrainRelief,
        entranceSupport: site.entranceSupport,
      },
      cameraEvidence,
      residentTerrain,
    };
    const siteEvidenceBytes = serialize(siteEvidence),
      siteEvidencePath = `${outputDirectory}/site-review-evidence.json`,
      siteEvidenceRef = {
        path: siteEvidencePath,
        sha256: raw(siteEvidenceBytes),
        contentHash: portableAssetContentHash(siteEvidenceBytes),
      };
    const authority = {
      schema: "limina.fb4-multi-room-review-authority/v4",
      candidate: {
        candidateId: manifest.candidateId,
        architectureId: architecture.functionalContract.buildingId,
        manifest: exact(manifestFile),
        glb: exact(glbFile),
        architectureIr: exact(architectureFile),
        specHash: manifest.compiler.specHash,
        irHash: manifest.compiler.irHash,
      },
      visualFloor: {
        referenceSetId: "project-gorgon/house/v1",
        releaseContract: {
          path: "plans/visual-fidelity-release-contract.md",
          sha256: raw(new Uint8Array(await readFile(resolve(ROOT, "plans/visual-fidelity-release-contract.md")))),
        },
        belowFloorPresentationProhibited: true,
        humanApprovalRequired: true,
      },
      environment: {
        authority: { path: environmentFile.path, sha256: environmentFile.sha256 },
        runtimeBundle: { path: bundleFile.path, sha256: bundleFile.sha256 },
        shot: "river-leading-line",
        context: "approved-temperate-production",
      },
      placement: PLACEMENT,
      topologyProof: {
        fromRoomId: "room/space/kitchen",
        toRoomId: "room/space/upper-landing",
        roomIds: ["room/space/kitchen", "room/space/ground-hall", "room/space/upper-landing"],
        connectionIds: ["portal/hall-kitchen", "stairs/primary"],
        expectedDoors: 3,
        expectedAnchors: 6,
      },
      presentation: {
        minimumResolution: [1920, 1080],
        fixedTimeSeconds: 12,
        warmupFrames: 4,
        timestampQueriesEnabled: false,
      },
      evidenceViews: FB4_V4_EVIDENCE_VIEWS,
      approval: {
        renderer: "limina-production-native-engine",
        humanDecision: "pending",
        visualApprovalClaimed: false,
        nonEngineApprovalProhibited: true,
      },
      siteReviewEnvelope: envelope,
      articulationEvidence: ref(articulationFile),
      siteReviewEnvelopeAuthority: envelopeRef,
      siteReviewEvidence: siteEvidenceRef,
      cameraSetHash,
      reviewToolClosureHash,
      semanticEvidence: semanticRef,
      semanticViewMapping: FB4_V4_SEMANTIC_VIEW_MAPPING.map((mapping, index) => ({
        ...mapping,
        semanticViewId: semantic.claims[index].viewId,
      })),
    };
    const validated = validateMultiRoomReviewAuthority(authority),
      authorityBytes = serialize(validated),
      final = resolve(ROOT, outputDirectory),
      staging = `${final}.staging-${process.pid}`,
      closureRead = (path: string) => {
        if (path === semanticPath) return semanticBytes;
        if (path === envelopePath) return envelopeBytes;
        if (path === siteEvidencePath) return siteEvidenceBytes;
        const match = [manifestFile, architectureFile, glbFile, articulationFile, environmentFile, bundleFile].find(
          (file) => file.path === path,
        );
        if (match) return match.bytes;
        return syncRead(path);
      };
    verifyMultiRoomReviewV4Closure(validated, closureRead);
    await mkdir(staging, { recursive: false, mode: 0o700 });
    await writeFile(resolve(staging, "semantic-evidence.json"), semanticBytes, { flag: "wx", mode: 0o600 });
    await writeFile(resolve(staging, "site-review-envelope.json"), envelopeBytes, { flag: "wx", mode: 0o600 });
    await writeFile(resolve(staging, "site-review-evidence.json"), siteEvidenceBytes, { flag: "wx", mode: 0o600 });
    await writeFile(resolve(staging, "review-authority.json"), authorityBytes, { flag: "wx", mode: 0o600 });
    await rename(staging, final);
    return {
      outputDirectory,
      authorityPath: `${outputDirectory}/review-authority.json`,
      authoritySha256: raw(authorityBytes),
      semanticEvidence: semanticRef,
      envelope: envelopeRef,
      siteEvidence: siteEvidenceRef,
      cameraSetHash,
      reviewToolClosureHash,
      site: siteEvidence.site,
    };
  } finally {
    loaded?.candidate.dispose();
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2),
    value = (flag: string) => {
      const index = args.indexOf(flag);
      return index < 0 ? undefined : args[index + 1];
    },
    candidateRoot = value("--candidate-root"),
    outputDirectory = value("--out");
  if (!candidateRoot || !outputDirectory)
    throw new Error(
      "usage: bun tools/architecture/build-fb4-multi-room-site-review.ts --candidate-root <append-only candidate> --out <new review directory> [--articulation-evidence <json>]",
    );
  console.log(
    JSON.stringify(
      await buildFb4MultiRoomSiteReview({
        candidateRoot,
        articulationEvidencePath: value("--articulation-evidence"),
        outputDirectory,
      }),
      null,
      2,
    ),
  );
}
