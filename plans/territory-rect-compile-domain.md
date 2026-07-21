# Territory-Rect Compile Domain

The terrain compiler's chunk domain is an origin-centered SQUARE sized by the farthest
authored point on either axis (`map-field`: `half = max|coord| + margin`). A 6.9×4.6 km
world is billed as its 7.4 km bounding square — 23,716 chunks against the 16,384 cap —
so every derived publish fails and the Atlas territory never reaches 3D. Owner decision
(2026-07-18): the engine must render arbitrary Atlas territory; the square must go.

## Chunk A — rectangular chunk domain over the authored territory

`terrain-compile.ts` derives its domain from `field.bounds` (the master square). Change:
domain = chunk range over the **territory rect** — `field.featureBounds` expanded by the
map-field margin, clamped to the master square. The master field itself stays square and
origin-centered (raster, erosion, hydrology placement, overview grid, topology hash all
keep their framing); only WHICH chunks are compiled changes. Chunks outside the
territory are unauthored deep sea — the square overview still renders the far field, so
the horizon does not change. The 16,384-chunk cap stays and now binds on actual
territory (~15 k for the live 6.9×4.6 km world → fits; a ~7.7×7.7 km authored territory
is the new practical ceiling).

Consequences accepted: compiled chunk SET changes for asymmetric worlds → new manifests
(cache invalidation, not a replay break — determinism is per-compile); terrain-edit
layers pinned to an old square `baseTopology` hash recompile against the rect domain
(none exist in live projects today).

## Chunk B — gates + live proof

- `p_world_terrain_compile`: new legs — an ASYMMETRIC off-center fixture must compile
  with a rectangular domain (width ≠ height in chunks), every chunk inside the
  territory rect + margin, and chunk count strictly below the bounding-square count
  (the falsifiability: the square derivation demonstrably fails this comparator).
  Symmetric-fixture goldens re-pinned only if the rect actually changes them.
- Live proof: rebundle world-compiler, restart the limina-world stack, and watch the
  stuck head (rev 42+, 23,716-chunk square) publish as a ~15 k-chunk rect revision;
  territory then mounts in the editor viewport.

## Sequencing (landable PRs)

1. A+B as one vertical slice (compiler change + gate legs + goldens + live proof).

## Verification

- `p_world_terrain_compile` exit 0 (incl. new asymmetric legs), derived-build
  coordinator/service suites, tsc, determinism/portability lints, quick sweep.
- The live limina-world publish is the end-to-end proof; viewport render is user UAT
  over the SSH tunnel (needs the 5174 forward).

## Risks / open questions

- The master square still caps master resolution (1025²): big worlds already sample a
  coarser master (~7.2 m step at 7.4 km) under the fixed 48 m/1.5 m chunk grid. The rect
  domain does not change that; a follow-up could shrink the master square to the
  territory rect for resolution, but that DOES move topology hashes/hydrology framing —
  out of scope here.
- Sparse reuse across the domain change: first compile after the switch reuses nothing
  (chunk set changed) — one full compile, then incremental resumes.

## Status & outcomes

**2026-07-18 — landed and proven on the live world.** One slice: the rect domain
(`terrain-compile.ts` — territory = featureBounds + 48 m margin clamped to the master
square), plus `MAX_WORLD_TERRAIN_COMPILE_ARTIFACT_BYTES` 256→512 MiB (at ~27 KiB/chunk
the old byte cap silently capped worlds at ~9.8 k chunks — the 16,384-chunk cap was
never reachable), plus derived-build-service authority reads (`authoring.sourceSnapshot`
×4) now pass `{ retryTransport: true }` like `authoring.commit` always did.

Gates: `p_world_terrain_compile` exit 0 — symmetric-fixture goldens UNCHANGED (rect ==
square for centered fixtures, so the change is behavior-preserving there); new
asymmetric-strip legs pin the exact rect (expected == actual chunk range, non-square,
dense) with falsifiability (the retired square derivation produces a different domain
and strictly more chunks). Coordinator/service/doc-template suites 77/77; tsc,
determinism, portability clean.

Live proof: limina-world's head — stuck since revision ~29 on `23716 chunks, exceeding
cap 16384` — published as **generation 26: 14,406 chunks = 147×98 rect** (7,056 m ×
4,704 m, off-center tx −70..76 / tz −41..56), 375 MiB artifacts. The bounding square
would have been 21,609.

NOT verified: the user's viewport render of the published territory (their UAT, over
the SSH tunnel with 5174 forwarded).

Known follow-up (measured, not yet fixed): the sidecar's publish window blocks its
event loop in three sync bursts (~10 s + ~4 s + ~54 s for the 375 MiB full rebuild —
worker hand-off/validation, staging, and install/verify). The editor host tears down
the unresponsive WS during long bursts, so a full-rebuild publish RACES its own
authority read — retryTransport (this slice) plus the ~30 s+ ping tolerance won the
race here, but a yielding/chunked publish path (or native hashing in the coordinator's
artifact validation) is the durable fix. Incremental saves reuse ~everything, so
steady-state publishes stay small and safely inside the window.
