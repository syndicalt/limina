#!/usr/bin/env python3
"""
Unit test for the terrain-diffusion -> limina /tile shim (tools/terrain-diffusion/shim.py).

NO GPU and NO network: a SYNTHETIC `/terrain` response is built in the EXACT real byte
format (int16-LE elevation, then float32-LE INTERLEAVED (H,W,4) climate, dims via
X-Height/X-Width) and fed through the shim's translation. We then decode the resulting
limina `/tile` envelope and assert it is byte-exact:
  * elevation int16 round-trips to metres, row-major;
  * climate is repacked CHANNEL-MAJOR (C,H,W) FAITHFULLY (temp@0, t_season@1, precip@2,
    p_cv@3) -- no reorder, no drop, NO biome channel;
  * the tile->pixel/scale mapping (z->i/rows, x->j/cols), seed gate, lod oversample,
    elev clamp, and the 30 m/px native constant;
  * THE CROSS-COMPONENT CONTRACT: decoding this wire the way a DEFAULT-configured
    `ModelTerrainSource` does (temp = channel 0, precip = channel 2, biome classified
    from temp+precip) yields the right temp/precip and a sane biome. This is the seam
    that silently broke when the wire forked from the consumer's expectations.

Byte layout / endianness / channel order is where the bugs hide, so this is exhaustive.

Run:  python tools/terrain-diffusion/test_shim.py     (exit 0 = pass)
   or: pytest tools/terrain-diffusion/test_shim.py
"""
import base64
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shim import (  # noqa: E402
    DEFAULT_NATIVE_M_PER_PX,
    Shim,
    tile_to_box,
    translate_terrain,
)

# Canonical climate channel layout the model emits + the shim preserves (model-source
# defaults select TEMP_CH for tempC and PRECIP_CH for precipMm). Pinned here so a wire
# change that breaks the consumer fails this test.
NCHAN = 4
TEMP_CH, T_SEASON_CH, PRECIP_CH, P_CV_CH = 0, 1, 2, 3

# Canonical Biome enum (MUST match js/src/terrain/types.ts) -- the reference the consumer
# classifies into; used here only to assert the decoded biome is sane.
ICE, DESERT, STEPPE, SAVANNA, TEMPERATE_FOREST, TROPICAL, BOREAL_WET = 0, 1, 2, 3, 4, 5, 6


def classify_biome_ref(temp_c, precip_mm):
    """Reference port of model-source.ts:classifyBiome -- the consumer's biome rule."""
    if temp_c < 0:
        return ICE
    if temp_c < 5:
        return BOREAL_WET if precip_mm > 500 else STEPPE
    if temp_c < 18:
        if precip_mm < 350:
            return STEPPE
        if precip_mm < 1500:
            return TEMPERATE_FOREST
        return BOREAL_WET
    if precip_mm < 250:
        return DESERT
    if precip_mm < 1000:
        return SAVANNA
    return TROPICAL


# --- synthetic upstream: build a /terrain body in the EXACT real format -----------
def synth_terrain_bytes(h, w):
    """elev[r,c] = r*10 + c (distinct per cell, catches transpose/index bugs).
    climate channels [temp, t_season, precip, p_cv]:
       temp   = -10 + 5*r       (spans ICE/cold/temperate/warm bands)
       precip = 200 * c         (spans arid..wet within each temp band)
       t_season = 999, p_cv = -999  (DISTINCT sentinels so a temp/precip mixup is caught)
    Returns (raw_bytes, elev_expected, temp_expected, precip_expected)."""
    elev = np.empty((h, w), dtype="<i2")
    temp = np.empty((h, w), dtype="<f4")
    precip = np.empty((h, w), dtype="<f4")
    for r in range(h):
        for c in range(w):
            elev[r, c] = r * 10 + c
            temp[r, c] = -10.0 + 5.0 * r
            precip[r, c] = 200.0 * c
    # channel-major (4,H,W) then transpose to (H,W,4) interleaved -- exactly api.py.
    clim = np.empty((NCHAN, h, w), dtype="<f4")
    clim[TEMP_CH] = temp
    clim[T_SEASON_CH] = 999.0    # sentinel
    clim[PRECIP_CH] = precip
    clim[P_CV_CH] = -999.0       # sentinel
    interleaved = np.ascontiguousarray(np.transpose(clim, (1, 2, 0)))  # (H,W,4)
    raw = np.ascontiguousarray(elev).tobytes() + interleaved.tobytes()
    return raw, elev, temp, precip


class MockShim(Shim):
    """A shim whose upstream is the synthetic generator (no network). It records the
    pixel box it was asked for so the tile->pixel mapping is verified end-to-end."""
    def __init__(self, **kw):
        super().__init__(**kw)
        self.last_box = None

    def fetch_terrain(self, i1, j1, i2, j2, scale):
        self.last_box = (i1, j1, i2, j2, scale)
        h = i2 - i1
        w = j2 - j1
        raw, *_ = synth_terrain_bytes(h, w)
        return raw, h, w


def make_shim(**over):
    kw = dict(
        target_url="http://mock", region_seed=1234, base_scale=1, max_scale=8,
        native_m_per_px=DEFAULT_NATIVE_M_PER_PX, elev_min=None, elev_max=None,
        default_tile=8, timeout=1.0,
    )
    kw.update(over)
    return MockShim(**kw)


# --- tests ----------------------------------------------------------------------
def test_native_resolution_is_30m():
    # H3: terrain-diffusion-30m is 30 m/px native (NOT 90). limina metersPerPx == this.
    assert DEFAULT_NATIVE_M_PER_PX == 30.0
    assert make_shim(base_scale=1).m_per_px == 30.0
    assert make_shim(base_scale=2).m_per_px == 15.0  # --scale 2 -> 15 m/px


def test_tile_to_box_mapping():
    # lod 0, base_scale 1: one tile = tile px at native scale, contiguous boxes.
    assert tile_to_box(2, 3, 0, 256, 1, 8) == (768, 512, 1024, 768, 1, 256)
    # z -> i/rows, x -> j/cols (matches model-source.ts localCell)
    i1, j1, i2, j2, scale, px = tile_to_box(2, 3, 0, 256, 1, 8)
    assert (i1, i2) == (3 * 256, 4 * 256) and (j1, j2) == (2 * 256, 3 * 256)
    # adjacency: tile (tx) and (tx+1) share a pixel edge (no gap/overlap).
    a = tile_to_box(0, 0, 0, 256, 1, 8)
    b = tile_to_box(1, 0, 0, 256, 1, 8)
    assert a[3] == b[1], "neighbor tiles must share the j edge (seam-consistent)"
    # origin offset shifts the whole box (anchor limina (0,0) on land vs ocean), adjacency preserved.
    assert tile_to_box(2, 3, 0, 256, 1, 8, 8800, -6300) == (9568, -5788, 9824, -5532, 1, 256)
    oa = tile_to_box(0, 0, 0, 256, 1, 8, 8800, -6300)
    ob = tile_to_box(1, 0, 0, 256, 1, 8, 8800, -6300)
    assert oa[3] == ob[1] and oa[0] == 8800 and oa[1] == -6300, "origin shifts both axes, seam intact"
    # lod is an oversample: scale doubles, px doubles, GROUND METRES STAY CONSTANT.
    native = DEFAULT_NATIVE_M_PER_PX
    ground0 = None
    for lod in range(6):
        i1, j1, i2, j2, scale, px = tile_to_box(0, 0, lod, 256, 1, 8)
        assert scale == min(1 << lod, 8)
        assert px == 256 * scale  # base_scale=1 -> factor==scale
        ground = px * (native / scale)
        ground0 = ground0 or ground
        assert abs(ground - ground0) < 1e-6, f"ground metres drift at lod {lod}: {ground} != {ground0}"


def test_envelope_byte_exact():
    shim = make_shim()
    h = w = 8
    _, elev_exp, temp_exp, precip_exp = synth_terrain_bytes(h, w)
    env = shim.handle_tile({"seed": 1234, "tx": 2, "tz": 3, "lod": 0, "tile": h})

    # the shim used the documented pixel box (z->i, x->j)
    assert shim.last_box == (3 * h, 2 * h, 4 * h, 3 * h, 1)
    assert env["nrows"] == h and env["ncols"] == w
    assert env["seed"] == 1234 and env["tx"] == 2 and env["tz"] == 3 and env["lod"] == 0

    # elevation: int16-LE metres round-trip exactly, row-major
    assert env["elev"]["dtype"] == "int16"
    elev_out = np.frombuffer(base64.b64decode(env["elev"]["b64"]), dtype="<i2").reshape(h, w)
    assert elev_out.tobytes() == elev_exp.tobytes(), "elev not byte-identical"
    assert np.array_equal(elev_out, elev_exp)

    # climate: FAITHFUL channel-major (4,H,W), no reorder/drop, no biome channel
    assert env["climate"]["channels"] == NCHAN and env["climate"]["dtype"] == "float32"
    clim = np.frombuffer(base64.b64decode(env["climate"]["b64"]), dtype="<f4")
    assert clim.size == NCHAN * h * w, f"climate size {clim.size} != {NCHAN*h*w}"
    clim = clim.reshape(NCHAN, h, w)
    assert np.array_equal(clim[TEMP_CH], temp_exp), "temp channel (0) wrong"
    assert np.array_equal(clim[PRECIP_CH], precip_exp), "precip channel (2) wrong"
    assert np.all(clim[T_SEASON_CH] == 999.0), "t_season (1) must be preserved, not dropped"
    assert np.all(clim[P_CV_CH] == -999.0), "p_cv (3) must be preserved, not dropped"


def test_model_source_default_decode_contract():
    """CROSS-COMPONENT: decode the shim wire the way a DEFAULT ModelTerrainSource does
    (tempChannel=0, precipChannel=2, biome classified from temp+precip). temp/precip must
    be right (NOT the t_season/p_cv sentinels) and the biome must be sane."""
    shim = make_shim()
    h = w = 8
    _, _, temp_exp, precip_exp = synth_terrain_bytes(h, w)
    env = shim.handle_tile({"seed": 1234, "tx": 0, "tz": 0, "lod": 0, "tile": h})
    wch = env["climate"]["channels"]
    clim = np.frombuffer(base64.b64decode(env["climate"]["b64"]), dtype="<f4").reshape(wch, h, w)
    # model-source defaults: tempChannel 0, precipChannel 2 must be in range + correct
    assert 0 < wch and 2 < wch, "default temp@0/precip@2 must index a valid channel"
    dec_temp = clim[0]   # what model-source reads as tempC
    dec_precip = clim[2]  # what model-source reads as precipMm
    assert np.array_equal(dec_temp, temp_exp), "default-decode tempC wrong (channel 0)"
    assert np.array_equal(dec_precip, precip_exp), "default-decode precipMm wrong (channel 2 != t_season!)"
    assert not np.any(dec_precip == 999.0), "precip must NOT be the t_season sentinel"
    # biome (classified the way model-source will) is a valid canonical enum, cell-for-cell
    for r in range(h):
        for c in range(w):
            b = classify_biome_ref(float(dec_temp[r, c]), float(dec_precip[r, c]))
            assert 0 <= b <= 6, f"biome out of range at [{r},{c}]: {b}"


def test_translate_pure_and_clamp():
    # direct pure-function path + elevation clamp to a fixed range
    h = w = 4
    raw, elev_exp, _, _ = synth_terrain_bytes(h, w)
    env = translate_terrain(raw, h, w, seed=7, tx=0, tz=0, lod=0, elev_min=5, elev_max=20)
    elev_out = np.frombuffer(base64.b64decode(env["elev"]["b64"]), dtype="<i2").reshape(h, w)
    assert elev_out.min() >= 5 and elev_out.max() <= 20
    assert np.array_equal(elev_out, np.clip(elev_exp, 5, 20))
    # climate still faithful 4-channel
    assert env["climate"]["channels"] == NCHAN


def test_seed_gate():
    shim = make_shim(region_seed=1234)
    # matching seed: fine
    shim.handle_tile({"seed": 1234, "tx": 0, "tz": 0, "lod": 0, "tile": 8})
    # mismatched seed: rejected, and NEVER fetched upstream (no model rebuild)
    shim.last_box = None
    raised = False
    try:
        shim.handle_tile({"seed": 9999, "tx": 0, "tz": 0, "lod": 0, "tile": 8})
    except ValueError:
        raised = True
    assert raised, "mismatched seed must be rejected"
    assert shim.last_box is None, "mismatched seed must NOT hit the model"


def test_lod_oversample_dims():
    """lod 1 doubles resolution (scale 2) over the SAME ground -> 2x nrows/ncols."""
    shim = make_shim(base_scale=1)
    env = shim.handle_tile({"seed": 1234, "tx": 0, "tz": 0, "lod": 1, "tile": 8})
    assert env["nrows"] == 16 and env["ncols"] == 16
    assert shim.last_box[4] == 2  # scale


def _run_all():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print(f"  ok  {t.__name__}")
    print(f"test_shim: {len(tests)} tests passed")


if __name__ == "__main__":
    _run_all()
