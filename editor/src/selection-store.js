export class SelectionStore {
  constructor() {
    this.selectedId = undefined;
    this.listeners = new Set();
  }

  get() {
    return this.selectedId;
  }

  select(entityId, source = "unknown") {
    if (typeof entityId !== "string" || entityId.length === 0) throw new TypeError("entityId must be a non-empty string");
    return this.#set(entityId, source);
  }

  clear(source = "unknown") {
    return this.#set(undefined, source);
  }

  reconcile(entityIds, source = "snapshot") {
    if (!(entityIds instanceof Set)) throw new TypeError("entityIds must be a Set");
    if (this.selectedId !== undefined && !entityIds.has(this.selectedId)) this.clear(source);
    return this.selectedId;
  }

  subscribe(listener, { emitCurrent = false } = {}) {
    if (typeof listener !== "function") throw new TypeError("selection listener must be a function");
    this.listeners.add(listener);
    if (emitCurrent) listener({ selectedId: this.selectedId, previousId: undefined, source: "subscribe" });
    return () => this.listeners.delete(listener);
  }

  #set(selectedId, source) {
    if (selectedId === this.selectedId) return false;
    const previousId = this.selectedId;
    this.selectedId = selectedId;
    const change = Object.freeze({ selectedId, previousId, source });
    for (const listener of [...this.listeners]) listener(change);
    return true;
  }
}

export const editorSelection = new SelectionStore();
