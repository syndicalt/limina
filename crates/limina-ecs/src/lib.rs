//! limina-ecs — native, rayon-parallel ECS hot-path ops over the zero-copy
//! JS-owned SoA component arrays. P3N-1′: a batched uniform-grid radius query
//! that is BIT-IDENTICAL to `js/src/spatial/index.ts` (`UniformGridSpatialIndex`)
//! — the JS index stays the determinism oracle.
//!
//! Bit-identical contract (matching the oracle exactly):
//!  - grid cell = `floor(coord / cellSize)` in **f64** (== JS `Math.floor`);
//!  - records carry an `order` = their index in `world.entities.ids()`; candidate
//!    records are gathered from the cell AABB and ordered by `order`;
//!  - `distance = sqrt(dx*dx + dy*dy + dz*dz)` in **f64** (f32 coords promoted to
//!    f64 exactly as JS reads a Float32Array element as a double), correctly-rounded
//!    `sqrt` (== JS `Math.sqrt`); the cutoff `distance > radius` EXCLUDES;
//!  - final order = (distance ascending, then `order` ascending) — identical to
//!    V8's stable `Array.sort` by distance over an order-ascending input.
//!
//! Grid: a CSR (counting-sort) uniform grid — distinct cells are densified via a
//! small map, records counting-sorted into ONE contiguous array (no per-bucket
//! allocation), each cell's slice left order-ascending. Built sequentially;
//! queries answered in parallel over DISJOINT output slices, so the result is
//! independent of the rayon thread count.

use deno_core::{extension, op2};
use deno_error::JsErrorBox;
use rayon::prelude::*;
use std::collections::HashMap;

/// Batched native uniform-grid radius query.
///
/// Inputs (all borrowed zero-copy from JS for the call):
///  - `px`/`py`/`pz`: the Position SoA Float32Arrays (indexed by `eid`).
///  - `ordered_eids`: active eids in `order` order (`ordered_eids[order] = eid`).
///  - `cell_size`: grid cell size (must match the JS oracle's `cellSize`).
///  - `queries`: 5 f64 per query — `[nx, ny, nz, radius, excludeEid]`
///    (`excludeEid < 0` means "no exclusion").
///  - `max_hits`: capacity per query in `out`.
///  - `out`: `K * (1 + max_hits)` u32 — per query `[count, hit0, hit1, …]`
///    (`count` is the TRUE hit count; only `min(count, max_hits)` eids are written).
#[op2(fast)]
#[allow(clippy::too_many_arguments)]
pub fn op_ecs_spatial_query_batch(
    #[buffer] px: &[f32],
    #[buffer] py: &[f32],
    #[buffer] pz: &[f32],
    #[buffer] ordered_eids: &[u32],
    cell_size: f64,
    #[buffer] queries: &[f64],
    max_hits: u32,
    #[buffer] out: &mut [u32],
) -> Result<(), JsErrorBox> {
    // Thin op wrapper: the `#[op2]` macro scopes the op type inside a generated
    // `const fn`, so the pure logic lives in a module-level fn that unit tests can
    // call directly (no JS runtime needed).
    spatial_query_batch(
        px,
        py,
        pz,
        ordered_eids,
        cell_size,
        queries,
        max_hits,
        out,
    )
}

/// Pure implementation of the batched uniform-grid radius query (see the op doc
/// above). Kept separate from the op so it is directly unit-testable.
#[allow(clippy::too_many_arguments)]
fn spatial_query_batch(
    px: &[f32],
    py: &[f32],
    pz: &[f32],
    ordered_eids: &[u32],
    cell_size: f64,
    queries: &[f64],
    max_hits: u32,
    out: &mut [u32],
) -> Result<(), JsErrorBox> {
    let n = ordered_eids.len();
    let max_hits = max_hits as usize;
    let stride = 1 + max_hits;

    // Validate the array-length invariants ONCE, here at the op boundary, before
    // the sequential build and the parallel query region. A desync between
    // `ordered_eids` and the Position SoA (a short/stale array handed over from
    // JS) would otherwise be an out-of-bounds panic mid-frame; instead surface a
    // clean error to JS. After these checks every `ordered_eids[..]` index into
    // px/py/pz is in bounds, so the hot loops can index unchecked.
    if px.len() != py.len() || px.len() != pz.len() {
        return Err(JsErrorBox::type_error(format!(
            "spatial_query_batch: position SoA arrays must be equal length (px={}, py={}, pz={})",
            px.len(),
            py.len(),
            pz.len(),
        )));
    }
    let pos_len = px.len();
    for &eid in ordered_eids {
        if eid as usize >= pos_len {
            return Err(JsErrorBox::type_error(format!(
                "spatial_query_batch: eid {eid} out of bounds for position SoA of length {pos_len}"
            )));
        }
    }

    // Record coords (f32 -> f64, matching JS reads) and the dense cell index of
    // each record. `cell_map` densifies the distinct cells actually occupied.
    let mut rx = vec![0f64; n];
    let mut ry = vec![0f64; n];
    let mut rz = vec![0f64; n];
    let mut cell_of = vec![0u32; n];
    let mut cell_map: HashMap<(i64, i64, i64), u32> = HashMap::with_capacity(n);
    let mut counts: Vec<u32> = Vec::new();
    for order in 0..n {
        let eid = ordered_eids[order] as usize;
        let x = px[eid] as f64;
        let y = py[eid] as f64;
        let z = pz[eid] as f64;
        rx[order] = x;
        ry[order] = y;
        rz[order] = z;
        let key = (
            (x / cell_size).floor() as i64,
            (y / cell_size).floor() as i64,
            (z / cell_size).floor() as i64,
        );
        let idx = *cell_map.entry(key).or_insert_with(|| {
            let id = counts.len() as u32;
            counts.push(0);
            id
        });
        cell_of[order] = idx;
        counts[idx as usize] += 1;
    }
    // Prefix-sum -> per-cell start offsets, then scatter record `order` indices in
    // ascending `order` so every cell's slice in `sorted` is order-ascending
    // (== JS `bucket.sort(compareRecordOrder)`).
    let num_cells = counts.len();
    let mut starts = vec![0u32; num_cells + 1];
    for c in 0..num_cells {
        starts[c + 1] = starts[c] + counts[c];
    }
    let mut cursor: Vec<u32> = starts[..num_cells].to_vec();
    let mut sorted = vec![0u32; n];
    for (order, &cidx) in cell_of.iter().enumerate() {
        let c = cidx as usize;
        sorted[cursor[c] as usize] = order as u32;
        cursor[c] += 1;
    }

    let k = queries.len() / 5;
    // `out` must hold one `stride`-wide chunk per query; a mis-sized buffer would
    // otherwise silently truncate (`take(k)`) or write past the end. Check up front.
    if out.len() < k * stride {
        return Err(JsErrorBox::type_error(format!(
            "spatial_query_batch: out buffer too small (need {} u32 for {k} queries, got {})",
            k * stride,
            out.len(),
        )));
    }
    // One query per output chunk; chunks are disjoint, so parallelism never
    // affects the result (each query is an independent pure function).
    out.par_chunks_mut(stride)
        .take(k)
        .enumerate()
        .for_each(|(q, slot)| {
            let nx = queries[q * 5];
            let ny = queries[q * 5 + 1];
            let nz = queries[q * 5 + 2];
            let radius = queries[q * 5 + 3];
            let exclude = queries[q * 5 + 4];
            let exclude_eid: i64 = if exclude >= 0.0 { exclude as i64 } else { -1 };

            let min_x = ((nx - radius) / cell_size).floor() as i64;
            let max_x = ((nx + radius) / cell_size).floor() as i64;
            let min_y = ((ny - radius) / cell_size).floor() as i64;
            let max_y = ((ny + radius) / cell_size).floor() as i64;
            let min_z = ((nz - radius) / cell_size).floor() as i64;
            let max_z = ((nz + radius) / cell_size).floor() as i64;

            // Gather candidate `order` indices from the cell AABB (each cell slice
            // is order-ascending), then order the union (== JS candidates.sort).
            let mut candidates: Vec<u32> = Vec::new();
            for cx in min_x..=max_x {
                for cy in min_y..=max_y {
                    for cz in min_z..=max_z {
                        if let Some(&idx) = cell_map.get(&(cx, cy, cz)) {
                            let s = starts[idx as usize] as usize;
                            let e = starts[idx as usize + 1] as usize;
                            candidates.extend_from_slice(&sorted[s..e]);
                        }
                    }
                }
            }
            candidates.sort_unstable();

            let mut hits: Vec<(f64, u32, u32)> = Vec::new(); // (distance, order, eid)
            for &order in &candidates {
                let oi = order as usize;
                let eid = ordered_eids[oi];
                if eid as i64 == exclude_eid {
                    continue;
                }
                let dx = rx[oi] - nx;
                let dy = ry[oi] - ny;
                let dz = rz[oi] - nz;
                let distance = (dx * dx + dy * dy + dz * dz).sqrt();
                if distance > radius {
                    continue;
                }
                hits.push((distance, order, eid));
            }
            // (distance asc, then order asc) == V8 stable sort by distance over an
            // order-ascending input. `f64::total_cmp` is a TOTAL order, so this is
            // well-defined even for pathological non-finite distances: a NaN distance
            // (e.g. from a NaN coordinate — the `distance > radius` cutoff lets it
            // through, exactly as the JS oracle's `distance > maxDistance` does) sorts
            // deterministically AFTER every finite distance, then ties break by
            // `order` ascending. For finite distances this is bit-identical to the
            // previous `partial_cmp` ordering; only the ordering of non-finite
            // distances (where V8's `a.distance - b.distance` comparator is itself
            // unspecified) is pinned to this documented, thread-count-independent rule.
            hits.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));

            let count = hits.len();
            slot[0] = count as u32;
            let written = count.min(max_hits);
            for (i, hit) in hits.iter().take(written).enumerate() {
                slot[1 + i] = hit.2;
            }
        });

    Ok(())
}

extension!(limina_ecs, ops = [op_ecs_spatial_query_batch],);

#[cfg(test)]
mod tests {
    use super::*;

    // Tests drive the module-level pure fn directly (the op itself is a thin
    // wrapper around it; the `#[op2]` op type is not reachable outside its macro).
    fn run(
        px: &[f32],
        py: &[f32],
        pz: &[f32],
        ordered_eids: &[u32],
        cell_size: f64,
        queries: &[f64],
        max_hits: u32,
        out: &mut [u32],
    ) -> Result<(), JsErrorBox> {
        spatial_query_batch(
            px,
            py,
            pz,
            ordered_eids,
            cell_size,
            queries,
            max_hits,
            out,
        )
    }

    #[test]
    fn oob_or_mismatched_input_errors_without_panicking() {
        // An eid past the end of the Position SoA must error, not OOB-panic.
        let px = [0.0f32];
        let py = [0.0f32];
        let pz = [0.0f32];
        let ordered_eids = [0u32, 5u32]; // 5 is out of bounds for len-1 arrays
        let queries = [0.0f64, 0.0, 0.0, 10.0, -1.0];
        let mut out = vec![0u32; 1 * (1 + 4)];
        assert!(run(&px, &py, &pz, &ordered_eids, 8.0, &queries, 4, &mut out).is_err());

        // A short/stale (mismatched-length) SoA must error too.
        let px = [0.0f32, 1.0];
        let py = [0.0f32];
        let pz = [0.0f32, 1.0];
        let ordered_eids = [0u32];
        let mut out = vec![0u32; 5];
        assert!(run(&px, &py, &pz, &ordered_eids, 8.0, &queries, 4, &mut out).is_err());

        // An undersized `out` buffer must error rather than truncate/overrun.
        let px = [0.0f32];
        let py = [0.0f32];
        let pz = [0.0f32];
        let ordered_eids = [0u32];
        let mut out = vec![0u32; 3]; // need 1 * (1 + 4) = 5
        assert!(run(&px, &py, &pz, &ordered_eids, 8.0, &queries, 4, &mut out).is_err());
    }

    #[test]
    fn small_query_returns_expected_sorted_neighbors() {
        // Three entities; only the two within radius 5 of the origin should hit,
        // ordered by ascending distance (eid 0 at d=0, then eid 1 at d=1).
        let px = [0.0f32, 1.0, 100.0];
        let py = [0.0f32, 0.0, 0.0];
        let pz = [0.0f32, 0.0, 0.0];
        let ordered_eids = [0u32, 1, 2];
        let queries = [0.0f64, 0.0, 0.0, 5.0, -1.0];
        let mut out = vec![0u32; 1 * (1 + 4)];
        run(&px, &py, &pz, &ordered_eids, 8.0, &queries, 4, &mut out).unwrap();
        assert_eq!(out[0], 2); // true hit count
        assert_eq!(&out[1..3], &[0u32, 1u32]); // nearest-first eids
    }

    #[test]
    fn nan_coordinate_produces_deterministic_ordering() {
        // A NaN coordinate yields a NaN distance, which (like the JS oracle) is
        // NOT excluded by the `distance > radius` cutoff. It must land in a
        // deterministic, documented position: after every finite distance.
        let px = [0.0f32, f32::NAN, 1.0];
        let py = [0.0f32, 0.0, 0.0];
        let pz = [0.0f32, 0.0, 0.0];
        let ordered_eids = [0u32, 1, 2];
        let queries = [0.0f64, 0.0, 0.0, 100.0, -1.0];

        let mut out_a = vec![0u32; 1 * (1 + 4)];
        run(&px, &py, &pz, &ordered_eids, 8.0, &queries, 4, &mut out_a).unwrap();
        // Determinism: an identical call yields an identical result.
        let mut out_b = vec![0u32; 1 * (1 + 4)];
        run(&px, &py, &pz, &ordered_eids, 8.0, &queries, 4, &mut out_b).unwrap();
        assert_eq!(out_a, out_b);

        assert_eq!(out_a[0], 3); // all three included (NaN not excluded)
        // Finite distances first, ascending (eid 0 at d=0, then eid 2 at d=1),
        // and the NaN-distance eid 1 pinned last.
        assert_eq!(&out_a[1..4], &[0u32, 2u32, 1u32]);
    }
}
