#!/usr/bin/env python3
"""
Phase 9 · Workstream C — the terrain generator worker (author-side only).

Serves tiles from the S0-greenlit InfiniteDiffusion model
(`xandergos/terrain-diffusion-30m`, fp16) over a thin local HTTP IPC that
`js/src/terrain/model-source.ts` (`ModelTerrainSource`) speaks. The host posts a
JSON tile request; this worker runs the model and returns elevation (int16 metres)
+ a 5-channel climate tensor, base64-encoded, in the wire envelope the source parses.

THIS RUNS ONLY AT AUTHORING TIME, ON THE AUTHOR'S GPU. End users never run it — they
replay cached tiles (Phase 8). Model loading mirrors `spikes/s0-terrain-diffusion/run.py`
exactly (same WorldPipeline path, same fp16 dtype, same caching strategy).

WIRE FORMAT (must stay in lockstep with model-source.ts AND tools/terrain-diffusion/shim.py
— this in-process worker and that wrap-the-shipped-service shim are TWO EQUIVALENT backends:
same axis, same channels/order, same 30 m/px native, same elev quantization (floor), so a
consumer gets the SAME world for the same (seed, coords) from either):
  POST /tile   {seed, tx, tz, lod, tile, hints} ->
    { name, seed, tx, tz, lod, nrows, ncols,
      elev:    { dtype:"int16",   b64 },                  # nrows*ncols int16 LE, metres (floor)
      climate: { channels:4, dtype:"float32", b64 } }     # (C,H,W) float32 LE, channel-major:
                                                          #   [temp@0, t_season@1, precip@2, p_cv@3]
                                                          #   (model-source reads temp@0/precip@2
                                                          #    + classifies biome itself; no biome
                                                          #    channel on the wire)
  AXIS: x->j (cols), z->i (rows). RESOLUTION: 30 m/px native (terrain-diffusion-30m).
  POST|GET /health  -> { ok, model, seed, dtype, device, loaded_seeds }
  errors -> HTTP 500 { error: "<message>" }   (the source surfaces this verbatim)

RUN (exact command — note CWD=TD_SRC, the conditioning code reads relative paths):

  SPIKE=/home/cheapseatsecon/Projects/Personal/limina/spikes/s0-terrain-diffusion
  TD_SRC=/tmp/terrain-diffusion-src                       # the cloned model repo
  cd "$TD_SRC" && TD_SRC="$TD_SRC" "$SPIKE/.venv/bin/python" \
      /home/cheapseatsecon/Projects/Personal/limina/tools/terrain-service/worker.py \
      --model "$SPIKE/weights" --dtype fp16 --port 8917

(Identical env to spikes/s0-terrain-diffusion/run.sh: same .venv, same weights, CWD=TD_SRC.)
"""
import argparse
import base64
import json
import os
import sys
import threading
import time

import numpy as np


def log(msg: str) -> None:
    print(f"[terrain-worker] {msg}", file=sys.stderr, flush=True)


def bounded_int(req: dict, key: str, lo: int, hi: int, default=None) -> int:
    """Parse req[key] as an int and enforce [lo, hi]. Raises ValueError on a missing
    required field / non-int / out-of-range value so the /tile handler can return a 4xx
    instead of letting an unbounded tile/tx/tz drive a huge (tile*tile) allocation -> OOM."""
    if key not in req:
        if default is None:
            raise ValueError(f"missing required field '{key}'")
        return default
    try:
        v = int(req[key])
    except (TypeError, ValueError):
        raise ValueError(f"field '{key}' must be an integer (got {req[key]!r})")
    if v < lo or v > hi:
        raise ValueError(f"field '{key}' out of range [{lo}, {hi}] (got {v})")
    return v


class TileGenerator:
    """Loads + caches one WorldPipeline per world seed (different seeds = different
    worlds). Mirrors run.py's load path. Each pipeline is ~1.16 GB VRAM at fp16, so a
    typical single-world session holds exactly one."""

    def __init__(self, model: str, dtype: str, device: str):
        self.model = model
        self.dtype = dtype
        self.device = device
        self._pipelines = {}
        self._lock = threading.Lock()  # serialize GPU access (one model, one GPU)
        # Make the cloned model source importable (TD_SRC = repo root), as run.py does.
        src = os.environ.get("TD_SRC")
        if src and src not in sys.path:
            sys.path.insert(0, src)

    def _pipeline(self, seed: int):
        with self._lock:
            if seed in self._pipelines:
                return self._pipelines[seed]
            from terrain_diffusion.inference.world_pipeline import WorldPipeline

            torch_dtype = None if self.dtype == "fp32" else self.dtype
            t0 = time.time()
            world = WorldPipeline.from_pretrained(
                self.model, seed=seed, torch_compile=False,
                dtype=torch_dtype, caching_strategy="direct", log_mode="info",
            )
            world.to(self.device)
            world.bind(hdf5_file=None)
            log(f"pipeline ready (seed={world.seed}) in {time.time() - t0:.1f}s")
            self._pipelines[seed] = world
            return world

    def generate(self, seed: int, tx: int, tz: int, tile: int):
        """Generate one tile. AXIS: x->j (cols), z->i (rows) — i = tz*tile, j = tx*tile —
        matching model-source.ts localCell (x->col, z->row) and tools/terrain-diffusion/shim.py
        (i1=tz*px, j1=tx*px). world.get(i1,j1,i2,j2) takes i=rows, j=cols. Contiguous px
        coords so adjacent tiles share the coarse/latent stages (the ~0.87 s/tile path, per S0)."""
        import torch

        world = self._pipeline(seed)
        i = tz * tile  # rows (height)  <- z
        j = tx * tile  # cols (width)   <- x
        with self._lock:
            out = world.get(i, j, i + tile, j + tile, with_climate=True)
            if self.device == "cuda":
                torch.cuda.synchronize()

        elev_t = out["elev"]
        elev = elev_t.detach().cpu().numpy()
        elev = np.squeeze(elev)
        if elev.ndim != 2:
            raise ValueError(f"unexpected elev shape {elev.shape}")
        nrows, ncols = int(elev.shape[0]), int(elev.shape[1])
        # int16 metres, little-endian, row-major — exactly what model-source.ts decodes.
        # Quantize by FLOOR (then clip), identical to terrain_diffusion api.py `_elev_to_int16`
        # so this worker and the shim emit byte-identical elevation for the same world.
        elev_i16 = np.clip(np.floor(elev), -32768, 32767).astype("<i2", copy=False)
        elev_b64 = base64.b64encode(np.ascontiguousarray(elev_i16).tobytes()).decode("ascii")

        env = {
            "name": "model:terrain-diffusion-30m",
            "seed": int(seed), "tx": int(tx), "tz": int(tz),
            "nrows": nrows, "ncols": ncols,
            "elev": {"dtype": "int16", "b64": elev_b64},
        }

        clim_t = out.get("climate")
        if clim_t is not None:
            clim = clim_t.detach().cpu().numpy()
            clim = np.squeeze(clim)
            if clim.ndim == 2:  # single channel
                clim = clim[None, ...]
            # CANONICAL 4 channels [temp(BIO1), t_season(BIO4), precip(BIO12), p_cv(BIO15)],
            # matching terrain_diffusion api.py (`climate[:4]`) and the shim. precip stays at
            # index 2 so a DEFAULT ModelTerrainSource (tempChannel 0, precipChannel 2) decodes
            # it; model-source classifies biome itself, so no biome channel on the wire.
            clim = clim[:4]
            channels = int(clim.shape[0])
            # channel-major (C,H,W) float32 LE — index = ch*H*W + r*W + c.
            clim_f32 = np.ascontiguousarray(clim.astype("<f4", copy=False))
            clim_b64 = base64.b64encode(clim_f32.tobytes()).decode("ascii")
            env["climate"] = {"channels": channels, "dtype": "float32", "b64": clim_b64}

        return env

    def status(self):
        return {
            "ok": True, "model": self.model, "dtype": self.dtype,
            "device": self.device, "loaded_seeds": sorted(self._pipelines.keys()),
        }


def build_app(gen: TileGenerator):
    from flask import Flask, request, jsonify

    app = Flask(__name__)

    @app.route("/health", methods=["GET", "POST"])
    def health():
        return jsonify(gen.status())

    @app.route("/tile", methods=["POST"])
    def tile():
        # Parse + BOUND the request first: reject junk / out-of-range coords with a 400 (client error)
        # before they can drive an unbounded (tile*tile) allocation. Bounds are generous but sane.
        try:
            req = request.get_json(force=True, silent=False) or {}
            # Seed spans the full u32 domain (limina's canonical seed range; the
            # recorder stores `seed >>> 0` and shim.py accepts full-range seeds).
            # Seed is NOT an allocation driver (tile/tx/tz are) — this bound only
            # rejects non-integers / negatives, not large valid worlds.
            seed = bounded_int(req, "seed", 0, 2**32 - 1)
            tx = bounded_int(req, "tx", -1_000_000, 1_000_000)
            tz = bounded_int(req, "tz", -1_000_000, 1_000_000)
            t = bounded_int(req, "tile", 1, 2048, default=256)
            lod = bounded_int(req, "lod", 0, 32, default=0)
        except Exception as e:  # malformed JSON or out-of-range coord -> client error, keep {error} envelope
            log(f"ERROR: bad /tile request: {e}")
            return jsonify({"error": str(e)}), 400
        try:
            t0 = time.time()
            env = gen.generate(seed, tx, tz, t)
            env["lod"] = lod
            log(f"tile (seed={seed} tx={tx} tz={tz}) in {(time.time() - t0) * 1000:.0f} ms")
            return jsonify(env)
        except Exception as e:  # the source surfaces {error} verbatim
            log(f"ERROR: {e}")
            return jsonify({"error": str(e)}), 500

    return app


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=os.environ.get("TD_MODEL", "./weights"))
    ap.add_argument("--dtype", default="fp16", choices=["fp32", "bf16", "fp16"])
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8917)
    args = ap.parse_args()

    if args.device == "cuda":
        import torch
        if not torch.cuda.is_available():
            log("ERROR: CUDA not available"); sys.exit(2)

    gen = TileGenerator(args.model, args.dtype, args.device)
    log(f"serving terrain tiles on http://{args.host}:{args.port}  "
        f"model={args.model} dtype={args.dtype} device={args.device}")
    app = build_app(gen)
    # threaded=False: one GPU, one model — serialize requests (the _lock also guards).
    app.run(host=args.host, port=args.port, threaded=False)


if __name__ == "__main__":
    main()
