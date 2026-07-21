import { AssetRegistry } from "../asset-registry.ts";
import { loadApprovedFunctionalSettlementRelease } from "../assets/functional-settlement-release.mjs";
import type { EditableTerrain } from "./terrain-edit.ts";
import type { RegionState } from "./terrain.ts";
import type { TerrainSource } from "../terrain/types.ts";
import { sampleTileSurfaceHeight } from "../terrain/mesh.ts";
import { TILE_SIZE } from "../terrain/procedural.ts";
import { sha256 } from "../world/sha256.mjs";
import type { InvokeBase, SkillRegistry } from "./registry.ts";
import type { SnapshotParticipantRegistry } from "../worldlog/snapshot.ts";
import type {
  FunctionalSettlementResidencySnapshot,
} from "./functional-settlement-residency.ts";
import { createReleasedFunctionalSettlementRuntimeResidency } from "./functional-settlement-runtime-residency.ts";
import type { FunctionalSettlementPlacementManager } from "./functional-settlement.ts";
import { createReleasedFunctionalSettlementSnapshotParticipant } from "./functional-settlement-snapshot.ts";

export type FunctionalSettlementExactReader = (path: string) => Uint8Array;

export interface FunctionalSettlementReleaseLoadInput {
  /** Exact release record path. Every transitive authority is read through `read`. */
  readonly releasePath: string;
  readonly read: FunctionalSettlementExactReader;
  readonly namespace: string;
  readonly invokeBase: () => InvokeBase;
}

export interface ResidentFunctionalSettlementTerrain {
  readonly source: TerrainSource;
  readonly regions: ReadonlyMap<string, RegionState>;
  readonly layers: ReadonlyMap<string, EditableTerrain>;
}

const SAFE_NAMESPACE = /^[a-z0-9][a-z0-9._/-]{0,79}$/;

function safeNamespace(value: string): string {
  if (!SAFE_NAMESPACE.test(value) || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new TypeError("functional settlement live host namespace is not a bounded safe id");
  }
  return value;
}

function containsTile(tile: EditableTerrain["tile"], x: number, z: number): boolean {
  const halfX = tile.scale[0] / 2;
  const halfZ = tile.scale[2] / 2;
  return x >= tile.origin[0] - halfX && x <= tile.origin[0] + halfX
    && z >= tile.origin[2] - halfZ && z <= tile.origin[2] + halfZ;
}

/**
 * Build the default production settlement sampler from terrain that is actually resident in the
 * registered core. Editable layers read their live, deformed height arrays. Generated regions
 * accept a point only while its exact tile is applied, then query the same source/seed/lod/hints
 * authority that produced that collider. A resident editable layer intentionally overrides the
 * generated substrate beneath it; overlapping authorities within the selected tier must agree
 * bit-for-bit. An uncovered or same-tier ambiguous point returns undefined so site verification
 * fails before mutation.
 */
export function createResidentFunctionalSettlementTerrainSampler(
  terrain: ResidentFunctionalSettlementTerrain,
): (x: number, z: number) => number | undefined {
  return (x, z) => {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return undefined;
    const layerSamples: number[] = [];
    for (const layer of terrain.layers.values()) {
      if (containsTile(layer.tile, x, z)) layerSamples.push(sampleTileSurfaceHeight(layer.tile, x, z));
    }
    if (layerSamples.length > 0) {
      if (layerSamples.some((sample) => !Number.isFinite(sample))) return undefined;
      return layerSamples.every((sample) => Object.is(sample, layerSamples[0])) ? layerSamples[0] : undefined;
    }
    const regionSamples: number[] = [];
    const tx = Math.floor(x / TILE_SIZE);
    const tz = Math.floor(z / TILE_SIZE);
    for (const region of terrain.regions.values()) {
      let resident = false;
      for (const tile of region.tiles.values()) if (tile.tx === tx && tile.tz === tz) { resident = true; break; }
      if (!resident) continue;
      regionSamples.push(terrain.source.sampleHeight(region.seed, x, z, region.lod, region.hints));
    }
    if (regionSamples.length === 0 || regionSamples.some((sample) => !Number.isFinite(sample))) return undefined;
    return regionSamples.every((sample) => Object.is(sample, regionSamples[0])) ? regionSamples[0] : undefined;
  };
}

function rawHash(bytes: Uint8Array): string { return `sha256:${sha256(bytes)}`; }

/** One exact released settlement attached to a live core. */
export interface FunctionalSettlementLiveSession {
  readonly releaseId: string;
  readonly settlementId: string;
  readonly namespace: string;
  readonly closed: boolean;
  snapshot(): FunctionalSettlementResidencySnapshot;
  setExplicitInterest(unitIds: Iterable<string>): void;
  update(position: readonly [number, number, number]): Promise<FunctionalSettlementResidencySnapshot>;
  close(): Promise<void>;
}

class LiveSession implements FunctionalSettlementLiveSession {
  readonly releaseId: string;
  readonly settlementId: string;
  readonly namespace: string;
  readonly #residency: ReturnType<typeof createReleasedFunctionalSettlementRuntimeResidency>;
  readonly #onClosed: () => void;
  #closed = false;

  constructor(
    release: any,
    namespace: string,
    residency: ReturnType<typeof createReleasedFunctionalSettlementRuntimeResidency>,
    onClosed: () => void,
  ) {
    this.releaseId = release.release.releaseId;
    this.settlementId = release.release.settlementId;
    this.namespace = namespace;
    this.#residency = residency;
    this.#onClosed = onClosed;
  }

  get closed(): boolean { return this.#closed; }
  snapshot(): FunctionalSettlementResidencySnapshot { return this.#residency.snapshot(); }
  setExplicitInterest(unitIds: Iterable<string>): void {
    if (this.#closed) throw new Error("functional settlement live session is closed");
    this.#residency.setExplicitInterest(unitIds);
  }
  update(position: readonly [number, number, number]): Promise<FunctionalSettlementResidencySnapshot> {
    if (this.#closed) return Promise.reject(new Error("functional settlement live session is closed"));
    return this.#residency.update(position);
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    await this.#residency.close();
    this.#onClosed();
    this.#closed = true;
  }
}

/**
 * Normal host boundary for FB-5. It loads and brands an exact release itself, warms the exact
 * runtime GLB and site artifacts into the core AssetRegistry, constructs only the released
 * residency adapter, and retains lifecycle ownership until atomic close. Callers never supply a
 * catalog, plan, site, terrain recipe, residency budget, or already-branded lookalike.
 */
export class FunctionalSettlementReleaseHost {
  readonly #registry: SkillRegistry;
  readonly #assets: AssetRegistry;
  readonly #placementManager: FunctionalSettlementPlacementManager;
  readonly #snapshotParticipants: SnapshotParticipantRegistry;
  readonly #sessions = new Map<string, FunctionalSettlementLiveSession>();

  constructor(
    registry: SkillRegistry,
    assets: AssetRegistry,
    placementManager: FunctionalSettlementPlacementManager,
    snapshotParticipants: SnapshotParticipantRegistry,
  ) {
    this.#registry = registry;
    this.#assets = assets;
    this.#placementManager = placementManager;
    this.#snapshotParticipants = snapshotParticipants;
  }

  get size(): number { return this.#sessions.size; }
  get(namespace: string): FunctionalSettlementLiveSession | undefined { return this.#sessions.get(namespace); }

  load(input: FunctionalSettlementReleaseLoadInput): FunctionalSettlementLiveSession {
    const namespace = safeNamespace(input.namespace);
    if (this.#sessions.has(namespace)) throw new Error(`functional settlement live host already owns namespace '${namespace}'`);
    if (typeof input.read !== "function" || typeof input.invokeBase !== "function") throw new TypeError("functional settlement live host requires exact reader and invocation authority");

    const cache = new Map<string, Uint8Array>();
    const read = (path: string): Uint8Array => {
      const prior = cache.get(path);
      if (prior !== undefined) return prior;
      const bytes = input.read(path);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new Error(`functional settlement live host could not read exact bytes '${path}'`);
      cache.set(path, bytes);
      return bytes;
    };
    const release = loadApprovedFunctionalSettlementRelease(read(input.releasePath), read) as any;

    const warm = (assetId: string, path: string, expectedRawHash: string): void => {
      const exact = read(path);
      if (rawHash(exact) !== expectedRawHash) throw new Error(`functional settlement live host runtime asset '${assetId}' drifted after release verification`);
      if (this.#assets.has(assetId)) {
        const resident = this.#assets.resolve(assetId).bytes;
        if (resident.byteLength !== exact.byteLength || rawHash(resident) !== expectedRawHash) {
          throw new Error(`functional settlement live host AssetRegistry already contains conflicting bytes for '${assetId}'`);
        }
      } else {
        this.#assets.seed(assetId, exact);
      }
    };
    for (const entry of release.publication.catalog.entries) {
      const path = release.publication.asset.path;
      if (path !== `assets/${entry.asset.assetId}`) throw new Error(`functional settlement live host publication path drifted for '${entry.asset.assetId}'`);
      warm(entry.asset.assetId, path, entry.asset.hash);
    }
    for (const site of release.release.sites) warm(site.path, site.path, site.sha256);

    const residency = createReleasedFunctionalSettlementRuntimeResidency(this.#registry, this.#placementManager, {
      namespace,
      release,
      invokeBase: input.invokeBase,
    });
    const participant = createReleasedFunctionalSettlementSnapshotParticipant({
      namespace,
      release,
      residency,
      placementManager: this.#placementManager,
    });
    this.#snapshotParticipants.register(participant);
    let session!: FunctionalSettlementLiveSession;
    session = new LiveSession(release, namespace, residency, () => {
      if (this.#sessions.get(namespace) !== session) throw new Error(`functional settlement live host lost ownership of namespace '${namespace}'`);
      if (!this.#snapshotParticipants.unregister(participant.key, participant)) {
        throw new Error(`functional settlement live host lost snapshot participant '${participant.key}'`);
      }
      this.#sessions.delete(namespace);
    });
    this.#sessions.set(namespace, session);
    return session;
  }

  async close(): Promise<void> {
    const failures: unknown[] = [];
    for (const session of [...this.#sessions.values()].sort((a, b) => a.namespace.localeCompare(b.namespace))) {
      try { await session.close(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "functional settlement live host teardown failed");
  }
}
