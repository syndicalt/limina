# veilstone-monolith.py — HERO fantasy landmark: an ancient Starweaver relic authored in headless
# Blender. A ~12m tapering basalt obelisk with real geometric bas-relief carving (celestial maps,
# robed figures, flowing rune script), a crisp GLOWING rune band at ~2/3 height, a multi-faceted
# glowing crystal crown, floating crystal shards, emissive crack-fill veins, bioluminescent
# vines/moss, pilgrim offerings, and a stepped stone platform with a scorched ground ring.
#
#   blender --background --factory-startup --python tools/blender/veilstone-monolith.py -- --out assets/veilstone-monolith.glb
#
# Same recipe as cottage.py/tudor-cottage.py (bake -> tile -> consume for the main stone material),
# but the CARVING is real 3D geometry (per-vertex procedural displacement in Python using
# mathutils.noise), not a baked normal map — deep bas-relief must survive at any lighting angle in
# the engine's simplified WebGL lighting, and true geometry is the most robust way to guarantee that.
#
# ENGINE-TRANSLATION NOTES (glTF/three.js consumption, not a Cycles render):
#   - No volumes, no particle systems, no shader animation. "Leaking light" = emissive geometry.
#   - Glow = Principled BSDF "Emission Color" + "Emission Strength" (Blender 4.0+ has these as
#     direct Principled inputs, no separate Emission node needed). Strength > 1 auto-exports the
#     KHR_materials_emissive_strength extension, which three.js 0.184 reads natively. The engine's
#     ACES tone-mapping compresses highlights, so emissive strengths here are pushed to 3.5-6.0 —
#     dim glows would tone-map to nothing.
#   - Crystals are mostly OPAQUE (glossy low-roughness + strong emissive core), no Transmission.
#   - Floating shards are REAL static meshes in an irregular ring, not a particle system.

import bpy, bmesh, sys, math, random, mathutils
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[argv.index("--out") + 1] if "--out" in argv else "assets/veilstone-monolith.glb"
RES = 512
random.seed(986754)  # req_98675_4 — deterministic

# ---- reset -------------------------------------------------------------------
bpy.ops.object.select_all(action="SELECT"); bpy.ops.object.delete()
for c in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.curves):
    for d in list(c):
        try: c.remove(d)
        except Exception: pass

# ================================================================================
# ---- generic helpers (same pattern as cottage.py / tudor-cottage.py) ---------
# ================================================================================
def box(name, center, size):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=center)
    o = bpy.context.active_object; o.name = name; o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    return o

def box_rot(name, center, size, rot_deg, mat=None):
    """A box placed+rotated+scaled in one go (never moved again afterward, so applying
    location+rotation+scale together is safe — see the tudor-cottage.py transform_apply gotcha
    note: that gotcha only bites objects that get REPOSITIONED after an early scale-only apply)."""
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=center)
    o = bpy.context.active_object; o.name = name; o.scale = size
    o.rotation_euler = tuple(math.radians(a) for a in rot_deg)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if mat: o.data.materials.append(mat)
    return o

def boolean(target, cutter, op="DIFFERENCE"):
    md = target.modifiers.new("b", "BOOLEAN"); md.operation = op; md.object = cutter; md.solver = "EXACT"
    bpy.context.view_layer.objects.active = target
    bpy.ops.object.modifier_apply(modifier=md.name)
    bpy.data.objects.remove(cutter, do_unlink=True)

def bevel(o, w=0.02, s=1):
    bpy.context.view_layer.objects.active = o
    md = o.modifiers.new("bv", "BEVEL"); md.width = w; md.segments = s; md.limit_method = "ANGLE"
    bpy.ops.object.modifier_apply(modifier=md.name)

def solid(name, rgb, rough=0.85, metal=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1.0)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    return m

def emissive(name, base_rgb, emit_rgb, strength, rough=0.35, metal=0.0):
    """Principled BSDF with Emission Color/Strength set directly (Blender 4+ socket) — exports as
    standard glTF emissiveFactor + KHR_materials_emissive_strength when strength > 1."""
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*base_rgb, 1.0)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    b.inputs["Emission Color"].default_value = (*emit_rgb, 1.0)
    b.inputs["Emission Strength"].default_value = strength
    return m

def bake_material(name, build, res=RES, use_normal=True):
    bpy.ops.mesh.primitive_plane_add(size=2, location=(200, 0, 0))
    pl = bpy.context.active_object
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; nds = nt.nodes; lk = nt.links
    bsdf = nds["Principled BSDF"]
    build(nds, lk, bsdf)
    pl.data.materials.append(m)
    sc = bpy.context.scene; sc.render.engine = "CYCLES"; sc.cycles.device = "CPU"; sc.cycles.samples = 16
    imgs = {}
    passes = [("DIFFUSE", "alb", False, {"pass_filter": {"COLOR"}}), ("ROUGHNESS", "rgh", True, {})]
    if use_normal: passes.append(("NORMAL", "nrm", True, {}))
    for bt, nm, nc, extra in passes:
        img = bpy.data.images.new(f"{name}_{nm}", res, res)
        img.colorspace_settings.name = "Non-Color" if nc else "sRGB"
        tx = nds.new("ShaderNodeTexImage"); tx.image = img; tx.select = True; nds.active = tx
        bpy.context.view_layer.objects.active = pl
        bpy.ops.object.bake(type=bt, width=res, height=res, margin=4, use_clear=True, **extra)
        img.pack()
        imgs[nm] = img
    bpy.data.objects.remove(pl, do_unlink=True)
    return imgs

def tiled_material(name, imgs, tile_m=1.0):
    sm = bpy.data.materials.new(name); sm.use_nodes = True; nt = sm.node_tree; n = nt.nodes; l = nt.links
    b = n["Principled BSDF"]
    uv = n.new("ShaderNodeTexCoord"); mp = n.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (1.0 / tile_m, 1.0 / tile_m, 1.0 / tile_m)
    l.new(uv.outputs["UV"], mp.inputs["Vector"])
    def tex(img, nc):
        t = n.new("ShaderNodeTexImage"); t.image = img; t.extension = "REPEAT"
        if nc: t.image.colorspace_settings.name = "Non-Color"
        l.new(mp.outputs["Vector"], t.inputs["Vector"]); return t
    l.new(tex(imgs["alb"], False).outputs["Color"], b.inputs["Base Color"])
    l.new(tex(imgs["rgh"], True).outputs["Color"], b.inputs["Roughness"])
    if "nrm" in imgs:
        nrm = n.new("ShaderNodeNormalMap")
        l.new(tex(imgs["nrm"], True).outputs["Color"], nrm.inputs["Color"])
        l.new(nrm.outputs["Normal"], b.inputs["Normal"])
    return sm

def apply_tiled(obj, mat):
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.cube_project(cube_size=1.0, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    obj.data.materials.clear(); obj.data.materials.append(mat)

def join_all(name, parts):
    if not parts: return None
    bpy.ops.object.select_all(action="DESELECT")
    for o in parts: o.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    parts[0].name = name
    return parts[0]

def smoothstep(e0, e1, x):
    if e1 == e0: return 0.0 if x < e0 else 1.0
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)

# ================================================================================
# ---- material node graph: dark basalt with cool blue mineral veins -----------
# ================================================================================
def build_basalt(nds, lk, bsdf):
    tc = nds.new("ShaderNodeTexCoord")
    noise1 = nds.new("ShaderNodeTexNoise"); noise1.inputs["Scale"].default_value = 6; noise1.inputs["Detail"].default_value = 6
    lk.new(tc.outputs["UV"], noise1.inputs["Vector"])
    ramp1 = nds.new("ShaderNodeValToRGB")
    ramp1.color_ramp.elements[0].position = 0.35; ramp1.color_ramp.elements[0].color = (0.045, 0.045, 0.05, 1)
    ramp1.color_ramp.elements[1].position = 0.65; ramp1.color_ramp.elements[1].color = (0.115, 0.115, 0.13, 1)
    lk.new(noise1.outputs["Fac"], ramp1.inputs["Fac"])
    # voronoi vein network — THIN cool-blue mineral veins along cell boundaries only (v2: the v1
    # thresholds were larger than the typical distance-to-edge range at this scale, so almost the
    # whole cell interior read as "vein" — a cobblestone-mosaic bug. Bigger cells (lower scale) +
    # a much tighter threshold band now confines the blue tint to slender crack-like lines.)
    vor = nds.new("ShaderNodeTexVoronoi"); vor.feature = "DISTANCE_TO_EDGE"; vor.inputs["Scale"].default_value = 2.0
    lk.new(tc.outputs["UV"], vor.inputs["Vector"])
    veinramp = nds.new("ShaderNodeValToRGB")
    veinramp.color_ramp.elements[0].position = 0.006; veinramp.color_ramp.elements[0].color = (1, 1, 1, 1)
    veinramp.color_ramp.elements[1].position = 0.022; veinramp.color_ramp.elements[1].color = (0, 0, 0, 1)
    lk.new(vor.outputs["Distance"], veinramp.inputs["Fac"])
    veincolor = nds.new("ShaderNodeMixRGB"); veincolor.blend_type = "MIX"
    lk.new(ramp1.outputs["Color"], veincolor.inputs["Color1"])
    veincolor.inputs["Color2"].default_value = (0.24, 0.46, 0.70, 1)
    lk.new(veinramp.outputs["Color"], veincolor.inputs["Fac"])
    lk.new(veincolor.outputs["Color"], bsdf.inputs["Base Color"])
    rgh = nds.new("ShaderNodeValToRGB")
    rgh.color_ramp.elements[0].position = 0.4; rgh.color_ramp.elements[0].color = (0.68, 0.68, 0.68, 1)
    rgh.color_ramp.elements[1].position = 0.6; rgh.color_ramp.elements[1].color = (0.88, 0.88, 0.88, 1)
    lk.new(noise1.outputs["Fac"], rgh.inputs["Fac"])
    lk.new(rgh.outputs["Color"], bsdf.inputs["Roughness"])
    # v3 note: round-2 GPU-eyes render showed the big geometric bas-relief (celestial dots, robed
    # figure, rune dashes — all REAL vertex displacement, confirmed present with up to 0.26m of
    # protrusion by a standalone math check) completely unreadable — pixel-sampled the render and
    # the vein texture's own high-frequency bump/contrast was visually drowning it out. Calmed the
    # texture-level bumps way down here so the LARGE shapes (boosted further below) can read.
    bump1 = nds.new("ShaderNodeBump"); bump1.inputs["Strength"].default_value = 0.16
    lk.new(noise1.outputs["Fac"], bump1.inputs["Height"])
    bump2 = nds.new("ShaderNodeBump"); bump2.inputs["Strength"].default_value = 0.12
    lk.new(vor.outputs["Distance"], bump2.inputs["Height"]); lk.new(bump1.outputs["Normal"], bump2.inputs["Normal"])
    # subtle vertical paneling
    mpv = nds.new("ShaderNodeMapping"); mpv.inputs["Scale"].default_value = (14, 1, 1)
    lk.new(tc.outputs["UV"], mpv.inputs["Vector"])
    wave = nds.new("ShaderNodeTexWave"); wave.wave_type = "BANDS"
    wave.inputs["Scale"].default_value = 1; wave.inputs["Distortion"].default_value = 0.3; wave.inputs["Detail"].default_value = 1
    lk.new(mpv.outputs["Vector"], wave.inputs["Vector"])
    bump3 = nds.new("ShaderNodeBump"); bump3.inputs["Strength"].default_value = 0.06
    lk.new(wave.outputs["Fac"], bump3.inputs["Height"]); lk.new(bump2.outputs["Normal"], bump3.inputs["Normal"])
    lk.new(bump3.outputs["Normal"], bsdf.inputs["Normal"])

IMG_BASALT = bake_material("Basalt", build_basalt)
MAT_STONE_SHAFT = tiled_material("BasaltShaft", IMG_BASALT, tile_m=1.0)
MAT_STONE_PLATFORM = tiled_material("BasaltPlatform", IMG_BASALT, tile_m=1.7)

# v3 note: round-2 GPU-eyes render still showed every glow as pale near-white (sampled actual
# pixels: (229,242,244) etc — R only ~6% below G/B). Diagnosis (confirmed against three.js's ACES
# filmic curve by hand): the v2 colors clustered all 3 channels close together (e.g. 0.35/0.85/1.0)
# *before* multiplying by strength, so after ACES's per-channel highlight rolloff every channel
# gets crushed toward 1.0 in the SAME proportion — chroma survives multiplication but not the
# curve's compression once all channels are already bright. The fix is per-channel SEPARATION: push
# one channel near-zero and keep total raw radiance (color*strength) under ~1.5 so the curve has
# room to keep them apart. (base_rgb also unlit-dark now — it was fighting the hue at low light.)
MAT_RUNE_GLOW = emissive("RuneGlow", (0.03, 0.08, 0.14), (0.04, 0.45, 0.95), 1.5, rough=0.35)
MAT_CRACK_GLOW = emissive("CrackGlow", (0.04, 0.1, 0.16), (0.08, 0.4, 0.9), 1.3, rough=0.3)
MAT_MOSS = emissive("Moss", (0.02, 0.1, 0.04), (0.05, 0.85, 0.25), 1.0, rough=0.75)
MAT_CRYSTAL_VIOLET = emissive("CrystalViolet", (0.1, 0.02, 0.16), (0.55, 0.05, 0.85), 1.4, rough=0.12)
MAT_CRYSTAL_CYAN = emissive("CrystalCyan", (0.02, 0.12, 0.11), (0.03, 0.75, 0.65), 1.4, rough=0.12)
MAT_CRYSTAL_SILVER = emissive("CrystalSilver", (0.2, 0.2, 0.24), (0.7, 0.75, 0.85), 1.3, rough=0.12)
CRYSTAL_MATS = [MAT_CRYSTAL_VIOLET, MAT_CRYSTAL_CYAN, MAT_CRYSTAL_SILVER]
MAT_POTTERY = solid("Pottery", (0.42, 0.24, 0.15), 0.85)
MAT_GOLD = solid("Coin", (0.7, 0.55, 0.15), 0.35, 0.9)
MAT_STEM = solid("Stem", (0.1, 0.25, 0.08), 0.8)
MAT_PETAL = emissive("Petal", (0.1, 0.03, 0.12), (0.5, 0.15, 0.6), 0.8, rough=0.5)
MAT_SCORCH = solid("Scorch", (0.035, 0.022, 0.02), 0.92)

# ================================================================================
# ---- dimensions (metres) ------------------------------------------------------
# ================================================================================
PLAT_R = [3.0, 2.6, 2.2]   # 3 stepped rings, largest first
PLAT_STEP_H = 0.15
PLAT_TOP = len(PLAT_R) * PLAT_STEP_H          # 0.45 — top step surface

BW0, BD0 = 1.25, 1.0        # base half-width/depth -> 2.5 x 2.0m footprint
BW1, BD1 = 0.85, 0.68       # top half-width/depth -> slight taper
SHAFT_Z0 = PLAT_TOP
SHAFT_H = 10.4
SHAFT_Z1 = SHAFT_Z0 + SHAFT_H

def halfw(t): return BW0 + (BW1 - BW0) * t
def halfd(t): return BD0 + (BD1 - BD0) * t

# ================================================================================
# ---- carved shaft: real per-vertex bas-relief geometry (not just a normal map) -
# ================================================================================
def relief_height(face_id, uu, t_local, t_global, seed):
    """uu in [-1,1] across face width, t_local/t_global in [0,1] fraction of height. Combines
    weathering/erosion, subtle vertical paneling grooves, upper celestial-map star scatter, a
    mid-lower flowing rune-script dash grid, and one raised robed-figure silhouette with arms
    flaring upward (channeling energy skyward) per face. Returns an outward offset in metres."""
    # v3 note: the geometry was already there (verified up to 0.11-0.26m of protrusion by a
    # standalone check) but got visually drowned out by the basalt texture's own bump-mapping —
    # fixed that at the texture level (build_basalt bump strengths cut ~2/3). Pushed these a bit
    # further too so the shapes unambiguously read as carving, not stone-scale noise.
    tg = t_global
    h = 0.0
    h += 0.022 * mathutils.noise.noise(Vector((uu * 3.1 + seed * 7.7, tg * 7.3, face_id * 11.3 + seed)))
    gp = (uu * 4.0) % 1.0
    if abs(gp - 0.5) < 0.06:
        h -= 0.014
    if tg > 0.5:
        d, _ = mathutils.noise.voronoi(Vector((uu * 4.5 + seed * 3.1, tg * 8.0 + seed, face_id * 5.7)))
        dot = max(0.0, 0.15 - d[0]) * 0.75
        h += dot * smoothstep(0.5, 0.62, tg)
    if 0.06 < tg < 0.5:
        row = math.floor(tg * 34)
        col = math.floor((uu * 0.5 + 0.5) * 14)
        cellv = mathutils.noise.cell(Vector((row + seed * 13, col + face_id * 7, seed)))
        if cellv > 0.1:
            h += 0.085 * smoothstep(0.06, 0.12, tg) * smoothstep(0.5, 0.44, tg)
    figt0, figt1 = 0.18, 0.52
    if figt0 < tg < figt1:
        ft = (tg - figt0) / (figt1 - figt0)
        robe_hw = 0.10 + 0.24 * (1 - ft)
        body = smoothstep(robe_hw + 0.03, robe_hw - 0.03, abs(uu))
        h += body * 0.16
        if ft > 0.7:
            arm_u = 0.05 + (ft - 0.7) / 0.3 * 0.32
            arm = smoothstep(0.06, 0.0, abs(abs(uu) - arm_u))
            h += arm * 0.13
    return h

def band_relief(face_id, uu, t_local, t_global, seed):
    """Prominent ~2/3-height rune band: a raised plate (reads as an inset banner) with denser,
    crisper glyph-stroke dashes than the general script — this object gets MAT_RUNE_GLOW. Base
    plate offset (0.1m) is kept safely ABOVE the max carving relief on the shaft underneath it
    (constellation dots there top out ~0.045m) so the glow plane never z-fights the stone."""
    row = math.floor(t_local * 3)
    col = math.floor((uu * 0.5 + 0.5) * 22)
    cellv = mathutils.noise.cell(Vector((row * 3.3 + seed * 17, col + face_id * 11, seed * 5 + 1)))
    return 0.10 + (0.045 if cellv > 0.05 else 0.0)

def make_face_object(name, face_id, nx, ny, z0, z1, relief_fn, seed):
    """Build one tapered side face of the shaft (or a sub-band of it) as its own subdivided mesh,
    outward normal auto-corrected. face_id: 0=front(+Y) 1=back(-Y) 2=right(+X) 3=left(-X)."""
    bm = bmesh.new()
    grid = [[None] * (nx + 1) for _ in range(ny + 1)]
    for j in range(ny + 1):
        t_local = j / ny
        z = z0 + (z1 - z0) * t_local
        t_global = (z - SHAFT_Z0) / SHAFT_H
        hw, hd = halfw(t_global), halfd(t_global)
        for i in range(nx + 1):
            uu = -1 + 2 * i / nx
            rh = relief_fn(face_id, uu, t_local, t_global, seed)
            if face_id == 0:   x, y = uu * hw, hd + rh
            elif face_id == 1: x, y = -uu * hw, -(hd + rh)
            elif face_id == 2: x, y = hw + rh, uu * hd
            else:               x, y = -(hw + rh), -uu * hd
            grid[j][i] = bm.verts.new((x, y, z))
    for j in range(ny):
        for i in range(nx):
            v00, v10, v01, v11 = grid[j][i], grid[j][i + 1], grid[j + 1][i], grid[j + 1][i + 1]
            bm.faces.new((v00, v10, v11)); bm.faces.new((v00, v11, v01))
    bm.faces.ensure_lookup_table()
    bm.normal_update()
    expected = {0: Vector((0, 1, 0)), 1: Vector((0, -1, 0)), 2: Vector((1, 0, 0)), 3: Vector((-1, 0, 0))}[face_id]
    if bm.faces[0].normal.dot(expected) < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    return ob

SHAFT_PARTS = []
for fid in range(4):
    ob = make_face_object(f"shaftFace{fid}", fid, 28, 56, SHAFT_Z0, SHAFT_Z1, relief_height, seed=fid * 4.1)
    apply_tiled(ob, MAT_STONE_SHAFT)
    SHAFT_PARTS.append(ob)

# top cap (crystal cluster sits on this)
bmc = bmesh.new()
v1 = bmc.verts.new((-BW1, -BD1, SHAFT_Z1)); v2 = bmc.verts.new((BW1, -BD1, SHAFT_Z1))
v3 = bmc.verts.new((BW1, BD1, SHAFT_Z1)); v4 = bmc.verts.new((-BW1, BD1, SHAFT_Z1))
f = bmc.faces.new((v1, v2, v3, v4)); bmc.normal_update()
if f.normal.z < 0: bmesh.ops.reverse_faces(bmc, faces=[f])
me_top = bpy.data.meshes.new("shaftTop"); bmc.to_mesh(me_top); bmc.free()
top_cap = bpy.data.objects.new("shaftTop", me_top); bpy.context.collection.objects.link(top_cap)
apply_tiled(top_cap, MAT_STONE_SHAFT)
SHAFT_PARTS.append(top_cap)

# ---- rune bands: one glowing carved strip per face at ~2/3 height ------------
RUNE_PARTS = []
BAND_Z0, BAND_Z1 = SHAFT_Z0 + SHAFT_H * 0.62, SHAFT_Z0 + SHAFT_H * 0.72
for fid in range(4):
    ob = make_face_object(f"rune{fid}", fid, 26, 12, BAND_Z0, BAND_Z1, band_relief, seed=fid * 3.7 + 1)
    ob.data.materials.append(MAT_RUNE_GLOW)
    RUNE_PARTS.append(ob)

# ---- emissive crack veins (thin light-leaking strips, lower/middle sections) -
def add_crack(face_id, u_frac, t_frac, length, angle_deg):
    tg = t_frac; z = SHAFT_Z0 + SHAFT_H * tg; hw, hd = halfw(tg), halfd(tg)
    if face_id == 0:   x, y, rot, size = u_frac * hw, hd + 0.012, (0, angle_deg, 0), (0.03, 0.018, length)
    elif face_id == 1: x, y, rot, size = -u_frac * hw, -(hd + 0.012), (0, angle_deg, 0), (0.03, 0.018, length)
    elif face_id == 2: x, y, rot, size = hw + 0.012, u_frac * hd, (angle_deg, 0, 0), (0.018, 0.03, length)
    else:               x, y, rot, size = -(hw + 0.012), -u_frac * hd, (angle_deg, 0, 0), (0.018, 0.03, length)
    return box_rot("crack", (x, y, z), size, rot, MAT_CRACK_GLOW)

CRACK_PARTS = [add_crack(*spec) for spec in [
    (0, -0.3, 0.18, 1.3, 12), (0, 0.35, 0.30, 1.0, -8), (1, 0.10, 0.22, 1.1, 6),
    (2, -0.20, 0.35, 0.9, -10), (3, 0.25, 0.15, 1.4, 9), (1, -0.35, 0.42, 0.7, -14),
]]

# ================================================================================
# ---- crystal crown + floating shards ------------------------------------------
# ================================================================================
def add_crystal(name, cx, cy, cz, h, r, mat, rot_deg, sides):
    bpy.ops.mesh.primitive_cone_add(vertices=sides, radius1=r, radius2=r * 0.04, depth=h, location=(cx, cy, cz + h / 2))
    o = bpy.context.active_object; o.name = name
    o.rotation_euler = tuple(math.radians(a) for a in rot_deg)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    o.data.materials.append(mat)
    return o

CLUSTER_BASE_Z = SHAFT_Z1 - 0.3
CRYSTAL_PARTS = []
for i in range(7):
    ang = random.uniform(0, 2 * math.pi); rad = random.uniform(0.05, 0.5)
    cx, cy = rad * math.cos(ang), rad * math.sin(ang)
    cz = CLUSTER_BASE_Z + random.uniform(-0.1, 0.15)
    h, r = random.uniform(1.0, 1.9), random.uniform(0.16, 0.3)
    rot = (random.uniform(-15, 15), random.uniform(-15, 15), random.uniform(0, 360))
    CRYSTAL_PARTS.append(add_crystal(f"crystal{i}", cx, cy, cz, h, r, CRYSTAL_MATS[i % 3], rot, random.choice([6, 7, 8])))

SHARD_PARTS = []
N_SHARDS = 7
for i in range(N_SHARDS):
    ang = (i / N_SHARDS) * 2 * math.pi + random.uniform(-0.3, 0.3)
    rad = random.uniform(1.5, 2.3)
    cx, cy = rad * math.cos(ang), rad * math.sin(ang)
    cz = SHAFT_Z0 + SHAFT_H * random.uniform(0.55, 0.95)
    h, r = random.uniform(0.18, 0.34), random.uniform(0.05, 0.1)
    rot = (random.uniform(-40, 40), random.uniform(-40, 40), random.uniform(0, 360))
    SHARD_PARTS.append(add_crystal(f"shard{i}", cx, cy, cz, h, r, CRYSTAL_MATS[i % 3], rot, 6))

# ================================================================================
# ---- bioluminescent vines + moss (bottom third) -------------------------------
# ================================================================================
def make_vine(name, ang0, rad0, radn, z0, height, turns, bevel_r, mat, n_pts=14):
    curve = bpy.data.curves.new(name, "CURVE"); curve.dimensions = "3D"
    sp = curve.splines.new("BEZIER"); sp.bezier_points.add(n_pts - 1)
    for i in range(n_pts):
        t = i / (n_pts - 1)
        ang = ang0 + turns * 2 * math.pi * t
        rad = rad0 + (radn - rad0) * t
        p = sp.bezier_points[i]
        p.co = (rad * math.cos(ang), rad * math.sin(ang), z0 + height * t)
        p.handle_left_type = "AUTO"; p.handle_right_type = "AUTO"
    curve.bevel_depth = bevel_r; curve.bevel_resolution = 2
    ob = bpy.data.objects.new(name, curve); bpy.context.collection.objects.link(ob)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.select_all(action="DESELECT"); ob.select_set(True)
    bpy.ops.object.convert(target="MESH")
    ob.data.materials.append(mat)
    return ob

VINE_PARTS = []
for i in range(4):
    ang0 = i * (2 * math.pi / 4) + random.uniform(-0.2, 0.2)
    rad0 = 1.05 + random.uniform(-0.05, 0.05)
    VINE_PARTS.append(make_vine(f"vine{i}", ang0, rad0, rad0 * 0.85, SHAFT_Z0 + 0.05, SHAFT_H * 0.33,
                                 1.3 + random.uniform(-0.2, 0.3), 0.028, MAT_MOSS))

MOSS_PARTS = []
for i in range(14):
    ang, rad = random.uniform(0, 2 * math.pi), random.uniform(0.85, 1.35)
    x, y = rad * math.cos(ang), rad * math.sin(ang)
    z = SHAFT_Z0 + random.uniform(0.05, 1.3)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=random.uniform(0.08, 0.18), location=(x, y, z))
    o = bpy.context.active_object; o.name = "moss"; o.scale = (1, 1, 0.4)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    o.data.materials.append(MAT_MOSS)
    MOSS_PARTS.append(o)

# ================================================================================
# ---- pilgrim offerings at the base --------------------------------------------
# ================================================================================
OFFERING_PARTS = []
pang, prad = random.uniform(0, 2 * math.pi), 1.6
px, py = prad * math.cos(pang), prad * math.sin(pang)
bpy.ops.mesh.primitive_cone_add(vertices=10, radius1=0.16, radius2=0.12, depth=0.28, location=(px, py, PLAT_TOP + 0.05))
jar = bpy.context.active_object; jar.name = "jar"; jar.rotation_euler = (math.radians(85), 0, math.radians(30))
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
jar.data.materials.append(MAT_POTTERY)
OFFERING_PARTS.append(jar)
for i in range(3):
    fx, fy = px + random.uniform(-0.25, 0.25), py + random.uniform(-0.25, 0.25)
    OFFERING_PARTS.append(box_rot(f"shard{i}", (fx, fy, PLAT_TOP + 0.02), (0.09, 0.06, 0.03),
                                   (0, 0, random.uniform(0, 360)), MAT_POTTERY))
for i in range(5):
    ang, rad = random.uniform(0, 2 * math.pi), random.uniform(1.3, 2.0)
    cx, cy = rad * math.cos(ang), rad * math.sin(ang)
    bpy.ops.mesh.primitive_cylinder_add(vertices=10, radius=0.05, depth=0.008, location=(cx, cy, PLAT_TOP + 0.006))
    o = bpy.context.active_object; o.name = "coin"
    o.rotation_euler = (math.radians(random.uniform(0, 8)), 0, math.radians(random.uniform(0, 360)))
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    o.data.materials.append(MAT_GOLD)
    OFFERING_PARTS.append(o)
for i in range(4):
    ang, rad = random.uniform(0, 2 * math.pi), random.uniform(1.3, 2.1)
    fx, fy = rad * math.cos(ang), rad * math.sin(ang)
    tilt = random.uniform(35, 65)
    bpy.ops.mesh.primitive_cylinder_add(vertices=6, radius=0.012, depth=0.22, location=(fx, fy, PLAT_TOP + 0.11))
    stem = bpy.context.active_object; stem.name = "stem"
    stem.rotation_euler = (math.radians(tilt), 0, math.radians(random.uniform(0, 360)))
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    stem.data.materials.append(MAT_STEM)
    OFFERING_PARTS.append(stem)
    tipz = PLAT_TOP + 0.11 + 0.11 * math.cos(math.radians(tilt))
    tipr = 0.11 * math.sin(math.radians(tilt))
    pang2 = random.uniform(0, 2 * math.pi)
    tx, ty = fx + tipr * math.cos(pang2), fy + tipr * math.sin(pang2)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=0.045, location=(tx, ty, tipz))
    petal = bpy.context.active_object; petal.name = "petal"; petal.scale = (1, 1, 0.6)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    petal.data.materials.append(MAT_PETAL)
    OFFERING_PARTS.append(petal)

# ================================================================================
# ---- stepped stone platform + scorched ground ring ----------------------------
# ================================================================================
PLATFORM_PARTS = []
z = 0.0
for i, r in enumerate(PLAT_R):
    bpy.ops.mesh.primitive_cylinder_add(vertices=40, radius=r, depth=PLAT_STEP_H, location=(0, 0, z + PLAT_STEP_H / 2))
    o = bpy.context.active_object; o.name = f"platform{i}"
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    apply_tiled(o, MAT_STONE_PLATFORM)
    bevel(o, 0.03, 1)
    PLATFORM_PARTS.append(o)
    z += PLAT_STEP_H

bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=3.35, depth=0.03, location=(0, 0, 0.015))
scorch_outer = bpy.context.active_object; scorch_outer.name = "scorchOuter"
bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=3.0, depth=0.06, location=(0, 0, 0.015))
scorch_inner = bpy.context.active_object
boolean(scorch_outer, scorch_inner)
scorch_outer.data.materials.append(MAT_SCORCH)
scorch_outer.name = "ScorchRing"

# ================================================================================
# ---- join into final asset objects + export -----------------------------------
# ================================================================================
join_all("Shaft", SHAFT_PARTS)
join_all("RuneBands", RUNE_PARTS)
join_all("CrackVeins", CRACK_PARTS)
join_all("CrystalCluster", CRYSTAL_PARTS)
join_all("FloatingShards", SHARD_PARTS)
join_all("Vines", VINE_PARTS)
join_all("MossPatches", MOSS_PARTS)
join_all("PilgrimOfferings", OFFERING_PARTS)
join_all("Platform", PLATFORM_PARTS)

def tri_count(me):
    me.calc_loop_triangles()
    return len(me.loop_triangles)
total_tris = sum(tri_count(o.data) for o in bpy.data.objects if o.type == "MESH")
print(f"veilstone-monolith: total tris ~= {total_tris}")
print(f"veilstone-monolith: shaft top z={SHAFT_Z1:.2f} crystal top~={CLUSTER_BASE_Z + 1.9:.2f} platform diameter={PLAT_R[0]*2:.1f}")

bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_yup=True, export_apply=True)
print(f"veilstone-monolith: wrote {OUT}")
