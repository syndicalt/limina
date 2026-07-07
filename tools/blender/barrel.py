# barrel.py — a weathered OAK VILLAGE BARREL authored in headless Blender: 18 individually-built
# bulged staves (bmesh profile strips + inward solidify) with visible gaps + bevels, recessed oak
# heads top/bottom, a dark interior core so gaps read as shadow (solid-exterior rule), four flat
# iron hoop bands (boolean rings) and a side bung. Same recipe as cottage.py/well.py: PBR baked
# with Cycles procedural node graphs (bake_material -> DIFFUSE/ROUGHNESS/NORMAL, packed) consumed
# via cube-projected UVs at true world scale (tiled_material). ~0.9 m tall, base z=0, centered.
#
#   blender --background --factory-startup --python tools/blender/barrel.py -- --out assets/prop-barrel.glb

import bpy, bmesh, sys, math, random

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[argv.index("--out") + 1] if "--out" in argv else "assets/prop-barrel.glb"
RES = 512
random.seed(11)

# ---- reset ---------------------------------------------------------------------
bpy.ops.object.select_all(action="SELECT"); bpy.ops.object.delete()
for c in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
    for d in list(c):
        try: c.remove(d)
        except Exception: pass

# ---- helpers (well.py pattern) ---------------------------------------------------
def cyl(name, center, radius, height, verts=32, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=radius, depth=height, location=center, rotation=rotation)
    o = bpy.context.active_object; o.name = name
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
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

# ---- oak grain (well.py's aged oak, slightly warmed for cooperage) ---------------
def build_oak(nds, lk, bsdf):
    tc = nds.new("ShaderNodeTexCoord")
    mp = nds.new("ShaderNodeMapping"); mp.inputs["Scale"].default_value = (1.0, 8.0, 1.0)
    lk.new(tc.outputs["UV"], mp.inputs["Vector"])
    wave = nds.new("ShaderNodeTexWave"); wave.wave_type = "BANDS"; wave.bands_direction = "Y"
    wave.inputs["Scale"].default_value = 6.0; wave.inputs["Distortion"].default_value = 2.5; wave.inputs["Detail"].default_value = 3.0
    lk.new(mp.outputs["Vector"], wave.inputs["Vector"])
    ramp = nds.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.3; ramp.color_ramp.elements[0].color = (0.10, 0.060, 0.030, 1)
    ramp.color_ramp.elements[1].position = 0.7; ramp.color_ramp.elements[1].color = (0.24, 0.15, 0.080, 1)
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
    bsdf.inputs["Roughness"].default_value = 0.62
    bump = nds.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.55
    lk.new(wave.outputs["Fac"], bump.inputs["Height"])
    lk.new(bump.outputs["Normal"], bsdf.inputs["Normal"])

IMG_OAK = bake_material("Oak", build_oak)
MAT_OAK = tiled_material("OakTiled", IMG_OAK, tile_m=0.45)
# low metallic + dark base: full-metal hoops read as WHITE bands under the engine's plain env
M_IRON = solid("Iron", (0.045, 0.043, 0.042), 0.55, 0.2)
M_DARK = solid("BarrelDark", (0.028, 0.020, 0.014), 0.95, 0.0)

# ---- dimensions (metres) ---------------------------------------------------------
H, R_END, R_MID = 0.90, 0.295, 0.360
N, GAPF, THICK = 18, 0.06, 0.035

def rad(z):
    z = max(0.0, min(H, z))
    return R_END + (R_MID - R_END) * math.sin(math.pi * z / H)

# ---- staves: bmesh profile strips, per-stave jitter, solidified inward ----------
staves = []
gap_half = 0.5 * GAPF * (2 * math.pi / N)
for i in range(N):
    a0 = 2 * math.pi * i / N + gap_half
    a1 = 2 * math.pi * (i + 1) / N - gap_half
    am = (a0 + a1) / 2
    jr = random.uniform(-0.004, 0.004)             # radial weathering jitter
    ztop = H - random.uniform(0.0, 0.014)          # uneven stave tops
    zs = [0.0, 0.15, 0.30, 0.45, 0.60, 0.75, ztop]
    bm = bmesh.new(); rings = []
    for z in zs:
        r = rad(z) + jr
        ring = [bm.verts.new((r * math.cos(a), r * math.sin(a), z)) for a in (a0, am, a1)]
        rings.append(ring)
    for k in range(len(rings) - 1):
        for j in range(2):
            bm.faces.new((rings[k][j], rings[k][j + 1], rings[k + 1][j + 1], rings[k + 1][j]))
    me = bpy.data.meshes.new(f"stave{i}"); bm.to_mesh(me); bm.free()
    me.uv_layers.new(name="UVMap")
    ob = bpy.data.objects.new(f"stave{i}", me); bpy.context.collection.objects.link(ob)
    bpy.context.view_layer.objects.active = ob; ob.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    md = ob.modifiers.new("s", "SOLIDIFY"); md.thickness = THICK; md.offset = -1.0
    bpy.ops.object.modifier_apply(modifier=md.name)
    staves.append(ob)

stave_j = join_all(staves, "BarrelStaves")
bevel(stave_j, 0.005, 1)
apply_tiled(stave_j, MAT_OAK, cube_size=0.45)

# ---- dark interior core (gaps read as shadowed interior, not see-through) -------
# top must stay BELOW the top head (z 0.8275) or its black cap reads as an open mouth
core = cyl("BarrelCore", (0, 0, 0.42), R_END - 0.035, 0.80, verts=24)
core.data.materials.append(M_DARK)

# ---- heads (recessed oak lids top + bottom) --------------------------------------
for z, nm in ((H - 0.055, "HeadTop"), (0.055, "HeadBot")):
    head = cyl(nm, (0, 0, z), rad(z) - THICK + 0.012, 0.035, verts=28)
    bevel(head, 0.004, 1)
    apply_tiled(head, MAT_OAK, cube_size=0.30)

# ---- iron hoops: flat bands (boolean rings) hugging the bulge --------------------
for z in (0.10, 0.32, 0.58, 0.80):
    band = cyl("hoop", (0, 0, z), rad(z) + 0.011, 0.05, verts=36)
    cut = cyl("hoopCut", (0, 0, z), rad(z) - 0.018, 0.2, verts=36)
    boolean(band, cut)
    bevel(band, 0.003, 1)
    # the EXACT boolean leaves an EMPTY material slot 0 (from the cutter); faces index slot 0,
    # so append() alone lands the iron in an unused slot 1 → exports material-less (white)
    band.data.materials.clear()
    band.data.materials.append(M_IRON)

# ---- bung plug on one flank ------------------------------------------------------
bz = 0.55; br = rad(bz)
bung = cyl("Bung", (br * math.cos(0.17) , br * math.sin(0.17), bz), 0.027, 0.05, verts=12,
           rotation=(0, math.pi / 2, 0.17))
apply_tiled(bung, MAT_OAK, cube_size=0.1)

# ---- export GLB ------------------------------------------------------------------
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_yup=True, export_apply=True)
print(f"barrel: wrote {OUT}")
