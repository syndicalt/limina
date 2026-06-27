#!/usr/bin/env python3
"""
S1 reference SHIM — adapt the real `terrain-diffusion` HTTP API to limina's `/tile`.
=================================================================================

limina's `ModelTerrainSource` (js/src/terrain/model-source.ts) speaks a stable,
model-agnostic protocol:

    POST {baseUrl}/tile  {seed, tx, tz, lod, tile, hints}
      -> JSON { name, seed, tx, tz, lod, nrows, ncols,
                elev:    { dtype:"int16",   b64 },              # nrows*ncols int16 LE, metres
                climate: { channels, dtype:"float32", b64 } }   # channel-major (C,H,W) float32 LE
    POST {baseUrl}/health -> { ok, ... }

The shipped `terrain-diffusion` service (terrain_diffusion.inference.api) speaks a
DIFFERENT, model-specific protocol (verified against the installed api.py):

    GET {target}/terrain?i1&j1&i2&j2&scale
      -> RAW bytes  [ int16-LE elevation  (h*w*2 bytes, metres, row-major (h,w)) ]
                    [ float32-LE climate   (h*w*4*4 bytes, INTERLEAVED (H,W,4)) ]
         channels = [temp(°C, BIO1), t_season(BIO4), precip(mm, BIO12), p_cv(BIO15)]
         dims carried in response headers  X-Height (h), X-Width (w)
    GET {target}/health -> { "status": "ok" }
    SEED is FIXED at server start (`python -m terrain_diffusion.inference.api --seed S`).

This shim is the per-model adapter that bridges the two. limina's `/tile` contract is
the STABLE seam; a new model only needs a new shim, never a change to limina.

THE WIRE CONTRACT (what this shim emits — must match what model-source.ts DECODES):
  * elevation: int16-LE metres, row-major (h,w), passthrough (optionally clamped to a
    fixed [elev-min, elev-max] range matching the limina source's normalization window).
  * climate: the model's INTERLEAVED (H,W,4) block is TRANSPOSED to limina's
    CHANNEL-MAJOR (C,H,W) and emitted FAITHFULLY — the same channels, same order:
        index 0 = temp (°C, BIO1)      index 2 = precip (mm, BIO12)
        index 1 = t_season (BIO4)      index 3 = p_cv (BIO15)
    No reduction, no reordering, NO biome channel. `model-source.ts` is the single
    source of truth for biome: it reads temp from channel 0 and precip from channel 2
    (its defaults), and CLASSIFIES the canonical `Biome` itself from temp+precip. So a
    DEFAULT-configured `ModelTerrainSource` decodes this wire correctly with NO override.
    (`channels` is the model's count — 4 for terrain-diffusion-30m; the decoder is
    channel-count-agnostic as long as temp@0 and precip@2 hold, which this guarantees.)

  This is the SAME wire `tools/terrain-service/worker.py` emits (the in-process backend),
  so a consumer gets the same world from either deployment — see that file's header.

COORDINATE + SCALE CONVENTION (tx,tz,lod,tile -> i1,j1,i2,j2,scale):
  The model's `scale` is an integer oversample relative to its native resolution
  (m/px = NATIVE / scale; NATIVE = 30 m/px for terrain-diffusion-30m at scale 1).
    base_scale  -- the model scale used at lod 0           (--scale, default 1)
    scale       = clamp(base_scale << lod, .., --max-scale)   (lod = oversample level)
    factor      = scale // base_scale                         (extra samples per tile)
    px_per_tile = tile * factor
    pixel box   i1 = tz*px_per_tile, i2 = i1+px_per_tile   (z -> i/rows/height)
                j1 = tx*px_per_tile, j2 = j1+px_per_tile   (x -> j/cols/width)
  (z->i, x->j matches model-source.ts localCell: x->col, z->row.) This keeps the WORLD
  METRES PER TILE CONSTANT across lods
  (ground = px_per_tile * NATIVE/scale = tile * NATIVE/base_scale), so it matches the
  limina source's FIXED extent (tilePx * metersPerPx) and only the heightfield
  resolution grows with lod. Adjacent tiles share a pixel edge -> seam-consistent.
  The limina source must therefore be configured with
      metersPerPx = NATIVE / base_scale   (e.g. 30 for --scale 1).

SEED: the model's launch seed is the region seed (`--region-seed`, set to the model's
  `--seed`). A /tile whose `seed` differs is REJECTED with an error envelope and is a
  NO-OP against the model (the shim never forwards `seed` to /terrain, so it can never
  trigger the model's expensive per-request `change_seed` rebuild).

Run:  python tools/terrain-diffusion/shim.py \
          --target-url http://127.0.0.1:8000 --region-seed 1234 --scale 1 --port 8917
Test: python tools/terrain-diffusion/test_shim.py   (no GPU / no network — synthetic upstream)
"""
import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

# terrain-diffusion-30m: native resolution is 30 m/px at scale 1 (the "30m" in the model
# name; matches model-source.ts metersPerPx default + worker.py + the S0 spike).
DEFAULT_NATIVE_M_PER_PX = 30.0


def log(msg: str) -> None:
    print(f"[td-shim] {msg}", file=sys.stderr, flush=True)


def tile_to_box(tx: int, tz: int, lod: int, tile: int, base_scale: int, max_scale: int):
    """Map a limina tile request to the model's (i1,j1,i2,j2,scale) pixel box.
    See the module docstring for the convention + invariants. Returns
    (i1, j1, i2, j2, scale, px_per_tile)."""
    scale = base_scale << lod
    if scale > max_scale:
        scale = max_scale
    factor = scale // base_scale  # >= 1; samples-per-tile multiplier vs lod 0
    px = tile * factor
    i1 = tz * px  # z -> i (rows / height)
    j1 = tx * px  # x -> j (cols / width)
    return i1, j1, i1 + px, j1 + px, scale, px


def translate_terrain(
    raw: bytes,
    h: int,
    w: int,
    *,
    seed: int,
    tx: int,
    tz: int,
    lod: int,
    elev_min=None,
    elev_max=None,
    name: str = "model:terrain-diffusion-30m",
) -> dict:
    """PURE translation: the raw terrain-diffusion /terrain body (+ its h,w) -> the
    limina /tile JSON envelope (a dict). Byte-exact, network-free (the unit test pins it).

    Elevation passes through (optional clamp). Climate is transposed from the model's
    INTERLEAVED (H,W,C) to limina's CHANNEL-MAJOR (C,H,W), FAITHFULLY (same channels,
    same order: temp@0, t_season@1, precip@2, p_cv@3) — model-source.ts selects temp@0 /
    precip@2 and classifies biome itself, so the wire carries NO biome channel."""
    elev_nbytes = h * w * 2
    if len(raw) < elev_nbytes:
        raise ValueError(f"elev block truncated: have {len(raw)} bytes, need >= {elev_nbytes} for {h}x{w} int16")

    # --- elevation: int16-LE metres, row-major (h,w). Pass through (optional clamp). ---
    elev = np.frombuffer(raw[:elev_nbytes], dtype="<i2").reshape(h, w)
    if elev_min is not None or elev_max is not None:
        lo = -32768 if elev_min is None else int(elev_min)
        hi = 32767 if elev_max is None else int(elev_max)
        elev = np.clip(elev, lo, hi)
    elev_i16 = np.ascontiguousarray(elev.astype("<i2", copy=False))
    env = {
        "name": name,
        "seed": int(seed),
        "tx": int(tx),
        "tz": int(tz),
        "lod": int(lod),
        "nrows": int(h),
        "ncols": int(w),
        "elev": {"dtype": "int16", "b64": base64.b64encode(elev_i16.tobytes()).decode("ascii")},
    }

    # --- climate: model INTERLEAVED (H,W,C) float32 -> FAITHFUL channel-major (C,H,W). ---
    clim_raw = raw[elev_nbytes:]
    if len(clim_raw):
        nfloats = len(clim_raw) // 4
        plane = h * w
        if nfloats % plane != 0:
            raise ValueError(f"climate block {len(clim_raw)} bytes not a whole number of {h}x{w} planes")
        nchan = nfloats // plane
        clim = np.frombuffer(clim_raw, dtype="<f4").reshape(h, w, nchan)  # (H,W,C) interleaved
        # (H,W,C) -> (C,H,W); index = ch*plane + r*W + c. NO channel drop/reorder.
        cm = np.ascontiguousarray(np.transpose(clim, (2, 0, 1)).astype("<f4", copy=False))
        env["climate"] = {
            "channels": int(nchan),
            "dtype": "float32",
            "b64": base64.b64encode(cm.tobytes()).decode("ascii"),
        }
    return env


# --- the shim service -----------------------------------------------------------
class Shim:
    def __init__(self, *, target_url, region_seed, base_scale, max_scale,
                 native_m_per_px, elev_min, elev_max, default_tile, timeout):
        self.target = target_url.rstrip("/")
        self.region_seed = int(region_seed)
        self.base_scale = int(base_scale)
        self.max_scale = int(max_scale)
        self.native_m_per_px = float(native_m_per_px)
        self.elev_min = elev_min
        self.elev_max = elev_max
        self.default_tile = int(default_tile)
        self.timeout = float(timeout)

    @property
    def m_per_px(self) -> float:
        return self.native_m_per_px / self.base_scale

    def fetch_terrain(self, i1, j1, i2, j2, scale):
        """GET {target}/terrain -> (raw bytes, h, w). Overridden in tests with a
        synthetic upstream (no network)."""
        url = f"{self.target}/terrain?i1={i1}&j1={j1}&i2={i2}&j2={j2}&scale={scale}"
        try:
            with urllib.request.urlopen(url, timeout=self.timeout) as r:
                raw = r.read()
                h = int(r.headers["X-Height"])
                w = int(r.headers["X-Width"])
            return raw, h, w
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            raise RuntimeError(f"upstream /terrain {e.code}: {body}")

    def handle_health(self) -> dict:
        try:
            with urllib.request.urlopen(f"{self.target}/health", timeout=self.timeout) as r:
                up = json.loads(r.read().decode("utf-8"))
            ok = (up.get("status") == "ok") or bool(up.get("ok"))
        except Exception as e:  # upstream down -> not ready
            return {"ok": False, "error": str(e), "target": self.target}
        return {
            "ok": ok,
            "model": "terrain-diffusion (via shim)",
            "seed": self.region_seed,
            "base_scale": self.base_scale,
            "native_m_per_px": self.native_m_per_px,
            "m_per_px": self.m_per_px,
            "target": self.target,
            "upstream": up,
        }

    def handle_tile(self, req: dict) -> dict:
        seed = int(req.get("seed", self.region_seed))
        tx = int(req["tx"])
        tz = int(req["tz"])
        lod = int(req.get("lod", 0))
        tile = int(req.get("tile", self.default_tile))
        # SEED GATE: the model's world is fixed at launch. A mismatched seed is a NO-OP
        # (never forwarded upstream -> never triggers a model rebuild) and is rejected.
        if seed != self.region_seed:
            raise ValueError(
                f"seed {seed} != region seed {self.region_seed}; this shim serves a single fixed-seed "
                f"world (relaunch the terrain-diffusion service + shim with --seed/--region-seed {seed})"
            )
        i1, j1, i2, j2, scale, px = tile_to_box(tx, tz, lod, tile, self.base_scale, self.max_scale)
        raw, h, w = self.fetch_terrain(i1, j1, i2, j2, scale)
        return translate_terrain(
            raw, h, w,
            seed=seed, tx=tx, tz=tz, lod=lod,
            elev_min=self.elev_min, elev_max=self.elev_max,
        )


def build_handler(shim: Shim):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _read_json(self):
            n = int(self.headers.get("content-length", 0))
            raw = self.rfile.read(n) if n else b"{}"
            return json.loads(raw or b"{}")

        def do_POST(self):
            try:
                if self.path.rstrip("/").endswith("/health"):
                    return self._send(200, shim.handle_health())
                if self.path.rstrip("/").endswith("/tile"):
                    env = shim.handle_tile(self._read_json())
                    return self._send(200, env)
                return self._send(404, {"error": "unknown route " + self.path})
            except Exception as e:  # model-source surfaces {error} verbatim
                log(f"ERROR {self.path}: {e}")
                return self._send(200, {"error": str(e)})

        # /health is also reachable via GET for curl/readiness probes.
        def do_GET(self):
            if self.path.rstrip("/").endswith("/health"):
                return self._send(200, shim.handle_health())
            return self._send(404, {"error": "unknown route " + self.path})

        def log_message(self, *a):
            pass  # quiet

    return Handler


def main():
    ap = argparse.ArgumentParser(description="terrain-diffusion -> limina /tile shim")
    ap.add_argument("--target-url", default=os.environ.get("TD_URL", "http://127.0.0.1:8000"),
                    help="base URL of the running terrain-diffusion service")
    ap.add_argument("--region-seed", type=int, default=int(os.environ.get("TD_SEED", "0")),
                    help="the seed the model was launched with (must match /tile requests)")
    ap.add_argument("--scale", type=int, default=1, help="base model scale at lod 0 (m/px = NATIVE/scale)")
    ap.add_argument("--max-scale", type=int, default=8, help="clamp for scale (model practical max)")
    ap.add_argument("--native-res", type=float, default=DEFAULT_NATIVE_M_PER_PX,
                    help="model native m/px at scale 1 (default 30; for reporting + the limina metersPerPx)")
    ap.add_argument("--elev-min", type=int, default=None, help="optional clamp floor (metres); default passthrough")
    ap.add_argument("--elev-max", type=int, default=None, help="optional clamp ceiling (metres); default passthrough")
    ap.add_argument("--tile", type=int, default=256, help="default tile edge in samples if a request omits it")
    ap.add_argument("--timeout", type=float, default=120.0, help="upstream request timeout (s)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8917, help="shim listen port (limina default baseUrl)")
    args = ap.parse_args()

    shim = Shim(
        target_url=args.target_url, region_seed=args.region_seed,
        base_scale=args.scale, max_scale=args.max_scale, native_m_per_px=args.native_res,
        elev_min=args.elev_min, elev_max=args.elev_max,
        default_tile=args.tile, timeout=args.timeout,
    )
    srv = ThreadingHTTPServer((args.host, args.port), build_handler(shim))
    log(f"serving limina /tile on http://{args.host}:{args.port}  ->  {shim.target}/terrain")
    log(f"region_seed={shim.region_seed} base_scale={shim.base_scale} "
        f"m/px={shim.m_per_px} (set limina metersPerPx={shim.m_per_px})")
    srv.serve_forever()


if __name__ == "__main__":
    main()
