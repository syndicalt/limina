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

WIRE FORMAT (must stay in lockstep with model-source.ts):
  POST /tile   {seed, tx, tz, lod, tile, hints} ->
    { name, seed, tx, tz, lod, nrows, ncols,
      elev:    { dtype:"int16",   b64 },                  # nrows*ncols int16 LE, metres
      climate: { channels:N, dtype:"float32", b64 } }     # (C,H,W) float32 LE, channel-major
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
        """Generate one tile. Contiguous px coords (tx,tz -> i,j) so adjacent tiles
        share the coarse/latent stages (the amortized ~0.87 s/tile path, per S0)."""
        import torch

        world = self._pipeline(seed)
        i = tx * tile
        j = tz * tile
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
        elev_i16 = np.rint(elev).astype("<i2", copy=False)
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
        try:
            req = request.get_json(force=True, silent=False) or {}
            seed = int(req["seed"]); tx = int(req["tx"]); tz = int(req["tz"])
            t = int(req.get("tile", 256))
            t0 = time.time()
            env = gen.generate(seed, tx, tz, t)
            env["lod"] = int(req.get("lod", 0))
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
