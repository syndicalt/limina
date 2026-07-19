import {
  assertApprovedFunctionalSettlementFurnishingAuthority,
  resolveApprovedFunctionalSettlementFurnishing,
} from "../assets/functional-settlement-furnishing.mjs";
import type { InvokeBase, SkillRegistry } from "./registry.ts";
import type { FunctionalSettlementBuildingHandle } from "./functional-settlement.ts";

export interface FunctionalSettlementFurnishingInstanceHandle {
  readonly instanceId: string;
  readonly socketId: string;
  readonly libraryId: string;
  readonly assetId: string;
  readonly contractHash: string;
  readonly position: readonly [number, number, number];
  readonly yaw: number;
  readonly socketCount: number;
  readonly activation: "dormant-authoring-sidecar";
}

export interface FunctionalSettlementFurnishingHandle {
  readonly placementId: string;
  readonly buildingRoot: string;
  readonly variantId: string;
  readonly instances: readonly FunctionalSettlementFurnishingInstanceHandle[];
}

export interface FunctionalSettlementFurnishingRuntimeOptions {
  readonly authority: unknown;
  readonly invokeBase: () => InvokeBase;
  /** CPU fault seam used to prove group rollback before a nested furniture placement. */
  readonly beforeInstancePlacement?: (placementId: string, instanceId: string, index: number) => void | Promise<void>;
}

function rotateY(value: readonly number[], yaw: number): readonly [number, number, number] {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return Object.freeze([value[0] * c + value[2] * s, value[1], -value[0] * s + value[2] * c]);
}
function frozenHandle(value: FunctionalSettlementFurnishingHandle): FunctionalSettlementFurnishingHandle {
  return Object.freeze({ ...value, instances: Object.freeze(value.instances.map((instance) => Object.freeze({ ...instance, position: Object.freeze([...instance.position]) as readonly [number, number, number] }))) });
}

/**
 * Transactional dormant furnishing-sidecar owner for released FB-5 buildings. It resolves exact
 * approved furniture contracts and world-space sockets, but intentionally creates zero ECS entities,
 * zero meshes, and zero colliders. Invisible collision would be a gameplay defect. Actual activation
 * remains closed until a future authority binds visual=true engine evidence and fresh HITL.
 */
export class FunctionalSettlementFurnishingRuntime {
  readonly #authority: any;
  readonly #invokeBase: () => InvokeBase;
  readonly #before?: FunctionalSettlementFurnishingRuntimeOptions["beforeInstancePlacement"];
  readonly #handles = new Map<string, FunctionalSettlementFurnishingHandle>();

  constructor(registry: SkillRegistry, options: FunctionalSettlementFurnishingRuntimeOptions) {
    void registry; // Kept in the constructor so the future visual adapter cannot bypass the engine registry seam.
    this.#authority = assertApprovedFunctionalSettlementFurnishingAuthority(options.authority);
    this.#invokeBase = options.invokeBase;
    this.#before = options.beforeInstancePlacement;
  }

  get size(): number { return this.#handles.size; }
  has(placementId: string): boolean { return this.#handles.has(placementId); }
  get(placementId: string): FunctionalSettlementFurnishingHandle | undefined { return this.#handles.get(placementId); }

  async furnish(building: FunctionalSettlementBuildingHandle): Promise<FunctionalSettlementFurnishingHandle> {
    if (this.#handles.has(building.placementId)) throw new Error(`functional settlement furnishing: duplicate placement '${building.placementId}'`);
    const recipe = resolveApprovedFunctionalSettlementFurnishing(this.#authority, building.placementId);
    if (building.catalogEntryId !== this.#authority.authority.building.catalogEntryId) throw new Error(`functional settlement furnishing: building '${building.placementId}' has the wrong catalog entry`);
    const inspection = this.#invokeBase(), buildingEntity = inspection.world.entities.resolve(building.root);
    if (buildingEntity?.origin?.tool !== "building.placeFunctional") throw new Error(`functional settlement furnishing: building root '${building.root}' is not live and functional`);
    const origin = buildingEntity.origin.input as { functionalSchema?: unknown };
    if (origin.functionalSchema !== "limina.functional-building/v2") throw new Error(`functional settlement furnishing: building root '${building.root}' lost v2 semantics`);

    const staged: FunctionalSettlementFurnishingInstanceHandle[] = [];
    for (let index = 0; index < recipe.bindings.length; index++) {
      const binding = recipe.bindings[index]; await this.#before?.(building.placementId, binding.instanceId, index);
      const local = rotateY(binding.socket.position, building.yaw), position: [number, number, number] = [building.position[0] + local[0], building.position[1] + local[1], building.position[2] + local[2]];
      staged.push(Object.freeze({ instanceId: binding.instanceId, socketId: binding.socketId, libraryId: binding.libraryId,
        assetId: binding.library.asset.path.replace(/^assets\//, ""), contractHash: binding.library.contractHash,
        position: Object.freeze(position), yaw: building.yaw + binding.socket.yawRadians,
        socketCount: binding.library.contract.sockets.length, activation: "dormant-authoring-sidecar" }));
    }
    // Publish only after every binding and fault seam completed. No world mutation happened above.
    const handle = frozenHandle({ placementId: building.placementId, buildingRoot: building.root, variantId: recipe.variantId, instances: staged });
    this.#handles.set(building.placementId, handle); return handle;
  }

  /** Exact logical detach; the dormant sidecar never owned world entities. */
  async unfurnish(placementId: string): Promise<void> {
    this.#handles.delete(placementId);
  }

  /** Called only after successful whole-building teardown, which recursively owns these children. */
  ownerDestroyed(placementId: string): void { this.#handles.delete(placementId); }
}
