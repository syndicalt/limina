# crate-stack.py — a SET-DRESSING CRATE STACK authored in headless Blender: three rough plank
# crates (four corner posts + horizontal side planks with visible gaps + top slats, over a dark
# inset core so gaps read as shadowed interior — solid-exterior rule), stacked slightly askew,
# with a crossed rope lashing + knot on the top crate. Weathered-silver wood PBR BAKED with
# Cycles (bake_material -> DIFFUSE/ROUGHNESS/NORMAL, packed) consumed via cube-projected UVs at
# world scale (tiled_material). ~1.15 m tall, base z=0, bounds re-centered on origin at the end.
#
#   blender --background --factory-startup --python tools/blender/crate-stack.py -- --out assets/prop-crate-stack.glb

import bpy, sys, math, random
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[argv.index("--out") + 1] if "--out" in argv else "assets/prop-crate-stack.glb"
RES = 512
random.seed(7)

# ---- reset ---------------------------------------------------------------------
bpy.ops.object.select_all(action="SELECT"); bpy.ops.object.delete()
for c in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
    for d in list(c):
        try: c.remove(d)
        except Exception: pass

# ---- helpers -------------------------------------------------------------------
def boxa(name, center, size):
    """Box with location+scale BAKED (origin left at world 0) so a later object-level rotation
    spins the whole crate about its own vertical axis, not each part about itself
    (transform_apply gotcha documented in tudor-cottage.py)."""
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=center)
    o = bpy.context.active_object; o.name = name; o.scale = size
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=True)
    return o

def cyl(name, center, radius, height, verts=16, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=radius, depth=height, location=center, rotation=rotation)
    o = bpy.context.active_object; o.name = name
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=False)
    return o

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

def join_all(objs, name):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    out = bpy.context.view_layer.objects.active; out.name = name
    return out

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

def apply_tiled(obj, mat, cube_size=1.0):
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.cube_project(cube_size=cube_size, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    obj.data.materials.clear(); obj.data.materials.append(mat)

# ---- weathered silver-brown crate wood ------------------------------------------
def build_weathered(nds, lk, bsdf):
    tc = nds.new("ShaderNodeTexCoord")
    mp = nds.new("ShaderNodeMapping"); mp.inputs["Scale"].default_value = (1.0, 8.0, 1.0)
    lk.new(tc.outputs["UV"], mp.inputs["Vector"])
    wave = nds.new("ShaderNodeTexWave"); wave.wave_type = "BANDS"; wave.bands_direction = "Y"
    wave.inputs["Scale"].default_value = 7.0; wave.inputs["Distortion"].default_value = 3.0; wave.inputs["Detail"].default_value = 3.0
    lk.new(mp.outputs["Vector"], wave.inputs["Vector"])
    ramp = nds.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.30; ramp.color_ramp.elements[0].color = (0.085, 0.072, 0.056, 1)
    ramp.color_ramp.elements[1].position = 0.72; ramp.color_ramp.elements[1].color = (0.235, 0.205, 0.160, 1)
    lk.new(wave.outputs["Fac"], ramp.inputs["Fac"])
    noise = nds.new("ShaderNodeTexNoise"); noise.inputs["Scale"].default_value = 42; noise.inputs["Detail"].default_value = 5
    lk.new(tc.outputs["UV"], noise.inputs["Vector"])
    nr = nds.new("ShaderNodeValToRGB")
    nr.color_ramp.elements[0].position = 0.38; nr.color_ramp.elements[0].color = (0.68, 0.68, 0.68, 1)
    nr.color_ramp.elements[1].position = 0.62; nr.color_ramp.elements[1].color = (1, 1, 1, 1)
    lk.new(noise.outputs["Fac"], nr.inputs["Fac"])
    grain = nds.new("ShaderNodeMixRGB"); grain.blend_type = "MULTIPLY"; grain.inputs["Fac"].default_value = 0.35
    lk.new(ramp.outputs["Color"], grain.inputs["Color1"]); lk.new(nr.outputs["Color"], grain.inputs["Color2"])
    lk.new(grain.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.78
    bump = nds.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.6
    lk.new(wave.outputs["Fac"], bump.inputs["Height"])
    lk.new(bump.outputs["Normal"], bsdf.inputs["Normal"])

IMG_WOOD = bake_material("CrateWood", build_weathered)
MAT_WOOD = tiled_material("CrateWoodTiled", IMG_WOOD, tile_m=0.5)
M_DARK = solid("CrateDark", (0.030, 0.024, 0.018), 0.95, 0.0)
M_ROPE = solid("Rope", (0.50, 0.40, 0.25), 0.92, 0.0)

# ---- crate builder: parts centered on origin, base z=0 ---------------------------
POST, T, GAP = 0.055, 0.026, 0.014

def make_crate(tag, w, d, h):
    """Returns (wood_obj, core_obj) built centered at origin, base z=0."""
    wood = []
    core = boxa(f"{tag}core", (0, 0, h / 2), (w - 0.05, d - 0.05, h - 0.03))
    core.data.materials.append(M_DARK)
    for sx in (-1, 1):
        for sy in (-1, 1):
            wood.append(boxa(f"{tag}post", (sx * (w / 2 - POST / 2), sy * (d / 2 - POST / 2), h / 2),
                             (POST, POST, h)))
    # horizontal side planks, 3 rows per face, jittered
    rows = 3
    ph = (h - 0.05 - (rows - 1) * GAP) / rows
    for r in range(rows):
        zc = 0.02 + ph / 2 + r * (ph + GAP)
        for sy in (-1, 1):  # y faces: planks span x between the posts
            jl = random.uniform(-0.012, 0.006); jo = random.uniform(0.0, 0.006)
            wood.append(boxa(f"{tag}plkY", (random.uniform(-0.006, 0.006), sy * (d / 2 - T / 2 + jo), zc),
                             (w - 2 * POST + 0.02 + jl, T, ph)))
        for sx in (-1, 1):  # x faces
            jl = random.uniform(-0.012, 0.006); jo = random.uniform(0.0, 0.006)
            wood.append(boxa(f"{tag}plkX", (sx * (w / 2 - T / 2 + jo), random.uniform(-0.006, 0.006), zc),
                             (T, d - 2 * POST + 0.02 + jl, ph)))
    # top slats along y
    ns = 4
    sw = (w - 0.03 - (ns - 1) * GAP) / ns
    for s in range(ns):
        xc = -w / 2 + 0.015 + sw / 2 + s * (sw + GAP)
        wood.append(boxa(f"{tag}slat", (xc, 0, h - T / 2), (sw, d - 0.02 + random.uniform(-0.015, 0.0), T)))
    wj = join_all(wood, f"{tag}Wood")
    bevel(wj, 0.006, 1)
    apply_tiled(wj, MAT_WOOD, cube_size=0.5)
    return wj, core

def place(objs, rot_z, loc):
    for o in objs:
        bpy.ops.object.select_all(action="DESELECT")
        o.select_set(True); bpy.context.view_layer.objects.active = o
        o.rotation_euler = (0, 0, rot_z)
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
        o.location = loc
        bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)

# ---- crate A (base), crate B (stacked askew, roped), crate C (ground, leaning in) --
A = make_crate("A", 0.68, 0.66, 0.60)
place(A, math.radians(3), (0.10, 0.02, 0))

B = make_crate("B", 0.56, 0.54, 0.52)
# rope lashing on B: two crossed vertical loops + knot, built in B-local frame
RT = 0.011  # rope half-thickness
w, d, h = 0.56, 0.54, 0.52
rope = []
for axis in ("x", "y"):
    L = (w if axis == "x" else d) + 2 * RT
    if axis == "x":
        rope.append(boxa("ropeTop", (0, 0.06, h + RT), (L, 2 * RT, 2 * RT)))
        rope.append(boxa("ropeBot", (0, 0.06, -RT + 0.004), (L, 2 * RT, 2 * RT)))
        for sx in (-1, 1):
            rope.append(boxa("ropeSide", (sx * (w / 2 + RT), 0.06, h / 2), (2 * RT, 2 * RT, h + 4 * RT)))
    else:
        rope.append(boxa("ropeTop", (-0.05, 0, h + RT), (2 * RT, L, 2 * RT)))
        rope.append(boxa("ropeBot", (-0.05, 0, -RT + 0.004), (2 * RT, L, 2 * RT)))
        for sy in (-1, 1):
            rope.append(boxa("ropeSide", (-0.05, sy * (d / 2 + RT), h / 2), (2 * RT, 2 * RT, h + 4 * RT)))
knot = cyl("ropeKnot", (-0.05, 0.06, h + 0.016), 0.030, 0.026, verts=12)
rope.append(knot)
rope.append(boxa("ropeTail", (-0.05, 0.10, h - 0.05), (0.016, 0.016, 0.16)))
ropeJ = join_all(rope, "BRope")
bevel(ropeJ, 0.004, 1)
ropeJ.data.materials.append(M_ROPE)
place(list(B) + [ropeJ], math.radians(16), (0.06, -0.04, 0.60))

C = make_crate("C", 0.40, 0.40, 0.36)
place(C, math.radians(-22), (-0.48, 0.14, 0))

# ---- re-center union bounds on origin, ground at z=0 ------------------------------
bpy.context.view_layer.update()
objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
mn = [1e9] * 3; mx = [-1e9] * 3
for o in objs:
    for c in o.bound_box:
        wv = o.matrix_world @ Vector(c)
        for i in range(3):
            mn[i] = min(mn[i], wv[i]); mx[i] = max(mx[i], wv[i])
cx, cy, dz = (mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, mn[2]
for o in objs:
    o.location.x -= cx; o.location.y -= cy; o.location.z -= dz
bpy.ops.object.select_all(action="SELECT")
bpy.context.view_layer.objects.active = objs[0]
bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)

# ---- export GLB ------------------------------------------------------------------
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_yup=True, export_apply=True)
print(f"crate-stack: wrote {OUT}")
