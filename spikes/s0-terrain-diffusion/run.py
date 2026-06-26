#!/usr/bin/env python3
"""
S0 probe harness for xandergos/terrain-diffusion-30m (InfiniteDiffusion).

Measures, on the real target GPU:
  - ms/tile at native 30 m/px
  - approximate peak VRAM
  - determinism: writes the first tile's elevation+climate to .npy so two
    cold runs with the same seed can be byte-compared (see run.sh).

This drives the published WorldPipeline directly (same path as
`terrain_diffusion.inference.api`), out of process, no engine integration.
NO synthetic numbers: everything printed is measured here.
"""
import argparse, json, time, os, sys
import numpy as np
import torch


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=os.environ.get("TD_MODEL", "./weights"),
                    help="HF id or local dir of terrain-diffusion-30m weights")
    ap.add_argument("--seed", type=int, default=1234)
    ap.add_argument("--tiles", type=int, default=8, help="number of tiles to time")
    ap.add_argument("--tile", type=int, default=256, help="tile edge in native px (30 m/px)")
    ap.add_argument("--stride", type=int, default=4096,
                    help="px between tile origins (non-overlapping, forces fresh gen)")
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--dtype", default="fp32", choices=["fp32", "bf16", "fp16"])
    ap.add_argument("--out", default=None, help="npy path to dump first tile (determinism check)")
    args = ap.parse_args()

    # Make the cloned source importable (set TD_SRC to the repo root).
    src = os.environ.get("TD_SRC")
    if src and src not in sys.path:
        sys.path.insert(0, src)

    from terrain_diffusion.inference.world_pipeline import WorldPipeline

    dtype = None if args.dtype == "fp32" else args.dtype
    if args.device == "cuda" and not torch.cuda.is_available():
        print("ERROR: CUDA not available", file=sys.stderr); sys.exit(2)

    t0 = time.time()
    world = WorldPipeline.from_pretrained(
        args.model, seed=args.seed, torch_compile=False,
        dtype=dtype, caching_strategy="direct", log_mode="info",
    )
    world.to(args.device)
    world.bind(hdf5_file=None)
    load_s = time.time() - t0
    print(f"[load] pipeline ready in {load_s:.1f}s  seed={world.seed}")

    if args.device == "cuda":
        torch.cuda.reset_peak_memory_stats()
        torch.cuda.synchronize()

    def gen(i, j):
        out = world.get(i, j, i + args.tile, j + args.tile, with_climate=True)
        if args.device == "cuda":
            torch.cuda.synchronize()
        return out

    # Warmup (first tile pays one-time graph/alloc costs) — not counted.
    w0 = time.time()
    first = gen(0, 0)
    warm_s = time.time() - w0
    print(f"[warmup] first tile {args.tile}x{args.tile} in {warm_s*1000:.0f} ms")

    if args.out:
        elev = first["elev"].detach().cpu().numpy().astype(np.float32)
        clim = first["climate"]
        clim = clim.detach().cpu().numpy().astype(np.float32) if clim is not None else np.zeros(0)
        np.savez(args.out, elev=elev, climate=clim, seed=np.int64(world.seed))
        print(f"[dump] wrote first tile to {args.out}.npz  elev{elev.shape} "
              f"min={elev.min():.1f} max={elev.max():.1f}")

    # Timed run over fresh, non-overlapping tiles.
    times = []
    for k in range(1, args.tiles + 1):
        i = k * args.stride
        j = (k * 7919) % args.stride * 16  # spread out
        t = time.time()
        gen(i, j)
        dt = (time.time() - t) * 1000.0
        times.append(dt)
        print(f"[tile {k:02d}] ({i},{j}) {dt:.0f} ms")

    times = np.array(times)
    peak_vram = (torch.cuda.max_memory_allocated() / 1e6) if args.device == "cuda" else 0.0
    px = args.tile * args.tile
    km2 = (args.tile * 30.0 / 1000.0) ** 2
    res = {
        "model": args.model,
        "tile_px": args.tile,
        "native_m_per_px": 30,
        "tile_km2": round(km2, 2),
        "ms_per_tile_median": round(float(np.median(times)), 1),
        "ms_per_tile_mean": round(float(times.mean()), 1),
        "ms_per_tile_min": round(float(times.min()), 1),
        "ms_per_tile_max": round(float(times.max()), 1),
        "us_per_px_median": round(float(np.median(times)) * 1000.0 / px, 3),
        "peak_vram_mb": round(peak_vram, 1),
        "warmup_ms": round(warm_s * 1000.0, 0),
        "load_s": round(load_s, 1),
        "dtype": args.dtype,
        "seed": int(world.seed),
        "n_tiles": args.tiles,
    }
    print("RESULT_JSON " + json.dumps(res))


if __name__ == "__main__":
    main()
