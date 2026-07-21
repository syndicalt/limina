// D5.2 optimistic sculpt preview — displace the LIVE derived chunk meshes under the
// brush the moment a dab fires, so the terrain morphs under the cursor instead of
// waiting seconds for the derived recompile. EDITOR-LOCAL and non-authoritative:
//   - The recorded terrain.deform commits the SAME math authority-side
//     (materializeTerrainBrushOp -> js/src/terrain/brush-kernel.mjs). The kernel is
//     INJECTED here (the viewport imports the terrainBrushKernel namespace from the
//     vendor bundle; node tests pass the module directly) — never copied.
//   - The recompiled revision lands by REMOUNTING the touched chunks (content
//     delta), wholesale replacing the previewed meshes — the preview never
//     accumulates on top of a revision, so no drift correction is needed.
//   - Physics is NOT previewed: the brush raycasts scene meshes (raycastGround over
//     scene.children), never colliders, and the recompile's content-delta swaps
//     colliders within seconds — a render-only preview cannot strand anything on
//     phantom geometry during an edit session.
// Modes: raise/lower only. smooth/flatten reject authority-side (no composed-height
// sampler wired) so previewing them would lie; noise is unreachable from the ribbon
// (its lattice key needs the base-topology domain the editor does not hold).

/** Derived chunk meshes under root. userData.derivedTerrain is set by the engine's
 *  featureLocalTerrainMesh; the coarse world-overview mesh (derivedWorldOverview)
 *  is deliberately excluded — it culls its quads wherever fine chunks reside. */
export function collectDerivedTerrainMeshes(root) {
  const meshes = [];
  const visit = (node) => {
    if (node?.userData?.derivedTerrain === true && node.geometry?.attributes?.position) meshes.push(node);
    const children = node?.children;
    if (Array.isArray(children)) for (const child of children) visit(child);
  };
  visit(root);
  return meshes;
}

/** Displace every in-radius vertex of the given derived chunk meshes by the same
 *  falloff math as materializeTerrainBrushOp. Chunk meshes are translate-only
 *  (featureLocalTerrainMesh bakes the tile origin into mesh.position and the
 *  ancestor groups sit at the world origin), so world = mesh.position + local.
 *  The Float32Array store rounds (y + deltaM) exactly like the composition's
 *  Math.fround per-op apply, so preview heights match the revision bit-for-bit.
 *  Returns an undo token for rollbackSculptPreview, or null when nothing moved. */
export function applySculptPreview(meshes, dab, kernel) {
  // Mode guard lives HERE (not only in the caller): smooth/flatten reject authority-side
  // (no composed-height sampler) and noise is ribbon-unreachable, so previewing them
  // would promise a morph the recorded dab never delivers.
  if (dab.mode !== "raise" && dab.mode !== "lower") return null;
  const [cx, cz] = dab.center;
  const touched = [];
  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    const attribute = geometry.attributes.position;
    const array = attribute.array;
    if (!(array instanceof Float32Array)) continue;
    const px = mesh.position.x, pz = mesh.position.z;
    let before = null;
    for (let i = 0; i + 2 < array.length; i += 3) {
      const f = kernel.brushWeightAt(dab.falloff, px + array[i], pz + array[i + 2], cx, cz, dab.radius);
      if (f === 0) continue; // outside the radius or a zero-weight rim — no edit, mirrors the kernel
      const deltaM = dab.mode === "lower" ? -(dab.delta * f) : dab.delta * f; // raise/lower, kernel-exact
      if (deltaM === 0) continue;
      if (before === null) { before = Float32Array.from(array); touched.push({ mesh, before }); }
      array[i + 1] += deltaM;
    }
    if (before !== null) refreshDisplacedGeometry(geometry, attribute);
  }
  return touched.length === 0 ? null : { touched };
}

/** Restore every previewed mesh byte-identical (the dab's recorded commit failed).
 *  Normals/bounds recompute from the restored positions, so a rolled-back mesh is
 *  indistinguishable from never-touched. */
export function rollbackSculptPreview(token) {
  for (const { mesh, before } of token.touched) {
    const geometry = mesh.geometry;
    const attribute = geometry?.attributes?.position;
    if (attribute?.array === undefined || attribute.array.length !== before.length) continue;
    attribute.array.set(before);
    refreshDisplacedGeometry(geometry, attribute);
  }
}

function refreshDisplacedGeometry(geometry, attribute) {
  attribute.needsUpdate = true;
  // computeVertexNormals is the same area-weighted accumulate-then-normalize pass the
  // engine's terrainTileGeometry runs over the same index winding.
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere(); // raycastGround's early-out must follow the raised surface
}
