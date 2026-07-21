# fence-section.py — a 3 m POST-AND-RAIL FENCE SECTION authored in headless Blender: two
# rough-hewn square posts (heavy bevel, pyramid-weathered tops, slight z jitter) set INSIDE the
# section ends at x=±1.35, and two tapered octagonal rails spanning the FULL 3 m (x -1.5..+1.5)
# so sections tile end-to-end with rail ends butting flush and no doubled coincident posts
# (adjacent posts sit 0.3 m apart at the joint, reading as a paired joint post). Wooden pegs at
# each crossing. Weathered wood PBR BAKED with Cycles (bake_material -> DIFFUSE/ROUGHNESS/NORMAL,
# packed) via cube-projected world-scale UVs (tiled_material). ~1.2 m tall, base z=0, centered.
#
#   blender --background --factory-startup --python tools/blender/fence-section.py -- --out assets/prop-fence-section.glb

import bpy, sys, math, random

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[argv.index("--out") + 1] if "--out" in argv else "assets/prop-fence-section.glb"
RES = 512
random.seed(3)

# ---- reset ---------------------------------------------------------------------
bpy.ops.object.select_all(action="SELECT"); bpy.ops.object.delete()
for c in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
    for d in list(c):
        try: c.remove(d)
        except Exception: pass

# ---- helpers -------------------------------------------------------------------
def boxa(name, center, size, rot_z=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=center)
    o = bpy.context.active_object; o.name = name
    o.scale = size; o.rotation_euler = (0, 0, rot_z)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
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

def bevel(o, w=0.02, s=1):
    bpy.context.view_layer.objects.active = o
    md = o.modifiers.new("bv", "BEVEL"); md.width = w; md.segments = s; md.limit_method = "ANGLE"
    bpy.ops.object.modifier_apply(modifier=md.name)

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

# ---- weathered split-rail wood ----------------------------------------------------
def build_weathered(nds, lk, bsdf):
    tc = nds.new("ShaderNodeTexCoord")
    mp = nds.new("ShaderNodeMapping"); mp.inputs["Scale"].default_value = (1.0, 8.0, 1.0)
    lk.new(tc.outputs["UV"], mp.inputs["Vector"])
    wave = nds.new("ShaderNodeTexWave"); wave.wave_type = "BANDS"; wave.bands_direction = "Y"
    wave.inputs["Scale"].default_value = 6.0; wave.inputs["Distortion"].default_value = 3.4; wave.inputs["Detail"].default_value = 3.0
    lk.new(mp.outputs["Vector"], wave.inputs["Vector"])
    ramp = nds.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.30; ramp.color_ramp.elements[0].color = (0.088, 0.078, 0.064, 1)
    ramp.color_ramp.elements[1].position = 0.72; ramp.color_ramp.elements[1].color = (0.240, 0.215, 0.175, 1)
    lk.new(wave.outputs["Fac"], ramp.inputs["Fac"])
    noise = nds.new("ShaderNodeTexNoise"); noise.inputs["Scale"].default_value = 38; noise.inputs["Detail"].default_value = 5
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

IMG_WOOD = bake_material("FenceWood", build_weathered)
MAT_WOOD = tiled_material("FenceWoodTiled", IMG_WOOD, tile_m=0.5)

# ---- dimensions (metres) — TILING CONTRACT: rails span exactly x=-1.5..+1.5 -------
LEN, POST_X, POST_S, POST_H = 3.0, 1.35, 0.135, 1.18
RAIL_Z = (0.56, 0.97)

PARTS = []

# posts: rough square timbers, slight z-rotation jitter, pyramid-weathered top
for sx in (-1, 1):
    jz = math.radians(random.uniform(-2.5, 2.5))
    p = boxa("post", (sx * POST_X, 0, POST_H / 2), (POST_S, POST_S, POST_H), rot_z=jz)
    bevel(p, 0.020, 2)
    cap = cone("postCap", (sx * POST_X, 0, POST_H + 0.028), POST_S * 0.62, 0.012, 0.075,
               verts=4, rotation=(0, 0, jz + math.pi / 4))
    bevel(cap, 0.008, 1)
    PARTS += [p, cap]

# rails: tapered octagonal timbers spanning the FULL 3 m so tiled sections butt flush.
# End radii are FIXED (no jitter) so neighbouring sections' rail ends match exactly.
for i, rz in enumerate(RAIL_Z):
    r1, r2 = (0.062, 0.050) if i == 0 else (0.050, 0.062)   # alternate taper direction
    rail = cone(f"rail{i}", (0, 0, rz), r1, r2, LEN, verts=8,
                rotation=(0, math.pi / 2, 0))
    bevel(rail, 0.006, 1)
    PARTS.append(rail)

# pegs at each post/rail crossing (poke through both faces)
for sx in (-1, 1):
    for rz in RAIL_Z:
        peg = cyl("peg", (sx * POST_X, 0, rz + 0.012), 0.017, 0.24, verts=10,
                  rotation=(math.pi / 2, 0, 0))
        bevel(peg, 0.004, 1)
        PARTS.append(peg)

fence = join_all(PARTS, "FenceSection")
apply_tiled(fence, MAT_WOOD, cube_size=0.5)

# ---- export GLB ------------------------------------------------------------------
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_yup=True, export_apply=True)
print(f"fence-section: wrote {OUT}")
