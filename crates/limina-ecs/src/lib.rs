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
) {
    let n = ordered_eids.len();
    let max_hits = max_hits as usize;
    let stride = 1 + max_hits;

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
            // order-ascending input.
            hits.sort_by(|a, b| {
                a.0.partial_cmp(&b.0)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then(a.1.cmp(&b.1))
            });

            let count = hits.len();
            slot[0] = count as u32;
            let written = count.min(max_hits);
            for (i, hit) in hits.iter().take(written).enumerate() {
                slot[1 + i] = hit.2;
            }
        });
}

extension!(limina_ecs, ops = [op_ecs_spatial_query_batch],);
