export class SelectionStore {
  constructor() {
    this.selectedId = undefined;
    // ALL selected ids, primary included (multi-select, 2.0-C). Empty when nothing is
    // selected; selectedId (the primary) is always a member when defined.
    this.selectedIds = new Set();
    this.listeners = new Set();
  }

  get() {
    return this.selectedId;
  }

  // Frozen defensive copy of every selected id (primary included).
  getMany() {
    return Object.freeze([...this.selectedIds]);
  }

  select(entityId, source = "unknown") {
    if (typeof entityId !== "string" || entityId.length === 0) throw new TypeError("entityId must be a non-empty string");
    return this.#set(entityId, new Set([entityId]), source);
  }

  // Multi-select: primary becomes the LAST id in the array; subscribers fire once.
  selectMany(entityIds, source = "unknown") {
    if (!Array.isArray(entityIds) || entityIds.length === 0) throw new TypeError("entityIds must be a non-empty array");
    for (const id of entityIds) {
      if (typeof id !== "string" || id.length === 0) throw new TypeError("entityIds must contain only non-empty strings");
    }
    return this.#set(entityIds[entityIds.length - 1], new Set(entityIds), source);
  }

  clear(source = "unknown") {
    return this.#set(undefined, new Set(), source);
  }

  reconcile(entityIds, source = "snapshot") {
    if (!(entityIds instanceof Set)) throw new TypeError("entityIds must be a Set");
    const surviving = new Set([...this.selectedIds].filter((id) => entityIds.has(id)));
    if (surviving.size === this.selectedIds.size) return this.selectedId;
    // The primary died: fall back to the last surviving id (selection order), or nothing.
    let primary;
    for (const id of surviving) primary = id;
    this.#set(primary, surviving, source);
    return this.selectedId;
  }

  subscribe(listener, { emitCurrent = false } = {}) {
    if (typeof listener !== "function") throw new TypeError("selection listener must be a function");
    this.listeners.add(listener);
    if (emitCurrent) {
      listener({ selectedId: this.selectedId, previousId: undefined, source: "subscribe", selectedIds: this.getMany() });
    }
    return () => this.listeners.delete(listener);
  }

  #set(selectedId, selectedIds, source) {
    if (selectedId === this.selectedId && setsEqual(selectedIds, this.selectedIds)) return false;
    const previousId = this.selectedId;
    this.selectedId = selectedId;
    this.selectedIds = selectedIds;
    // selectedIds is additive: older subscribers destructure only the original three fields.
    const change = Object.freeze({ selectedId, previousId, source, selectedIds: Object.freeze([...selectedIds]) });
    for (const listener of [...this.listeners]) listener(change);
    return true;
  }
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

export const editorSelection = new SelectionStore();
