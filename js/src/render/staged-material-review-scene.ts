import * as THREE from "../../build/three.bundle.mjs";
import { AssetRegistry } from "../asset-registry.ts";
import { LiminaTracer } from "../observability/event.ts";
import { registerCoreSkills } from "../skills/index.ts";
import { resolveProfile } from "../skills/permissions.ts";
import { SkillRegistry, type WorldContext } from "../skills/registry.ts";
import { portableAssetContentHash } from "../world/asset-content-hash.mjs";
import { sha256 } from "../world/sha256.mjs";

type Hash = `sha256:${string}`;
type V3 = readonly [number, number, number];
const HASH = /^sha256:[0-9a-f]{64}$/;
const BASE_VIEW_IDS =
  "poly-haven-pack-swatches,authored-simple-role-swatches,representative-exterior-shell-crop,representative-interior-hearth-crop";
const ENHANCED_VIEW_IDS = `${BASE_VIEW_IDS},roof-dormer-eave-continuity`;

interface ExactFile {
  readonly path: string;
  readonly sha256: Hash;
  readonly contentHash: Hash;
}
export interface StagedMaterialReviewAuthority {
  readonly schema: "limina.staged-material-review-scene/v1";
  readonly approvalPolicy: {
    readonly renderer: "limina-production-native-engine";
    readonly blenderApprovalProhibited: true;
    readonly nonEngineApprovalProhibited: true;
    readonly humanDecisionRequired: true;
  };
  readonly approvedShell: ExactFile & {
    readonly artifactId: string;
    readonly contractHash: Hash;
    readonly runtimeGlbPath: string;
    readonly runtimeGlbSha256: Hash;
    readonly surfaceMappingFacetHash: Hash;
    readonly materialRoleSlotsFacetHash: Hash;
  };
  readonly paletteLock: ExactFile & {
    readonly paletteId: string;
    readonly packIds: readonly string[];
    readonly authoredSimpleRoles: readonly string[];
  };
  readonly derived: {
    readonly assetId: string;
    readonly sha256: Hash;
    readonly assetHash: Hash;
    readonly manifestPath: string;
    readonly manifestSha256: Hash;
    readonly manifestContentHash: Hash;
    readonly sourceShellSha256: Hash;
    readonly fallback: "none";
    readonly extension: "KHR_texture_basisu";
  };
  readonly stageArtifact: ExactFile & {
    readonly artifactId: string;
    readonly kind: "material-palette";
    readonly status: "draft";
  };
  readonly presentation: {
    readonly minimumResolution: readonly [number, number];
    readonly fixedTimeSeconds: number;
    readonly warmupFrames: number;
    readonly neutralStudio: true;
    readonly lighting?: {
      readonly ambientColor: number;
      readonly ambientIntensity: number;
      readonly directionalColor: number;
      readonly directionalIntensity: number;
      readonly direction: V3;
    };
  };
  readonly evidenceViews: readonly {
    readonly id:
      | "poly-haven-pack-swatches"
      | "authored-simple-role-swatches"
      | "representative-exterior-shell-crop"
      | "representative-interior-hearth-crop"
      | "roof-dormer-eave-continuity";
    readonly role: string;
    readonly subject: "pack-swatches" | "simple-swatches" | "shell";
    readonly camera: {
      readonly position: V3;
      readonly target: V3;
      readonly fovDeg: number;
      readonly near: number;
      readonly far: number;
    };
  }[];
}

function file(value: unknown, label: string): asserts value is ExactFile {
  const v = value as Partial<ExactFile>;
  if (!v?.path || !HASH.test(v.sha256 ?? "") || !HASH.test(v.contentHash ?? ""))
    throw new Error(`material review authority has invalid ${label} identity`);
}
function v3(value: unknown, label: string): asserts value is V3 {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite))
    throw new Error(`material review authority has invalid ${label}`);
}
function uniqueSorted(value: unknown, label: string, minimum = 1): asserts value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.some((v) => typeof v !== "string" || v.length === 0) ||
    new Set(value).size !== value.length ||
    value.join(",") !== [...value].sort().join(",")
  )
    throw new Error(`material review authority requires canonical ${label}`);
}

export function validateStagedMaterialReviewAuthority(value: unknown): StagedMaterialReviewAuthority {
  const a = value as Partial<StagedMaterialReviewAuthority>;
  if (a.schema !== "limina.staged-material-review-scene/v1")
    throw new Error("unsupported staged material review authority");
  if (
    a.approvalPolicy?.renderer !== "limina-production-native-engine" ||
    a.approvalPolicy.blenderApprovalProhibited !== true ||
    a.approvalPolicy.nonEngineApprovalProhibited !== true ||
    a.approvalPolicy.humanDecisionRequired !== true
  )
    throw new Error("M1 approval is restricted to human review of Limina production native-engine evidence");
  file(a.approvedShell, "approved shell");
  if (
    !a.approvedShell.artifactId ||
    !HASH.test(a.approvedShell.contractHash) ||
    !a.approvedShell.runtimeGlbPath ||
    !HASH.test(a.approvedShell.runtimeGlbSha256) ||
    !HASH.test(a.approvedShell.surfaceMappingFacetHash) ||
    !HASH.test(a.approvedShell.materialRoleSlotsFacetHash)
  )
    throw new Error("material review authority lacks exact approved A1 shell closure");
  file(a.paletteLock, "materials.lock");
  uniqueSorted(a.paletteLock.packIds, "six-pack inventory", 6);
  uniqueSorted(a.paletteLock.authoredSimpleRoles, "authored-simple role inventory");
  if (a.paletteLock.packIds.length !== 6 || !a.paletteLock.paletteId)
    throw new Error("M1 review requires exactly six Poly Haven packs");
  if (
    !a.derived?.assetId ||
    ![
      a.derived.sha256,
      a.derived.assetHash,
      a.derived.manifestSha256,
      a.derived.manifestContentHash,
      a.derived.sourceShellSha256,
    ].every((v) => HASH.test(v ?? "")) ||
    !a.derived.manifestPath ||
    a.derived.fallback !== "none" ||
    a.derived.extension !== "KHR_texture_basisu"
  )
    throw new Error("material review authority lacks fallback-free KTX2 derivation closure");
  if (a.derived.sourceShellSha256 !== a.approvedShell.runtimeGlbSha256)
    throw new Error("M1 KTX2 asset is not derived from the approved A1 shell");
  file(a.stageArtifact, "draft M1 stage artifact");
  if (
    a.stageArtifact.kind !== "material-palette" ||
    a.stageArtifact.status !== "draft" ||
    a.stageArtifact.artifactId !== a.paletteLock.paletteId
  )
    throw new Error("material review authority does not bind the draft M1 stage artifact");
  const p = a.presentation;
  if (
    !Array.isArray(p?.minimumResolution) ||
    p.minimumResolution.length !== 2 ||
    !p.minimumResolution.every((n) => Number.isSafeInteger(n) && n >= 720) ||
    !Number.isSafeInteger(p.warmupFrames) ||
    p.warmupFrames < 1 ||
    p.warmupFrames > 120 ||
    !Number.isFinite(p.fixedTimeSeconds) ||
    p.fixedTimeSeconds < 0 ||
    p.neutralStudio !== true
  )
    throw new Error("material review authority has invalid presentation policy");
  if (p.lighting !== undefined) {
    const l = p.lighting;
    if (
      !Number.isSafeInteger(l.ambientColor) ||
      l.ambientColor < 0 ||
      l.ambientColor > 0xffffff ||
      !Number.isFinite(l.ambientIntensity) ||
      l.ambientIntensity <= 0 ||
      l.ambientIntensity > 4 ||
      !Number.isSafeInteger(l.directionalColor) ||
      l.directionalColor < 0 ||
      l.directionalColor > 0xffffff ||
      !Number.isFinite(l.directionalIntensity) ||
      l.directionalIntensity <= 0 ||
      l.directionalIntensity > 4
    )
      throw new Error("material review authority has invalid neutral-studio lighting");
    v3(l.direction, "neutral-studio light direction");
  }
  const viewIds = Array.isArray(a.evidenceViews) ? a.evidenceViews.map((v) => v.id).join(",") : "",
    subjects = Array.isArray(a.evidenceViews) ? a.evidenceViews.map((v) => v.subject).join(",") : "";
  if (
    !Array.isArray(a.evidenceViews) ||
    ![BASE_VIEW_IDS, ENHANCED_VIEW_IDS].includes(viewIds) ||
    !["pack-swatches,simple-swatches,shell,shell", "pack-swatches,simple-swatches,shell,shell,shell"].includes(subjects)
  )
    throw new Error("material review authority lacks the canonical M1 evidence set");
  for (const view of a.evidenceViews) {
    if (
      !view.role ||
      !Number.isFinite(view.camera?.fovDeg) ||
      view.camera.fovDeg < 15 ||
      view.camera.fovDeg > 80 ||
      !Number.isFinite(view.camera?.near) ||
      view.camera.near <= 0 ||
      !Number.isFinite(view.camera?.far) ||
      view.camera.far <= view.camera.near
    )
      throw new Error(`material review view ${view.id} is invalid`);
    v3(view.camera.position, `${view.id} camera position`);
    v3(view.camera.target, `${view.id} camera target`);
  }
  return a as StagedMaterialReviewAuthority;
}

/** Verify every authority-bound file before the native renderer or KTX2 loader is initialized. */
export function verifyStagedMaterialReviewClosure(
  authority: StagedMaterialReviewAuthority,
  read: (path: string) => Uint8Array,
): Readonly<Record<string, Uint8Array>> {
  validateStagedMaterialReviewAuthority(authority);
  const entries: readonly [string, string, Hash, Hash][] = [
    [
      "approvedShell",
      authority.approvedShell.path,
      authority.approvedShell.sha256,
      authority.approvedShell.contentHash,
    ],
    ["paletteLock", authority.paletteLock.path, authority.paletteLock.sha256, authority.paletteLock.contentHash],
    [
      "manifest",
      authority.derived.manifestPath,
      authority.derived.manifestSha256,
      authority.derived.manifestContentHash,
    ],
    [
      "stageArtifact",
      authority.stageArtifact.path,
      authority.stageArtifact.sha256,
      authority.stageArtifact.contentHash,
    ],
  ];
  const out: Record<string, Uint8Array> = {};
  for (const [label, path, raw, content] of entries) {
    const bytes = read(path);
    if (`sha256:${sha256(bytes)}` !== raw || portableAssetContentHash(bytes) !== content)
      throw new Error(`material review ${label} bytes drifted`);
    out[label] = bytes;
  }
  const shell = read(authority.approvedShell.runtimeGlbPath);
  if (`sha256:${sha256(shell)}` !== authority.approvedShell.runtimeGlbSha256)
    throw new Error("material review approved shell GLB drifted");
  const derived = read(`assets/${authority.derived.assetId}`);
  if (
    `sha256:${sha256(derived)}` !== authority.derived.sha256 ||
    portableAssetContentHash(derived) !== authority.derived.assetHash
  )
    throw new Error("material review derived KTX2 GLB drifted");
  const palette = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(out.paletteLock));
  const lockedPackIds = (palette.packs ?? []).map((pack: any) => pack.id).sort();
  const lockedSimpleRoles = (palette.roles ?? [])
    .filter((role: any) => role.kind === "authored-simple")
    .map((role: any) => role.role)
    .sort();
  if (lockedPackIds.join(",") !== authority.paletteLock.packIds.join(","))
    throw new Error("material review authority pack IDs do not match materials.lock");
  if (lockedSimpleRoles.join(",") !== authority.paletteLock.authoredSimpleRoles.join(","))
    throw new Error("material review authority authored-simple role IDs do not match materials.lock");
  for (const role of (palette.roles ?? []).filter((entry: any) => entry.kind === "texture-pack"))
    if (!lockedPackIds.includes(role.packId))
      throw new Error(`materials.lock role ${role.role} references missing pack ${role.packId}`);
  out.approvedShellGlb = shell;
  out.derivedGlb = derived;
  return Object.freeze(out);
}

/** Canonical association: pack identity lives at packs[].id; texture roles refer to it by packId. */
export function materialRoleForPack(palette: any, packId: string): any {
  if (!(palette.packs ?? []).some((pack: any) => pack.id === packId))
    throw new Error(`materials.lock lacks pack ${packId}`);
  const role = (palette.roles ?? []).find(
    (candidate: any) => candidate.kind === "texture-pack" && candidate.packId === packId,
  );
  if (!role) throw new Error(`materials.lock lacks a texture role for pack ${packId}`);
  return role;
}

/** Mount the approved-shell-derived KTX2 GLB through production asset.place, then add engine-native swatch geometry. */
export async function mountStagedMaterialReview(world: WorldContext, authority: StagedMaterialReviewAuthority) {
  const closure = verifyStagedMaterialReviewClosure(authority, (path) => world.ops.op_read_asset(path));
  const assets = new AssetRegistry(world.ops);
  assets.seed(authority.derived.assetId, closure.derivedGlb);
  const registry = new SkillRegistry(new LiminaTracer("staged-material-m1-review"));
  registerCoreSkills(registry, { assets });
  const base = {
    agentId: "staged-material-m1-review",
    sessionId: "staged-material-m1-review",
    permissions: resolveProfile("builder.readWrite"),
    tick: 0,
    world,
  };
  let tick = 1;
  const invoke = async (name: string, input: unknown) => {
    const r = await registry.invoke(name, input, { ...base, tick: tick++ });
    if (!r.success) throw new Error(`${name} failed: ${JSON.stringify(r.error)}`);
    return r.result as Record<string, unknown>;
  };
  const placed = await invoke("asset.place", {
    assetId: authority.derived.assetId,
    hash: authority.derived.assetHash,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    ground: false,
  });
  if (placed.hash !== authority.derived.assetHash) throw new Error("asset.place returned an unpinned M1 subject");
  const subject = world.entities.resolve(placed.entity as string);
  if (!subject?.mesh) throw new Error("M1 asset.place did not create an engine render root");
  const materialByName = new Map<string, THREE.Material>();
  (subject.mesh as unknown as THREE.Object3D).traverse((object) => {
    const material = (object as THREE.Mesh).material;
    if (Array.isArray(material)) for (const m of material) materialByName.set(m.name, m);
    else if (material) materialByName.set(material.name, material);
  });
  const palette = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(closure.paletteLock));
  const simpleRoles = palette.roles.filter((r: any) => r.kind === "authored-simple");
  const group = new THREE.Group();
  group.name = "M1 engine material swatches";
  world.scene.add(group);
  const swatches: THREE.Mesh[] = [];
  for (const [index, packId] of authority.paletteLock.packIds.entries()) {
    const role = materialRoleForPack(palette, packId),
      source = materialByName.get(role.materialName);
    if (!source) throw new Error(`derived KTX2 GLB lacks swatch material ${role.materialName}`);
    for (const [shape, z] of [
      ["sphere", 0],
      ["plane", 1.45],
    ] as const) {
      const geometry =
        shape === "sphere" ? new THREE.SphereGeometry(0.55, 48, 32) : new THREE.PlaneGeometry(1.15, 1.15, 1, 1);
      const mesh = new THREE.Mesh(geometry, source);
      mesh.name = `pack/${packId}/${shape}`;
      mesh.position.set((index - 2.5) * 1.35, 0.7, z);
      if (shape === "plane") mesh.rotation.x = -Math.PI / 2;
      group.add(mesh);
      swatches.push(mesh);
    }
  }
  for (const [index, role] of simpleRoles.entries()) {
    const p = role.parameters,
      material = new THREE.MeshStandardMaterial({
        name: role.materialName,
        color: new THREE.Color(...p.baseColorSrgb),
        roughness: p.roughness,
        metalness: p.metallic,
        transparent: p.alpha < 1,
        opacity: p.alpha,
        emissive: new THREE.Color(...p.emissionSrgb),
        emissiveIntensity: p.emissionStrength,
      });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.42, 32, 24), material);
    mesh.name = `simple/${role.role}`;
    mesh.position.set((index - (simpleRoles.length - 1) / 2) * 1.05, 0.55, 3.2);
    group.add(mesh);
    swatches.push(mesh);
  }
  const floor = (
    await invoke("scene.createEntity", { shape: "box", size: 24, color: 0x777777, pbr: true, position: [0, -0.18, 0] })
  ).entity as string;
  await invoke("three.setTransform", { entity: floor, scale: [1, 0.015, 1] });
  await invoke("three.setMaterial", { entity: floor, roughness: 0.88, metalness: 0, receiveShadow: true });
  const lighting = authority.presentation.lighting ?? {
    ambientColor: 0xe9edf2,
    ambientIntensity: 1.05,
    directionalColor: 0xfff4e2,
    directionalIntensity: 2.4,
    direction: [5, 8, 6] as V3,
  };
  await invoke("three.setLighting", { ...lighting, castShadow: true, shadowMapSize: 2048, shadowCameraExtent: 14 });
  let current: StagedMaterialReviewAuthority["evidenceViews"][number]["subject"] = "pack-swatches",
    currentVisible = true;
  const applyVisibility = () => {
    subject.mesh!.visible = currentVisible && current === "shell";
    for (const mesh of swatches)
      mesh.visible =
        currentVisible &&
        (current === "pack-swatches"
          ? mesh.name.startsWith("pack/")
          : current === "simple-swatches"
            ? mesh.name.startsWith("simple/")
            : false);
  };
  const setViewSubject = (kind: StagedMaterialReviewAuthority["evidenceViews"][number]["subject"]) => {
    current = kind;
    currentVisible = true;
    applyVisibility();
  };
  const setCurrentSubjectVisible = (visible: boolean) => {
    currentVisible = visible;
    applyVisibility();
  };
  applyVisibility();
  return Object.freeze({
    entity: placed.entity as string,
    packSwatches: authority.paletteLock.packIds.length * 2,
    simpleSwatches: simpleRoles.length,
    stageEntities: Object.freeze([floor]),
    setViewSubject,
    setCurrentSubjectVisible,
    dispose: async () => {
      world.scene.remove(group);
      for (const mesh of swatches) {
        mesh.geometry.dispose();
        if (mesh.name.startsWith("simple/")) (mesh.material as THREE.Material).dispose();
      }
      const failures = [];
      for (const entity of [floor, placed.entity as string]) {
        const removed = await registry.invoke("scene.destroyEntity", { entity }, { ...base, tick: tick++ });
        if (!removed.success)
          failures.push(new Error(`M1 scene.destroyEntity failed: ${JSON.stringify(removed.error)}`));
      }
      if (failures.length) throw new AggregateError(failures, "M1 review disposal failed");
    },
  });
}
