# cottage.py — a humble medieval TIMBER COTTAGE authored in headless Blender, with REAL baked textures
# (daub/plaster walls, half-timber oak frame, thatch roof, stone base course) instead of solid PBR colors.
# The build agent authoring a bespoke dwelling as a whole GLB the engine consumes. Non-Adobe end to end.
#
#   blender --background --factory-startup --python tools/blender/cottage.py -- --out assets/cottage-authored.glb
#
# Texture strategy (same recipe as castle.py): bake a small procedural node-graph to an IMAGE (Cycles bake
# passes: DIFFUSE/ROUGHNESS/NORMAL) on a throwaway plane, pack the image into the .blend, then build a
# CONSUMPTION material that samples that image via cube-projected UVs tiled at true world scale. Every
# surface (walls, timber, thatch, stone) gets genuine embedded Image Texture nodes — no flat Principled color.
#
# Reviewer pass (v2): walls read too stony/grey -> daub pushed warmer/brighter with lower roughness contrast
# and fieldstone strictly confined to the base course + chimney; the half-timber frame is now real 3D relief
# (chunky posts/rails/braces proud of the wall, beveled for edge-highlight, plus symmetric back braces);
# windows get a timber surround + mullion cross + stone sill, the door gets a lintel/jambs, plank battens,
# iron strap-hinges + rivets + a ring handle + a stone threshold, and the roof gets rafter-tail stubs under
# the eaves plus gable bargeboards so it reads as crafted, not extruded.

import bpy, bmesh, sys, math
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[argv.index("--out") + 1] if "--out" in argv else "assets/cottage-authored.glb"
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

def build_wall(nds, lk, bsdf):
    """Lime-daub / plaster: warm CREAM base + soft mottling, low roughness contrast — must read as plaster,
    never as stone. Kept deliberately brighter/warmer and smoother than the fieldstone material below."""
    tc = nds.new("ShaderNodeTexCoord")
    noise1 = nds.new("ShaderNodeTexNoise"); noise1.inputs["Scale"].default_value = 12; noise1.inputs["Detail"].default_value = 4
    lk.new(tc.outputs["UV"], noise1.inputs["Vector"])
    ramp1 = nds.new("ShaderNodeValToRGB")
    ramp1.color_ramp.elements[0].position = 0.35; ramp1.color_ramp.elements[0].color = (0.86, 0.78, 0.60, 1)
    ramp1.color_ramp.elements[1].position = 0.65; ramp1.color_ramp.elements[1].color = (0.97, 0.93, 0.82, 1)
    lk.new(noise1.outputs["Fac"], ramp1.inputs["Fac"])
    # faint warm streaking — much subtler than a stone-reading material, keeps it a soft plaster
    mp2 = nds.new("ShaderNodeMapping"); mp2.inputs["Scale"].default_value = (3.0, 0.25, 1.0)
    lk.new(tc.outputs["UV"], mp2.inputs["Vector"])
    noise2 = nds.new("ShaderNodeTexNoise"); noise2.inputs["Scale"].default_value = 4.0; noise2.inputs["Detail"].default_value = 6
    lk.new(mp2.outputs["Vector"], noise2.inputs["Vector"])
    ramp2 = nds.new("ShaderNodeValToRGB")
    ramp2.color_ramp.elements[0].position = 0.42; ramp2.color_ramp.elements[0].color = (0.68, 0.58, 0.42, 1)
    ramp2.color_ramp.elements[1].position = 0.72; ramp2.color_ramp.elements[1].color = (1, 1, 1, 1)
    lk.new(noise2.outputs["Fac"], ramp2.inputs["Fac"])
    dirt = nds.new("ShaderNodeMixRGB"); dirt.blend_type = "MULTIPLY"; dirt.inputs["Fac"].default_value = 0.22
    lk.new(ramp1.outputs["Color"], dirt.inputs["Color1"]); lk.new(ramp2.outputs["Color"], dirt.inputs["Color2"])
    lk.new(dirt.outputs["Color"], bsdf.inputs["Base Color"])
    rgh = nds.new("ShaderNodeValToRGB")
    rgh.color_ramp.elements[0].position = 0.4; rgh.color_ramp.elements[0].color = (0.60, 0.60, 0.60, 1)
    rgh.color_ramp.elements[1].position = 0.6; rgh.color_ramp.elements[1].color = (0.72, 0.72, 0.72, 1)
    lk.new(noise1.outputs["Fac"], rgh.inputs["Fac"])
    lk.new(rgh.outputs["Color"], bsdf.inputs["Roughness"])
    bump = nds.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.12
    lk.new(noise1.outputs["Fac"], bump.inputs["Height"])
    lk.new(bump.outputs["Normal"], bsdf.inputs["Normal"])

def build_timber(nds, lk, bsdf):
    """Dark oak: vertical grain bands + fine noise grain + strong bump so the frame reads under any light."""
    tc = nds.new("ShaderNodeTexCoord")
    mp = nds.new("ShaderNodeMapping"); mp.inputs["Scale"].default_value = (1.0, 8.0, 1.0)
    lk.new(tc.outputs["UV"], mp.inputs["Vector"])
    wave = nds.new("ShaderNodeTexWave"); wave.wave_type = "BANDS"; wave.bands_direction = "Y"
    wave.inputs["Scale"].default_value = 6.0; wave.inputs["Distortion"].default_value = 2.5; wave.inputs["Detail"].default_value = 3.0
    lk.new(mp.outputs["Vector"], wave.inputs["Vector"])
    ramp = nds.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.3; ramp.color_ramp.elements[0].color = (0.055, 0.032, 0.018, 1)
    ramp.color_ramp.elements[1].position = 0.7; ramp.color_ramp.elements[1].color = (0.16, 0.10, 0.058, 1)
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
    bsdf.inputs["Roughness"].default_value = 0.6
    bump = nds.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.55
    lk.new(wave.outputs["Fac"], bump.inputs["Height"])
    lk.new(bump.outputs["Normal"], bsdf.inputs["Normal"])

def build_thatch(nds, lk, bsdf):
    """Thatch: warped horizontal row banding (straw courses) + fine strand fibers + strong directional bump."""
    tc = nds.new("ShaderNodeTexCoord")
    mp = nds.new("ShaderNodeMapping"); mp.inputs["Scale"].default_value = (1.0, 14.0, 1.0)
    lk.new(tc.outputs["UV"], mp.inputs["Vector"])
    warpnoise = nds.new("ShaderNodeTexNoise"); warpnoise.inputs["Scale"].default_value = 20; warpnoise.inputs["Detail"].default_value = 6
    lk.new(mp.outputs["Vector"], warpnoise.inputs["Vector"])
    warpvec = nds.new("ShaderNodeVectorMath"); warpvec.operation = "SCALE"; warpvec.inputs["Scale"].default_value = 0.05
    lk.new(warpnoise.outputs["Color"], warpvec.inputs[0])
    warpadd = nds.new("ShaderNodeVectorMath"); warpadd.operation = "ADD"
    lk.new(mp.outputs["Vector"], warpadd.inputs[0]); lk.new(warpvec.outputs["Vector"], warpadd.inputs[1])
    rows = nds.new("ShaderNodeTexWave"); rows.wave_type = "BANDS"; rows.bands_direction = "Y"
    rows.inputs["Scale"].default_value = 0.6; rows.inputs["Distortion"].default_value = 3.6; rows.inputs["Detail"].default_value = 4.0
    lk.new(warpadd.outputs["Vector"], rows.inputs["Vector"])
    ramp = nds.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.24; ramp.color_ramp.elements[0].color = (0.32, 0.20, 0.07, 1)
    ramp.color_ramp.elements[1].position = 0.76; ramp.color_ramp.elements[1].color = (0.64, 0.47, 0.20, 1)
    lk.new(rows.outputs["Fac"], ramp.inputs["Fac"])
    stripes = nds.new("ShaderNodeTexWave"); stripes.wave_type = "BANDS"; stripes.bands_direction = "X"
    stripes.inputs["Scale"].default_value = 60.0; stripes.inputs["Distortion"].default_value = 3.0; stripes.inputs["Detail"].default_value = 2.0
    lk.new(warpadd.outputs["Vector"], stripes.inputs["Vector"])
    fibramp = nds.new("ShaderNodeValToRGB")
    fibramp.color_ramp.elements[0].position = 0.45; fibramp.color_ramp.elements[0].color = (0.78, 0.78, 0.78, 1)
    fibramp.color_ramp.elements[1].position = 0.55; fibramp.color_ramp.elements[1].color = (1, 1, 1, 1)
    lk.new(stripes.outputs["Fac"], fibramp.inputs["Fac"])
    fibctrl = nds.new("ShaderNodeMixRGB"); fibctrl.blend_type = "MULTIPLY"; fibctrl.inputs["Fac"].default_value = 0.3
    lk.new(ramp.outputs["Color"], fibctrl.inputs["Color1"]); lk.new(fibramp.outputs["Color"], fibctrl.inputs["Color2"])
    # large-scale sun-bleached patches to break up the mechanical row regularity
    patch = nds.new("ShaderNodeTexNoise"); patch.inputs["Scale"].default_value = 3.2; patch.inputs["Detail"].default_value = 4
    lk.new(tc.outputs["UV"], patch.inputs["Vector"])
    patchramp = nds.new("ShaderNodeValToRGB")
    patchramp.color_ramp.elements[0].position = 0.4; patchramp.color_ramp.elements[0].color = (0.82, 0.82, 0.80, 1)
    patchramp.color_ramp.elements[1].position = 0.6; patchramp.color_ramp.elements[1].color = (1, 1, 1, 1)
    lk.new(patch.outputs["Fac"], patchramp.inputs["Fac"])
    patched = nds.new("ShaderNodeMixRGB"); patched.blend_type = "MULTIPLY"; patched.inputs["Fac"].default_value = 0.5
    lk.new(fibctrl.outputs["Color"], patched.inputs["Color1"]); lk.new(patchramp.outputs["Color"], patched.inputs["Color2"])
    lk.new(patched.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.95
    bump1 = nds.new("ShaderNodeBump"); bump1.inputs["Strength"].default_value = 0.7
    lk.new(rows.outputs["Fac"], bump1.inputs["Height"])
    bump2 = nds.new("ShaderNodeBump"); bump2.inputs["Strength"].default_value = 0.25
    lk.new(stripes.outputs["Fac"], bump2.inputs["Height"]); lk.new(bump1.outputs["Normal"], bump2.inputs["Normal"])
    lk.new(bump2.outputs["Normal"], bsdf.inputs["Normal"])

def build_stone(nds, lk, bsdf):
    """Rough fieldstone — confined to the base course + chimney ONLY: brick-cell pattern, cool grey, mortar joints."""
    tc = nds.new("ShaderNodeTexCoord")
    brick = nds.new("ShaderNodeTexBrick"); brick.inputs["Scale"].default_value = 3.0
    brick.inputs["Mortar Size"].default_value = 0.02; brick.inputs["Mortar Smooth"].default_value = 0.2
    brick.inputs["Brick Width"].default_value = 0.5; brick.inputs["Row Height"].default_value = 0.25
    brick.inputs["Color1"].default_value = (0.40, 0.39, 0.35, 1); brick.inputs["Color2"].default_value = (0.52, 0.50, 0.45, 1)
    brick.inputs["Mortar"].default_value = (0.15, 0.15, 0.14, 1)
    lk.new(tc.outputs["UV"], brick.inputs["Vector"])
    lk.new(brick.outputs["Color"], bsdf.inputs["Base Color"])
    rgh = nds.new("ShaderNodeMixRGB"); rgh.inputs["Color1"].default_value = (0.8, 0.8, 0.8, 1); rgh.inputs["Color2"].default_value = (0.95, 0.95, 0.95, 1)
    lk.new(brick.outputs["Fac"], rgh.inputs["Fac"])
    lk.new(rgh.outputs["Color"], bsdf.inputs["Roughness"])
    bump = nds.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.6
    lk.new(brick.outputs["Fac"], bump.inputs["Height"])
    lk.new(bump.outputs["Normal"], bsdf.inputs["Normal"])

IMG_WALL = bake_material("Daub", build_wall)
IMG_TIMBER = bake_material("Timber", build_timber)
IMG_THATCH = bake_material("Thatch", build_thatch)
IMG_STONE = bake_material("Stone", build_stone)

MAT_WALL = tiled_material("DaubTiled", IMG_WALL, tile_m=2.2)
MAT_TIMBER = tiled_material("TimberTiled", IMG_TIMBER, tile_m=0.8)
MAT_THATCH = tiled_material("ThatchTiled", IMG_THATCH, tile_m=1.6)
MAT_STONE = tiled_material("StoneTiled", IMG_STONE, tile_m=1.2)
M_DARK = solid("Glass", (0.05, 0.06, 0.08), 0.25)
M_METAL = solid("Iron", (0.075, 0.072, 0.070), 0.4, 0.85)

# ================================================================================
# ---- dimensions (metres) ------------------------------------------------------
# ================================================================================
W, D, H, T = 6.4, 4.6, 3.0, 0.35     # footprint W x D, wall height, wall thickness
PITCH, EAVE = 2.0, 0.3                # roof rise, eaves/verge overhang
BASE_H = 0.4                          # stone base course height

# ---- half-timber helpers (defined early: window/door dressing reuse them too) ----
TIMBER_T, TIMBER_W = 0.15, 0.19  # TIMBER_T = proud depth off the wall plane, TIMBER_W = in-plane member width
TIMBER_PARTS = []

def face_pos(face, u, depth_off):
    """(x, y) on a wall face, `u` = coordinate along the wall, `depth_off` = outward offset from the true
    wall surface (positive always points AWAY from the building, regardless of which face)."""
    if face == "front": return (u, D / 2 + depth_off)
    if face == "back":  return (u, -D / 2 - depth_off)
    if face == "left":  return (-W / 2 - depth_off, u)
    if face == "right": return (W / 2 + depth_off, u)

def face_box(face, u, z, along, extent, height, mat, front_offset=0.0, name="dress"):
    """A box sitting on a wall face: `along` = in-plane size along the wall, `extent` = how far it sticks
    out from the wall (its thickness in the outward direction), `front_offset` = gap before it starts."""
    x, y = face_pos(face, u, front_offset + extent / 2.0)
    size = (along, extent, height) if face in ("front", "back") else (extent, along, height)
    o = box(name, (x, y, z), size)
    apply_tiled(o, mat)
    return o

def timber_box(name, center, size):
    o = box(name, center, size); apply_tiled(o, MAT_TIMBER); TIMBER_PARTS.append(o); return o

def vertical_stud(face, u, z0, z1):
    x, y = face_pos(face, u, TIMBER_T / 2)
    cz = (z0 + z1) / 2; h = z1 - z0
    if face in ("front", "back"): timber_box("stud", (x, y, cz), (TIMBER_W, TIMBER_T, h))
    else: timber_box("stud", (x, y, cz), (TIMBER_T, TIMBER_W, h))

def rail(face, z, u0, u1):
    x, y = face_pos(face, (u0 + u1) / 2, TIMBER_T / 2)
    length = abs(u1 - u0)
    if face in ("front", "back"): timber_box("rail", (x, y, z), (length, TIMBER_T, TIMBER_W))
    else: timber_box("rail", (x, y, z), (TIMBER_T, length, TIMBER_W))

def brace(face, u0, z0, u1, z1):
    xm, ym = face_pos(face, (u0 + u1) / 2, TIMBER_T / 2 + 0.005)
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

def window_dressing(face, u, cz, w, h):
    """Timber surround + mullion cross + a stone sill — a real crafted opening, not a bare hole."""
    bw, fe, mw = 0.10, 0.08, 0.05
    TIMBER_PARTS.append(face_box(face, u, cz + h / 2 + bw / 2, w + 2 * bw, fe, bw, MAT_TIMBER, name="winTop"))
    TIMBER_PARTS.append(face_box(face, u, cz - h / 2 - bw / 2, w + 2 * bw, fe, bw, MAT_TIMBER, name="winBot"))
    TIMBER_PARTS.append(face_box(face, u - w / 2 - bw / 2, cz, bw, fe, h, MAT_TIMBER, name="winL"))
    TIMBER_PARTS.append(face_box(face, u + w / 2 + bw / 2, cz, bw, fe, h, MAT_TIMBER, name="winR"))
    TIMBER_PARTS.append(face_box(face, u, cz, mw, fe * 0.65, h, MAT_TIMBER, name="winMullV"))
    TIMBER_PARTS.append(face_box(face, u, cz, w, fe * 0.65, mw, MAT_TIMBER, name="winMullH"))
    face_box(face, u, cz - h / 2 - bw - 0.05, w + 0.34, fe + 0.10, 0.09, MAT_STONE, name="winSill")

# ---- walls: solid block hollowed by an inner cutter, then openings -----------
walls = box("Walls", (0, 0, H / 2), (W, D, H))
inner = box("Inner", (0, 0, H / 2 + 0.2), (W - 2 * T, D - 2 * T, H))
boolean(walls, inner)

def opening(cx, cz, w, h, face, glass=True):
    if face == "front":
        boolean(walls, box("cut", (cx, D / 2, cz), (w, T * 3, h)))
        if glass:
            p = box("panel", (cx, D / 2 - T * 0.35, cz), (w * 0.85, 0.05, h * 0.85)); p.data.materials.append(M_DARK)
    elif face == "side":
        sgn = cx
        boolean(walls, box("cut", (sgn * W / 2, 0, cz), (T * 3, w, h)))
        if glass:
            p = box("panel", (sgn * (W / 2 - T * 0.35), 0, cz), (0.05, w * 0.85, h * 0.85)); p.data.materials.append(M_DARK)

# door (front, center)
DOOR_W, DOOR_H, DOOR_CZ = 1.0, 1.95, 1.05
boolean(walls, box("doorcut", (0, D / 2, DOOR_CZ), (1.1, T * 3, 2.05)))
door = box("Door", (0, D / 2 - T * 0.35, DOOR_CZ), (DOOR_W, 0.06, DOOR_H))

# windows: 2 front, 1 side — each dressed with a timber surround + sill
opening(-2.05, 1.7, 0.85, 0.9, "front"); window_dressing("front", -2.05, 1.7, 0.85, 0.9)
opening(2.05, 1.7, 0.85, 0.9, "front");  window_dressing("front", 2.05, 1.7, 0.85, 0.9)
opening(1, 1.7, 0.85, 0.9, "side");      window_dressing("right", 0, 1.7, 0.85, 0.9)

bevel(walls, 0.02, 2)
apply_tiled(walls, MAT_WALL)
apply_tiled(door, MAT_TIMBER)

# ---- door dressing: lintel/jambs, plank battens, iron strap-hinges + rivets, ring handle, threshold ----
DOOR_FACE_Y = (D / 2 - T * 0.35) - 0.03  # the door slab's outward face
dbw, dfe = 0.11, 0.09
TIMBER_PARTS.append(face_box("front", 0, DOOR_CZ + DOOR_H / 2 + dbw / 2, 1.1 + 2 * dbw, dfe, dbw, MAT_TIMBER, name="doorLintel"))
TIMBER_PARTS.append(face_box("front", -0.55 - dbw / 2, DOOR_CZ, dbw, dfe, DOOR_H, MAT_TIMBER, name="doorJambL"))
TIMBER_PARTS.append(face_box("front", 0.55 + dbw / 2, DOOR_CZ, dbw, dfe, DOOR_H, MAT_TIMBER, name="doorJambR"))

N_PLANKS = 5
plank_w = 0.92 / N_PLANKS
for i in range(N_PLANKS):
    pu = -0.46 + plank_w * (i + 0.5)
    o = box(f"doorPlank{i}", (pu, DOOR_FACE_Y - 0.028, DOOR_CZ), (plank_w * 0.78, 0.045, DOOR_H - 0.05))
    apply_tiled(o, MAT_TIMBER); TIMBER_PARTS.append(o)

for hz in (DOOR_CZ + 0.62, DOOR_CZ - 0.62):
    hstrap = box("hinge", (-0.10, DOOR_FACE_Y - 0.065, hz), (0.62, 0.025, 0.115)); hstrap.data.materials.append(M_METAL)
    for k in range(4):
        rx = -0.34 + 0.20 * k
        rivet = box("rivet", (rx, DOOR_FACE_Y - 0.078, hz), (0.045, 0.022, 0.045)); rivet.data.materials.append(M_METAL)
handle = box("handle", (0.34, DOOR_FACE_Y - 0.07, DOOR_CZ - 0.05), (0.11, 0.035, 0.11)); handle.data.materials.append(M_METAL)

threshold = box("threshold", (0, D / 2 + 0.16, 0.06), (1.34, 0.32, 0.12))
apply_tiled(threshold, MAT_STONE); bevel(threshold, 0.02, 1)

# ---- stone base course (grounding skirt) -------------------------------------
base_outer = box("BaseOuter", (0, 0, BASE_H / 2), (W + 0.08, D + 0.08, BASE_H))
base_inner = box("BaseInner", (0, 0, BASE_H / 2 + 0.05), (W - 2 * T + 0.06, D - 2 * T + 0.06, BASE_H + 0.1))
boolean(base_outer, base_inner)
apply_tiled(base_outer, MAT_STONE)
bevel(base_outer, 0.02, 1)

# ---- half-timber frame: studs + rails + corner braces on wall faces ---------
Z0, Z1 = BASE_H + 0.15, H - 0.15  # timber span between rails

# front face: corners, door flanks, X-brace either side of the door
for u in (-W / 2 + 0.15, -0.85, 0.85, W / 2 - 0.15):
    vertical_stud("front", u, Z0, Z1)
rail("front", Z1, -W / 2 + 0.1, W / 2 - 0.1)
rail("front", Z0, -W / 2 + 0.1, W / 2 - 0.1)
brace("front", -1.55, Z0, -0.85, Z1)
brace("front", 0.85, Z1, 1.55, Z0)

# back face: corners + 2 mid studs + corner-to-mid braces (symmetric with the front)
for u in (-W / 2 + 0.15, -1.2, 1.2, W / 2 - 0.15):
    vertical_stud("back", u, Z0, Z1)
rail("back", Z1, -W / 2 + 0.1, W / 2 - 0.1)
rail("back", Z0, -W / 2 + 0.1, W / 2 - 0.1)
brace("back", -W / 2 + 0.15, Z0, -1.2, Z1)
brace("back", 1.2, Z1, W / 2 - 0.15, Z0)

# side faces: corners + mid stud (right face has the window, skip a center stud there)
for u in (-D / 2 + 0.15, D / 2 - 0.15):
    vertical_stud("left", u, Z0, Z1); vertical_stud("right", u, Z0, Z1)
vertical_stud("left", 0, Z0, Z1)
rail("left", Z1, -D / 2 + 0.1, D / 2 - 0.1); rail("left", Z0, -D / 2 + 0.1, D / 2 - 0.1)
rail("right", Z1, -D / 2 + 0.1, D / 2 - 0.1); rail("right", Z0, -D / 2 + 0.1, D / 2 - 0.1)

# ---- roof: solid triangular prism (ridge along X) → fills gables, has slopes -
me = bpy.data.meshes.new("Roof"); roof = bpy.data.objects.new("Roof", me)
bpy.context.collection.objects.link(roof)
xL, xR = -(W / 2 + EAVE), (W / 2 + EAVE)
yF, yB = (D / 2 + EAVE), -(D / 2 + EAVE)
zb, zt = H - 0.05, H + PITCH
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
me.materials.append(MAT_THATCH); me.materials.append(MAT_WALL)   # 0=thatch (slopes), 1=daub (gables)
for i, f in enumerate(me.polygons):
    f.material_index = 1 if i in (0, 1) else 0
bevel(roof, 0.04, 1)

# ---- rafter tails (under the eaves) + gable bargeboards — crafted roof detail ----
def rafter_tails(y_wall, y_out, z, n):
    step = W / n
    for i in range(n):
        xu = -W / 2 + step * (i + 0.5)
        ym = (y_wall + y_out) / 2; length = abs(y_out - y_wall)
        o = box(f"rafterTail{i}", (xu, ym, z), (0.09, length, 0.09))
        apply_tiled(o, MAT_TIMBER); TIMBER_PARTS.append(o)

rafter_tails(D / 2 - 0.05, D / 2 + EAVE + 0.05, H - 0.10, 8)
rafter_tails(-D / 2 + 0.05, -D / 2 - EAVE - 0.05, H - 0.10, 8)

def bargeboard(xface, y0, z0, y1, z1, sign, name):
    length = math.hypot(y1 - y0, z1 - z0)
    ang = math.atan2(z1 - z0, y1 - y0)
    ym, zm = (y0 + y1) / 2, (z0 + z1) / 2
    xm = xface + sign * 0.05
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(xm, ym, zm))
    o = bpy.context.active_object; o.name = name
    o.scale = (0.06, length, 0.24); o.rotation_euler = (ang, 0, 0)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    apply_tiled(o, MAT_TIMBER)
    return o

TIMBER_PARTS.append(bargeboard(xL, yF, zb, 0, zt, -1, "bargeL1"))
TIMBER_PARTS.append(bargeboard(xL, yB, zb, 0, zt, -1, "bargeL2"))
TIMBER_PARTS.append(bargeboard(xR, yF, zb, 0, zt, 1, "bargeR1"))
TIMBER_PARTS.append(bargeboard(xR, yB, zb, 0, zt, 1, "bargeR2"))

# ---- chimney on the +X gable --------------------------------------------------
CHIM_BASE_Z, CHIM_H = H + PITCH * 0.55, 1.3
chim = box("Chimney", (W / 2 - 0.55, D / 2 - 0.8, CHIM_BASE_Z + CHIM_H / 2), (0.6, 0.6, CHIM_H))
apply_tiled(chim, MAT_STONE)
bevel(chim, 0.02, 1)

# ---- join every timber member into one object, then bevel for a clean edge-highlight ----
bpy.ops.object.select_all(action="DESELECT")
for o in TIMBER_PARTS: o.select_set(True)
bpy.context.view_layer.objects.active = TIMBER_PARTS[0]
bpy.ops.object.join()
TIMBER_PARTS[0].name = "TimberFrame"
bevel(TIMBER_PARTS[0], 0.015, 2)

# ---- export GLB (Y-up, embedded materials + textures) -------------------------
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_yup=True, export_apply=True)
print(f"cottage: wrote {OUT}")
