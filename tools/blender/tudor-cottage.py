# tudor-cottage.py — a TUDOR-STYLE dwelling authored in headless Blender, with REAL baked textures
# (warm red brick footing, stark white lime-plaster, near-black oak half-timbering, dark wood-shingle
# roof) instead of solid PBR colors. Same recipe/pattern as cottage.py (bake -> tile -> consume), but a
# distinctly different silhouette: a JETTIED upper storey (the signature Tudor overhang), dense
# black-and-white half-timbering with diagonal/herringbone bracing, a steep (50°+) roof and a tall
# brick chimney rising well above the ridge.
#
#   blender --background --factory-startup --python tools/blender/tudor-cottage.py -- --out assets/tudor-cottage.glb
#
# Texture strategy: bake a small procedural node-graph to an IMAGE (Cycles bake passes:
# DIFFUSE/ROUGHNESS/NORMAL) on a throwaway plane, pack the image into the .blend, then build a
# CONSUMPTION material that samples that image via cube-projected UVs tiled at true world scale. Every
# surface (brick, plaster, timber, shingle) gets genuine embedded Image Texture nodes — no flat color.

import bpy, bmesh, sys, math
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[argv.index("--out") + 1] if "--out" in argv else "assets/tudor-cottage.glb"
RES = 512  # texture resolution per bake (keeps GLB small; 4 materials x up to 3 passes)

# ---- reset -------------------------------------------------------------------
bpy.ops.object.select_all(action="SELECT"); bpy.ops.object.delete()
for c in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
    for d in list(c):
        try: c.remove(d)
        except Exception: pass

# ---- geometry helpers ---------------------------------------------------------
def box(name, center, size):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=center)
    o = bpy.context.active_object; o.name = name; o.scale = size
    bpy.ops.object.transform_apply(scale=True)
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

# ---- texture baking (bake a procedural node-graph to a real IMAGE, then pack it) --------------
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
    """Consumption material: samples the baked images, tiled (REPEAT) at true world scale."""
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

# ================================================================================
# ---- material node graphs -----------------------------------------------------
# ================================================================================

def build_brick(nds, lk, bsdf):
    """Warm Tudor red-brick footing/chimney: brick-cell pattern in ruddy terracotta with dark mortar."""
    tc = nds.new("ShaderNodeTexCoord")
    brick = nds.new("ShaderNodeTexBrick"); brick.inputs["Scale"].default_value = 5.0
    brick.inputs["Mortar Size"].default_value = 0.018; brick.inputs["Mortar Smooth"].default_value = 0.15
    brick.inputs["Brick Width"].default_value = 0.5; brick.inputs["Row Height"].default_value = 0.22
    brick.inputs["Color1"].default_value = (0.42, 0.16, 0.10, 1); brick.inputs["Color2"].default_value = (0.55, 0.24, 0.15, 1)
    brick.inputs["Mortar"].default_value = (0.20, 0.18, 0.16, 1)
    lk.new(tc.outputs["UV"], brick.inputs["Vector"])
    # subtle per-brick tone variance so it isn't two flat colors
    noise = nds.new("ShaderNodeTexNoise"); noise.inputs["Scale"].default_value = 40; noise.inputs["Detail"].default_value = 3
    lk.new(tc.outputs["UV"], noise.inputs["Vector"])
    tint = nds.new("ShaderNodeMixRGB"); tint.blend_type = "MULTIPLY"; tint.inputs["Fac"].default_value = 0.25
    tint.inputs["Color2"].default_value = (1.0, 0.9, 0.85, 1)
    lk.new(brick.outputs["Color"], tint.inputs["Color1"]); lk.new(noise.outputs["Fac"], tint.inputs["Fac"])
    lk.new(tint.outputs["Color"], bsdf.inputs["Base Color"])
    rgh = nds.new("ShaderNodeMixRGB"); rgh.inputs["Color1"].default_value = (0.75, 0.75, 0.75, 1); rgh.inputs["Color2"].default_value = (0.92, 0.92, 0.92, 1)
    lk.new(brick.outputs["Fac"], rgh.inputs["Fac"])
    lk.new(rgh.outputs["Color"], bsdf.inputs["Roughness"])
    bump = nds.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.55
    lk.new(brick.outputs["Fac"], bump.inputs["Height"])
    lk.new(bump.outputs["Normal"], bsdf.inputs["Normal"])

def build_plaster(nds, lk, bsdf):
    """Stark white lime-plaster daub — brighter & cooler than a rustic cottage's cream daub, to read as
    the crisp white infill of a black-and-white Tudor frame."""
    tc = nds.new("ShaderNodeTexCoord")
    noise1 = nds.new("ShaderNodeTexNoise"); noise1.inputs["Scale"].default_value = 14; noise1.inputs["Detail"].default_value = 4
    lk.new(tc.outputs["UV"], noise1.inputs["Vector"])
    ramp1 = nds.new("ShaderNodeValToRGB")
    ramp1.color_ramp.elements[0].position = 0.35; ramp1.color_ramp.elements[0].color = (0.90, 0.89, 0.85, 1)
    ramp1.color_ramp.elements[1].position = 0.65; ramp1.color_ramp.elements[1].color = (0.99, 0.99, 0.97, 1)
    lk.new(noise1.outputs["Fac"], ramp1.inputs["Fac"])
    # faint grey wash streaking to keep it a plaster, not paper-flat
    mp2 = nds.new("ShaderNodeMapping"); mp2.inputs["Scale"].default_value = (2.5, 0.2, 1.0)
    lk.new(tc.outputs["UV"], mp2.inputs["Vector"])
    noise2 = nds.new("ShaderNodeTexNoise"); noise2.inputs["Scale"].default_value = 5.0; noise2.inputs["Detail"].default_value = 6
    lk.new(mp2.outputs["Vector"], noise2.inputs["Vector"])
    ramp2 = nds.new("ShaderNodeValToRGB")
    ramp2.color_ramp.elements[0].position = 0.42; ramp2.color_ramp.elements[0].color = (0.80, 0.80, 0.78, 1)
    ramp2.color_ramp.elements[1].position = 0.72; ramp2.color_ramp.elements[1].color = (1, 1, 1, 1)
    lk.new(noise2.outputs["Fac"], ramp2.inputs["Fac"])
    dirt = nds.new("ShaderNodeMixRGB"); dirt.blend_type = "MULTIPLY"; dirt.inputs["Fac"].default_value = 0.12
    lk.new(ramp1.outputs["Color"], dirt.inputs["Color1"]); lk.new(ramp2.outputs["Color"], dirt.inputs["Color2"])
    lk.new(dirt.outputs["Color"], bsdf.inputs["Base Color"])
    rgh = nds.new("ShaderNodeValToRGB")
    rgh.color_ramp.elements[0].position = 0.4; rgh.color_ramp.elements[0].color = (0.45, 0.45, 0.45, 1)
    rgh.color_ramp.elements[1].position = 0.6; rgh.color_ramp.elements[1].color = (0.60, 0.60, 0.60, 1)
    lk.new(noise1.outputs["Fac"], rgh.inputs["Fac"])
    lk.new(rgh.outputs["Color"], bsdf.inputs["Roughness"])
    bump = nds.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.10
    lk.new(noise1.outputs["Fac"], bump.inputs["Height"])
    lk.new(bump.outputs["Normal"], bsdf.inputs["Normal"])

def build_timber(nds, lk, bsdf):
    """Near-black oak — pushed darker than a rustic cottage's oak for the stark Tudor black/white contrast."""
    tc = nds.new("ShaderNodeTexCoord")
    mp = nds.new("ShaderNodeMapping"); mp.inputs["Scale"].default_value = (1.0, 8.0, 1.0)
    lk.new(tc.outputs["UV"], mp.inputs["Vector"])
    wave = nds.new("ShaderNodeTexWave"); wave.wave_type = "BANDS"; wave.bands_direction = "Y"
    wave.inputs["Scale"].default_value = 6.0; wave.inputs["Distortion"].default_value = 2.5; wave.inputs["Detail"].default_value = 3.0
    lk.new(mp.outputs["Vector"], wave.inputs["Vector"])
    ramp = nds.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.3; ramp.color_ramp.elements[0].color = (0.015, 0.011, 0.008, 1)
    ramp.color_ramp.elements[1].position = 0.7; ramp.color_ramp.elements[1].color = (0.075, 0.052, 0.032, 1)
    lk.new(wave.outputs["Fac"], ramp.inputs["Fac"])
    noise = nds.new("ShaderNodeTexNoise"); noise.inputs["Scale"].default_value = 40; noise.inputs["Detail"].default_value = 4
    lk.new(tc.outputs["UV"], noise.inputs["Vector"])
    noiseramp = nds.new("ShaderNodeValToRGB")
    noiseramp.color_ramp.elements[0].position = 0.4; noiseramp.color_ramp.elements[0].color = (0.7, 0.7, 0.7, 1)
    noiseramp.color_ramp.elements[1].position = 0.6; noiseramp.color_ramp.elements[1].color = (1, 1, 1, 1)
    lk.new(noise.outputs["Fac"], noiseramp.inputs["Fac"])
    grain = nds.new("ShaderNodeMixRGB"); grain.blend_type = "MULTIPLY"; grain.inputs["Fac"].default_value = 0.3
    lk.new(ramp.outputs["Color"], grain.inputs["Color1"]); lk.new(noiseramp.outputs["Color"], grain.inputs["Color2"])
    lk.new(grain.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.55
    bump = nds.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.55
    lk.new(wave.outputs["Fac"], bump.inputs["Height"])
    lk.new(bump.outputs["Normal"], bsdf.inputs["Normal"])

def build_shingle(nds, lk, bsdf):
    """Dark weathered wood-shingle roof coursing — rows of overlapping shingles, cool charcoal-brown,
    distinct from a straw thatch."""
    tc = nds.new("ShaderNodeTexCoord")
    mp = nds.new("ShaderNodeMapping"); mp.inputs["Scale"].default_value = (1.0, 22.0, 1.0)
    lk.new(tc.outputs["UV"], mp.inputs["Vector"])
    rows = nds.new("ShaderNodeTexWave"); rows.wave_type = "BANDS"; rows.bands_direction = "Y"
    rows.inputs["Scale"].default_value = 1.0; rows.inputs["Distortion"].default_value = 1.2; rows.inputs["Detail"].default_value = 2.0
    lk.new(mp.outputs["Vector"], rows.inputs["Vector"])
    # per-shingle vertical seams
    mp2 = nds.new("ShaderNodeMapping"); mp2.inputs["Scale"].default_value = (16.0, 1.0, 1.0)
    lk.new(tc.outputs["UV"], mp2.inputs["Vector"])
    seams = nds.new("ShaderNodeTexWave"); seams.wave_type = "BANDS"; seams.bands_direction = "X"
    seams.inputs["Scale"].default_value = 1.0; seams.inputs["Distortion"].default_value = 2.2; seams.inputs["Detail"].default_value = 3.0
    lk.new(mp2.outputs["Vector"], seams.inputs["Vector"])
    ramp = nds.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.30; ramp.color_ramp.elements[0].color = (0.045, 0.038, 0.034, 1)
    ramp.color_ramp.elements[1].position = 0.70; ramp.color_ramp.elements[1].color = (0.14, 0.115, 0.095, 1)
    lk.new(rows.outputs["Fac"], ramp.inputs["Fac"])
    seamramp = nds.new("ShaderNodeValToRGB")
    seamramp.color_ramp.elements[0].position = 0.46; seamramp.color_ramp.elements[0].color = (0.65, 0.65, 0.65, 1)
    seamramp.color_ramp.elements[1].position = 0.54; seamramp.color_ramp.elements[1].color = (1, 1, 1, 1)
    lk.new(seams.outputs["Fac"], seamramp.inputs["Fac"])
    combo = nds.new("ShaderNodeMixRGB"); combo.blend_type = "MULTIPLY"; combo.inputs["Fac"].default_value = 0.55
    lk.new(ramp.outputs["Color"], combo.inputs["Color1"]); lk.new(seamramp.outputs["Color"], combo.inputs["Color2"])
    # weathering patches
    patch = nds.new("ShaderNodeTexNoise"); patch.inputs["Scale"].default_value = 3.5; patch.inputs["Detail"].default_value = 4
    lk.new(tc.outputs["UV"], patch.inputs["Vector"])
    patchramp = nds.new("ShaderNodeValToRGB")
    patchramp.color_ramp.elements[0].position = 0.4; patchramp.color_ramp.elements[0].color = (0.75, 0.75, 0.78, 1)
    patchramp.color_ramp.elements[1].position = 0.6; patchramp.color_ramp.elements[1].color = (1, 1, 1, 1)
    lk.new(patch.outputs["Fac"], patchramp.inputs["Fac"])
    patched = nds.new("ShaderNodeMixRGB"); patched.blend_type = "MULTIPLY"; patched.inputs["Fac"].default_value = 0.4
    lk.new(combo.outputs["Color"], patched.inputs["Color1"]); lk.new(patchramp.outputs["Color"], patched.inputs["Color2"])
    lk.new(patched.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.85
    bump1 = nds.new("ShaderNodeBump"); bump1.inputs["Strength"].default_value = 0.6
    lk.new(rows.outputs["Fac"], bump1.inputs["Height"])
    bump2 = nds.new("ShaderNodeBump"); bump2.inputs["Strength"].default_value = 0.35
    lk.new(seams.outputs["Fac"], bump2.inputs["Height"]); lk.new(bump1.outputs["Normal"], bump2.inputs["Normal"])
    lk.new(bump2.outputs["Normal"], bsdf.inputs["Normal"])

IMG_BRICK = bake_material("Brick", build_brick)
IMG_PLASTER = bake_material("Plaster", build_plaster)
IMG_TIMBER = bake_material("Timber", build_timber)
IMG_SHINGLE = bake_material("Shingle", build_shingle)

MAT_BRICK = tiled_material("BrickTiled", IMG_BRICK, tile_m=1.2)
MAT_PLASTER = tiled_material("PlasterTiled", IMG_PLASTER, tile_m=2.0)
MAT_TIMBER = tiled_material("TimberTiled", IMG_TIMBER, tile_m=0.8)
MAT_SHINGLE = tiled_material("ShingleTiled", IMG_SHINGLE, tile_m=1.4)
M_DARK = solid("Glass", (0.06, 0.07, 0.09), 0.2)
M_METAL = solid("Iron", (0.07, 0.068, 0.065), 0.4, 0.85)

# ================================================================================
# ---- dimensions (metres) ------------------------------------------------------
# ================================================================================
# Ground floor (brick footing) is set BACK from the upper floor by the jetty overhang; the upper
# (timber-framed) floor is the widest point of the building and defines the overall footprint.
W2, D2 = 7.0, 6.0                 # upper (jettied) floor footprint — the building's widest point
JETTY = 0.45                      # signature Tudor overhang: upper floor projects past the ground floor
W1, D1 = W2 - 2 * JETTY, D2 - 2 * JETTY   # ground floor footprint (set back)
T = 0.32                          # wall thickness
H1 = 2.5                          # ground floor (brick) wall height
H2 = 2.3                          # upper floor (timber+plaster) wall height
EAVE = 0.3                        # roof verge/eaves overhang past the upper floor walls
PITCH_DEG = 50.0                  # steep Tudor roof pitch (kept just at the 50°+ floor so the roof
                                   # doesn't swallow the whole elevation over a 6m span)
BAND_H = 0.18                     # bressummer beam (jetty support beam) thickness

half_span = D2 / 2.0 + EAVE
RISE = half_span * math.tan(math.radians(PITCH_DEG))

# ---- half-timber helpers (parameterised by footprint so both floors can reuse them) ----
TIMBER_T, TIMBER_W = 0.14, 0.20   # TIMBER_T = proud depth off the wall plane, TIMBER_W = in-plane member width
TIMBER_PARTS = []

def face_pos(face, u, depth_off, w, d):
    """(x, y) on a wall face, `u` = coordinate along the wall, `depth_off` = outward offset from the true
    wall surface (positive always points AWAY from the building, regardless of which face)."""
    if face == "front": return (u, d / 2 + depth_off)
    if face == "back":  return (u, -d / 2 - depth_off)
    if face == "left":  return (-w / 2 - depth_off, u)
    if face == "right": return (w / 2 + depth_off, u)

def face_box(face, u, z, along, extent, height, mat, w, d, front_offset=0.0, name="dress"):
    x, y = face_pos(face, u, front_offset + extent / 2.0, w, d)
    size = (along, extent, height) if face in ("front", "back") else (extent, along, height)
    o = box(name, (x, y, z), size)
    apply_tiled(o, mat)
    return o

def timber_box(name, center, size):
    o = box(name, center, size); apply_tiled(o, MAT_TIMBER); TIMBER_PARTS.append(o); return o

def vertical_stud(face, u, z0, z1, w, d):
    x, y = face_pos(face, u, TIMBER_T / 2, w, d)
    cz = (z0 + z1) / 2; h = z1 - z0
    if face in ("front", "back"): timber_box("stud", (x, y, cz), (TIMBER_W, TIMBER_T, h))
    else: timber_box("stud", (x, y, cz), (TIMBER_T, TIMBER_W, h))

def rail(face, z, u0, u1, w, d):
    x, y = face_pos(face, (u0 + u1) / 2, TIMBER_T / 2, w, d)
    length = abs(u1 - u0)
    if face in ("front", "back"): timber_box("rail", (x, y, z), (length, TIMBER_T, TIMBER_W))
    else: timber_box("rail", (x, y, z), (TIMBER_T, length, TIMBER_W))

def brace(face, u0, z0, u1, z1, w, d):
    xm, ym = face_pos(face, (u0 + u1) / 2, TIMBER_T / 2 + 0.005, w, d)
    length = math.hypot(u1 - u0, z1 - z0)
    ang = math.atan2(z1 - z0, u1 - u0)
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(xm, ym, (z0 + z1) / 2))
    o = bpy.context.active_object; o.name = "brace"
    if face in ("front", "back"):
        o.scale = (length, TIMBER_T, TIMBER_W); o.rotation_euler = (0, -ang, 0)
    else:
        o.scale = (TIMBER_T, length, TIMBER_W); o.rotation_euler = (-ang, 0, 0)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    apply_tiled(o, MAT_TIMBER); TIMBER_PARTS.append(o)

def zigzag_panel(face, u0, z0, u1, z1, w, d, n=3):
    """Dense diagonal / herringbone bracing: a continuous zigzag of diagonal timbers filling a panel —
    much denser than a single corner brace, and the distinctive Tudor chevron look."""
    step = (u1 - u0) / n
    for i in range(n):
        a, b = u0 + step * i, u0 + step * (i + 1)
        mid = (a + b) / 2
        if i % 2 == 0:
            brace(face, a, z0, mid, z1, w, d); brace(face, mid, z1, b, z0, w, d)
        else:
            brace(face, a, z1, mid, z0, w, d); brace(face, mid, z0, b, z1, w, d)

def leaded_window(face, u, cz, win_w, win_h, w, d, n_mullions=3):
    """A small, deep-set leaded/mullioned window: timber surround + N vertical uprights + one
    horizontal transom — reads as leaded glazing, denser than a single cross."""
    bw, fe, mw = 0.09, 0.075, 0.045
    TIMBER_PARTS.append(face_box(face, u, cz + win_h / 2 + bw / 2, win_w + 2 * bw, fe, bw, MAT_TIMBER, w, d, name="winTop"))
    TIMBER_PARTS.append(face_box(face, u, cz - win_h / 2 - bw / 2, win_w + 2 * bw, fe, bw, MAT_TIMBER, w, d, name="winBot"))
    TIMBER_PARTS.append(face_box(face, u - win_w / 2 - bw / 2, cz, bw, fe, win_h, MAT_TIMBER, w, d, name="winL"))
    TIMBER_PARTS.append(face_box(face, u + win_w / 2 + bw / 2, cz, bw, fe, win_h, MAT_TIMBER, w, d, name="winR"))
    for k in range(n_mullions):
        mu = u - win_w / 2 + win_w * (k + 1) / (n_mullions + 1)
        TIMBER_PARTS.append(face_box(face, mu, cz, mw, fe * 0.7, win_h, MAT_TIMBER, w, d, name="mullV"))
    TIMBER_PARTS.append(face_box(face, u, cz, win_w, fe * 0.7, mw, MAT_TIMBER, w, d, name="mullH"))

def opening(cx, cz, w_, h_, face, footW, footD, glass=True):
    if face == "front":
        boolean(WALL_OBJ[0], box("cut", (cx, footD / 2, cz), (w_, T * 3, h_)))
        if glass:
            p = box("panel", (cx, footD / 2 - T * 0.35, cz), (w_ * 0.8, 0.04, h_ * 0.8)); p.data.materials.append(M_DARK)
    elif face == "back":
        boolean(WALL_OBJ[0], box("cut", (cx, -footD / 2, cz), (w_, T * 3, h_)))
        if glass:
            p = box("panel", (cx, -footD / 2 + T * 0.35, cz), (w_ * 0.8, 0.04, h_ * 0.8)); p.data.materials.append(M_DARK)
    elif face == "side":
        sgn = 1 if cx > 0 else -1
        boolean(WALL_OBJ[0], box("cut", (sgn * footW / 2, 0, cz), (T * 3, w_, h_)))
        if glass:
            p = box("panel", (sgn * (footW / 2 - T * 0.35), 0, cz), (0.04, w_ * 0.8, h_ * 0.8)); p.data.materials.append(M_DARK)

# ================================================================================
# ---- ground floor: brick footing walls + door + 2 small windows --------------
# ================================================================================
gf = box("GroundFloor", (0, 0, H1 / 2), (W1, D1, H1))
gf_inner = box("GFInner", (0, 0, H1 / 2 + 0.2), (W1 - 2 * T, D1 - 2 * T, H1))
boolean(gf, gf_inner)
WALL_OBJ = [gf]

DOOR_W, DOOR_H, DOOR_CZ = 0.95, 1.85, 1.0
boolean(gf, box("doorcut", (0, D1 / 2, DOOR_CZ), (1.05, T * 3, 1.95)))
door = box("Door", (0, D1 / 2 - T * 0.35, DOOR_CZ), (DOOR_W, 0.06, DOOR_H))

GWIN_W, GWIN_H, GWIN_CZ = 0.7, 0.75, 1.35
opening(-1.9, GWIN_CZ, GWIN_W, GWIN_H, "front", W1, D1)
opening(1.9, GWIN_CZ, GWIN_W, GWIN_H, "front", W1, D1)
opening(-1, GWIN_CZ, GWIN_W, GWIN_H, "side", W1, D1)   # left-face ground floor window (centered, u=0)

bevel(gf, 0.02, 2)
apply_tiled(gf, MAT_BRICK)
apply_tiled(door, MAT_TIMBER)

# door dressing: timber lintel + jambs + plank battens (brick ground floor, timber trim)
DOOR_FACE_Y = (D1 / 2 - T * 0.35) - 0.03
dbw, dfe = 0.11, 0.09
TIMBER_PARTS.append(face_box("front", 0, DOOR_CZ + DOOR_H / 2 + dbw / 2, 1.05 + 2 * dbw, dfe, dbw, MAT_TIMBER, W1, D1, name="doorLintel"))
TIMBER_PARTS.append(face_box("front", -0.525 - dbw / 2, DOOR_CZ, dbw, dfe, DOOR_H, MAT_TIMBER, W1, D1, name="doorJambL"))
TIMBER_PARTS.append(face_box("front", 0.525 + dbw / 2, DOOR_CZ, dbw, dfe, DOOR_H, MAT_TIMBER, W1, D1, name="doorJambR"))
N_PLANKS = 5
plank_w = 0.88 / N_PLANKS
for i in range(N_PLANKS):
    pu = -0.44 + plank_w * (i + 0.5)
    o = box(f"doorPlank{i}", (pu, DOOR_FACE_Y - 0.026, DOOR_CZ), (plank_w * 0.78, 0.04, DOOR_H - 0.05))
    apply_tiled(o, MAT_TIMBER); TIMBER_PARTS.append(o)
for hz in (DOOR_CZ + 0.55, DOOR_CZ - 0.55):
    hstrap = box("hinge", (-0.08, DOOR_FACE_Y - 0.06, hz), (0.55, 0.022, 0.10)); hstrap.data.materials.append(M_METAL)
handle = box("handle", (0.32, DOOR_FACE_Y - 0.065, DOOR_CZ - 0.05), (0.1, 0.03, 0.1)); handle.data.materials.append(M_METAL)

threshold = box("threshold", (0, D1 / 2 + 0.15, 0.06), (1.25, 0.3, 0.12))
apply_tiled(threshold, MAT_BRICK); bevel(threshold, 0.02, 1)

# ground-floor window dressings (leaded, 2 uprights — smaller openings)
leaded_window("front", -1.9, GWIN_CZ, GWIN_W, GWIN_H, W1, D1, n_mullions=2)
leaded_window("front", 1.9, GWIN_CZ, GWIN_W, GWIN_H, W1, D1, n_mullions=2)
leaded_window("left", 0, GWIN_CZ, GWIN_W, GWIN_H, W1, D1, n_mullions=2)
face_box("front", -1.9, GWIN_CZ - GWIN_H / 2 - 0.12, GWIN_W + 0.3, 0.14, 0.08, MAT_BRICK, W1, D1, name="sillL")
face_box("front", 1.9, GWIN_CZ - GWIN_H / 2 - 0.12, GWIN_W + 0.3, 0.14, 0.08, MAT_BRICK, W1, D1, name="sillR")

# ================================================================================
# ---- bressummer beam + joist ends: the jetty transition ---------------------
# ================================================================================
BAND_Z = H1 + BAND_H / 2
band = box("Bressummer", (0, 0, BAND_Z), (W2, D2, BAND_H))
band_inner = box("BressummerInner", (0, 0, BAND_Z + 0.02), (W1 - 0.1, D1 - 0.1, BAND_H + 0.05))
boolean(band, band_inner)
apply_tiled(band, MAT_TIMBER)

def joist_ends(face, w1_, d1_, n):
    for i in range(n):
        u = -{"front": w1_, "back": w1_, "left": d1_, "right": d1_}[face] / 2 * 0.8 + (i / max(n - 1, 1)) * ({"front": w1_, "back": w1_, "left": d1_, "right": d1_}[face] * 0.8)
        x, y = face_pos(face, u, JETTY / 2, w1_, d1_)
        size = (0.12, JETTY, 0.09) if face in ("front", "back") else (JETTY, 0.12, 0.09)
        o = box(f"joist_{face}{i}", (x, y, H1 + 0.02), size)
        apply_tiled(o, MAT_TIMBER); TIMBER_PARTS.append(o)

joist_ends("front", W1, D1, 6)
joist_ends("back", W1, D1, 6)

# jetty corner brackets (curved knee braces approximated as angled timber blocks) supporting the overhang.
# NOTE: built via raw primitive_cube_add (not the box() helper) — box()'s internal transform_apply
# already bakes LOCATION into the mesh (Blender's transform_apply defaults location/rotation to True
# when unspecified), leaving object.location at world (0,0,0); rotating such an object afterwards would
# spin it about the WORLD origin instead of its own center. Setting scale+rotation together and applying
# both in one call (like brace()/bargeboard() do) keeps the rotation centered on the bracket itself.
for (fx, fy) in [(-1, 1), (1, 1), (-1, -1), (1, -1)]:
    bx = fx * (W1 / 2 - 0.1); by = fy * (D1 / 2 - 0.1)
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(bx, by, H1 - 0.05))
    o = bpy.context.active_object; o.name = f"bracket_{fx}_{fy}"
    o.scale = (0.25, 0.25, 0.22); o.rotation_euler = (0, 0, math.radians(45))
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    apply_tiled(o, MAT_TIMBER); TIMBER_PARTS.append(o)

# ================================================================================
# ---- upper floor: jettied, timber-framed, white plaster infill --------------
# ================================================================================
UF_Z0 = H1 + BAND_H
uf = box("UpperFloor", (0, 0, UF_Z0 + H2 / 2), (W2, D2, H2))
uf_inner = box("UFInner", (0, 0, UF_Z0 + H2 / 2 + 0.2), (W2 - 2 * T, D2 - 2 * T, H2))
boolean(uf, uf_inner)
WALL_OBJ = [uf]

UWIN_W, UWIN_H, UWIN_CZ = 0.95, 0.95, UF_Z0 + H2 * 0.52
opening(-1.75, UWIN_CZ, UWIN_W, UWIN_H, "front", W2, D2)
opening(1.75, UWIN_CZ, UWIN_W, UWIN_H, "front", W2, D2)
opening(0, UWIN_CZ, 0.8, 0.85, "back", W2, D2)
opening(W2 / 2, UWIN_CZ, 0.8, 0.85, "side", W2, D2)
opening(-W2 / 2, UWIN_CZ, 0.8, 0.85, "side", W2, D2)

bevel(uf, 0.015, 1)
apply_tiled(uf, MAT_PLASTER)

# leaded windows on the upper floor — the prominent jetty windows get 3 uprights
leaded_window("front", -1.75, UWIN_CZ, UWIN_W, UWIN_H, W2, D2, n_mullions=3)
leaded_window("front", 1.75, UWIN_CZ, UWIN_W, UWIN_H, W2, D2, n_mullions=3)
leaded_window("back", 0, UWIN_CZ, 0.8, 0.85, W2, D2, n_mullions=2)
leaded_window("right", 0, UWIN_CZ, 0.8, 0.85, W2, D2, n_mullions=2)
leaded_window("left", 0, UWIN_CZ, 0.8, 0.85, W2, D2, n_mullions=2)

# ---- half-timber frame: dense studs + rails + diagonal/herringbone bracing --
Z0, Z1 = UF_Z0 + 0.1, UF_Z0 + H2 - 0.1

# front face: corners, window flanks, herringbone zigzag panels between studs (either side of + between windows)
front_studs_u = [-W2 / 2 + 0.15, -2.55, -0.95, 0.95, 2.55, W2 / 2 - 0.15]
for u in front_studs_u:
    vertical_stud("front", u, Z0, Z1, W2, D2)
rail("front", Z1, -W2 / 2 + 0.1, W2 / 2 - 0.1, W2, D2)
rail("front", Z0, -W2 / 2 + 0.1, W2 / 2 - 0.1, W2, D2)
zigzag_panel("front", -W2 / 2 + 0.15, Z0, -2.55, Z1, W2, D2, n=2)
zigzag_panel("front", 2.55, Z0, W2 / 2 - 0.15, Z1, W2, D2, n=2)
# chevron panels above/below the window band, between the two front windows (flanking the door axis)
zigzag_panel("front", -0.6, UWIN_CZ + UWIN_H / 2 + 0.2, 0.6, Z1, W2, D2, n=1)
zigzag_panel("front", -0.6, Z0, 0.6, UWIN_CZ - UWIN_H / 2 - 0.2, W2, D2, n=1)

# back face: corners + mid studs + herringbone panels
back_studs_u = [-W2 / 2 + 0.15, -1.3, 1.3, W2 / 2 - 0.15]
for u in back_studs_u:
    vertical_stud("back", u, Z0, Z1, W2, D2)
rail("back", Z1, -W2 / 2 + 0.1, W2 / 2 - 0.1, W2, D2)
rail("back", Z0, -W2 / 2 + 0.1, W2 / 2 - 0.1, W2, D2)
zigzag_panel("back", -W2 / 2 + 0.15, Z0, -1.3, Z1, W2, D2, n=2)
zigzag_panel("back", 1.3, Z0, W2 / 2 - 0.15, Z1, W2, D2, n=2)

# side faces: corners + mid stud + herringbone panels
for u in (-D2 / 2 + 0.15, D2 / 2 - 0.15):
    vertical_stud("left", u, Z0, Z1, W2, D2); vertical_stud("right", u, Z0, Z1, W2, D2)
vertical_stud("left", 0, Z0, Z1, W2, D2); vertical_stud("right", 0, Z0, Z1, W2, D2)
rail("left", Z1, -D2 / 2 + 0.1, D2 / 2 - 0.1, W2, D2); rail("left", Z0, -D2 / 2 + 0.1, D2 / 2 - 0.1, W2, D2)
rail("right", Z1, -D2 / 2 + 0.1, D2 / 2 - 0.1, W2, D2); rail("right", Z0, -D2 / 2 + 0.1, D2 / 2 - 0.1, W2, D2)
zigzag_panel("left", -D2 / 2 + 0.15, Z0, -0.1, Z1, W2, D2, n=2)
zigzag_panel("left", 0.1, Z0, D2 / 2 - 0.15, Z1, W2, D2, n=2)
zigzag_panel("right", -D2 / 2 + 0.15, Z0, -0.1, Z1, W2, D2, n=2)
zigzag_panel("right", 0.1, Z0, D2 / 2 - 0.15, Z1, W2, D2, n=2)

# ================================================================================
# ---- roof: solid triangular prism (ridge along X) → fills gables, steep pitch -
# ================================================================================
RIDGE_Z0 = UF_Z0 + H2 - 0.05  # roof base = top of upper-floor walls
me = bpy.data.meshes.new("Roof"); roof = bpy.data.objects.new("Roof", me)
bpy.context.collection.objects.link(roof)
xL, xR = -(W2 / 2 + EAVE), (W2 / 2 + EAVE)
yF, yB = (D2 / 2 + EAVE), -(D2 / 2 + EAVE)
zb, zt = RIDGE_Z0, RIDGE_Z0 + RISE
bm = bmesh.new()
vs = [bm.verts.new(p) for p in [
    (xL, yF, zb), (xL, yB, zb), (xL, 0, zt),
    (xR, yF, zb), (xR, yB, zb), (xR, 0, zt)]]
bm.faces.new((vs[0], vs[1], vs[2]))            # left gable triangle
bm.faces.new((vs[3], vs[5], vs[4]))            # right gable triangle
bm.faces.new((vs[0], vs[2], vs[5], vs[3]))     # front slope
bm.faces.new((vs[1], vs[4], vs[5], vs[2]))     # back slope
bm.faces.new((vs[0], vs[3], vs[4], vs[1]))     # bottom (sits on walls)
bm.to_mesh(me); bm.free()
me.uv_layers.new(name="UVMap")

bpy.context.view_layer.objects.active = roof
bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.cube_project(cube_size=1.0, correct_aspect=True, scale_to_bounds=False)
bpy.ops.object.mode_set(mode="OBJECT")
me.materials.append(MAT_SHINGLE); me.materials.append(MAT_PLASTER)   # 0=shingle (slopes), 1=plaster (gables)
for i, f in enumerate(me.polygons):
    f.material_index = 1 if i in (0, 1) else 0
bevel(roof, 0.04, 1)

# ---- rafter tails (under the deep eaves) + gable bargeboards ----------------
def rafter_tails(y_wall, y_out, z, n):
    step = W2 / n
    for i in range(n):
        xu = -W2 / 2 + step * (i + 0.5)
        ym = (y_wall + y_out) / 2; length = abs(y_out - y_wall)
        o = box(f"rafterTail{i}", (xu, ym, z), (0.09, length, 0.09))
        apply_tiled(o, MAT_TIMBER); TIMBER_PARTS.append(o)

rafter_tails(D2 / 2 - 0.05, D2 / 2 + EAVE + 0.05, RIDGE_Z0 + 0.05, 9)
rafter_tails(-D2 / 2 + 0.05, -D2 / 2 - EAVE - 0.05, RIDGE_Z0 + 0.05, 9)

def bargeboard(xface, y0, z0, y1, z1, sign, name):
    length = math.hypot(y1 - y0, z1 - z0)
    ang = math.atan2(z1 - z0, y1 - y0)
    ym, zm = (y0 + y1) / 2, (z0 + z1) / 2
    xm = xface + sign * 0.05
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(xm, ym, zm))
    o = bpy.context.active_object; o.name = name
    o.scale = (0.06, length, 0.26); o.rotation_euler = (ang, 0, 0)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    apply_tiled(o, MAT_TIMBER)
    return o

TIMBER_PARTS.append(bargeboard(xL, yF, zb, 0, zt, -1, "bargeL1"))
TIMBER_PARTS.append(bargeboard(xL, yB, zb, 0, zt, -1, "bargeL2"))
TIMBER_PARTS.append(bargeboard(xR, yF, zb, 0, zt, 1, "bargeR1"))
TIMBER_PARTS.append(bargeboard(xR, yB, zb, 0, zt, 1, "bargeR2"))

# ================================================================================
# ---- chimney: tall brick stack, rising well above the ridge (Tudor signature) -
# ================================================================================
CHIM_BASE_Z = zb + RISE * 0.4
CHIM_H = zt - CHIM_BASE_Z + 1.6   # guarantee it clears the ridge apex by ~1.6m
chim_x = W2 / 2 - 0.65
chim = box("Chimney", (chim_x, D2 / 2 - 0.9, CHIM_BASE_Z + CHIM_H / 2), (0.65, 0.65, CHIM_H))
apply_tiled(chim, MAT_BRICK)
bevel(chim, 0.02, 1)
# chimney cap/coping: a slightly wider brick collar near the top for a crafted, prominent silhouette
cap = box("ChimneyCap", (chim_x, D2 / 2 - 0.9, CHIM_BASE_Z + CHIM_H - 0.15), (0.82, 0.82, 0.24))
apply_tiled(cap, MAT_BRICK); bevel(cap, 0.02, 1)
pot = box("ChimneyPot", (chim_x, D2 / 2 - 0.9, CHIM_BASE_Z + CHIM_H + 0.15), (0.22, 0.22, 0.3))
apply_tiled(pot, MAT_BRICK)

# ---- join every timber member into one object, then bevel for a clean edge-highlight ----
bpy.ops.object.select_all(action="DESELECT")
for o in TIMBER_PARTS: o.select_set(True)
bpy.context.view_layer.objects.active = TIMBER_PARTS[0]
bpy.ops.object.join()
TIMBER_PARTS[0].name = "TimberFrame"
bevel(TIMBER_PARTS[0], 0.012, 2)

# ---- export GLB (Y-up, embedded materials + textures) -------------------------
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_yup=True, export_apply=True)
print(f"tudor-cottage: wrote {OUT}  (ridge~{zt:.2f}m, chimney-top~{CHIM_BASE_Z+CHIM_H:.2f}m, footprint {W2}x{D2})")
