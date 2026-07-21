import * as THREE from "../../build/three.bundle.mjs";
import type { TreePopulationBuildInput, TreePopulationMount } from "./tree-population-residency.ts";
import type { SelectedTreeInstance, TreePopulationPageSelection } from "./tree-population-plan.ts";
import { TreeSpeciesBatchAdapter, aggregateTreeSpeciesBatchMetrics, type TreeSpeciesBatchMetrics } from "./tree-population-batch.ts";

interface PublishedPage { readonly token: number; readonly selection: TreePopulationPageSelection }

/** Shared global batches: page commits mutate compacted species buffers, never allocate meshes per page. */
export class TreePopulationBatchSet {
  readonly root = new THREE.Group();
  readonly metrics: TreeSpeciesBatchMetrics;
  private readonly species = new Map<string, TreeSpeciesBatchAdapter>();
  private readonly pages = new Map<string, PublishedPage>();
  private anchorX = 0;
  private anchorZ = 0;
  private token = 0;
  private disposed = false;

  constructor(adapters: readonly TreeSpeciesBatchAdapter[]) {
    if (adapters.length === 0) throw new RangeError("tree population batch set requires at least one species adapter");
    for (const adapter of adapters) {
      if (this.species.has(adapter.speciesId)) throw new RangeError(`tree population batch species '${adapter.speciesId}' is duplicated`);
      this.species.set(adapter.speciesId, adapter); this.root.add(adapter.root);
    }
    this.root.name = "limina-tree-population-batches";
    this.metrics = aggregateTreeSpeciesBatchMetrics(adapters.map((adapter) => adapter.metrics));
  }

  buildMount(input: TreePopulationBuildInput): TreePopulationMount {
    if (this.disposed) throw new Error("tree population batch set is disposed");
    let committedToken: number | undefined, released = false;
    return Object.freeze({
      trees: input.selection.instances.length,
      commit: () => {
        if (released) throw new Error(`tree page '${input.selection.key}' candidate is already released`);
        committedToken = this.publishPage(input.selection, input.anchorX, input.anchorZ);
      },
      dispose: () => {
        if (released) return; released = true;
        if (committedToken !== undefined) this.removePage(input.selection.key, committedToken);
      },
    });
  }

  pageKeys(): readonly string[] { return Object.freeze([...this.pages.keys()].sort()); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.pages.clear();
    const errors: unknown[] = [];
    for (const adapter of this.species.values()) {
      try { this.root.remove(adapter.root); } catch (error) { errors.push(error); }
      try { adapter.dispose(); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, `tree population batch-set disposal failed in ${errors.length} operation(s)`);
  }

  private publishPage(selection: TreePopulationPageSelection, anchorX: number, anchorZ: number): number {
    this.validateSelection(selection);
    const priorPages = new Map(this.pages), priorAnchorX = this.anchorX, priorAnchorZ = this.anchorZ;
    const token = ++this.token;
    this.pages.set(selection.key, { token, selection });
    try { this.publishAll(anchorX, anchorZ); }
    catch (primary) {
      this.pages.clear(); for (const [key, value] of priorPages) this.pages.set(key, value);
      try { this.publishAll(priorAnchorX, priorAnchorZ); }
      catch (rollback) { throw new AggregateError([primary, rollback], `tree page '${selection.key}' publication rollback failed`); }
      throw primary;
    }
    return token;
  }

  private removePage(key: string, token: number): void {
    const current = this.pages.get(key);
    if (current?.token !== token) return;
    this.pages.delete(key);
    try { this.publishAll(this.anchorX, this.anchorZ); }
    catch (primary) {
      this.pages.set(key, current);
      try { this.publishAll(this.anchorX, this.anchorZ); }
      catch (rollback) { throw new AggregateError([primary, rollback], `tree page '${key}' removal rollback failed`); }
      throw primary;
    }
  }

  private validateSelection(selection: TreePopulationPageSelection): void {
    for (const tree of selection.instances) if (!this.species.has(tree.speciesId)) {
      throw new RangeError(`tree page '${selection.key}' references unmounted species '${tree.speciesId}'`);
    }
  }

  private publishAll(anchorX: number, anchorZ: number): void {
    const selected = new Map<string, SelectedTreeInstance[]>([...this.species.keys()].map((id) => [id, []]));
    for (const page of [...this.pages.values()].sort((a, b) => a.selection.pageZ - b.selection.pageZ || a.selection.pageX - b.selection.pageX)) {
      for (const tree of page.selection.instances) selected.get(tree.speciesId)!.push(tree);
    }
    for (const [id, adapter] of this.species) adapter.publish(selected.get(id)!, anchorX, anchorZ);
    this.root.position.set(0, 0, 0); this.anchorX = anchorX; this.anchorZ = anchorZ;
  }
}
