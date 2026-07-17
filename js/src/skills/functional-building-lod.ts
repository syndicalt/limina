import type { CameraLike } from "../engine.ts";

type PositionLike = { x: number; y: number; z: number };
export type FunctionalBuildingLodNode = {
  visible: boolean;
  userData?: { liminaLod?: { level?: unknown }; limina?: { id?: unknown } };
  traverse?(visit: (node: FunctionalBuildingLodNode) => void): void;
};

export type FunctionalBuildingLodOptions = Readonly<{
  anchor: readonly [number, number, number];
  distances: readonly number[];
  hysteresis: number;
  doorNodeIds: ReadonlySet<string>;
}>;

export type FunctionalBuildingStaticBatch = Readonly<{ lodRoots: readonly number[]; doorRoot: number; doorRoots?: readonly number[] }>;

/** Read the authoritative asset-level package manifest without decoding meshes or textures. */
export function parseFunctionalBuildingStaticBatch(bytes: Uint8Array): FunctionalBuildingStaticBatch | undefined {
  let jsonBytes = bytes;
  if (bytes.byteLength >= 20) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) === 0x46546c67) {
      if (view.getUint32(4, true) !== 2 || view.getUint32(16, true) !== 0x4e4f534a) throw new Error("functional building LOD: malformed GLB JSON chunk");
      const length = view.getUint32(12, true);
      if (20 + length > bytes.byteLength) throw new Error("functional building LOD: truncated GLB JSON chunk");
      jsonBytes = bytes.subarray(20, 20 + length);
    }
  }
  let document: unknown;
  try { document = JSON.parse(new TextDecoder().decode(jsonBytes).replace(/[\0 ]+$/, "")); }
  catch (error) { throw new Error("functional building LOD: invalid glTF JSON", { cause: error }); }
  const batch = (document as { asset?: { extras?: { liminaStaticBatch?: unknown } } })?.asset?.extras?.liminaStaticBatch;
  if (batch === undefined) return undefined;
  const value = batch as { schema?: unknown; lodRoots?: unknown; doorRoot?: unknown; doorRoots?: unknown };
  if (value.schema !== "limina.static-batch/1" || !Array.isArray(value.lodRoots) || value.lodRoots.length !== 3
    || value.lodRoots.some((index) => !Number.isInteger(index) || index < 0) || new Set(value.lodRoots).size !== value.lodRoots.length
    || !Number.isInteger(value.doorRoot) || (value.doorRoot as number) < 0
    || (value.doorRoots !== undefined && (!Array.isArray(value.doorRoots) || value.doorRoots.length === 0
      || value.doorRoots.some((index) => !Number.isInteger(index) || index < 0)
      || new Set(value.doorRoots).size !== value.doorRoots.length || !value.doorRoots.includes(value.doorRoot)))) {
    throw new Error("functional building LOD: invalid limina.static-batch/1 manifest");
  }
  return Object.freeze({ lodRoots: Object.freeze([...(value.lodRoots as number[])]), doorRoot: value.doorRoot as number,
    ...(value.doorRoots === undefined ? {} : { doorRoots: Object.freeze([...(value.doorRoots as number[])]) }) });
}

function finitePosition(value: unknown): value is PositionLike {
  const position = value as PositionLike | undefined;
  return position !== undefined && Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z);
}

/** Resolve compiler-authored whole-building LOD roots from glTF extras, fail-closed on ambiguity. */
export function resolveFunctionalBuildingLodRoots(root: FunctionalBuildingLodNode, doorNodeIds: ReadonlySet<string>): FunctionalBuildingLodNode[] {
  const byLevel = new Map<number, FunctionalBuildingLodNode>();
  root.traverse?.((node) => {
    const raw = node.userData?.liminaLod?.level;
    if (raw === undefined) return;
    if (!Number.isInteger(raw) || (raw as number) < 0) throw new Error("functional building LOD: invalid semantic level");
    const level = raw as number;
    if (byLevel.has(level)) throw new Error(`functional building LOD: duplicate LOD${level} root`);
    byLevel.set(level, node);
  });
  if (byLevel.size === 0) return [];
  const roots = [...byLevel.entries()].sort((a, b) => a[0] - b[0]);
  roots.forEach(([level], index) => { if (level !== index) throw new Error("functional building LOD: levels must be contiguous from LOD0"); });
  for (const [, lodRoot] of roots) lodRoot.traverse?.((node) => {
    const semanticId = node.userData?.limina?.id;
    if (typeof semanticId === "string" && doorNodeIds.has(semanticId)) {
      throw new Error(`functional building LOD: articulated door '${semanticId}' was included in a static batch`);
    }
  });
  return roots.map(([, node]) => node);
}

/** Render-only, replay-rebuilt controller. Hysteresis prevents camera jitter from thrashing roots. */
export class FunctionalBuildingLodController {
  readonly roots: readonly FunctionalBuildingLodNode[];
  readonly anchor: readonly [number, number, number];
  readonly distances: readonly number[];
  readonly hysteresis: number;
  #level = 0;

  constructor(roots: readonly FunctionalBuildingLodNode[], options: Omit<FunctionalBuildingLodOptions, "doorNodeIds">) {
    if (roots.length < 2) throw new Error("functional building LOD: at least two roots are required");
    if (options.distances.length !== roots.length - 1 || options.distances.some((value, index) => !Number.isFinite(value) || value <= 0 || (index > 0 && value <= options.distances[index - 1]))) {
      throw new Error("functional building LOD: distances must be finite, positive, strictly increasing, and match the root count");
    }
    if (!Number.isFinite(options.hysteresis) || options.hysteresis < 0 || options.hysteresis >= 0.5) throw new Error("functional building LOD: hysteresis must be in [0, 0.5)");
    this.roots = roots; this.anchor = options.anchor; this.distances = options.distances; this.hysteresis = options.hysteresis;
    this.apply(0);
  }

  get level(): number { return this.#level; }

  update(camera: CameraLike): void {
    if (!finitePosition(camera.position)) return;
    const dx = camera.position.x - this.anchor[0], dy = camera.position.y - this.anchor[1], dz = camera.position.z - this.anchor[2];
    const distance = Math.hypot(dx, dy, dz);
    let next = this.#level;
    while (next < this.roots.length - 1 && distance >= this.distances[next] * (1 + this.hysteresis)) next++;
    while (next > 0 && distance < this.distances[next - 1] * (1 - this.hysteresis)) next--;
    this.apply(next);
  }

  /** Explicit selection is useful for deterministic evidence captures; ordinary play uses update(). */
  apply(level: number): void {
    if (!Number.isInteger(level) || level < 0 || level >= this.roots.length) throw new RangeError(`functional building LOD: invalid level ${level}`);
    this.#level = level;
    this.roots.forEach((root, index) => { root.visible = index === level; });
  }
}
