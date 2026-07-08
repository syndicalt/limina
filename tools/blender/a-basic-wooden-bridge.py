# a-basic-wooden-bridge.py — a BASIC WOODEN FOOTBRIDGE authored in headless Blender: two gently
# arched stringer beams (bmesh loft, 0.20 m camber over the 6 m span) resting on squared ground
# sills, a deck of 25 individually-jittered transverse planks that follow the camber, side curbs,
# five railing posts per side with pyramid-weathered caps, and hand/mid rails segmented post-to-post
# so the railing follows the arc. Iron nail heads pin each plank over the stringers.
# Two REAL baked wood materials (Cycles DIFFUSE/ROUGHNESS/NORMAL -> packed images, cube-projected
# world-scale UVs): silvery weathered deck planks (grain along the plank), warmer dark-oak frame.
# ~6.0 x 2.0 m, rail top ~1.8 m, base z=0, centered on origin, span along X.
#
#   blender --background --factory-startup --python tools/blender/a-basic-wooden-bridge.py -- --out assets/a-basic-wooden-bridge.glb

import bpy, bmesh, sys, math, random

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[argv.index("--out") + 1] if "--out" in argv else "assets/a-basic-wooden-bridge.glb"
RES = 512
random.seed(11)

# ---- reset ---------------------------------------------------------------------
bpy.ops.object.select_all(action="SELECT"); bpy.ops.object.delete()
for c in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
    for d in list(c):
        try: c.remove(d)
        except Exception: pass

# ---- helpers -------------------------------------------------------------------
def boxa(name, center, size, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=center)
    o = bpy.context.active_object; o.name = name
    o.scale = size; o.rotation_euler = rot
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return o

def cone(name, center, r1, r2, height, verts=24, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r1, radius2=r2, depth=height, location=center, rotation=rotation)
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

def solid(name, rgb, rough=0.85, metal=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1.0)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    return m

# ---- texture baking (bake a procedural node-graph to a real IMAGE, then pack it) ----
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
# ---- material node graphs ------------------------------------------------------
# ================================================================================

def build_deck_wood(nds, lk, bsdf):
    """Silvery weathered deck planks: grain lines run along texture V (= world Y on the deck top
    via cube projection, i.e. along each plank), plus fine elongated streaks and sun-bleached
    patches so 25 planks don't read as one uniform slab."""
    tc = nds.new("ShaderNodeTexCoord")
    mp = nds.new("ShaderNodeMapping"); mp.inputs["Scale"].default_value = (1.0, 1.0, 1.0)
    lk.new(tc.outputs["UV"], mp.inputs["Vector"])
    # grain must stay mostly STRAIGHT along the plank — at Distortion 3.6 / high ramp contrast the
    # deck read as wavy zebra stripes on the GPU QC render, not wood
    wave = nds.new("ShaderNodeTexWave"); wave.wave_type = "BANDS"; wave.bands_direction = "X"
    wave.inputs["Scale"].default_value = 6.5; wave.inputs["Distortion"].default_value = 1.4; wave.inputs["Detail"].default_value = 2.0
    lk.new(mp.outputs["Vector"], wave.inputs["Vector"])
    ramp = nds.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.24; ramp.color_ramp.elements[0].color = (0.205, 0.172, 0.132, 1)
    ramp.color_ramp.elements[1].position = 0.76; ramp.color_ramp.elements[1].color = (0.300, 0.258, 0.202, 1)
    lk.new(wave.outputs["Fac"], ramp.inputs["Fac"])
    # fine streaks elongated along the grain (compressed X, stretched Y) — kept LOW contrast and
    # irregular: at high contrast this banding read as corduroy/ribbing on plank ends, not wood
    mp2 = nds.new("ShaderNodeMapping"); mp2.inputs["Scale"].default_value = (18.0, 2.2, 2.2)
    lk.new(tc.outputs["UV"], mp2.inputs["Vector"])
    noise = nds.new("ShaderNodeTexNoise"); noise.inputs["Scale"].default_value = 1.0; noise.inputs["Detail"].default_value = 5
    lk.new(mp2.outputs["Vector"], noise.inputs["Vector"])
    nr = nds.new("ShaderNodeValToRGB")
    nr.color_ramp.elements[0].position = 0.32; nr.color_ramp.elements[0].color = (0.78, 0.78, 0.78, 1)
    nr.color_ramp.elements[1].position = 0.68; nr.color_ramp.elements[1].color = (1, 1, 1, 1)
    lk.new(noise.outputs["Fac"], nr.inputs["Fac"])
    grain = nds.new("ShaderNodeMixRGB"); grain.blend_type = "MULTIPLY"; grain.inputs["Fac"].default_value = 0.18
    lk.new(ramp.outputs["Color"], grain.inputs["Color1"]); lk.new(nr.outputs["Color"], grain.inputs["Color2"])
    # broad sun-bleach / damp patches
    patch = nds.new("ShaderNodeTexNoise"); patch.inputs["Scale"].default_value = 2.6; patch.inputs["Detail"].default_value = 4
    lk.new(tc.outputs["UV"], patch.inputs["Vector"])
    pr = nds.new("ShaderNodeValToRGB")
    pr.color_ramp.elements[0].position = 0.40; pr.color_ramp.elements[0].color = (0.86, 0.86, 0.84, 1)
    pr.color_ramp.elements[1].position = 0.62; pr.color_ramp.elements[1].color = (1.03, 1.03, 1.02, 1)
    lk.new(patch.outputs["Fac"], pr.inputs["Fac"])
    patched = nds.new("ShaderNodeMixRGB"); patched.blend_type = "MULTIPLY"; patched.inputs["Fac"].default_value = 0.32
    lk.new(grain.outputs["Color"], patched.inputs["Color1"]); lk.new(pr.outputs["Color"], patched.inputs["Color2"])
    lk.new(patched.outputs["Color"], bsdf.inputs["Base Color"])
    rgh = nds.new("ShaderNodeValToRGB")
    rgh.color_ramp.elements[0].position = 0.3; rgh.color_ramp.elements[0].color = (0.62, 0.62, 0.62, 1)
    rgh.color_ramp.elements[1].position = 0.7; rgh.color_ramp.elements[1].color = (0.86, 0.86, 0.86, 1)
    lk.new(wave.outputs["Fac"], rgh.inputs["Fac"])
    lk.new(rgh.outputs["Color"], bsdf.inputs["Roughness"])
    bump = nds.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.22
    lk.new(wave.outputs["Fac"], bump.inputs["Height"])
    bump2 = nds.new("ShaderNodeBump"); bump2.inputs["Strength"].default_value = 0.08
    lk.new(noise.outputs["Fac"], bump2.inputs["Height"]); lk.new(bump.outputs["Normal"], bump2.inputs["Normal"])
    lk.new(bump2.outputs["Normal"], bsdf.inputs["Normal"])

def build_oak_frame(nds, lk, bsdf):
    """Warm dark-oak structural timber (stringers/posts/rails/sills): mid-brown, heavier grain
    relief than the deck, distorted enough to read as wood on members running any direction."""
    tc = nds.new("ShaderNodeTexCoord")
    mp = nds.new("ShaderNodeMapping"); mp.inputs["Scale"].default_value = (1.0, 6.0, 1.0)
    lk.new(tc.outputs["UV"], mp.inputs["Vector"])
    wave = nds.new("ShaderNodeTexWave"); wave.wave_type = "BANDS"; wave.bands_direction = "Y"
    wave.inputs["Scale"].default_value = 7.0; wave.inputs["Distortion"].default_value = 3.2; wave.inputs["Detail"].default_value = 3.0
    lk.new(mp.outputs["Vector"], wave.inputs["Vector"])
    ramp = nds.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.30; ramp.color_ramp.elements[0].color = (0.082, 0.052, 0.028, 1)
    ramp.color_ramp.elements[1].position = 0.72; ramp.color_ramp.elements[1].color = (0.225, 0.148, 0.082, 1)
    lk.new(wave.outputs["Fac"], ramp.inputs["Fac"])
    noise = nds.new("ShaderNodeTexNoise"); noise.inputs["Scale"].default_value = 36; noise.inputs["Detail"].default_value = 5
    lk.new(tc.outputs["UV"], noise.inputs["Vector"])
    nr = nds.new("ShaderNodeValToRGB")
    nr.color_ramp.elements[0].position = 0.38; nr.color_ramp.elements[0].color = (0.66, 0.66, 0.66, 1)
    nr.color_ramp.elements[1].position = 0.62; nr.color_ramp.elements[1].color = (1, 1, 1, 1)
    lk.new(noise.outputs["Fac"], nr.inputs["Fac"])
    grain = nds.new("ShaderNodeMixRGB"); grain.blend_type = "MULTIPLY"; grain.inputs["Fac"].default_value = 0.32
    lk.new(ramp.outputs["Color"], grain.inputs["Color1"]); lk.new(nr.outputs["Color"], grain.inputs["Color2"])
    lk.new(grain.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.68
    bump = nds.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.55
    lk.new(wave.outputs["Fac"], bump.inputs["Height"])
    lk.new(bump.outputs["Normal"], bsdf.inputs["Normal"])

IMG_DECK = bake_material("BridgeDeck", build_deck_wood)
IMG_OAK = bake_material("BridgeOak", build_oak_frame)
MAT_DECK = tiled_material("BridgeDeckTiled", IMG_DECK, tile_m=0.7)
MAT_OAK = tiled_material("BridgeOakTiled", IMG_OAK, tile_m=0.6)
M_IRON = solid("Iron", (0.08, 0.075, 0.07), 0.68, 0.55)  # rough/half-metal: full metallic nail heads mirror the sky and read as blue specks

# ================================================================================
# ---- dimensions (metres) -------------------------------------------------------
# ================================================================================
HALF = 3.0            # half-span along X (total 6.0)
DECK_W = 2.0          # plank length along Y
RISE = 0.20           # camber at mid-span
END_Z = 0.56          # stringer top at the ends
STR_D, STR_T, STR_Y = 0.30, 0.16, 0.78   # stringer depth, thickness, centreline |y|
PLANK_T = 0.055
POST_S, RAIL_H, MID_H = 0.105, 1.01, 0.55  # post square, hand/mid rail centre above deck line
POST_XS = [-2.75, -1.375, 0.0, 1.375, 2.75]
POST_Y = 0.92

def arc_top(x):
    """Stringer-top / deck-underside line: gentle parabolic camber."""
    return END_Z + RISE * (1.0 - (x / HALF) ** 2)

def arc_slope(x):
    return -2.0 * RISE * x / (HALF ** 2)

OAK_PARTS, DECK_PARTS, IRON_PARTS = [], [], []

# ---- stringers: lofted beams following the camber ------------------------------
def lofted_stringer(name, y0, y1, segs=24):
    me = bpy.data.meshes.new(name); ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    bm = bmesh.new()
    rings = []
    for i in range(segs + 1):
        x = -HALF + (2.0 * HALF) * i / segs
        zt = arc_top(x); zb = zt - STR_D
        rings.append([bm.verts.new((x, y0, zb)), bm.verts.new((x, y1, zb)),
                      bm.verts.new((x, y1, zt)), bm.verts.new((x, y0, zt))])
    for a, b in zip(rings, rings[1:]):
        for k in range(4):
            bm.faces.new((a[k], a[(k + 1) % 4], b[(k + 1) % 4], b[k]))
    bm.faces.new(rings[0]); bm.faces.new(tuple(reversed(rings[-1])))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me); bm.free()
    me.uv_layers.new(name="UVMap")
    return ob

for sy in (-1, 1):
    OAK_PARTS.append(lofted_stringer(f"stringer{sy}", sy * STR_Y - STR_T / 2, sy * STR_Y + STR_T / 2))

# ---- ground sills under the stringer ends (they take the bridge to z=0) --------
for sx in (-1, 1):
    top = arc_top(sx * HALF) - STR_D          # 0.26: stringer underside at the ends
    sill = boxa("sill", (sx * 2.86, 0, top / 2), (0.28, DECK_W + 0.15, top))
    bevel(sill, 0.025, 2)
    OAK_PARTS.append(sill)

# ---- deck planks: transverse, jittered, following the camber -------------------
N_PLANKS, STEP = 25, 0.24
for i in range(N_PLANKS):
    x = -HALF + STEP * (i + 0.5)
    w = 0.215 + random.uniform(-0.008, 0.008)
    ln = DECK_W + random.uniform(-0.035, 0.01)
    tilt = -math.atan(arc_slope(x))
    zrot = math.radians(random.uniform(-0.7, 0.7))
    p = boxa(f"plank{i}", (x, random.uniform(-0.015, 0.015), arc_top(x) + PLANK_T / 2),
             (w, ln, PLANK_T), rot=(0, tilt, zrot))
    bevel(p, 0.008, 1)
    DECK_PARTS.append(p)
    # iron nail heads where the plank crosses each stringer
    for sy in (-1, 1):
        nail = boxa("nail", (x, sy * (STR_Y - 0.04), arc_top(x) + PLANK_T + 0.004),
                    (0.024, 0.024, 0.016), rot=(0, tilt, zrot))
        IRON_PARTS.append(nail)

# ---- curbs: low edge boards on the deck, segmented between posts ----------------
def seg_beam(name, x0, x1, z_of, size_y, size_z, y, extend=0.06):
    z0, z1 = z_of(x0), z_of(x1)
    dx, dz = x1 - x0, z1 - z0
    ln = math.hypot(dx, dz) + extend
    o = boxa(name, ((x0 + x1) / 2, y, (z0 + z1) / 2), (ln, size_y, size_z),
             rot=(0, -math.atan2(dz, dx), 0))
    bevel(o, 0.008, 1)
    return o

for sy in (-1, 1):
    for a, b in zip(POST_XS, POST_XS[1:]):
        OAK_PARTS.append(seg_beam("curb", a, b, lambda x: arc_top(x) + PLANK_T + 0.05,
                                  0.055, 0.10, sy * POST_Y, extend=0.10))

# ---- railing: posts + pyramid caps + hand/mid rails following the arc -----------
for sy in (-1, 1):
    for px in POST_XS:
        base = arc_top(px)                     # embedded through the plank onto the stringer line
        h = 1.06
        jz = math.radians(random.uniform(-1.5, 1.5))
        post = boxa("post", (px, sy * POST_Y, base + h / 2), (POST_S, POST_S, h), rot=(0, 0, jz))
        bevel(post, 0.012, 2)
        cap = cone("postCap", (px, sy * POST_Y, base + h + 0.026), POST_S * 0.66, 0.011, 0.07,
                   verts=4, rotation=(0, 0, jz + math.pi / 4))
        bevel(cap, 0.006, 1)
        OAK_PARTS += [post, cap]
    for a, b in zip(POST_XS, POST_XS[1:]):
        OAK_PARTS.append(seg_beam("handrail", a, b, lambda x: arc_top(x) + RAIL_H,
                                  0.115, 0.065, sy * POST_Y, extend=0.11))
        OAK_PARTS.append(seg_beam("midrail", a, b, lambda x: arc_top(x) + MID_H,
                                  0.075, 0.05, sy * POST_Y, extend=0.11))

# ---- join by material, project UVs, export --------------------------------------
frame = join_all(OAK_PARTS, "BridgeFrame")
apply_tiled(frame, MAT_OAK)
deck = join_all(DECK_PARTS, "BridgeDeck")
apply_tiled(deck, MAT_DECK)
nails = join_all(IRON_PARTS, "BridgeNails")
nails.data.materials.clear(); nails.data.materials.append(M_IRON)

bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_yup=True, export_apply=True)
print(f"a-basic-wooden-bridge: wrote {OUT}")
