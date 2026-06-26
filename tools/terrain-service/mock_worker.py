#!/usr/bin/env python3
"""
A dependency-free (stdlib only, NO torch) mock of worker.py that serves the SAME wire
envelope with a synthetic, deterministic elev+climate payload.

Purpose: verify the REAL HTTP IPC path end to end — the host `op_http_post` op ->
this server -> `ModelTerrainSource` parse — without a GPU or the diffusion model. The
model output itself is S0-covered (spikes/s0-terrain-diffusion/RESULT.md); this proves
the transport + envelope are correct over actual HTTP.

Synthetic tile: elev[r][c] = r*10 + c (metres); climate channel ch = constant
[12.5, 4.0, 800.0, 15.0, 1.0]  (temp °C, tempSeason, precip mm, precipCV, +1).

Run:  python3 tools/terrain-service/mock_worker.py --port 8917
"""
import argparse
import base64
import json
import struct
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TILE = 8
CHANNELS = 5
CH_VALUES = [12.5, 4.0, 800.0, 15.0, 1.0]


def synthetic_envelope(seed, tx, tz, lod, tile):
    nrows = ncols = tile
    elev = bytearray()
    for r in range(nrows):
        for c in range(ncols):
            elev += struct.pack("<h", (r * 10 + c) % 32767)  # int16 LE metres
    clim = bytearray()
    for ch in range(CHANNELS):
        for _ in range(nrows * ncols):
            clim += struct.pack("<f", CH_VALUES[ch])  # float32 LE, channel-major
    return {
        "name": "mock:terrain-diffusion-30m",
        "seed": seed, "tx": tx, "tz": tz, "lod": lod,
        "nrows": nrows, "ncols": ncols,
        "elev": {"dtype": "int16", "b64": base64.b64encode(bytes(elev)).decode()},
        "climate": {"channels": CHANNELS, "dtype": "float32",
                    "b64": base64.b64encode(bytes(clim)).decode()},
    }


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        raw = self.rfile.read(n) if n else b"{}"
        if self.path.endswith("/health"):
            return self._send(200, {"ok": True, "model": "mock", "seed": 0})
        if self.path.endswith("/tile"):
            req = json.loads(raw or b"{}")
            env = synthetic_envelope(
                int(req.get("seed", 0)), int(req.get("tx", 0)), int(req.get("tz", 0)),
                int(req.get("lod", 0)), int(req.get("tile", TILE)),
            )
            return self._send(200, env)
        self._send(404, {"error": "unknown route " + self.path})

    def do_GET(self):
        if self.path.endswith("/health"):
            return self._send(200, {"ok": True, "model": "mock", "seed": 0})
        self._send(404, {"error": "unknown route " + self.path})

    def log_message(self, *a):
        pass  # quiet


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8917)
    args = ap.parse_args()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[mock-worker] serving on http://{args.host}:{args.port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
