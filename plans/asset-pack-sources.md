# Asset Pack Sources — FOSS / Permissive Curation Reference

Purpose: the vetted source list for curating (and creating) limina's asset packs — biomes, materials,
props, vegetation, characters, sky. The governing constraint is **redistribution**, not price: limina's
cloud asset repository re-hosts and may **monetize** curated assets (see [[cloud-asset-repository-monetization]]),
so a source is only usable if its license permits redistribution in a commercial product. Every license
below was verified against the source's live license/terms page (July 2026), not from memory.

"MIT" is rare for art; the practical permissive tiers for *assets* are **CC0** (redistribute freely, no
attribution) and, with obligations, **CC-BY**. Code tools are MIT/Apache/GPL — their *output* is what matters.

---

## 1. License policy — the ingest gate

Default-deny. An asset enters the repo only if its license lands in Tier A or Tier B, with provenance recorded.

| License | Bundle & sell? | Obligation | Tier |
|---|---|---|---|
| **CC0 / Public Domain** | Yes | None | **A — preferred** |
| **MIT** | Yes | Retain license text (per-project, not per-asset) | **A** |
| **Apache-2.0** | Yes | Retain license + NOTICE; patent grant | **A** |
| **CC-BY-4.0** | Yes | Credit author + title + source URL + license + "modified?" flag, surfaced in-product | **B — attribution-gated** |
| **CC-BY-SA** | Contaminates | ShareAlike — derivatives must relicense CC-BY-SA | **Reject** |
| **CC-BY-NC** | No | NonCommercial | **Reject** |
| **CC-BY-ND** | No | NoDerivatives — can't retopo/convert/repackage | **Reject** |
| **GPL / LGPL / AGPL** (incl. MB-Lab output) | No | Copyleft; AGPL adds a network clause | **Reject** |
| **Royalty-Free (BlenderKit RF) / marketplace EULA** (Fab, Unity, Unreal, TurboSquid, CGTrader) | No | "use in a game" ≠ "redistribute the asset" | **Reject** |

Operational rules:
- **Whitelist `license ∈ {CC0, MIT, Apache-2.0}`** for the no-attribution / monetizable tier; keep CC-BY in a
  separate tier that stores + surfaces per-asset `author · title · sourceUrl · license(name+version+link) · modified?`.
- **Never ingest preview/thumbnail renders.** OpenGameArt, Poly Haven, Sketchfab all license the *asset files*
  under CC but the *thumbnails/metadata/logos* separately (often "all rights reserved"). Ingest the model/texture only.
- **Per-asset license capture is mandatory for mixed sources** (Poly Pizza, Sketchfab, OpenGameArt) — the license
  is per-model, not site-wide. Poly Pizza's API has a CC0/CC-BY filter param; use it.
- Courtesy requests that CC0 can't legally bind (KayKit, Poly Haven: "please don't resell verbatim") have no legal
  force but are relationship-relevant for a business monetizing community work — prefer bundling into worlds/kits
  over re-selling a raw pack unchanged.

---

## 2. Sources by category (verified)

Legend — Redist: ✅ free · 🅐 with-attribution (CC-BY) · ⛔ excluded. PBR: does it ship albedo+normal+roughness(+AO/height).

### 3D models — props / buildings / kits
| Source | License | Redist | glTF? | PBR | Notes |
|---|---|---|---|---|---|
| **Poly Haven** polyhaven.com/models | CC0 | ✅ | ✅ | ✅ | Only major model source **above the fidelity floor** as-is; real scale; API for bulk. Modest count, realistic props (not modular kits). |
| **Kenney** kenney.nl | CC0 | ✅ | ✅ | ✗ | Thousands; modular City/Nature/Castle/Furniture kits — ideal kitbash. Flat/vertex-colored. |
| **Quaternius** quaternius.com | CC0 | ✅ | ✅* | ✗ | Hundreds of themed packs (already used: `qt-farmer`). Atlas-textured. *Confirm glTF per pack. |
| **KayKit** kaylousberg.itch.io | CC0 | ✅ | ✅ | ✗ | Best craft/silhouette of the low-poly sets; medieval/dungeon/city/adventurers. Courtesy: don't resell verbatim. |
| **TheBaseMesh** thebasemesh.com | CC0 | ✅ | ✗ (OBJ/FBX) | ✗ (grey) | 1250+ clean-quad UV'd base meshes → build-agent textures them. Blockout/kitbash base, not a deliverable. |
| **Poly Pizza** poly.pizza | CC0 **+** CC-BY | ✅/🅐 | ✅ | ✗ | 8000+ (incl. archived Google Poly). Already wired in `asset-fetch.ts`. Split CC0/CC-BY at ingest via API param. |
| **Sketchfab** (CC0/CC-BY filter) | mixed | ✅/🅐 | ✅ | some ✅ | Large, includes PBR scans. Filter to CC0/CC-BY only; exclude NC/ND/SA; QC per model. |
| BlenderKit | mixed (RF + CC0) | ⛔ except CC0 | — | — | RF tier forbids re-hosting/resale of the asset. Ingest CC0 subset only. |
| Fab / Unity / Unreal / TurboSquid / CGTrader | EULA | ⛔ | — | — | "Use in a game" only; redistribution barred. |

### PBR materials / textures
| Source | License | Redist | Channels | Res | Notes |
|---|---|---|---|---|---|
| **ambientCG** ambientcg.com | CC0 | ✅ | albedo/normal/rough/metal/AO/height | 1–8K+ | Largest CC0 lib; best terrain breadth (ground/rock/cliff/gravel/grass/soil/snow/bark). Bulk API. **Primary.** Also the texture supplier for ez-tree bark/leaves. |
| **cgbookcase** cgbookcase.com/textures | CC0 | ✅ | full PBR | to 8K | 566, photogrammetry-grade ground/forest-floor/rock/moss. **Primary.** |
| **Poly Haven textures** polyhaven.com/textures | CC0 | ✅ | full PBR | 1–8K | Resale explicitly blessed; clean API. **Primary.** |
| **3DTextures.me** | CC0 | ✅ | full PBR | 2K free (4K Patreon) | CC0 grant holds regardless of the convenience paywall. Secondary. |
| **Texture Ninja** texture.ninja | CC0 | ✅ | flat photos only | — | Raw albedo/height *source* photos (no maps) → author your own PBR. |
| ShareTextures | "CC0" + no-redistribute clause | ⛔ | — | — | Self-contradictory; ToS forbids redistribution/automated download. Excluded. |
| FreePBR | non-commercial + no-redistribute | ⛔ | — | — | Commercial use is a paid purchase. Excluded. |
| textures.com | proprietary | ⛔ | — | — | Explicitly bars bundling PBR into models / open-source relicensing. The trap to avoid. |

### Vegetation / nature / terrain data / sky
| Source | License | Redist | Format | Notes |
|---|---|---|---|---|
| **ez-tree** github.com/dgreenheck/ez-tree | MIT | ✅ | JS → GLB | Procedural, deterministic, already integrated. Post-2026 refactor externalizes bark/leaf textures → pair with ambientCG. |
| **Quaternius Nature/Ultimate** | CC0 | ✅ | glTF | Trees/plants/rocks/grass/flowers/cliffs. |
| **Poly Haven models/HDRIs** | CC0 | ✅ | GLB / EXR-HDR | Photoscanned rocks/logs; 700+ outdoor HDRIs = the CC0 skybox/IBL source. |
| **Motion Forge heightmaps** motionforgepictures.com/height-maps | CC0 | ✅ | 16-bit PNG | Cleanest drop-in heightmaps. |
| **SRTM** (USGS EarthExplorer) | public domain | ✅ | GeoTIFF/HGT | Global 30m real elevation, no strings. |
| **USGS 3DEP** | public domain | ✅ | GeoTIFF/LAZ | ~10m + 1m lidar, **US-only**. |
| **ESA WorldCover 10m** esa-worldcover.org | CC-BY-4.0 | 🅐 | GeoTIFF | 11-class global landcover → **biome driver**. Attribution required. |
| **Copernicus DEM GLO-30** | ESA/Airbus free license (not CC0) | 🅐 | GeoTIFF | Best global 30m, but non-CC0 + **excludes Armenia/Azerbaijan**. Prefer SRTM/Motion Forge for a no-strings default. |
| **three.js `Sky` (Preetham)** | MIT | ✅ | GLSL→TSL | Procedural analytic sky; no asset weight. |
| **FastNoiseLite** github.com/Auburn/FastNoiseLite | MIT | ✅ | code | Procedural heightfield/biome fallback. |
| Blender Sapling / modular_tree / improved-sapling | GPL (code) | ✅ **output** | GLB | GPL binds the *add-on source*, not the baked GLB it exports. Consume the GLB; never vendor the GPL source into engine code. |
| Xfrog / World Machine / Gaea | proprietary | ⛔ | — | Commercial; excluded. |

### Rigged characters / creatures / animation
| Source | License | Redist | Format | Notes |
|---|---|---|---|---|
| **Quaternius Universal Base Characters** + anim packs | CC0 | ✅ | glTF/FBX | Rigged, retargetable, 120+ CC0 animations. Cleanest. |
| **KayKit** Adventurers/Skeletons/Character-Animations | CC0 | ✅ | glTF/FBX | Rigged + animated + modular; skeleton enemies; shared humanoid rig. |
| **Kenney** character packs | CC0 | ✅ | glTF/FBX | Blocky, zero-risk. |
| **MakeHuman** | CC0 output *(official unmodified build only)* | ✅ | glTF/FBX | Parametric realistic humans; basic rig → auto-rig/retarget. CC0 exception voids on forked builds / non-CC0 community add-ons. |
| **VRoid Studio** self-authored exports | you own it | ✅ | VRM→glTF | Anime avatars; you may sell your own exports. Downloaded 3rd-party VRMs carry embedded per-model license flags. |
| **CMU Mocap** mocap.cs.cmu.edu | free for all uses | ✅ | BVH | Large realistic mocap; retarget to your rig; no glTF OOTB. |
| **Mixamo** | Adobe EULA | ⛔ | — | EULA *specifically* forbids redistributing raw character/animation files as an asset package — exactly this repo's model. Fine only for an end-user's own game, never as repo inventory. |
| MB-Lab | AGPL output | ⛔ | — | Copyleft output. |
| Ready Player Me | restrictive + EOL | ⛔ | — | Services shut down Jan 31 2026. |

### Aggregators / hunting grounds
- **awesome-cc0** github.com/madjin/awesome-cc0 — the CC0 ecosystem index (start here).
- **Sketchfab** & **OpenGameArt** license filters — CC0 clean; CC-BY attribution-gated; **exclude CC-BY-SA / GPL / NC / ND**.
- **Icosa Gallery** icosa.gallery — preserves the archived Google Poly library (per-model CC0/CC-BY).
- itch.io — a storefront, not a license; read each listing's "Asset license" field; never assume free download = redistributable.

---

## 3. Strategy

1. **CC0-first, always.** Build the default tier entirely from CC0 (Poly Haven, Kenney, Quaternius, KayKit,
   ambientCG, cgbookcase, Motion Forge, CMU). Zero attribution bookkeeping, unconditional resale.
2. **Own-it-outright is the monetization moat.** Material Maker (MIT) + Texture Ninja (CC0 source photos) +
   Blender authoring + ez-tree (MIT) generate bespoke materials/vegetation limina *fully owns* — no upstream
   license, nothing a competitor's repo can also contain. This is the strategic complement to re-hosting shared CC0.
3. **Fidelity reconciliation.** Bulk low-poly CC0 packs (Kenney/Quaternius/KayKit) are atlas-textured → below
   `art-direction/fidelity-floor.json`. Two lanes: (a) a deliberate **stylized tier**, or (b) **kitbash/base geometry**
   the build agent re-materials to PBR (TheBaseMesh is explicitly this). Poly Haven models + the CC0 *material*
   libraries clear the floor as-is. See [[procedural-fidelity-nms-lesson]], [[asset-qc-gate]].
4. **Biome coverage** = terrain PBR (ambientCG/cgbookcase) + heightmaps (Motion Forge/SRTM) + landcover
   (ESA WorldCover, drives biome selection) + vegetation (ez-tree + Quaternius/Poly Haven) + sky (Poly Haven HDRIs
   + Preetham). This composes forest / grassland / tundra / desert / wetland from clean sources. See [[build-pipeline-order]].

---

## 4. Provenance gap to close (prerequisite for selling anything)

- `.card.json` already carries `license` + `source` (e.g. `qt-farmer`: "CC0, Quaternius via Poly Pizza"), and
  `tools/asset-fetch.ts` fails `licenseSpdx` closed to `"unknown"` — good.
- **Gap:** `catalog.json` entries carry `authoredBy` but **no per-entry license/attribution block.** For CC-BY assets
  and any sellable unit, the catalog entry itself must carry `{ licenseSpdx, attribution{author,title,sourceUrl,license,modified} }`,
  or a CC-BY asset cannot legally ship. Extend the CatalogEntry schema + the asset-QC gate to require it; reject
  Tier-B assets that can't populate it. Ties into the publishable unit = GLB + card + CatalogEntry.

## 5. Recommended landing sequence
1. Extend CatalogEntry + asset-QC gate with the license/attribution block; encode the Tier-A/B/reject policy as a
   gate (falsifiable: a CC-BY asset with no attribution, or any rejected license, must FAIL).
2. Add CC0 `AssetSource` adapters (mirroring the existing Poly Pizza source): Poly Haven (models+HDRIs+textures via API),
   ambientCG, cgbookcase, Kenney. CC0-only ingest, provenance auto-populated.
3. Stand up the own-it pipeline: Material Maker + Texture Ninja + Blender bake → bespoke terrain/material packs.
4. Seed biome packs (forest → grassland → tundra) end-to-end through the build pipeline; QC on the real GPU.

## Risks / open questions
- **CC-BY attribution surfacing** — does the shipped product (exported world / player) render an attribution manifest?
  Required before any CC-BY asset ships. Keeping the default tier CC0-only sidesteps this until it's built.
- **Style coherence** — mixing Poly Haven (photoreal) with Kenney/KayKit (flat stylized) in one world looks incoherent;
  curate per-pack art direction, don't blend tiers in a scene.
- **Legal sign-off** — the Mixamo/MakeHuman/VRoid/Copernicus edge cases should be confirmed by counsel before a
  commercial launch. This doc is verified research, not legal advice.
