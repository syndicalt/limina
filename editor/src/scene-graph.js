// Scene-graph membership — the predicate behind the viewport's selection guard.
//
// TransformControls throws "The attached 3D object must be a part of the scene graph" every frame
// once its attached object is removed from the scene (e.g. the selected entity is deleted via the
// World panel, an agent, or a recorded-stream re-author — any path that ISN'T the viewport's own
// Delete key, which detaches first). Left unchecked it floods the console and wedges the app.
//
// isAttachedToScene walks the object's parent chain: it is still in the graph iff the walk reaches
// `root` (the live scene). Pure + THREE-agnostic (only reads `.parent`), so it is unit-testable
// headlessly without a renderer or DOM.

/** True iff `object` is still connected to `root` through its parent chain. A removed object
 *  (parent === null, or re-parented off the scene) yields false. Null/undefined → false. */
export function isAttachedToScene(object, root) {
  if (!object || !root) return false;
  let node = object;
  // Bound the walk defensively so a corrupted/cyclic graph can never spin forever.
  for (let guard = 0; node && guard < 4096; guard++) {
    if (node === root) return true;
    node = node.parent;
  }
  return false;
}
