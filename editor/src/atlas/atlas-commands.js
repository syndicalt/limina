// Atlas undo commands (Editor 2.0): the commit seam for the native Atlas surface.
// Faithful to the original map-commands.js semantics — every mutation is
// a {label, redo, undo} closure holding its own before/after slices; rasters are
// only ever written through the bbox patch writer, so undo of a stroke restores
// EXACTLY the pre-stroke cells (and bumps rev, invalidating render caches both
// ways). Ported here because the editor page cannot import the old frontend dir;
// the old module retired with the SPA (2.0-A) and now lives at
// tools/design/map-commands.js for the mapstudio gate.

/** Snapshot a raster bbox (row-major slice). */
export function snapshotBBox(raster, bbox) {
  const { c0, r0, c1, r1 } = bbox;
  const bw = c1 - c0 + 1;
  const bh = r1 - r0 + 1;
  const out = new raster.cells.constructor(bw * bh);
  for (let r = 0; r < bh; r++) {
    out.set(raster.cells.subarray((r0 + r) * raster.w + c0, (r0 + r) * raster.w + c0 + bw), r * bw);
  }
  return out;
}

/** Union of two bboxes (stroke = many dabs, one command). */
export function bboxUnion(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  return {
    c0: Math.min(a.c0, b.c0),
    r0: Math.min(a.r0, b.r0),
    c1: Math.max(a.c1, b.c1),
    r1: Math.max(a.r1, b.r1),
  };
}

/** One stroke's before/after bbox slices as an undoable command. */
export function cmdPatchRaster(mapId, raster, bbox, before, after, label = "brush stroke") {
  const { c0, r0, c1, r1 } = bbox;
  const bw = c1 - c0 + 1;
  const bh = r1 - r0 + 1;
  if (before.length !== bw * bh || after.length !== bw * bh) return null;
  const b = before.slice();
  const a = after.slice();
  const write = (patch) => {
    for (let r = 0; r < bh; r++) {
      raster.cells.set(patch.subarray(r * bw, (r + 1) * bw), (r0 + r) * raster.w + c0);
    }
    raster.dirty = true;
    raster.rev = (raster.rev || 0) + 1;
  };
  return {
    label,
    mapId,
    redo() { write(a); },
    undo() { write(b); },
  };
}

/** A scalar map property (sea level, units) as an undoable command. */
export function cmdSetMapProp(mapId, doc, key, before, after) {
  return {
    label: `set ${key}`,
    mapId,
    redo() { doc[key] = after; },
    undo() { doc[key] = before; },
  };
}

/** Session undo stack (cap 100, matching the original's retention contract). */
export function createUndoStack(capacity = 100) {
  const entries = [];
  let cursor = 0; // entries[cursor] is the next redo; cursor === entries.length at tip
  return Object.freeze({
    push(cmd) {
      if (cmd === null || cmd === undefined) return;
      entries.length = cursor; // a new command kills the redo tail
      entries.push(cmd);
      if (entries.length > capacity) entries.shift();
      cursor = entries.length;
    },
    undo() {
      if (cursor === 0) return undefined;
      const cmd = entries[cursor - 1];
      cmd.undo();
      cursor--;
      return cmd.label;
    },
    redo() {
      if (cursor === entries.length) return undefined;
      const cmd = entries[cursor];
      cmd.redo();
      cursor++;
      return cmd.label;
    },
    get depth() { return cursor; },
    get redoDepth() { return entries.length - cursor; },
  });
}
