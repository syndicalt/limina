# signpost.py — a LEANING WOODEN SIGNPOST authored in headless Blender: a rough-hewn tapered
# post (9-sided, leaning ~6 degrees) carrying two arrow-ended direction boards pointing
# opposite ways, each with a shallow GEOMETRY-INSET blank panel (boolean recess) on both faces
# so the sign reads carved at gameplay distance; iron cap band + bolt heads, and a few
# fieldstones packed at the foot to seat the lean. Weathered wood PBR BAKED with Cycles
# (bake_material -> DIFFUSE/ROUGHNESS/NORMAL, packed) via cube-projected world-scale UVs
# (tiled_material). ~2.4 m tall, base z=0, bounds re-centered on origin at the end.
#
#   blender --background --factory-startup --python tools/blender/signpost.py -- --out assets/prop-signpost.glb

import bpy, bmesh, sys, math, random
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[argv.index("--out") + 1] if "--out" in argv else "assets/prop-signpost.glb"
RES = 512
random.seed(5)

# ---- reset ---------------------------------------------------------------------
bpy.ops.object.select_all(action="SELECT"); bpy.ops.object.delete()
for c in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
    for d in list(c):
        try: c.remove(d)
        except Exception: pass

# ---- helpers -------------------------------------------------------------------
def boxa(name, center, size):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=center)
    o = bpy.context.active_object; o.name = name; o.scale = size
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=True)
    return o

def cone(name, center, r1, r2, height, verts=24, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r1, radius2=r2, depth=height, location=center, rotation=rotation)
    o = bpy.context.active_object; o.name = name
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=False)
    return o

def cyl(name, center, radius, height, verts=16, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=radius, depth=height, location=center, rotation=rotation)
    o = bpy.context.active_object; o.name = name
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=False)
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

# ---- weathered roadside wood ------------------------------------------------------
def build_weathered(nds, lk, bsdf):
    tc = nds.new("ShaderNodeTexCoord")
    mp = nds.new("ShaderNodeMapping"); mp.inputs["Scale"].default_value = (1.0, 8.0, 1.0)
    lk.new(tc.outputs["UV"], mp.inputs["Vector"])
    wave = nds.new("ShaderNodeTexWave"); wave.wave_type = "BANDS"; wave.bands_direction = "Y"
    wave.inputs["Scale"].default_value = 6.5; wave.inputs["Distortion"].default_value = 3.2; wave.inputs["Detail"].default_value = 3.0
    lk.new(mp.outputs["Vector"], wave.inputs["Vector"])
    ramp = nds.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.30; ramp.color_ramp.elements[0].color = (0.078, 0.066, 0.052, 1)
    ramp.color_ramp.elements[1].position = 0.72; ramp.color_ramp.elements[1].color = (0.215, 0.190, 0.150, 1)
    lk.new(wave.outputs["Fac"], ramp.inputs["Fac"])
    noise = nds.new("ShaderNodeTexNoise"); noise.inputs["Scale"].default_value = 40; noise.inputs["Detail"].default_value = 5
    lk.new(tc.outputs["UV"], noise.inputs["Vector"])
    nr = nds.new("ShaderNodeValToRGB")
    nr.color_ramp.elements[0].position = 0.38; nr.color_ramp.elements[0].color = (0.66, 0.66, 0.66, 1)
    nr.color_ramp.elements[1].position = 0.62; nr.color_ramp.elements[1].color = (1, 1, 1, 1)
    lk.new(noise.outputs["Fac"], nr.inputs["Fac"])
    grain = nds.new("ShaderNodeMixRGB"); grain.blend_type = "MULTIPLY"; grain.inputs["Fac"].default_value = 0.35
    lk.new(ramp.outputs["Color"], grain.inputs["Color1"]); lk.new(nr.outputs["Color"], grain.inputs["Color2"])
    lk.new(grain.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.80
    bump = nds.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.6
    lk.new(wave.outputs["Fac"], bump.inputs["Height"])
    lk.new(bump.outputs["Normal"], bsdf.inputs["Normal"])

IMG_WOOD = bake_material("SignWood", build_weathered)
MAT_WOOD = tiled_material("SignWoodTiled", IMG_WOOD, tile_m=0.5)
# low metallic + dark base: full-metal reads as WHITE under the engine's plain env
M_IRON = solid("Iron", (0.045, 0.043, 0.042), 0.55, 0.2)
M_STONE = solid("FootStone", (0.105, 0.100, 0.090), 0.95, 0.0)

# ---- post (tapered, rough 9-gon) + boards, built vertical then leaned -------------
H = 2.38
WOOD = []
post = cone("Post", (0, 0, H / 2), 0.085, 0.062, H, verts=9)
WOOD.append(post)

def board(name, L, hgt, thick, z, rot_z):
    """Arrow-ended direction board pointing +x from the post, with inset blank panels."""
    bm = bmesh.new()
    pts = [(-0.06, -hgt / 2), (-0.06, hgt / 2), (L - 0.13, hgt / 2), (L, 0), (L - 0.13, -hgt / 2)]
    top = [bm.verts.new((x, thick / 2, zz)) for (x, zz) in pts]
    bot = [bm.verts.new((x, -thick / 2, zz)) for (x, zz) in pts]
    bm.faces.new(top); bm.faces.new(list(reversed(bot)))
    n = len(pts)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((top[i], top[j], bot[j], bot[i]))
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    me.uv_layers.new(name="UVMap")
    ob = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(ob)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.select_all(action="DESELECT"); ob.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    # carved-looking blank panel: shallow boolean recess on BOTH faces
    for sy in (-1, 1):
        cut = boxa("panelCut", (L * 0.40, sy * (thick / 2 + 0.002), 0), (L * 0.62, 0.012, hgt * 0.55))
        boolean(ob, cut)
    bevel(ob, 0.006, 1)
    # raise to height + swing around the post
    ob.rotation_euler = (0, 0, rot_z)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    ob.location = (0, 0, z)
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
    return ob

WOOD.append(board("BoardA", 0.92, 0.20, 0.042, 2.02, math.radians(18)))
WOOD.append(board("BoardB", 0.80, 0.19, 0.042, 1.70, math.radians(196)))

wood_j = join_all(WOOD, "SignWoodJ")
apply_tiled(wood_j, MAT_WOOD, cube_size=0.5)

# iron: cap band near the top + a bolt head at each board root (follow the lean with the wood)
IRON = []
band = cyl("CapBand", (0, 0, 2.30), 0.078, 0.045, verts=18)
cutc = cyl("bandCut", (0, 0, 2.30), 0.052, 0.2, verts=18)
boolean(band, cutc)
IRON.append(band)
for z, a in ((2.02, math.radians(18)), (1.70, math.radians(196))):
    IRON.append(cyl("Bolt", (0.088 * math.cos(a), 0.088 * math.sin(a), z), 0.016, 0.03, verts=10,
                    rotation=(0, math.pi / 2, a)))
iron_j = join_all(IRON, "SignIron")
# the boolean'd band carries an EMPTY slot 0 into the join; clear or the iron lands unused
iron_j.data.materials.clear()
iron_j.data.materials.append(M_IRON)

# ---- lean the whole sign ~6 degrees, then re-seat on the ground -------------------
LEAN = math.radians(6)
for o in (wood_j, iron_j):
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True); bpy.context.view_layer.objects.active = o
    o.rotation_euler = (0, LEAN, 0)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)

# ---- fieldstones packed at the foot (hide the leaned base seam) -------------------
base_x = 0.0  # post origin is at world 0; the lean pivots there, base stays near x~0
for k in range(5):
    a = k * 2 * math.pi / 5 + random.uniform(-0.3, 0.3)
    rr = random.uniform(0.10, 0.16)
    r = random.uniform(0.065, 0.10)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=r,
                                          location=(base_x + rr * math.cos(a), rr * math.sin(a), r * 0.45))
    rock = bpy.context.active_object; rock.name = f"rock{k}"
    rock.scale = (1.0, random.uniform(0.8, 1.2), 0.62)
    rock.rotation_euler = (0, 0, random.uniform(0, math.pi))
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    rock.data.materials.append(M_STONE)

# ---- re-center bounds on origin (x/y), ground min-z at 0 --------------------------
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
print(f"signpost: wrote {OUT}")
