# Visual Fidelity Release Contract

This contract is a hard release floor for Limina's production renderer. The nine user-supplied Project
Gorgon frames identified by `VISUAL_FIDELITY_REFERENCE_SET_ID` in
`js/src/render/visual-fidelity-floor.ts` define the minimum acceptable overall result. They are review-only
references and are not redistributed by this repository; their filenames and SHA-256 identities are locked
in source so the local review set cannot silently change.

Passing a shader probe, pixel-difference test, headless fixture, editor viewport, or performance benchmark
does **not** establish visual fidelity. Such evidence may prove one subsystem, but it is never a scene result
and must never be presented as one.

## Required result

Every final capture must come from the native production engine at a fixed acceptance camera, with no debug
material, placeholder primitive, missing asset, editor overlay, fixture content, or fallback renderer. It must
meet all common facets below. A built-environment lane additionally requires authored, textured architecture.

- layered PBR terrain with visible material-scale detail and slope/elevation/biome blending;
- convincing macro terrain silhouette, erosion, rock exposure, and intentional scene termination;
- depth-driven water colour/opacity, animated surface response, reflection, and a coherent shore transition;
- dense, varied vegetation with grass/ground cover, canopy/understory structure, instancing, culling, and LOD;
- coherent sky, aerial perspective, fog/weather, colour grade, and time-of-day lighting;
- stable direct/environment lighting, contact grounding, and production shadow quality;
- licensed/provenanced assets that pass import, material, scale, LOD, texture, and lifecycle QC;
- fixed-camera visual regression with no missing content, LOD holes, late shader compilation, or clipping;
- clean repeated Edit/Play/rebuild teardown with bounded CPU/GPU/resource ownership;
- safe target-laptop native measurements for frame time, hitches, draw calls, triangles, texture/GPU memory,
  streaming, startup, and shader warm-up. NVIDIA timestamp queries are not required and must not be used on
  the affected machine while they remain associated with Xid 32 resets.

## Review boundary

`evaluateVisualFidelityEvidence` has two gates:

1. `eligibleForHumanReview` means every automated/system facet passed and the frame is safe to show as a
   candidate. Diagnostics and fixtures fail before this boundary.
2. `releasePassed` additionally requires explicit human comparison and approval against the locked reference
   set. Automated metrics cannot substitute for visual judgment.

Nature and built-environment captures are separate lanes. A failure in either remains internal, is logged with
the violated facets, and returns to implementation. No below-floor capture is a roadmap acceptance artifact.
