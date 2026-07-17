# Look-push survey — Three.js ecosystem shortlist

This is the opening research slice of the "look push": a survey of best-in-class open Three.js
implementations across seven render domains, each given an adopt / port / skip verdict. Hard
gates on every verdict: license must be MIT / Apache-2.0 / CC0 / BSD (anything else is
`skip (license)`, stated explicitly with a source); limina renders on **WebGPURenderer**
(TSL/node materials) with a `forceWebGL2` headless fallback, so pure WebGL/GLSL work is real but
gets `port` with an effort estimate, never `adopt`; and limina keeps capabilities small,
self-contained, and dependency-free (no heavy framework lock-in) per the engine's cardinal rules.

Repo checks done first: `js/build/three.bundle.mjs` pins **three r184** (already TSL/WebGPU-native
core). Already-referenced libs confirmed still in play: `threejs-water` (jeantimex, water.ts/render
docs), `GrassSystemThreeJS` (achrefelouafi; its former tile-source strategy has been retired), `ez-tree`
(dgreenheck, `js/src/render/tree-source.ts`), `MeshToonNodeMaterial` (`js/src/render/toon.ts`).
limina's own `water.ts` already hand-rolls a TSL depth-faded sea material (not literally the
jeantimex code) and `post.ts` already builds a TSL `PostProcessing` stack (GTAO + bloom + grade)
on three's built-in nodes.

---

## Water

Ocean + rivers/lakes; reflection/refraction/caustics/depth. Depth-buffer water is a stated want.

| Candidate | License | Renderer | What it does | Verdict | Effort |
|---|---|---|---|---|---|
| [threejs-water](https://github.com/jeantimex/threejs-water) (jeantimex) | MIT ([source](https://github.com/jeantimex/threejs-water)) | WebGL/GLSL | Real-time raytraced-look reflections/refractions/caustics/interactive ripples | **already referenced** — port (WebGL→TSL) for the caustics/refraction technique | M |
| [webgpu-water](https://github.com/jeantimex/webgpu-water) (jeantimex) | MIT ([source](https://github.com/jeantimex/webgpu-water)) | **WebGPU-native** | Same Evan-Wallace-derived water sim, rebuilt directly on WebGPU compute | **adopt** — same author, same technique, already ported to the exact renderer limina targets; strictly higher-leverage than the WebGL sibling | — |
| three.js core `webgpu_ocean` example (Tessendorf FFT ocean) | MIT (three.js core license, [source](https://github.com/mrdoob/three.js/blob/master/LICENSE)) | WebGPU-native TSL | Multi-cascade FFT ocean: displacement, derivative normals, foam, absorption-colour body | **adopt** — bundled with three itself; verify `three.bundle.mjs`'s build step pulls the `examples/jsm` ocean module in (it's an example, not core export, so it may need vendoring into the bundle build) | S (vendor only) |
| [fft-ocean](https://github.com/jbouny/fft-ocean) (jbouny) | **unconfirmed** — no LICENSE file in repo or README | WebGL/GLSL | Older WebGL FFT ocean rendering | **skip (license unconfirmed)** | — |
| "Three.js Water Pro" / "Tidewater" (docs.threejswaterpro.com, ilikekillnerds blog) | **unconfirmed / appears commercial** (paid-product docs site, no visible OSS license) | WebGPU/TSL | FFT + Gerstner ocean kit | **skip (license unconfirmed)** — do not act on this without a direct license check | — |

Already referenced, unaffected: `threejs-water`.

---

## Sky / atmosphere

Physical sky, sun, aerial perspective.

| Candidate | License | Renderer | What it does | Verdict | Effort |
|---|---|---|---|---|---|
| three.js core `Sky.js` (examples/jsm/objects) | MIT (three.js core) | WebGL GLSL `ShaderMaterial` (Preetham model) | Analytical sky dome + sun disc | **port (WebGL→TSL)** — trivial analytical function, cheap to re-express as a TSL node so it composites with the rest of the WebGPU render graph | S |
| [precomputed_atmospheric_scattering](https://github.com/jeantimex/precomputed_atmospheric_scattering) (jeantimex) | MIT, preserving Eric Bruneton's original license ([source](https://github.com/jeantimex/precomputed_atmospheric_scattering)) | WebGL/GLSL | Bruneton precomputed-LUT atmospheric scattering — real aerial perspective, not just a sky dome | **port (WebGL→TSL)** — the fidelity upgrade over Preetham/Sky.js (true aerial-perspective falloff on distant terrain/buildings), but precomputed-LUT machinery is nontrivial to re-express as TSL compute | L |

No WebGPU-native atmosphere library found with a confirmed permissive license; both candidates need a port.

---

## Volumetrics / fog

God rays, height fog, volumetric clouds.

| Candidate | License | Renderer | What it does | Verdict | Effort |
|---|---|---|---|---|---|
| three.js core TSL fog nodes (`heightFogFactor`, `rangeFogFactor`, `densityFogFactor`) + `webgpu_volume_cloud` / `webgpu_volume_lighting` examples | MIT (three.js core) | WebGPU-native TSL | Height fog, range/density fog, raymarched volume cloud + volumetric-lighting examples, all native node functions | **adopt** — this is the correct base layer; verify the bundle build vendors the two example modules the same way as the ocean example | S (vendor only) |
| [procedural-clouds-threejs](https://github.com/CK42BB/procedural-clouds-threejs) (CK42BB) | MIT ([source](https://github.com/CK42BB/procedural-clouds-threejs)) | WebGPU raymarch + WebGL2 fallback | Procedural volumetric clouds + a god-ray post pass, WGSL 3D-noise compute | **port (reference only)** — technique worth stealing (steal the raymarch/noise approach into a limina-owned module); repo itself is very low-maturity (6 commits, 39 stars, "Teaching Three.js" educational series) so treat as a reference implementation, not a dependency | S–M |
| [three-good-godrays](https://github.com/Ameobea/three-good-godrays) | **zlib** ([source](https://raw.githubusercontent.com/Ameobea/three-good-godrays/main/LICENSE), copyright Casey Primozic, adapted from N8python) | WebGL, built on pmndrs/postprocessing | Screen-space raymarched god rays; actively maintained (updated for three r182) | **skip (license)** — zlib is permissive but is not in the MIT/Apache-2.0/CC0/BSD allow-list; flagging as a possible exception candidate if the user wants to grant one (it's a well-understood, OSI-approved permissive license), but not marking adopt/port without that sign-off | — |
| [three-volumetric-clouds](https://github.com/FarazzShaikh/three-volumetric-clouds) | **unconfirmed** — repo is archived/read-only, no visible LICENSE file | WebGL | "Nubis, Evolved" (Guerrilla Games) style volumetric clouds | **skip (license unconfirmed)** | — |

---

## TSL / WebGPU node materials

The material system + notable node-material shaders.

| Candidate | License | Renderer | What it does | Verdict | Effort |
|---|---|---|---|---|---|
| three.js core TSL (`three/webgpu`, `three/tsl`) | MIT (three.js core) | WebGPU-native | The node-material authoring language itself — already limina's material substrate | **adopt** (already in use: `water.ts`, `post.ts`, `toon.ts`) | — |
| [tsl-textures](https://github.com/boytchev/tsl-textures) (Pavel Boytchev) | MIT ([source](https://github.com/boytchev/tsl-textures)) | WebGPU-native TSL | Library of real-time procedural TSL textures (marble, wood, rust, clouds, etc.) as small composable node functions | **adopt** — directly fits "procedural, swappable, dependency-free": each texture is a standalone function you copy in, not a framework | S per texture |
| three.js core triplanar node (`triplanarTexture()`) | MIT (three.js core) | WebGPU-native TSL | Native triplanar-mapping node function, already ships in TSL | **adopt** — see Terrain shading below, this is the base primitive for splat/height-blend terrain materials, already in the bundle | S |
| [THREE-CustomShaderMaterial](https://github.com/FarazzShaikh/THREE-CustomShaderMaterial) | MIT ([source](https://github.com/FarazzShaikh/THREE-CustomShaderMaterial)) | WebGL (`onBeforeCompile` GLSL-chunk injection) | Extends built-in materials with custom shader chunks | **skip (superseded)** — solves a WebGL-era problem (extending `MeshStandardMaterial` without owning the whole shader); native TSL node materials solve this directly on the renderer limina targets, so adopting CSM would be moving backward | — |

---

## Post-processing

The WebGPU post stack: bloom, SSAO/GTAO, DOF, tonemap, TAA/FXAA.

| Candidate | License | Renderer | What it does | Verdict | Effort |
|---|---|---|---|---|---|
| three.js core `PostProcessing` (TSL node pipeline: bloom, GTAO, DOF, tonemap, TRAA/FXAA nodes) | MIT (three.js core) | WebGPU-native | The full post stack | **adopt — already in use** (`js/src/render/post.ts` is built directly on this: MRT depth+normal pass, GTAO, bloom, grade) | — |
| [n8ao-webgpu](https://github.com/marioandf/n8ao-webgpu) (MarioAndF, WebGPU/TSL port of N8AO) | CC0-1.0 ([source](https://github.com/marioandf/n8ao-webgpu)); original [N8AO](https://github.com/N8python/n8ao) also CC0-1.0; port is author-endorsed | WebGPU-native TSL | Higher-quality SSAO/GTAO with better temporal stability, fixes the halo artifacts three's built-in `GTAONode` shows at depth discontinuities | **adopt** — direct drop-in upgrade over the built-in GTAO `post.ts` already uses, same license tier (CC0, even more permissive than MIT), author-endorsed port | S–M (swap the AO node in `post.ts`) |
| [pmndrs/postprocessing](https://github.com/pmndrs/postprocessing) | **zlib** ([source](https://github.com/pmndrs/postprocessing/blob/main/LICENSE.md)) | WebGL (WebGPU support still incomplete as of mid-2026) | The de facto WebGL post-processing library (bloom, DOF, god rays effects, etc.) | **skip (license + renderer)** — zlib outside the allow-list, and WebGPU support isn't there yet anyway; three's own TSL `PostProcessing` is the correct target | — |
| [realism-effects](https://github.com/0beqz/realism-effects) (0beqz) | MIT ([source](https://github.com/0beqz/realism-effects)) | WebGL | SSGI (screen-space global illumination), motion blur, TRAA | **port (WebGL→TSL)** — SSGI is the highest-fidelity single item in this whole survey (real bounce light instead of baked AO), but nontrivial to port; TRAA piece is smaller since three's TSL stack already has a TRAA node to diff against | SSGI: L · TRAA: S (mostly already covered by core) |

---

## Terrain shading

Splat/triplanar/height-blend materials (not generation).

| Candidate | License | Renderer | What it does | Verdict | Effort |
|---|---|---|---|---|---|
| three.js core `triplanarTexture()` TSL node | MIT (three.js core) | WebGPU-native | Native triplanar mapping node — `material.colorNode = triplanarTexture(texture(diffuseMap))` | **adopt** — this is the actual answer for terrain shading; no external dependency needed at all, the primitive already ships in the bundle. The work is building a small limina-owned height/slope-blend material ON TOP of this node (splat by paint-channel weight, the same channel `grass-source.ts` already reads), not sourcing an external terrain-material library | M (own module, built on a core primitive) |
| [textureSplat](https://github.com/nickfallon/textureSplat) (nickfallon) | MIT ([source](https://github.com/nickfallon/textureSplat)) | WebGL/GLSL | Custom shader blending 4–7 materials (diffuse/normal/ORM) via a splat-mixmap texture | **port (WebGL→TSL), reference only** — useful as a worked example of splat-mixmap blending logic, not worth depending on given the native triplanar node above | S (reference, not adopt) |
| [THREE.Terrain](https://github.com/IceCreamYou/THREE.Terrain) (IceCreamYou) | MIT ([source](https://github.com/IceCreamYou/THREE.Terrain)) | WebGL, `MeshLambertMaterial`-based | Height-banded multi-texture blend utility (plus terrain *generation*, out of scope here) | **skip (out of scope / superseded)** — old fixed-pipeline material blend; the generation half is explicitly out of scope and the shading half is worse than the native TSL triplanar node | — |

This domain has no standalone forkable terrain-material *library* worth adopting whole — the
right move is building limina's own splat material directly on three's native `triplanarTexture()`
node, which is already in the bundle.

---

## Vegetation / ground cover

Instanced grass + tree systems.

| Candidate | License | Renderer | What it does | Verdict | Effort |
|---|---|---|---|---|---|
| [GrassSystemThreeJS](https://github.com/achrefelouafi/GrassSystemThreeJS) (achrefelouafi) | MIT ([source](https://github.com/achrefelouafi/GrassSystemThreeJS)) | — | Coverage-mask-driven instanced grass | Historical input only; superseded by the canonical pluggable grass-field pipeline | — |
| [ez-tree](https://github.com/dgreenheck/ez-tree) (dgreenheck) | MIT ([source](https://github.com/dgreenheck/ez-tree)) | — | Seeded procedural tree generator | **already referenced**, adopted (`js/src/render/tree-source.ts`) | — |
| [procedural-grass-threejs](https://github.com/CK42BB/procedural-grass-threejs) | MIT ([source](https://github.com/CK42BB/procedural-grass-threejs)) | WebGPU compute + WebGL2 fallback | Multi-layer wind system: global sway, rolling gust waves, per-blade turbulence | **port (reference only)** — the multi-layer wind technique is a real upgrade over a single sway term; very low-maturity repo (3 commits, 6 stars, educational series) so steal the technique into `grass-render.ts`, don't depend on the package | S |
| [InstancedMesh2](https://github.com/agargaro/instanced-mesh) (agargaro) | MIT ([source](https://github.com/agargaro/instanced-mesh/blob/master/LICENSE), copyright Andrea Gargaro) | **WebGL-only** ("only works with `WebGLRenderer`", requires three r159+) | Enhanced `InstancedMesh` — per-instance frustum culling, BVH raycasting, LOD, sorting, per-instance uniforms | **skip (renderer)** for the WebGPU live path; **port** is real work (WebGPU-native instancing needs its own culling/LOD story) but could still land under the `forceWebGL2` headless path today without a port | port effort if pursued: M–L |

---

## Top picks to start

Ranked by leverage (biggest fidelity jump for the smallest, license-clean, WebGPU-native lift):

1. **`n8ao-webgpu`** (post-processing) — CC0, WebGPU/TSL-native, author-endorsed port, drop-in swap
   for the `GTAONode` `post.ts` already uses; fixes a named, visible artifact (depth-discontinuity
   halos) for near-zero integration cost.
2. **Core triplanar node → limina terrain splat material** (terrain shading) — the primitive is
   already in the r184 bundle (`triplanarTexture()`); the payoff (real height/slope-blended terrain
   surfaces instead of a flat paint tint) is exactly the "surface not shape" fidelity gap already
   on record for this project.
3. **`webgpu-water`** (jeantimex) — MIT, WebGPU-native, same author/technique family as the
   already-referenced `threejs-water`, but built for the exact renderer limina targets — strictly
   supersedes chasing a WebGL→TSL port of the sibling repo.
4. **Core TSL fog/volume examples** (`heightFogFactor`/`densityFogFactor` + `webgpu_volume_cloud`)
   (volumetrics) — MIT, WebGPU-native, already in the three r184 bundle; likely just needs vendoring
   into the build the same way the ocean example does, before any external dependency is considered.
5. **`tsl-textures`** (Pavel Boytchev) (TSL node materials) — MIT, WebGPU-native, small composable
   functions (exactly the "dependency-free, forkable" shape the project wants) — immediately useful
   for terrain/prop surface variety without waiting on a bespoke procedural-texture module.

Everything else in the domain tables above is either already covered (`GrassSystemThreeJS`,
`ez-tree`, `threejs-water`, `MeshToonNodeMaterial`) or a genuine `port` with a real effort cost
(`realism-effects` SSGI = L, `precomputed_atmospheric_scattering` = L) that should wait behind
these five.

---

## Verification / open questions

Could not confirm a license (do not act on these without a direct check):

- `jbouny/fft-ocean` — no LICENSE file or README license section found.
- "Three.js Water Pro" / "Tidewater" ocean kit (docs.threejswaterpro.com, ilikekillnerds blog
  post) — reads as a commercial product page; no visible OSS license.
- `FarazzShaikh/three-volumetric-clouds` — repository is archived/read-only with no visible
  LICENSE file.

Flagged for an explicit user call (permissive but outside the stated MIT/Apache-2.0/CC0/BSD gate):

- `three-good-godrays` (Ameobea) and `pmndrs/postprocessing` are both **zlib**-licensed. zlib is a
  well-understood OSI-approved permissive license (same practical freedoms as BSD), but it is not
  one of the four named in the hard constraint, so both are marked `skip (license)` rather than
  `adopt`/`port` here. If zlib should count as an allowed license going forward, that's a one-line
  policy call, not a re-survey.

Not independently re-verified, taken from the repos' own README license sections rather than a raw
LICENSE-file fetch (lower confidence than the entries fetched directly): `THREE.Terrain`,
`textureSplat`, `procedural-clouds-threejs`, `procedural-grass-threejs`. All read MIT consistently
across README and footer badge, but worth a second glance before depending on them for anything
beyond "steal the technique."

Not checked at all (out of the seven stated domains, flagged so scope is explicit, not silently
dropped): character/skin shading, water caustics as a *standalone* module separate from the ocean
kits above, and snow/sand-specific surface shaders — none were asked for and none are covered here.
