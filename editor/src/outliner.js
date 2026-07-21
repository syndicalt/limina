const DEFAULT_PAGE_SIZE = 500;
export const MAX_OUTLINER_ENTITIES = 20_000;
const OUTLINER_ROW_HEIGHT = 24;
const OUTLINER_OVERSCAN = 8;

const compareCodeUnits = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function entityId(record) {
  return typeof record?.entity === "string" && record.entity.length > 0 ? record.entity : undefined;
}

export class SnapshotPageLoader {
  constructor({ pageSize = DEFAULT_PAGE_SIZE, totalCap = MAX_OUTLINER_ENTITIES } = {}) {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new TypeError("pageSize must be 1..500");
    if (!Number.isInteger(totalCap) || totalCap < 1) throw new TypeError("totalCap must be a positive integer");
    this.pageSize = pageSize;
    this.totalCap = totalCap;
    this.generation = 0;
  }

  cancel() {
    this.generation++;
  }

  async load(client) {
    if (!client || typeof client.callTool !== "function") throw new TypeError("snapshot client is required");
    const generation = ++this.generation;
    const entities = [];
    const seenEntities = new Set();
    const seenCursors = new Set();
    let afterEntity;
    let firstPage;
    let expectedTotal;
    let entityVersion;

    while (true) {
      let page;
      try {
        page = await client.callTool("inspector.snapshot", {
          ...(afterEntity === undefined ? {} : { afterEntity }),
          ...(entityVersion === undefined ? {} : { entityVersion }),
          limit: this.pageSize,
          includeResources: false,
          includeSkills: false,
        });
      } catch (error) {
        if (generation !== this.generation) return undefined;
        throw error;
      }
      if (generation !== this.generation) return undefined;
      if (!page || !Array.isArray(page.entities) || !page.page || !Number.isInteger(page.page.totalEntities) ||
          !Number.isInteger(page.page.entityVersion) || page.page.entityVersion < 0) {
        throw new Error("inspector.snapshot returned an invalid page");
      }
      if (page.page.totalEntities < 0 || page.page.totalEntities > this.totalCap) {
        throw new Error(`world contains ${page.page.totalEntities} entities; Outliner cap is ${this.totalCap}`);
      }
      if (expectedTotal === undefined) expectedTotal = page.page.totalEntities;
      else if (page.page.totalEntities !== expectedTotal) throw new Error("entity count changed during paginated snapshot");
      if (entityVersion === undefined) entityVersion = page.page.entityVersion;
      else if (page.page.entityVersion !== entityVersion) throw new Error("entity version changed during paginated snapshot");
      if (firstPage === undefined) firstPage = page;
      for (const record of page.entities) {
        const id = entityId(record);
        if (id === undefined || seenEntities.has(id)) throw new Error("inspector.snapshot returned an invalid or duplicate entity id");
        seenEntities.add(id);
        entities.push(record);
        if (entities.length > this.totalCap) throw new Error(`Outliner entity cap ${this.totalCap} exceeded`);
      }
      const cursor = page.page.nextAfterEntity;
      if (cursor === null) break;
      if (typeof cursor !== "string" || cursor.length === 0 || seenCursors.has(cursor) || !seenEntities.has(cursor)) {
        throw new Error("inspector.snapshot pagination cursor did not advance");
      }
      seenCursors.add(cursor);
      afterEntity = cursor;
    }
    if (entities.length !== expectedTotal) {
      throw new Error(`inspector.snapshot returned ${entities.length} of ${expectedTotal} entities`);
    }
    return { ...firstPage, entities, page: { ...firstPage.page, limit: this.pageSize, nextAfterEntity: null } };
  }
}

export function buildOutlinerForest(records) {
  const byId = new Map();
  for (const record of records ?? []) {
    const id = entityId(record);
    if (id !== undefined && !byId.has(id)) byId.set(id, record);
  }
  const ids = [...byId.keys()].sort(compareCodeUnits);
  const parentById = new Map();
  const orphaned = new Set();
  const cycleBroken = new Set();
  for (const id of ids) {
    const parent = byId.get(id)?.parent;
    if (typeof parent !== "string" || parent.length === 0) continue;
    if (parent === id) { cycleBroken.add(id); continue; }
    if (!byId.has(parent)) { orphaned.add(id); continue; }
    parentById.set(id, parent);
  }

  const complete = new Set();
  for (const start of ids) {
    if (complete.has(start)) continue;
    const path = [];
    const pathIndex = new Map();
    let current = start;
    while (current !== undefined && !complete.has(current)) {
      const repeatedAt = pathIndex.get(current);
      if (repeatedAt !== undefined) {
        const cycle = path.slice(repeatedAt);
        const root = [...cycle].sort(compareCodeUnits)[0];
        parentById.delete(root);
        cycleBroken.add(root);
        break;
      }
      pathIndex.set(current, path.length);
      path.push(current);
      current = parentById.get(current);
    }
    for (const id of path) complete.add(id);
  }

  const nodes = new Map(ids.map((id) => [id, {
    id,
    record: byId.get(id),
    children: [],
    orphaned: orphaned.has(id),
    cycleBroken: cycleBroken.has(id),
  }]));
  const roots = [];
  for (const id of ids) {
    const parent = parentById.get(id);
    if (parent === undefined) roots.push(nodes.get(id));
    else nodes.get(parent).children.push(nodes.get(id));
  }
  return roots;
}

export function filterOutlinerForest(roots, query) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (needle === "") return roots;
  const output = [];
  const stack = roots.slice().reverse().map((node) => ({ node, visited: false, target: output }));
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame.visited) {
      const clone = { ...frame.node, children: [] };
      stack.push({ ...frame, visited: true, clone });
      for (let index = frame.node.children.length - 1; index >= 0; index--) {
        stack.push({ node: frame.node.children[index], visited: false, target: clone.children });
      }
    } else {
      const tags = Array.isArray(frame.node.record?.tags) ? frame.node.record.tags.join(" ") : "";
      if (`${frame.node.id} ${tags}`.toLowerCase().includes(needle) || frame.clone.children.length > 0) {
        frame.target.push(frame.clone);
      }
    }
  }
  return output;
}

export function createOutlinerView(root, selection) {
  if (!root || !selection) throw new TypeError("Outliner root and selection store are required");
  const state = {
    records: [],
    expanded: new Set(),
    knownRoots: new Set(),
    query: "",
    signature: undefined,
    visible: [],
    parentById: new Map(),
  };
  const search = document.createElement("input");
  search.type = "search";
  search.className = "outliner-search";
  search.placeholder = "Filter entities";
  search.setAttribute("aria-label", "Filter entities");
  const tree = document.createElement("div");
  tree.className = "outliner-tree";
  tree.setAttribute("role", "tree");
  const spacer = document.createElement("div");
  spacer.className = "outliner-spacer";
  const layer = document.createElement("div");
  layer.className = "outliner-layer";
  const empty = document.createElement("div");
  empty.className = "muted outliner-empty";
  tree.append(spacer, layer, empty);
  root.replaceChildren(search, tree);
  const renderedRows = new Map();

  function flatten(forest) {
    const visible = [];
    const stack = forest.slice().reverse().map((node) => ({ node, depth: 0 }));
    while (stack.length > 0) {
      const entry = stack.pop();
      visible.push(entry);
      const open = state.query.trim() !== "" || state.expanded.has(entry.node.id);
      if (open) {
        for (let index = entry.node.children.length - 1; index >= 0; index--) {
          stack.push({ node: entry.node.children[index], depth: entry.depth + 1 });
        }
      }
    }
    return visible;
  }

  function renderWindow() {
    renderedRows.clear();
    layer.innerHTML = "";
    const viewportRows = Math.ceil((tree.clientHeight || 320) / OUTLINER_ROW_HEIGHT);
    const start = Math.max(0, Math.floor(tree.scrollTop / OUTLINER_ROW_HEIGHT) - OUTLINER_OVERSCAN);
    const end = Math.min(state.visible.length, start + viewportRows + OUTLINER_OVERSCAN * 2);
    layer.style.transform = `translateY(${start * OUTLINER_ROW_HEIGHT}px)`;
    for (let index = start; index < end; index++) {
      const { node, depth } = state.visible[index];
      const row = document.createElement("div");
      row.className = "outliner-row";
      row.dataset.entityId = node.id;
      row.setAttribute("role", "treeitem");
      row.setAttribute("aria-level", String(depth + 1));
      row.classList.toggle("selected", selection.get() === node.id);
      row.style.setProperty("--outliner-depth", String(depth));
      const hasChildren = node.children.length > 0;
      const open = state.query.trim() !== "" || state.expanded.has(node.id);
      if (hasChildren) row.setAttribute("aria-expanded", String(open));
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "outliner-toggle";
      toggle.textContent = hasChildren ? (open ? "▾" : "▸") : "";
      toggle.disabled = !hasChildren;
      toggle.title = hasChildren ? (open ? "Collapse" : "Expand") : "";
      toggle.setAttribute("aria-label", hasChildren ? `${open ? "Collapse" : "Expand"} ${node.id}` : "Leaf entity");
      toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!hasChildren) return;
        if (open) state.expanded.delete(node.id); else state.expanded.add(node.id);
        renderStructure();
      });
      const label = document.createElement("span");
      label.className = "outliner-label mono";
      label.textContent = node.id;
      row.append(toggle, label);
      if (node.orphaned || node.cycleBroken) {
        const warning = document.createElement("span");
        warning.className = "outliner-warning";
        warning.textContent = "!";
        warning.title = node.orphaned ? "Missing parent" : "Hierarchy cycle repaired for display";
        row.appendChild(warning);
      }
      row.addEventListener("click", () => selection.select(node.id, "outliner"));
      renderedRows.set(node.id, row);
      layer.appendChild(row);
    }
  }

  function renderStructure() {
    const scrollTop = tree.scrollTop;
    const forest = filterOutlinerForest(buildOutlinerForest(state.records), state.query);
    state.parentById.clear();
    const hierarchy = forest.slice().reverse().map((node) => ({ node, parentId: undefined }));
    while (hierarchy.length > 0) {
      const { node, parentId } = hierarchy.pop();
      if (parentId !== undefined) state.parentById.set(node.id, parentId);
      for (let index = node.children.length - 1; index >= 0; index--) {
        hierarchy.push({ node: node.children[index], parentId: node.id });
      }
    }
    state.visible = flatten(forest);
    spacer.style.height = `${state.visible.length * OUTLINER_ROW_HEIGHT}px`;
    empty.hidden = state.visible.length > 0;
    empty.textContent = state.query ? "no matching entities" : "no entities";
    tree.scrollTop = scrollTop;
    renderWindow();
  }

  function revealSelection(selectedId) {
    if (selectedId === undefined || !state.records.some((record) => entityId(record) === selectedId)) return;
    let expanded = false;
    let parentId = state.parentById.get(selectedId);
    while (parentId !== undefined) {
      if (!state.expanded.has(parentId)) {
        state.expanded.add(parentId);
        expanded = true;
      }
      parentId = state.parentById.get(parentId);
    }
    if (expanded) renderStructure();
    const selectedIndex = state.visible.findIndex((entry) => entry.node.id === selectedId);
    if (selectedIndex < 0) return;
    const rowTop = selectedIndex * OUTLINER_ROW_HEIGHT;
    const rowBottom = rowTop + OUTLINER_ROW_HEIGHT;
    const viewportBottom = tree.scrollTop + (tree.clientHeight || 320);
    let scrolled = false;
    if (rowTop < tree.scrollTop) {
      tree.scrollTop = rowTop;
      scrolled = true;
    } else if (rowBottom > viewportBottom) {
      tree.scrollTop = rowBottom - (tree.clientHeight || 320);
      scrolled = true;
    }
    if (scrolled) renderWindow();
  }

  search.addEventListener("input", () => { state.query = search.value; renderStructure(); });
  tree.addEventListener("scroll", renderWindow, { passive: true });
  const unsubscribe = selection.subscribe(({ selectedId, previousId, source }) => {
    if (previousId !== undefined) renderedRows.get(previousId)?.classList.remove("selected");
    if (selectedId !== undefined) renderedRows.get(selectedId)?.classList.add("selected");
    if (source !== "outliner") revealSelection(selectedId);
  });
  return {
    setEntities(records) {
      const next = Array.isArray(records) ? records : [];
      const signature = JSON.stringify(next.map((record) => [
        entityId(record),
        typeof record?.parent === "string" ? record.parent : null,
        Array.isArray(record?.tags) ? record.tags : [],
      ]).sort((left, right) => compareCodeUnits(left[0] ?? "", right[0] ?? "")));
      if (signature === state.signature) return false;
      state.records = next;
      state.signature = signature;
      const ids = new Set(next.map(entityId).filter(Boolean));
      for (const id of [...state.expanded]) if (!ids.has(id)) state.expanded.delete(id);
      const roots = buildOutlinerForest(next);
      const nextRoots = new Set(roots.map((node) => node.id));
      for (const id of nextRoots) if (!state.knownRoots.has(id)) state.expanded.add(id);
      state.knownRoots = nextRoots;
      renderStructure();
      return true;
    },
    destroy() { unsubscribe(); tree.removeEventListener("scroll", renderWindow); root.replaceChildren(); },
  };
}
