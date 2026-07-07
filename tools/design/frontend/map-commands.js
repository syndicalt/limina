// map-commands.js — the Map Studio undo/redo command stack. PURE and DOM-free by contract:
// every command operates only on the map object it is given (features array + map props), so the
// mapstudio gate can import this file in Node and property-test that undo(redo(map)) restores the
// exact original for every command type. Keep it that way — a `document.` reference in here breaks
// the gate, and untested undo is worse than no undo.
//
// Model: a command is { label, mapId, redo(map), undo(map) }. Interactive mutations (drags) happen
// live during the gesture; the command is pushed AFTER with { applied: true } so push() doesn't
// re-apply it. History is session-memory only (does not survive a reload) — stated in the UI hint.

export function createHistory(limit = 100) {
  return { undo: [], redo: [], limit };
}

/** Push a command. If opts.applied, the mutation already happened (drag-commit pattern) and redo()
 *  is NOT called now. Any new command invalidates the redo stack. */
export function push(history, cmd, opts = {}, map = null) {
  if (!opts.applied) cmd.redo(map);
  history.undo.push(cmd);
  if (history.undo.length > history.limit) history.undo.shift();
  history.redo.length = 0;
  return cmd;
}

/** Undo the most recent command against `resolveMap(mapId)`. Returns the command (for redraw /
 *  save scheduling) or null. A command whose map no longer resolves is dropped, not an error. */
export function undo(history, resolveMap) {
  const cmd = history.undo.pop();
  if (!cmd) return null;
  const map = resolveMap(cmd.mapId);
  if (!map) return undo(history, resolveMap);
  cmd.undo(map);
  history.redo.push(cmd);
  return cmd;
}

export function redo(history, resolveMap) {
  const cmd = history.redo.pop();
  if (!cmd) return null;
  const map = resolveMap(cmd.mapId);
  if (!map) return redo(history, resolveMap);
  cmd.redo(map);
  history.undo.push(cmd);
  return cmd;
}

// ---- command constructors ---------------------------------------------------------------------
// Each captures the minimal before-state it needs as a deep snapshot (features are small plain
// JSON; rasters get patch-based commands in S1, built on this same stack API).

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const idx = (map, fid) => map.features.findIndex((f) => f.id === fid);

export function cmdAddFeature(mapId, feature) {
  const snap = clone(feature);
  return {
    label: "add " + (feature.kind || feature.type),
    mapId,
    redo(map) { map.features.push(clone(snap)); },
    undo(map) { const i = idx(map, snap.id); if (i >= 0) map.features.splice(i, 1); },
  };
}

export function cmdDeleteFeature(mapId, map, fid) {
  const i = idx(map, fid);
  if (i < 0) return null;
  const snap = clone(map.features[i]);
  return {
    label: "delete " + (snap.kind || snap.type),
    mapId,
    redo(m) { const j = idx(m, fid); if (j >= 0) m.features.splice(j, 1); },
    undo(m) { m.features.splice(Math.min(i, m.features.length), 0, clone(snap)); },
  };
}

export function cmdDeleteFeatures(mapId, map, fids) {
  const set = new Set(fids);
  const snaps = map.features.map((f, i) => (set.has(f.id) ? { i, f: clone(f) } : null)).filter(Boolean);
  if (snaps.length === 0) return null;
  return {
    label: "delete " + snaps.length + " features",
    mapId,
    redo(m) { m.features = m.features.filter((f) => !set.has(f.id)); },
    undo(m) { for (const s of snaps) m.features.splice(Math.min(s.i, m.features.length), 0, clone(s.f)); },
  };
}

export function cmdClearFeatures(mapId, map) {
  const snap = clone(map.features);
  if (snap.length === 0) return null;
  return {
    label: "clear features",
    mapId,
    redo(m) { m.features = []; },
    undo(m) { m.features = clone(snap); },
  };
}

/** Property edit (inspector save): captures the before-values of exactly the patched keys,
 *  including keys the patch introduces (before === undefined → undo deletes them). */
export function cmdUpdateFeature(mapId, map, fid, patch) {
  const i = idx(map, fid);
  if (i < 0) return null;
  const before = {};
  for (const k of Object.keys(patch)) before[k] = clone(map.features[i][k]);
  const after = clone(patch);
  const applyTo = (m, vals) => {
    const j = idx(m, fid);
    if (j < 0) return;
    for (const [k, v] of Object.entries(vals)) {
      if (v === undefined) delete m.features[j][k];
      else m.features[j][k] = clone(v);
    }
  };
  return {
    label: "edit feature",
    mapId,
    redo(m) { applyTo(m, after); },
    undo(m) { applyTo(m, before); },
  };
}

/** Geometry drag commit (whole-feature move or single-vertex move): before/after snapshots of the
 *  geometry captured at gesture start/end. `geom` is {points} or {x,z} depending on feature type. */
export function cmdMoveFeature(mapId, fid, before, after) {
  const b = clone(before), a = clone(after);
  const applyTo = (m, g) => {
    const j = idx(m, fid);
    if (j < 0) return;
    if (g.points !== undefined) m.features[j].points = clone(g.points);
    if (g.x !== undefined) { m.features[j].x = g.x; m.features[j].z = g.z; }
  };
  return {
    label: "move feature",
    mapId,
    redo(m) { applyTo(m, a); },
    undo(m) { applyTo(m, b); },
  };
}

/** A raster brush stroke (Map Studio S1): before/after u8 snapshots of the cell BBOX the stroke
 *  touched, applied to a live raster store entry ({w, h, cells: Uint8Array, dirty}) held by
 *  closure — the raster lives OUTSIDE the doc (decoded once per map), so this command targets it
 *  directly rather than re-resolving through the map. Stays pure/DOM-free: the gate constructs a
 *  raster object and property-tests inversion exactly like the feature commands. */
export function cmdPatchRaster(mapId, raster, bbox, before, after) {
  const { c0, r0, c1, r1 } = bbox;
  const bw = c1 - c0 + 1, bh = r1 - r0 + 1;
  if (before.length !== bw * bh || after.length !== bw * bh) return null;
  const b = before.slice(), a = after.slice();
  const write = (patch) => {
    for (let r = 0; r < bh; r++) raster.cells.set(patch.subarray(r * bw, (r + 1) * bw), (r0 + r) * raster.w + c0);
    raster.dirty = true;
  };
  return {
    label: "elevation stroke",
    mapId,
    redo() { write(a); },
    undo() { write(b); },
  };
}

/** Move/resize the elevation region (Map Studio S1 UAT: the region must be user-adjustable).
 *  Same closure-held raster-store pattern as cmdPatchRaster; the cells are untouched — the rect
 *  is pure world-space metadata, so moving it slides the painted terrain and resizing stretches
 *  it (predictable, and exactly what the rasterizer's rect projection does). */
export function cmdSetRasterRect(mapId, raster, before, after) {
  const b = clone(before), a = clone(after);
  return {
    label: "move/resize elevation region",
    mapId,
    redo() { raster.rect = clone(a); raster.dirty = true; },
    undo() { raster.rect = clone(b); raster.dirty = true; },
  };
}

/** Snapshot a raster bbox (row-major slice) — the capture half of cmdPatchRaster. */
export function rasterBboxSnapshot(raster, bbox) {
  const { c0, r0, c1, r1 } = bbox;
  const bw = c1 - c0 + 1, bh = r1 - r0 + 1;
  const out = new Uint8Array(bw * bh);
  for (let r = 0; r < bh; r++) out.set(raster.cells.subarray((r0 + r) * raster.w + c0, (r0 + r) * raster.w + c1 + 1), r * bw);
  return out;
}

/** Map-level scalar prop (e.g. the sea toggle). */
export function cmdSetMapProp(mapId, key, before, after) {
  const b = clone(before), a = clone(after);
  const set = (m, v) => { if (v === undefined) delete m[key]; else m[key] = clone(v); };
  return {
    label: "set " + key,
    mapId,
    redo(m) { set(m, a); },
    undo(m) { set(m, b); },
  };
}
