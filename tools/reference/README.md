# Optional visual reference discovery

This directory is a standalone authoring experiment, not an engine, compiler, package, or BuildingProgram dependency. The normal workflow is for an agent to use its existing browser/image-search capability and optionally normalize a few selected results here. References assist unfamiliar construction and style decisions; they do not authorize spatial geometry.

```sh
node tools/reference/search-visual-references.mjs \
  --query "medieval domestic wall-adjacent staircase" \
  --media image,3d-model \
  --providers manual-web \
  --ingest /tmp/reviewed-web-results.json \
  --out /tmp/stair-candidates.json
```

`manual-web` is the only default. Catalog adapters are explicit opt-ins through `--providers`; none is required or installed with Limina. `EUROPEANA_API_KEY`, `SMITHSONIAN_API_KEY`, and `SKETCHFAB_TOKEN` enable their respective optional adapters. Sketchfab results are thumbnail references only; discovery never downloads a model.

Codex or another agent can use a general web/image search tool, then save normalized hits as a JSON array and pass it with `--ingest hits.json`. Every hit needs a canonical HTTPS page URL. Creator, rights, and license should be captured from that page; incomplete provenance is retained for review but marked ineligible.

If a project needs a pinned reference board, create a reviewed selection file:

```json
{
  "id": "architecture/domestic-stair/v1",
  "subjectKind": "architecture",
  "sources": [
    { "candidateId": "wikimedia-commons/123", "roles": ["circulation", "wall-adjacency", "joinery"] }
  ]
}
```

Promote only selected, licensed image candidates into the existing acquisition pipeline:

```sh
node tools/reference/promote-visual-reference-candidates.mjs \
  --candidates /tmp/stair-candidates.json \
  --selection /tmp/stair-selection.json \
  --out art-direction/architecture/domestic-stair-reference-acquisition.json
node tools/reference/acquire-visual-reference-board.mjs \
  --manifest art-direction/architecture/domestic-stair-reference-acquisition.json \
  --out art-direction/architecture/domestic-stair-reference-board.json
```

Discovery candidates are never production assets. Unknown rights fail the promotion gate, and 3D models/materials remain inspiration-only unless a separate asset-ingestion policy is explicitly invoked. Runtime and packaged content never perform reference discovery.
