# Limina DGX Spark resume packet

This packet freezes the state needed to move the complete authoritative Limina workspace from the
laptop to the NVIDIA DGX Spark. The browser review bridge is deliberately the first Spark-side task;
it is not part of this transfer.

## Non-negotiable boundaries

- The dirty workspace is authoritative. Do not replace it with a fresh clone or reconstruct it from
  `HEAD`.
- Use the same absolute destination path when possible:
  `/home/cheapseatsecon/Projects/Personal/limina`.
- Copy only over a private SSH connection. `.env` and `.env.local` contain local credentials and have
  been tightened to mode `0600`.
- Keep the laptop source unchanged until destination verification succeeds.
- Do not copy x86 build products to ARM64. The transfer policy excludes native build caches,
  dependency installations, virtual environments, generated distributions, Zaxy projection files,
  and runtime locks.
- Any NVIDIA Xid stops all GPU work immediately. Report the exact event and do not retry before the
  Spark has rebooted. Timestamp queries remain disabled.
- Do not show the owner a candidate that is below the locked Project Gorgon reference floor.

## Authoritative source state

- Branch: `feat/gamestack-refactor`
- HEAD: `769bc2da5288f736d860b213938b264764791dad`
- Ahead of `origin/feat/gamestack-refactor`: 376 commits at handoff preparation time
- Zaxy session: `limina-default`
- Zaxy authority: `.eventloom/limina-default.jsonl`
- Transfer manifest: `.limina/handoff/dgx-spark-workspace.manifest.json`
- All-ref recovery bundle: `.limina/handoff/limina-all-refs.bundle`

There are eight linked Claude worktrees. One has independent uncommitted work and is included in the
portable manifest:

- `.claude/worktrees/agent-a6ad6337a3f4c98b9/js/src/skills/three.ts`
- `.claude/worktrees/agent-a6ad6337a3f4c98b9/js/test/p59_multilight.ts`

The worktree Git pointers contain the current absolute workspace path. If the Spark destination must
differ, run `git worktree repair` and repair the absolute paths in `AGENTS.md`, `.mcp.json`,
`zaxy-mcp.json`, `.claude/settings.local.json`, and the generated `bin/limina-mcp` wrapper before
starting agents. Using the same path avoids this migration.

## Owner-approved visual checkpoint

- Artifact: `assets/qc/internal/temperate-river-leading-line-native-grass-v4.0.1.png`
- PNG SHA-256: `232e84925ff4fd951159feb6d35a602d04b50ac753bf78e09692582d3304d173`
- Byte length: 3,787,259
- Approval: `art-direction/temperate-fidelity-native-grass-v4.0.1-review.json`
- Owner statement: `it looks great.`
- Backend: native WebGPU on Intel Iris Xe, 1921 by 1081
- NVIDIA Xid observed: false

The nine locked Project Gorgon images are preserved privately under
`art-direction/library/project-gorgon-floor-20260711/`. Their bytes match the hashes pinned by
`js/src/render/visual-fidelity-floor.ts`. The directory remains intentionally ignored by Git but is
included by the transfer manifest and rsync policy.

The approved grass fix is engine/package behavior, not an asset-pack-specific trick. Cinematic
physical grass now dissolves from 18 m to 32 m into the existing far-surface proxy. Density,
residency, far rendering, and the triangle ceiling did not increase.

## Frozen production identities

- Grass package: `limina.grass.interactive-temperate-meadow@4.0.1`
- Grass descriptors:
  - `assets/population/grassland-meadow-grass.json@4.0.1`
  - `assets/population/temperate-forest-grass.json@4.0.1`
- Runtime pack: `assets/biomes/temperate-fidelity-runtime-pack.json@1.1.5`
- Runtime pack content identity:
  `sha256:17ba696bf2c8277aa30a1c8a298c15a96be208323e075c8d16346017a6ad8597`
- Compiler publication: `1.4.0`
- Publication manifest:
  `sha256:12a9ea3b9aed64bc3952e06eccb61cef263daabda2bac81debcc6aeb8c6b881c`
- Content closure:
  `sha256:f4239506113f835238c2326fdbfa8fd061d9963c21d6c1dbd89833993f371e09`
- Publication: 256 chunks, 56,493 placements
- Approved resident scene: 25 terrain tiles, 25 surface tiles, 10,918 placements, 257 canopy
  instances, 59 grass tiles, 508,360 grass blades

## Known evidence caveat

`traces/temperate-fidelity-native-capture.json` contains valid native pixels and exact pixel hashes,
but its `drawCalls=1` and `triangles=1` values count only the final fullscreen post pass. They are not
whole-scene submission evidence. Do not cite them as a performance or geometry result. Correcting the
measurement scope is the first formal rendering task after the review bridge exists.

## Create and verify the laptop snapshot

Run these from the workspace root after all repository writers have stopped:

```bash
mkdir -p .limina/handoff
git bundle create .limina/handoff/limina-all-refs.bundle --all
git bundle verify .limina/handoff/limina-all-refs.bundle

node tools/handoff/workspace-transfer-manifest.mjs create \
  .limina/handoff/dgx-spark-workspace.manifest.json
node tools/handoff/workspace-transfer-manifest.mjs verify \
  .limina/handoff/dgx-spark-workspace.manifest.json
```

The manifest hashes every portable regular file and symlink, file modes, all Git refs, the registered
worktree list, every linked-worktree dirty status, main worktree status/diffs, and a full Git object
integrity result. It includes ignored evidence, references, research, asset caches, traces, secrets,
Zaxy JSONL, and Claude worktree sources. It excludes only the paths declared in
`tools/handoff/dgx-spark-transfer-policy.json`.

## Transfer

First create an empty destination at the same absolute path on the Spark. Then run this on the laptop,
replacing `SPARK_HOST` with the SSH host:

```bash
node tools/handoff/workspace-transfer-manifest.mjs transfer \
  .limina/handoff/dgx-spark-workspace.manifest.json \
  cheapseatsecon@SPARK_HOST:/home/cheapseatsecon/Projects/Personal/limina/
```

The transfer uses rsync with archive semantics, hardlink and sparse-file preservation, safe symlinks,
partial-file recovery, delayed updates, and no owner/group preservation. It never uses `--delete`.
The source is verified immediately before rsync begins.

## Verify on the Spark

Do not install dependencies or edit files before this succeeds:

```bash
cd /home/cheapseatsecon/Projects/Personal/limina

node tools/handoff/workspace-transfer-manifest.mjs verify \
  .limina/handoff/dgx-spark-workspace.manifest.json
git bundle verify .limina/handoff/limina-all-refs.bundle
git fsck --full
git status --short --branch
git worktree list --porcelain

zaxy memory checkout "Resume Limina formal fidelity closure on DGX Spark" \
  --eventloom-path .eventloom \
  --session-id limina-default
```

The manifest verifier must report the source as x64 and the destination as ARM64 while all portable
files and Git identities remain exact. A mismatch means the laptop source stays authoritative and the
Spark copy must not be used.

## ARM64 bootstrap

The CI-supported baseline is Node 22, Bun 1.3.14, and stable Rust. The laptop snapshot used Node
24.15.0, npm 11.12.1, Bun 1.3.14, and Rust 1.95.0. Record the Spark versions before diagnosing any
cross-machine difference.

```bash
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  libasound2-dev libudev-dev pkg-config cmake ninja-build \
  libx11-dev libxcursor-dev libxi-dev libxrandr-dev \
  libxkbcommon-dev libxkbcommon-x11-dev libwayland-dev

(cd tools && bun install --frozen-lockfile)
(cd js && npm ci)
cargo build --release --workspace
```

Blender is not portable from the laptop's x86 installation. Install an ARM64-compatible Blender and
set `BLENDER_BIN` before running Blender-backed asset tools. Regenerate `bin/limina-mcp` after the
Spark build instead of trusting the copied laptop wrapper.

## First non-GPU verification

Run this before creating any window or touching the GPU:

```bash
npm --prefix js run check:types
npm --prefix js run check:determinism
npm --prefix js run check:portability

./target/release/limina js/test/p_grass_distance_coverage_contract.ts
./target/release/limina js/test/p_grass_midfield_variation_contract.ts
./target/release/limina js/test/p_grass_silhouette_contract.ts
./target/release/limina js/test/p_biome_surface_material.ts
./target/release/limina js/test/p_grass_field_stream_manager.ts
./target/release/limina js/test/p_continuous_biome_grass_runtime.ts
./target/release/limina js/test/p_temperate_fidelity_scene_lifecycle.ts
./target/release/limina js/test/p_render_telemetry.ts

bun js/test/p_temperate_fidelity_runtime_pack.ts
bun js/test/p_temperate_fidelity_v13_candidate.ts
bun tools/world/build-temperate-fidelity-surfaces.ts
node --test tools/preview/native-temperate-fidelity-capture-static.test.mjs
```

The publication build command is deliberately no-write. If it says the publication is stale, stop and
diagnose rather than regenerating the authority during handoff validation.

## Resume order on the Spark

1. Read `AGENTS.md` and this packet.
2. Activate Codex through Zaxy:

   ```bash
   zaxy activate codex \
     --eventloom-path /home/cheapseatsecon/Projects/Personal/limina/.eventloom \
     --session-id limina-default \
     --current-task "Create the DGX Spark visual review bridge, then resume formal fidelity closure" \
     --workspace-root /home/cheapseatsecon/Projects/Personal/limina \
     --launch
   ```

3. Create and test the browser review bridge before the first Spark render.
4. Fix the whole-scene submission telemetry scope. The final post triangle must not masquerade as the
   production scene.
5. Run one guarded Spark capture. It is a new target-hardware artifact and requires exact human review;
   laptop approval does not automatically transfer to different pixels.
6. Repin or supersede `art-direction/temperate-fidelity-native-regression.json` only after review.
7. Continue formal release closure. Do not resume grass or foliage tuning unless a new reviewed artifact
   demonstrates a concrete regression.

## Remaining formal roadmap work

- Correct native whole-scene draw and triangle telemetry.
- Produce an actual fixed-camera candidate-versus-baseline regression artifact.
- Prove native GPU resource and memory return after repeated lifecycle cycles. The current headless gate
  already proves production-scene ownership and teardown twice.
- Add production performance profiles. Spark evidence is a high-end profile and does not silently replace
  the release contract's locked laptop profile.
- Add GPU texture compression and runtime negotiation.
- Establish aggregate post-upload geometry, instance, texture, and post-buffer budgets.
- Complete exact production-asset QC and hash-bound acceptance.
- Continue native asset-generation pipeline chunks C through F after the nature-bundle release work is
  formally closed.

Deferred visual polish remains flow-driven foam, local turbulence, and river eddies. It is not the next
golden-path task.
