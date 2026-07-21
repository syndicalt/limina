# Canonical asset acceptance manifest

`manifest.json` is the only asset-acceptance authority. `catalog.json`, cards, thumbnails, and files
merely present on disk are discovery inputs; none imply approval. The versioned contract is
`limina.asset-manifest/1`, enforced by `tools/qc/asset-manifest.mjs`.

An accepted `entries[]` record contains:

- `id` and `class`: stable identity and one of `building`, `character`, `model`, `prop`, `vegetation`.
- `model`: asset-root-relative `path` and exact `sha256:` content address.
- `provenance`: HTTPS `sourceUrl`, SPDX `licenseSpdx`, and required `attribution` (nullable only when
  the license does not require it).
- `metrics`: exact derived bounds, vertex/triangle/mesh/primitive/material counts, texture slots, and embedded
  texture MIME types/resolutions. These are recomputed from the model; stale values fail.
- `lods`: ordered `{ path, sha256, distanceM }` records. Vegetation requires at least one LOD.
- `qc`: exact gate version, hash-pinned evidence path, and a separate explicit human visual approval
  naming the governing reference contract.

`candidates[]` persist acquisition provenance but are not accepted. A mechanically inspected candidate
may record hash-pinned `mechanicalEvidence`, per-LOD metrics, and deliberately unassigned LOD distances;
it still cannot claim human approval. Fetching, generating, mechanical QC, or producing an image can
never set human approval. `unlistedPolicy: "excluded"` means legacy,
fixture, ignored, and untracked files remain unavailable to the acceptance path until deliberately
migrated with proof.
