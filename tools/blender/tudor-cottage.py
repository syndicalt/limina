# tudor-cottage.py (v2) — a TUDOR-STYLE dwelling authored in headless Blender, with REAL baked textures
# (warm red brick footing, aged limewash plaster, near-black oak half-timbering, dark wood-shingle
# roof). v2 re-author after the v1 "passable" verdict; the recorded critiques drove three changes:
#   1. DENSE repeated herringbone chevrons across the front elevation on BOTH storeys (continuous
#      chevron friezes above/below the window row, stacked-V bays, and a timber-over-plinth ground
#      tier on the new cross-wing) — replacing v1's single kite/diamond motif.
#   2. Massing breaks: a jettied, gabled CROSS-WING on the front-left, a gabled DORMER on the front
#      roof slope, visible joist ends + diagonal knee braces under a chunkier bressummer (a real
#      jetty shadow line), dressed gable ends, and a tall chimney straddling the ridge.
#   3. AGED limewash plaster: low-frequency ochre/grey mottle + streaking + wider roughness range +
#      stronger bump, instead of v1's paper-flat near-white.
#
#   blender --background --factory-startup --python tools/blender/tudor-cottage.py -- --out assets/tudor-cottage.glb
#
# Texture strategy (unchanged from v1 / cottage.py): bake a small procedural node-graph to an IMAGE
# (Cycles bake passes: DIFFUSE/ROUGHNESS/NORMAL) on a throwaway plane, pack the image, then build a
# CONSUMPTION material that samples that image via cube-projected UVs tiled at true world scale.

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
    """AGED limewash plaster (v2): warm off-white with LOW-FREQUENCY ochre/grey mottle patches,
    vertical weather-streaking, a wide roughness range and a real bump — v1's stark flat white was
    the recorded critique ('plaster too flat')."""
    tc = nds.new("ShaderNodeTexCoord")
    # fine plaster grain
    noise1 = nds.new("ShaderNodeTexNoise"); noise1.inputs["Scale"].default_value = 16; noise1.inputs["Detail"].default_value = 5
    lk.new(tc.outputs["UV"], noise1.inputs["Vector"])
    ramp1 = nds.new("ShaderNodeValToRGB")
    ramp1.color_ramp.elements[0].position = 0.30; ramp1.color_ramp.elements[0].color = (0.80, 0.77, 0.68, 1)
    ramp1.color_ramp.elements[1].position = 0.70; ramp1.color_ramp.elements[1].color = (0.96, 0.95, 0.89, 1)
    lk.new(noise1.outputs["Fac"], ramp1.inputs["Fac"])
    # low-frequency aged mottle — big soft patches of ochre-grey (damp, old limewash coats)
    noise3 = nds.new("ShaderNodeTexNoise"); noise3.inputs["Scale"].default_value = 2.6; noise3.inputs["Detail"].default_value = 3
    lk.new(tc.outputs["UV"], noise3.inputs["Vector"])
    ramp3 = nds.new("ShaderNodeValToRGB")
    ramp3.color_ramp.elements[0].position = 0.32; ramp3.color_ramp.elements[0].color = (0.65, 0.61, 0.50, 1)
    ramp3.color_ramp.elements[1].position = 0.68; ramp3.color_ramp.elements[1].color = (1, 1, 1, 1)
    lk.new(noise3.outputs["Fac"], ramp3.inputs["Fac"])
    mottle = nds.new("ShaderNodeMixRGB"); mottle.blend_type = "MULTIPLY"; mottle.inputs["Fac"].default_value = 0.7
    lk.new(ramp1.outputs["Color"], mottle.inputs["Color1"]); lk.new(ramp3.outputs["Color"], mottle.inputs["Color2"])
    # vertical weather streaks
    mp2 = nds.new("ShaderNodeMapping"); mp2.inputs["Scale"].default_value = (2.5, 0.22, 1.0)
    lk.new(tc.outputs["UV"], mp2.inputs["Vector"])
    noise2 = nds.new("ShaderNodeTexNoise"); noise2.inputs["Scale"].default_value = 5.0; noise2.inputs["Detail"].default_value = 6
    lk.new(mp2.outputs["Vector"], noise2.inputs["Vector"])
    ramp2 = nds.new("ShaderNodeValToRGB")
    ramp2.color_ramp.elements[0].position = 0.40; ramp2.color_ramp.elements[0].color = (0.78, 0.77, 0.72, 1)
    ramp2.color_ramp.elements[1].position = 0.72; ramp2.color_ramp.elements[1].color = (1, 1, 1, 1)
    lk.new(noise2.outputs["Fac"], ramp2.inputs["Fac"])
    dirt = nds.new("ShaderNodeMixRGB"); dirt.blend_type = "MULTIPLY"; dirt.inputs["Fac"].default_value = 0.25
    lk.new(mottle.outputs["Color"], dirt.inputs["Color1"]); lk.new(ramp2.outputs["Color"], dirt.inputs["Color2"])
    lk.new(dirt.outputs["Color"], bsdf.inputs["Base Color"])
    # roughness varies with the mottle (damp patches read flatter/darker in the light)
    rgh = nds.new("ShaderNodeValToRGB")
    rgh.color_ramp.elements[0].position = 0.30; rgh.color_ramp.elements[0].color = (0.55, 0.55, 0.55, 1)
    rgh.color_ramp.elements[1].position = 0.70; rgh.color_ramp.elements[1].color = (0.88, 0.88, 0.88, 1)
    lk.new(noise3.outputs["Fac"], rgh.inputs["Fac"])
    lk.new(rgh.outputs["Color"], bsdf.inputs["Roughness"])
    # bump: fine grain + low-freq undulation (hand-floated daub, not machine-flat board)
    hmix = nds.new("ShaderNodeMixRGB"); hmix.blend_type = "ADD"; hmix.inputs["Fac"].default_value = 0.5
    lk.new(noise1.outputs["Fac"], hmix.inputs["Color1"]); lk.new(noise3.outputs["Fac"], hmix.inputs["Color2"])
    bump = nds.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.28
    lk.new(hmix.outputs["Color"], bump.inputs["Height"])
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
    """Dark weathered wood-shingle roof coursing — rows of overlapping shingles, cool charcoal-brown."""
    tc = nds.new("ShaderNodeTexCoord")
    mp = nds.new("ShaderNodeMapping"); mp.inputs["Scale"].default_value = (1.0, 22.0, 1.0)
    lk.new(tc.outputs["UV"], mp.inputs["Vector"])
    rows = nds.new("ShaderNodeTexWave"); rows.wave_type = "BANDS"; rows.bands_direction = "Y"
    rows.inputs["Scale"].default_value = 1.0; rows.inputs["Distortion"].default_value = 1.2; rows.inputs["Detail"].default_value = 2.0
    lk.new(mp.outputs["Vector"], rows.inputs["Vector"])
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
    patch = nds.new("ShaderNodeTexNoise"); patch.inputs["Scale"].default_value = 3.5; patch.inputs["Detail"].default_value = 4
    lk.new(tc.outputs["UV"], patch.inputs["Vector"])
    patchramp = nds.new("ShaderNodeValToRGB")
    patchramp.color_ramp.elements[0].position = 0.4; patchramp.color_ramp.elements[0].color = (0.75, 0.75, 0.78, 1)
    patchramp.color_ramp.elements[1].position = 0.6; patchramp.color_ramp.elements[1].color = (1, 1, 1, 1)
    lk.new(patch.outputs["Fac"], patchramp.inputs["Fac"])
    patched = nds.new("ShaderNodeMixRGB"); patched.blend_type = "MULTIPLY"; patched.inputs["Fac"].default_value = 0.5
    lk.new(combo.outputs["Color"], patched.inputs["Color1"]); lk.new(patchramp.outputs["Color"], patched.inputs["Color2"])
    lk.new(patched.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.85
    bump1 = nds.new("ShaderNodeBump"); bump1.inputs["Strength"].default_value = 0.9
    lk.new(rows.outputs["Fac"], bump1.inputs["Height"])
    bump2 = nds.new("ShaderNodeBump"); bump2.inputs["Strength"].default_value = 0.5
    lk.new(seams.outputs["Fac"], bump2.inputs["Height"]); lk.new(bump1.outputs["Normal"], bump2.inputs["Normal"])
    lk.new(bump2.outputs["Normal"], bsdf.inputs["Normal"])

IMG_BRICK = bake_material("Brick", build_brick)
IMG_PLASTER = bake_material("Plaster", build_plaster)
IMG_TIMBER = bake_material("Timber", build_timber)
IMG_SHINGLE = bake_material("Shingle", build_shingle)

MAT_BRICK = tiled_material("BrickTiled", IMG_BRICK, tile_m=1.2)
MAT_PLASTER = tiled_material("PlasterTiled", IMG_PLASTER, tile_m=2.4)
MAT_TIMBER = tiled_material("TimberTiled", IMG_TIMBER, tile_m=0.8)
MAT_SHINGLE = tiled_material("ShingleTiled", IMG_SHINGLE, tile_m=1.4)
M_DARK = solid("Glass", (0.06, 0.07, 0.09), 0.2)
M_METAL = solid("Iron", (0.07, 0.068, 0.065), 0.4, 0.85)

# ================================================================================
# ---- dimensions (metres) ------------------------------------------------------
# ================================================================================
W2, D2 = 7.0, 6.0                 # upper (jettied) main floor footprint
JETTY = 0.45                      # signature Tudor overhang
W1, D1 = W2 - 2 * JETTY, D2 - 2 * JETTY   # ground floor footprint (set back)
T = 0.32                          # wall thickness
H1 = 2.5                          # ground floor (brick) wall height
H2 = 2.3                          # upper floor (timber+plaster) wall height
EAVE = 0.35                       # roof verge/eaves overhang past the upper floor walls
PITCH_DEG = 53.0                  # steep Tudor roof pitch
BAND_H = 0.22                     # bressummer beam (jetty support beam) thickness

half_span = D2 / 2.0 + EAVE
RISE = half_span * math.tan(math.radians(PITCH_DEG))
UF_Z0 = H1 + BAND_H               # upper-floor wall base
UF_TOP = UF_Z0 + H2               # upper-floor wall top
RIDGE_Z0 = UF_TOP - 0.05          # main roof base
ZT = RIDGE_Z0 + RISE              # main ridge apex

# cross-wing (front-left): breaks the boxy massing; its ground tier is timber-framed over a low
# brick plinth so the herringbone reads on BOTH storeys of the front elevation.
WING_W = 2.7
WX = -1.7
WING_X0, WING_X1 = WX - WING_W / 2, WX + WING_W / 2
WG_Y = D1 / 2 + 0.6               # wing ground-storey front face
WU_Y = WG_Y + JETTY               # wing upper-storey (jettied) front face
PLINTH_H = 0.98
WING_RISE = (WING_W / 2 + 0.3) * math.tan(math.radians(54))
WING_ZT = RIDGE_Z0 + WING_RISE    # wing ridge

# ---- half-timber helpers -------------------------------------------------------
TIMBER_T, TIMBER_W = 0.13, 0.18   # proud depth off the wall plane / in-plane member width
TIMBER_PARTS = []

def face_pos(face, u, depth_off, w, d):
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

def vertical_stud(face, u, z0, z1, w, d, ww=None):
    ww = ww or TIMBER_W
    x, y = face_pos(face, u, TIMBER_T / 2, w, d)
    cz = (z0 + z1) / 2; h = z1 - z0
    if face in ("front", "back"): timber_box("stud", (x, y, cz), (ww, TIMBER_T, h))
    else: timber_box("stud", (x, y, cz), (TIMBER_T, ww, h))

def rail(face, z, u0, u1, w, d, rw=None):
    rw = rw or TIMBER_W
    x, y = face_pos(face, (u0 + u1) / 2, TIMBER_T / 2, w, d)
    length = abs(u1 - u0)
    if face in ("front", "back"): timber_box("rail", (x, y, z), (length, TIMBER_T, rw))
    else: timber_box("rail", (x, y, z), (TIMBER_T, length, rw))

def brace(face, u0, z0, u1, z1, w, d, mw=None):
    mw = mw or TIMBER_W
    xm, ym = face_pos(face, (u0 + u1) / 2, TIMBER_T / 2 + 0.005, w, d)
    length = math.hypot(u1 - u0, z1 - z0)
    ang = math.atan2(z1 - z0, u1 - u0)
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(xm, ym, (z0 + z1) / 2))
    o = bpy.context.active_object; o.name = "brace"
    if face in ("front", "back"):
        o.scale = (length, TIMBER_T, mw); o.rotation_euler = (0, -ang, 0)
    else:
        o.scale = (TIMBER_T, length, mw); o.rotation_euler = (-ang, 0, 0)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    apply_tiled(o, MAT_TIMBER); TIMBER_PARTS.append(o)

def zigzag_panel(face, u0, z0, u1, z1, w, d, n=3, mw=None):
    """A continuous zigzag of diagonal timbers filling a panel — the Tudor chevron look."""
    step = (u1 - u0) / n
    for i in range(n):
        a, b = u0 + step * i, u0 + step * (i + 1)
        mid = (a + b) / 2
        if i % 2 == 0:
            brace(face, a, z0, mid, z1, w, d, mw); brace(face, mid, z1, b, z0, w, d, mw)
        else:
            brace(face, a, z1, mid, z0, w, d, mw); brace(face, mid, z0, b, z1, w, d, mw)

def herringbone(face, u0, z0, u1, z1, w, d):
    """DENSE repeated herringbone: split a bay into rows (rail between rows) and fill each row with
    ~45-degree chevrons sized to the row. This is the v2 answer to 'bracing too sparse'."""
    Wb, Hb = u1 - u0, z1 - z0
    if Wb <= 0.12 or Hb <= 0.12: return
    rows = max(1, min(4, round(Hb / (max(Wb, 0.3) * 0.6))))
    rh = Hb / rows
    mw = min(TIMBER_W, rh * 0.42)
    for r in range(rows):
        za, zb_ = z0 + r * rh, z0 + (r + 1) * rh
        if r > 0 and rh >= 0.45:
            rail(face, za, u0, u1, w, d, rw=min(TIMBER_W, rh * 0.3))
        n = max(1, round(Wb / (rh * 1.8)))
        zigzag_panel(face, u0, za + mw * 0.4, u1, zb_ - mw * 0.4, w, d, n=n, mw=mw)

def leaded_window(face, u, cz, win_w, win_h, w, d, n_mullions=3):
    """Timber surround + N vertical uprights + one horizontal transom — reads as leaded glazing."""
    bw, fe, mw = 0.09, 0.075, 0.045
    TIMBER_PARTS.append(face_box(face, u, cz + win_h / 2 + bw / 2, win_w + 2 * bw, fe, bw, MAT_TIMBER, w, d, name="winTop"))
    TIMBER_PARTS.append(face_box(face, u, cz - win_h / 2 - bw / 2, win_w + 2 * bw, fe, bw, MAT_TIMBER, w, d, name="winBot"))
    TIMBER_PARTS.append(face_box(face, u - win_w / 2 - bw / 2, cz, bw, fe, win_h, MAT_TIMBER, w, d, name="winL"))
    TIMBER_PARTS.append(face_box(face, u + win_w / 2 + bw / 2, cz, bw, fe, win_h, MAT_TIMBER, w, d, name="winR"))
    for k in range(n_mullions):
        mu = u - win_w / 2 + win_w * (k + 1) / (n_mullions + 1)
        TIMBER_PARTS.append(face_box(face, mu, cz, mw, fe * 0.7, win_h, MAT_TIMBER, w, d, name="mullV"))
    TIMBER_PARTS.append(face_box(face, u, cz, win_w, fe * 0.7, mw, MAT_TIMBER, w, d, name="mullH"))

def surface_window(face, u, cz, win_w, win_h, w, d, n_mullions=2):
    """Window on a solid surface (gables, wing, dormer): dark glass panel + leaded frame, no boolean."""
    face_box(face, u, cz, win_w + 0.04, 0.028, win_h + 0.04, M_DARK, w, d, name="glassPanel")
    leaded_window(face, u, cz, win_w, win_h, w, d, n_mullions=n_mullions)

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

def gable_prism_y(name, xc, half_w, y_front, y_back, zb_, zt_):
    """Solid gabled prism with the ridge along Y (wing roof, dormer roof). Front triangle is
    plaster (the gable face); slopes/back are shingle."""
    me = bpy.data.meshes.new(name); ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    bm = bmesh.new()
    v = [bm.verts.new(p) for p in [
        (xc - half_w, y_front, zb_), (xc + half_w, y_front, zb_), (xc, y_front, zt_),
        (xc - half_w, y_back, zb_), (xc + half_w, y_back, zb_), (xc, y_back, zt_)]]
    bm.faces.new((v[0], v[1], v[2]))              # front gable triangle (index 0 -> plaster)
    bm.faces.new((v[3], v[5], v[4]))              # back triangle (buried)
    bm.faces.new((v[0], v[2], v[5], v[3]))        # left slope
    bm.faces.new((v[1], v[4], v[5], v[2]))        # right slope
    bm.faces.new((v[0], v[3], v[4], v[1]))        # bottom
    bm.to_mesh(me); bm.free()
    me.uv_layers.new(name="UVMap")
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.cube_project(cube_size=1.0, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    me.materials.append(MAT_SHINGLE); me.materials.append(MAT_PLASTER)
    for i, f in enumerate(me.polygons):
        f.material_index = 1 if i == 0 else 0
    bevel(ob, 0.03, 1)
    return ob

def bargeboard_y(y_face, x0, z0, x1, z1, name):
    """Raked bargeboard on a +Y-facing gable (wing, dormer)."""
    length = math.hypot(x1 - x0, z1 - z0)
    ang = math.atan2(z1 - z0, x1 - x0)
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=((x0 + x1) / 2, y_face, (z0 + z1) / 2 + 0.06))
    o = bpy.context.active_object; o.name = name
    o.scale = (length, 0.06, 0.30); o.rotation_euler = (0, -ang, 0)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    apply_tiled(o, MAT_TIMBER); TIMBER_PARTS.append(o)

def knee(face, u, w, d):
    """Diagonal knee brace under the jetty: wall face -> jetty edge (out-of-plane 45-degree strut)."""
    x, y = face_pos(face, u, JETTY / 2 - 0.06, w, d)
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(x, y, H1 - 0.30))
    o = bpy.context.active_object; o.name = "knee"
    if face == "front":
        o.scale = (0.13, 0.60, 0.13); o.rotation_euler = (math.radians(45), 0, 0)
    elif face == "back":
        o.scale = (0.13, 0.60, 0.13); o.rotation_euler = (math.radians(-45), 0, 0)
    elif face == "right":
        o.scale = (0.60, 0.13, 0.13); o.rotation_euler = (0, math.radians(-45), 0)
    else:
        o.scale = (0.60, 0.13, 0.13); o.rotation_euler = (0, math.radians(45), 0)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    apply_tiled(o, MAT_TIMBER); TIMBER_PARTS.append(o)

def joists(face, u0, u1, n, w, d, depth=None):
    """Visible floor-joist ends protruding under the bressummer — the jetty shadow line."""
    depth = depth or (JETTY + 0.18)
    for i in range(n):
        u = u0 + (u1 - u0) * (i + 0.5) / n
        x, y = face_pos(face, u, depth / 2 - 0.04, w, d)
        size = (0.13, depth, 0.11) if face in ("front", "back") else (depth, 0.13, 0.11)
        timber_box(f"joist_{face}{i}", (x, y, H1 - 0.075), size)

# ================================================================================
# ---- ground floor: brick footing walls + door + windows -----------------------
# ================================================================================
gf = box("GroundFloor", (0, 0, H1 / 2), (W1, D1, H1))
gf_inner = box("GFInner", (0, 0, H1 / 2 + 0.2), (W1 - 2 * T, D1 - 2 * T, H1))
boolean(gf, gf_inner)
WALL_OBJ = [gf]

DOOR_X, DOOR_W, DOOR_H, DOOR_CZ = 1.0, 0.95, 1.85, 1.0
boolean(gf, box("doorcut", (DOOR_X, D1 / 2, DOOR_CZ), (1.05, T * 3, 1.95)))
door = box("Door", (DOOR_X, D1 / 2 - T * 0.35, DOOR_CZ), (DOOR_W, 0.06, DOOR_H))

GWIN_W, GWIN_H, GWIN_CZ = 0.7, 0.75, 1.35
opening(2.35, GWIN_CZ, GWIN_W, GWIN_H, "front", W1, D1)
opening(-1, GWIN_CZ, GWIN_W, GWIN_H, "side", W1, D1)    # left face (u=0)
opening(1, GWIN_CZ, GWIN_W, GWIN_H, "side", W1, D1)     # right face (u=0)
opening(-1.9, GWIN_CZ, GWIN_W, GWIN_H, "back", W1, D1)
opening(1.9, GWIN_CZ, GWIN_W, GWIN_H, "back", W1, D1)

bevel(gf, 0.02, 2)
apply_tiled(gf, MAT_BRICK)
apply_tiled(door, MAT_TIMBER)

# door dressing: timber lintel + jambs + plank battens
DOOR_FACE_Y = (D1 / 2 - T * 0.35) - 0.03
dbw, dfe = 0.11, 0.09
TIMBER_PARTS.append(face_box("front", DOOR_X, DOOR_CZ + DOOR_H / 2 + dbw / 2, 1.05 + 2 * dbw, dfe, dbw, MAT_TIMBER, W1, D1, name="doorLintel"))
TIMBER_PARTS.append(face_box("front", DOOR_X - 0.525 - dbw / 2, DOOR_CZ, dbw, dfe, DOOR_H, MAT_TIMBER, W1, D1, name="doorJambL"))
TIMBER_PARTS.append(face_box("front", DOOR_X + 0.525 + dbw / 2, DOOR_CZ, dbw, dfe, DOOR_H, MAT_TIMBER, W1, D1, name="doorJambR"))
N_PLANKS = 5
plank_w = 0.88 / N_PLANKS
for i in range(N_PLANKS):
    pu = DOOR_X - 0.44 + plank_w * (i + 0.5)
    o = box(f"doorPlank{i}", (pu, DOOR_FACE_Y - 0.026, DOOR_CZ), (plank_w * 0.78, 0.04, DOOR_H - 0.05))
    apply_tiled(o, MAT_TIMBER); TIMBER_PARTS.append(o)
for hz in (DOOR_CZ + 0.55, DOOR_CZ - 0.55):
    hstrap = box("hinge", (DOOR_X - 0.08, DOOR_FACE_Y - 0.06, hz), (0.55, 0.022, 0.10)); hstrap.data.materials.append(M_METAL)
handle = box("handle", (DOOR_X + 0.32, DOOR_FACE_Y - 0.065, DOOR_CZ - 0.05), (0.1, 0.03, 0.1)); handle.data.materials.append(M_METAL)

threshold = box("threshold", (DOOR_X, D1 / 2 + 0.15, 0.06), (1.25, 0.3, 0.12))
apply_tiled(threshold, MAT_BRICK); bevel(threshold, 0.02, 1)

# ground-floor window dressings + brick sills
leaded_window("front", 2.35, GWIN_CZ, GWIN_W, GWIN_H, W1, D1, n_mullions=2)
leaded_window("left", 0, GWIN_CZ, GWIN_W, GWIN_H, W1, D1, n_mullions=2)
leaded_window("right", 0, GWIN_CZ, GWIN_W, GWIN_H, W1, D1, n_mullions=2)
leaded_window("back", -1.9, GWIN_CZ, GWIN_W, GWIN_H, W1, D1, n_mullions=2)
leaded_window("back", 1.9, GWIN_CZ, GWIN_W, GWIN_H, W1, D1, n_mullions=2)
for f_, u_ in (("front", 2.35), ("back", -1.9), ("back", 1.9)):
    face_box(f_, u_, GWIN_CZ - GWIN_H / 2 - 0.12, GWIN_W + 0.3, 0.14, 0.08, MAT_BRICK, W1, D1, name="sill")

# ================================================================================
# ---- cross-wing (front-left): plinth + timbered ground tier + jettied upper ----
# ================================================================================
wing_plinth = box("WingPlinth", (WX, (2.3 + WG_Y + 0.03) / 2, PLINTH_H / 2), (WING_W, WG_Y + 0.03 - 2.3, PLINTH_H))
apply_tiled(wing_plinth, MAT_BRICK); bevel(wing_plinth, 0.02, 1)

WGF_Y = WG_Y - 0.03  # wing ground-tier plaster face (slightly recessed behind the plinth lip)
wing_g = box("WingGround", (WX, (2.3 + WGF_Y) / 2, (PLINTH_H + H1) / 2), (WING_W - 0.04, WGF_Y - 2.3, H1 - PLINTH_H))
apply_tiled(wing_g, MAT_PLASTER); bevel(wing_g, 0.015, 1)

# wing ground tier framing (face y = WGF_Y -> synthetic d): posts + rails + window + stacked chevrons
d_wg = 2 * WGF_Y
vertical_stud("front", WING_X0 + 0.11, PLINTH_H + 0.02, H1, W2, d_wg, ww=0.2)
vertical_stud("front", WING_X1 - 0.11, PLINTH_H + 0.02, H1, W2, d_wg, ww=0.2)
rail("front", PLINTH_H + 0.09, WING_X0 + 0.03, WING_X1 - 0.03, W2, d_wg)
rail("front", H1 - 0.07, WING_X0 + 0.03, WING_X1 - 0.03, W2, d_wg)
surface_window("front", WX, 1.75, 0.78, 0.68, W2, d_wg, n_mullions=2)
herringbone("front", WING_X0 + 0.22, PLINTH_H + 0.20, WX - 0.53, H1 - 0.17, W2, d_wg)
herringbone("front", WX + 0.53, PLINTH_H + 0.20, WING_X1 - 0.22, H1 - 0.17, W2, d_wg)

# wing bressummer + joist ends + knee braces (the jetty transition, repeated on the wing)
wing_band = box("WingBand", (WX, (2.3 + WU_Y + 0.03) / 2, H1 + BAND_H / 2), (WING_W + 0.12, WU_Y + 0.03 - 2.3, BAND_H))
apply_tiled(wing_band, MAT_TIMBER)
joists("front", WING_X0 + 0.15, WING_X1 - 0.15, 5, W1, 2 * WG_Y, depth=JETTY + 0.14)
knee("front", WX - 0.85, W1, 2 * WG_Y)
knee("front", WX + 0.85, W1, 2 * WG_Y)

# wing upper storey (jettied)
wing_u = box("WingUpper", (WX, (2.85 + WU_Y) / 2, UF_Z0 + H2 / 2), (WING_W, WU_Y - 2.85, H2))
apply_tiled(wing_u, MAT_PLASTER); bevel(wing_u, 0.015, 1)
# flank corner posts (the wing's side planes) — kept INSIDE the wing's front plane
timber_box("wingFlankL", (WING_X0 - TIMBER_T / 2 + 0.01, WU_Y - 0.42, UF_Z0 + H2 / 2), (TIMBER_T, 0.62, H2 - 0.12))
timber_box("wingFlankR", (WING_X1 + TIMBER_T / 2 - 0.01, WU_Y - 0.42, UF_Z0 + H2 / 2), (TIMBER_T, 0.62, H2 - 0.12))

# ================================================================================
# ---- main bressummer + joist ends + knee braces --------------------------------
# ================================================================================
BAND_Z = H1 + BAND_H / 2
band = box("Bressummer", (0, 0, BAND_Z), (W2, D2, BAND_H))
band_inner = box("BressummerInner", (0, 0, BAND_Z + 0.02), (W1 - 0.1, D1 - 0.1, BAND_H + 0.05))
boolean(band, band_inner)
apply_tiled(band, MAT_TIMBER)

joists("front", -0.15, 3.3, 7, W1, D1)
joists("back", -3.3, 3.3, 11, W1, D1)
joists("left", -2.4, 2.4, 8, W1, D1)
joists("right", -2.4, 2.4, 8, W1, D1)
for u in (0.25, 2.9):  knee("front", u, W1, D1)
for u in (-2.4, 0.0, 2.4): knee("back", u, W1, D1)
for u in (-1.8, 1.8):
    knee("left", u, W1, D1); knee("right", u, W1, D1)

# ================================================================================
# ---- upper floor: jettied, timber-framed, aged plaster infill ------------------
# ================================================================================
uf = box("UpperFloor", (0, 0, UF_Z0 + H2 / 2), (W2, D2, H2))
uf_inner = box("UFInner", (0, 0, UF_Z0 + H2 / 2 + 0.2), (W2 - 2 * T, D2 - 2 * T, H2))
boolean(uf, uf_inner)
WALL_OBJ = [uf]

UWIN_W, UWIN_H = 0.95, 0.95
UWIN_CZ = UF_Z0 + H2 * 0.52
opening(1.7, UWIN_CZ, UWIN_W, UWIN_H, "front", W2, D2)
opening(0, UWIN_CZ, 0.8, 0.85, "back", W2, D2)
opening(W2 / 2, UWIN_CZ, 0.8, 0.85, "side", W2, D2)
opening(-W2 / 2, UWIN_CZ, 0.8, 0.85, "side", W2, D2)

bevel(uf, 0.015, 1)
apply_tiled(uf, MAT_PLASTER)

leaded_window("front", 1.7, UWIN_CZ, UWIN_W, UWIN_H, W2, D2, n_mullions=3)
leaded_window("back", 0, UWIN_CZ, 0.8, 0.85, W2, D2, n_mullions=2)
leaded_window("right", 0, UWIN_CZ, 0.8, 0.85, W2, D2, n_mullions=2)
leaded_window("left", 0, UWIN_CZ, 0.8, 0.85, W2, D2, n_mullions=2)
# wing upper window (surface-mounted; the wing box is solid)
d_wu = 2 * WU_Y
surface_window("front", WX, UWIN_CZ, UWIN_W, UWIN_H, W2, d_wu, n_mullions=3)

# ---- half-timber frame: plates, rails, studs + DENSE herringbone ---------------
Z0, Z1 = UF_Z0 + 0.08, UF_TOP - 0.10
SILL_Z = UWIN_CZ - UWIN_H / 2 - 0.14   # rail just under the window frames
HEAD_Z = UWIN_CZ + UWIN_H / 2 + 0.14   # rail just over the window frames

# FRONT (main wall, right of the wing): continuous chevron friezes above+below the window row,
# stacked-V bays flanking the window — dense, repeated, across the elevation.
rail("front", Z1, -3.44, 3.44, W2, D2)
rail("front", Z0, -3.44, 3.44, W2, D2)
rail("front", SILL_Z, -0.34, 3.40, W2, D2)
rail("front", HEAD_Z, -0.34, 3.40, W2, D2)
vertical_stud("front", -3.26, Z0, Z1, W2, D2, ww=0.44)  # covers the sliver between wing and corner
vertical_stud("front", -0.25, Z0, Z1, W2, D2)
vertical_stud("front", 1.02, Z0, Z1, W2, D2)
vertical_stud("front", 2.38, Z0, Z1, W2, D2)
vertical_stud("front", 3.36, Z0, Z1, W2, D2, ww=0.24)
herringbone("front", -0.14, Z0 + 0.10, 3.30, SILL_Z - 0.08, W2, D2)     # lower frieze
herringbone("front", -0.14, HEAD_Z + 0.08, 3.30, Z1 - 0.09, W2, D2)     # upper frieze
herringbone("front", -0.14, SILL_Z + 0.10, 0.92, HEAD_Z - 0.10, W2, D2) # bay left of window
herringbone("front", 2.48, SILL_Z + 0.10, 3.28, HEAD_Z - 0.10, W2, D2)  # bay right of window

# WING upper front: same language at the wing's plane
rail("front", Z1, WING_X0 - 0.03, WING_X1 + 0.03, W2, d_wu)
rail("front", Z0, WING_X0 - 0.03, WING_X1 + 0.03, W2, d_wu)
rail("front", SILL_Z, WING_X0 + 0.02, WING_X1 - 0.02, W2, d_wu)
rail("front", HEAD_Z, WING_X0 + 0.02, WING_X1 - 0.02, W2, d_wu)
vertical_stud("front", WING_X0 + 0.11, Z0, Z1, W2, d_wu, ww=0.22)
vertical_stud("front", WING_X1 - 0.11, Z0, Z1, W2, d_wu, ww=0.22)
herringbone("front", WING_X0 + 0.24, Z0 + 0.10, WING_X1 - 0.24, SILL_Z - 0.08, W2, d_wu)
herringbone("front", WING_X0 + 0.24, HEAD_Z + 0.08, WING_X1 - 0.24, Z1 - 0.09, W2, d_wu)
herringbone("front", WING_X0 + 0.24, SILL_Z + 0.10, WX - 0.66, HEAD_Z - 0.10, W2, d_wu)
herringbone("front", WX + 0.66, SILL_Z + 0.10, WING_X1 - 0.24, HEAD_Z - 0.10, W2, d_wu)

# BACK
rail("back", Z1, -3.44, 3.44, W2, D2); rail("back", Z0, -3.44, 3.44, W2, D2)
rail("back", SILL_Z, -3.40, 3.40, W2, D2); rail("back", HEAD_Z, -3.40, 3.40, W2, D2)
for u in (-3.36, -1.35, 1.35, 3.36):
    vertical_stud("back", u, Z0, Z1, W2, D2, ww=0.24 if abs(u) > 3 else None)
herringbone("back", -3.26, Z0 + 0.10, 3.26, SILL_Z - 0.08, W2, D2)
herringbone("back", -3.26, HEAD_Z + 0.08, 3.26, Z1 - 0.09, W2, D2)
herringbone("back", -3.24, SILL_Z + 0.10, -1.46, HEAD_Z - 0.10, W2, D2)
herringbone("back", 1.46, SILL_Z + 0.10, 3.24, HEAD_Z - 0.10, W2, D2)

# SIDES
for f_ in ("left", "right"):
    rail(f_, Z1, -2.94, 2.94, W2, D2); rail(f_, Z0, -2.94, 2.94, W2, D2)
    rail(f_, SILL_Z, -2.90, 2.90, W2, D2); rail(f_, HEAD_Z, -2.90, 2.90, W2, D2)
    for u in (-2.86, -0.62, 0.62, 2.86):
        vertical_stud(f_, u, Z0, Z1, W2, D2, ww=0.24 if abs(u) > 2.5 else None)
    herringbone(f_, -2.76, Z0 + 0.10, 2.76, SILL_Z - 0.08, W2, D2)
    herringbone(f_, -2.76, HEAD_Z + 0.08, 2.76, Z1 - 0.09, W2, D2)
    herringbone(f_, -2.74, SILL_Z + 0.10, -0.74, HEAD_Z - 0.10, W2, D2)
    herringbone(f_, 0.74, SILL_Z + 0.10, 2.74, HEAD_Z - 0.10, W2, D2)

# ================================================================================
# ---- main roof: solid prism (ridge along X), steep pitch -----------------------
# ================================================================================
me = bpy.data.meshes.new("Roof"); roof = bpy.data.objects.new("Roof", me)
bpy.context.collection.objects.link(roof)
xL, xR = -(W2 / 2 + EAVE), (W2 / 2 + EAVE)
yF, yB = (D2 / 2 + EAVE), -(D2 / 2 + EAVE)
zb, zt = RIDGE_Z0, ZT
bm = bmesh.new()
vs = [bm.verts.new(p) for p in [
    (xL, yF, zb), (xL, yB, zb), (xL, 0, zt),
    (xR, yF, zb), (xR, yB, zb), (xR, 0, zt)]]
bm.faces.new((vs[0], vs[1], vs[2]))            # left gable triangle
bm.faces.new((vs[3], vs[5], vs[4]))            # right gable triangle
bm.faces.new((vs[0], vs[2], vs[5], vs[3]))     # front slope
bm.faces.new((vs[1], vs[4], vs[5], vs[2]))     # back slope
bm.faces.new((vs[0], vs[3], vs[4], vs[1]))     # bottom
bm.to_mesh(me); bm.free()
me.uv_layers.new(name="UVMap")
bpy.context.view_layer.objects.active = roof
bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.cube_project(cube_size=1.0, correct_aspect=True, scale_to_bounds=False)
bpy.ops.object.mode_set(mode="OBJECT")
me.materials.append(MAT_SHINGLE); me.materials.append(MAT_PLASTER)   # 0=shingle, 1=plaster gables
for i, f in enumerate(me.polygons):
    f.material_index = 1 if i in (0, 1) else 0
bevel(roof, 0.04, 1)

# ridge beam (silhouette)
ridge_beam = timber_box("RidgeBeam", (0, 0, zt + 0.03), (W2 + 2 * EAVE + 0.15, 0.26, 0.15))

# ---- dressed gable ends (v1 left them blank white) -----------------------------
WG = W2 + 2 * EAVE  # synthetic width so face_pos lands on the gable plane
def dress_gable(face):
    surface_window(face, 0, 5.55, 0.7, 0.75, WG, D2, n_mullions=2)
    vertical_stud(face, 0, 6.15, zt - 0.35, WG, D2)                    # king stud above the window
    vertical_stud(face, -0.75, zb + 0.08, 6.35, WG, D2)
    vertical_stud(face, 0.75, zb + 0.08, 6.35, WG, D2)
    rail(face, 6.55, -2.05, 2.05, WG, D2)                              # collar
    brace(face, -2.55, zb + 0.18, -0.72, 6.42, WG, D2)
    brace(face, 2.55, zb + 0.18, 0.72, 6.42, WG, D2)
    brace(face, -1.30, 6.68, -0.14, 7.82, WG, D2)
    brace(face, 1.30, 6.68, 0.14, 7.82, WG, D2)
dress_gable("left")
dress_gable("right")

# ---- rafter tails (under the deep eaves) + gable bargeboards ----------------
def rafter_tails(y_wall, y_out, z, x0, x1, n):
    for i in range(n):
        xu = x0 + (x1 - x0) * (i + 0.5) / n
        ym = (y_wall + y_out) / 2; length = abs(y_out - y_wall)
        timber_box(f"rafterTail{i}", (xu, ym, z), (0.10, length, 0.10))

rafter_tails(D2 / 2 - 0.05, D2 / 2 + EAVE + 0.05, RIDGE_Z0 + 0.05, -0.15, 3.4, 6)   # front (right of wing)
rafter_tails(-D2 / 2 + 0.05, -D2 / 2 - EAVE - 0.05, RIDGE_Z0 + 0.05, -3.4, 3.4, 11) # back

def bargeboard(xface, y0, z0, y1, z1, sign, name):
    length = math.hypot(y1 - y0, z1 - z0)
    ang = math.atan2(z1 - z0, y1 - y0)
    ym, zm = (y0 + y1) / 2, (z0 + z1) / 2 + 0.06
    xm = xface + sign * 0.05
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(xm, ym, zm))
    o = bpy.context.active_object; o.name = name
    o.scale = (0.06, length, 0.32); o.rotation_euler = (ang, 0, 0)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    apply_tiled(o, MAT_TIMBER)
    return o

TIMBER_PARTS.append(bargeboard(xL, yF, zb, 0, zt, -1, "bargeL1"))
TIMBER_PARTS.append(bargeboard(xL, yB, zb, 0, zt, -1, "bargeL2"))
TIMBER_PARTS.append(bargeboard(xR, yF, zb, 0, zt, 1, "bargeR1"))
TIMBER_PARTS.append(bargeboard(xR, yB, zb, 0, zt, 1, "bargeR2"))

# ================================================================================
# ---- wing roof: gabled prism (ridge along Y) buried into the main slope --------
# ================================================================================
WING_YF = WU_Y + 0.30
wing_roof = gable_prism_y("WingRoof", WX, WING_W / 2 + 0.3, WING_YF, 1.0, RIDGE_Z0, WING_ZT)
# wing gable face dressing (face plane y = WING_YF)
d_wgbl = 2 * WING_YF
surface_window("front", WX, 5.75, 0.75, 0.75, W2, d_wgbl, n_mullions=2)
vertical_stud("front", WX, 6.28, WING_ZT - 0.22, W2, d_wgbl)
rail("front", 5.30, WX - 0.92, WX + 0.92, W2, d_wgbl)
brace("front", WX - 1.32, RIDGE_Z0 + 0.10, WX - 0.50, 6.32, W2, d_wgbl)
brace("front", WX + 1.32, RIDGE_Z0 + 0.10, WX + 0.50, 6.32, W2, d_wgbl)
bargeboard_y(WING_YF + 0.04, WX - (WING_W / 2 + 0.3), RIDGE_Z0, WX, WING_ZT, "wingBargeL")
bargeboard_y(WING_YF + 0.04, WX + (WING_W / 2 + 0.3), RIDGE_Z0, WX, WING_ZT, "wingBargeR")
wing_ridge = timber_box("WingRidge", (WX, (WING_YF + 1.0) / 2, WING_ZT + 0.02), (0.22, WING_YF - 1.0, 0.12))

# ================================================================================
# ---- gabled dormer on the front slope (right side) -----------------------------
# ================================================================================
DX, DW = 1.7, 1.4
DY = 2.7                                   # dormer face plane
dorm = box("DormerWalls", (DX, (1.8 + DY) / 2, (5.60 + 7.02) / 2), (DW, DY - 1.8, 7.02 - 5.60))
apply_tiled(dorm, MAT_PLASTER); bevel(dorm, 0.015, 1)
dorm_roof = gable_prism_y("DormerRoof", DX, DW / 2 + 0.15, DY + 0.25, 0.95, 6.98, 7.88)
d_dorm = 2 * DY
surface_window("front", DX, 6.42, 0.72, 0.68, W2, d_dorm, n_mullions=2)
vertical_stud("front", DX - DW / 2 + 0.08, 5.95, 6.98, W2, d_dorm, ww=0.12)
vertical_stud("front", DX + DW / 2 - 0.08, 5.95, 6.98, W2, d_dorm, ww=0.12)
bargeboard_y(DY + 0.25 + 0.04, DX - (DW / 2 + 0.15), 6.98, DX, 7.88, "dormBargeL")
bargeboard_y(DY + 0.25 + 0.04, DX + (DW / 2 + 0.15), 6.98, DX, 7.88, "dormBargeR")

# ================================================================================
# ---- chimney: tall brick stack straddling the ridge (back-left) ----------------
# ================================================================================
CX, CY = -2.3, -0.9
CH_TOP = 10.55
chim = box("Chimney", (CX, CY, (6.4 + CH_TOP - 0.28) / 2), (0.72, 0.72, CH_TOP - 0.28 - 6.4))
apply_tiled(chim, MAT_BRICK); bevel(chim, 0.02, 1)
cap = box("ChimneyCap", (CX, CY, CH_TOP - 0.14), (0.92, 0.92, 0.28))
apply_tiled(cap, MAT_BRICK); bevel(cap, 0.02, 1)
# twin pots, set diagonally (the iconic Tudor silhouette)
for dx in (-0.18, 0.18):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(CX + dx, CY, CH_TOP + 0.16))
    o = bpy.context.active_object; o.name = "pot"
    o.scale = (0.17, 0.17, 0.34); o.rotation_euler = (0, 0, math.radians(45))
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    apply_tiled(o, MAT_BRICK)

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
print(f"tudor-cottage v2: wrote {OUT}  (ridge~{zt:.2f}m, wing-ridge~{WING_ZT:.2f}m, chimney-top~{CH_TOP+0.33:.2f}m, footprint {W2}x{D2}+wing)")
