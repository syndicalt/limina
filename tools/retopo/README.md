# Static opaque retopo

This is Limina's first production retopo funnel slice. It accepts only embedded GLB 2.0 triangle
meshes with embedded buffers/images, opaque materials, and no rigs, animations, shape keys, or glTF extensions,
non-finite transforms/bounds, or geometry outside the 60 metre asset envelope. Unsupported inputs
fail before Blender runs and no destination is overwritten.

```bash
BLENDER_BIN="$HOME/blender-5.1.2-linux-x64/blender" bun --cwd tools run asset:retopo -- \
  --input /path/source.glb --output /path/clean.glb --lod-output /path/clean-lod1.glb \
  --evidence /path/clean.retopo.json --seed 1729 --target-faces 5000 --resolution 1024
```

The host wrapper runs Blender with `--factory-startup --threads 1` and pins common CPU thread-pool
variables to one. Blender 5.1 QuadriFlow receives the explicit seed, Smart UV unwraps the result,
and Cycles CPU bakes selected-to-active albedo, OpenGL (+Y) tangent normal, roughness, and AO. The
Cycles seed and fixed one-thread renderer are pinned; AO uses 32 samples by default and can be
changed explicitly with `--bake-samples`. The export has one opaque material and a packed ORM
texture (`R=AO`, `G=roughness`, `B=0 metallic`). The
existing pinned meshoptimizer host tool creates LOD1. Outputs and exact recipe/hash/metric evidence
are staged in the common destination directory; exclusive hard-link publication prevents overwrite
races, and evidence is linked last as the publication commit marker. Existing output paths are
rejected, and a failed publication removes every file created by that run.

Before publication, the primary output must also pass the same transform-aware bounds classifier
used by `check:assets` and the repository's default mechanical `asset-qc-gate.mjs` floor. Those
verdicts and measured values are recorded in the evidence file. This remains a mechanical import
gate; it does not replace the Project Gorgon visual-fidelity contract or human approval.

Byte determinism is tested by two complete builds. Determinism is scoped to the pinned Blender
version, meshoptimizer dependency, CPU architecture, recipe, and thread environment recorded in the
evidence. Blender and Cycles do not promise cross-version or cross-architecture byte identity, so
published bytes remain content-addressed build artifacts and must be regenerated only in the pinned
environment.
