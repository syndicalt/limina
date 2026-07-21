# well.py — a medieval STONE VILLAGE WELL authored in headless Blender: fieldstone cylindrical shaft
# (hollow, open mouth), two oak posts, a timber header + wood-shingle gable canopy, and a working-looking
# timber winch (roller/axle + iron brackets + crank + rope) with a bonus hanging bucket. Same recipe as
# cottage.py/watchtower.py: PBR textures BAKED with Cycles procedural node graphs (bake_material() ->
# DIFFUSE/ROUGHNESS/NORMAL passes, packed images), consumed via cube-projected UVs tiled at true world
# scale (tiled_material()) — no flat Principled colors. The build agent authors this as a whole GLB the
# engine only CONSUMES. Non-Adobe end to end.
#
#   blender --background --factory-startup --python tools/blender/well.py -- --out assets/stone-well.glb

import bpy, bmesh, sys, math

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[argv.index("--out") + 1] if "--out" in argv else "assets/stone-well.glb"
RES = 512

# ---- reset ---------------------------------------------------------------------
bpy.ops.object.select_all(action="SELECT"); bpy.ops.object.delete()
for c in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
    for d in list(c):
        try: c.remove(d)
        except Exception: pass

# ---- geometry helpers ------------------------------------------------------------
def box(name, center, size):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=center)
    o = bpy.context.active_object; o.name = name; o.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return o

def cyl(name, center, radius, height, verts=32, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=radius, depth=height, location=center, rotation=rotation)
    o = bpy.context.active_object; o.name = name
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    return o

def cone(name, center, r1, r2, height, verts=24, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r1, radius2=r2, depth=height, location=center, rotation=rotation)
    o = bpy.context.active_object; o.name = name
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    return o

def torus(name, center, major_r, minor_r, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(location=center, major_radius=major_r, minor_radius=minor_r, rotation=rotation,
                                      major_segments=28, minor_segments=10)
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

def apply_tiled(obj, mat, cube_size=1.0):
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.cube_project(cube_size=cube_size, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    obj.data.materials.clear(); obj.data.materials.append(mat)

# ================================================================================
# ---- material node graphs -----------------------------------------------------
# ================================================================================

def build_fieldstone(nds, lk, bsdf):
    """Rough weathered fieldstone: irregular brick-cell coursing + voronoi per-stone tint + weathering
    stains + strong cavity bump — reads as rugged stacked fieldstone, not cut ashlar."""
    tc = nds.new("ShaderNodeTexCoord")
    warpn = nds.new("ShaderNodeTexNoise"); warpn.inputs["Scale"].default_value = 5.0; warpn.inputs["Detail"].default_value = 3.0
    lk.new(tc.outputs["UV"], warpn.inputs["Vector"])
    wsc = nds.new("ShaderNodeVectorMath"); wsc.operation = "SCALE"; wsc.inputs["Scale"].default_value = 0.06
    lk.new(warpn.outputs["Color"], wsc.inputs[0])
    warp = nds.new("ShaderNodeVectorMath"); warp.operation = "ADD"
    lk.new(tc.outputs["UV"], warp.inputs[0]); lk.new(wsc.outputs["Vector"], warp.inputs[1])
    WV = warp.outputs["Vector"]

    brick = nds.new("ShaderNodeTexBrick"); brick.inputs["Scale"].default_value = 3.4
    brick.inputs["Mortar Size"].default_value = 0.035; brick.inputs["Mortar Smooth"].default_value = 0.25
    brick.inputs["Brick Width"].default_value = 0.55; brick.inputs["Row Height"].default_value = 0.30
    brick.inputs["Color1"].default_value = (0.42, 0.40, 0.35, 1); brick.inputs["Color2"].default_value = (0.54, 0.51, 0.45, 1)
    brick.inputs["Mortar"].default_value = (0.14, 0.13, 0.12, 1)
    lk.new(WV, brick.inputs["Vector"]); fac = brick.outputs["Fac"]

    cells = nds.new("ShaderNodeTexVoronoi"); cells.inputs["Scale"].default_value = 4.5
    lk.new(WV, cells.inputs["Vector"])
    cellv = nds.new("ShaderNodeRGBToBW"); lk.new(cells.outputs["Color"], cellv.inputs["Color"])
    cmap = nds.new("ShaderNodeMapRange"); lk.new(cellv.outputs["Val"], cmap.inputs["Value"])
    cmap.inputs["To Min"].default_value = 0.75; cmap.inputs["To Max"].default_value = 1.12

    weath = nds.new("ShaderNodeTexNoise"); weath.inputs["Scale"].default_value = 2.2; weath.inputs["Detail"].default_value = 8
    lk.new(WV, weath.inputs["Vector"])
    stain = nds.new("ShaderNodeValToRGB")
    stain.color_ramp.elements[0].position = 0.4; stain.color_ramp.elements[0].color = (0.30, 0.32, 0.24, 1)
    stain.color_ramp.elements[1].position = 0.78; stain.color_ramp.elements[1].color = (1, 1, 1, 1)
    lk.new(weath.outputs["Fac"], stain.inputs["Fac"])

    tint = nds.new("ShaderNodeMixRGB"); tint.blend_type = "MULTIPLY"; tint.inputs["Fac"].default_value = 1.0
    lk.new(brick.outputs["Color"], tint.inputs["Color1"]); lk.new(cmap.outputs["Result"], tint.inputs["Color2"])
    grime = nds.new("ShaderNodeMixRGB"); grime.blend_type = "MULTIPLY"
    lk.new(stain.outputs["Color"], grime.inputs["Fac"])
    lk.new(tint.outputs["Color"], grime.inputs["Color1"]); grime.inputs["Color2"].default_value = (0.80, 0.79, 0.74, 1)
    cav = nds.new("ShaderNodeMixRGB"); cav.blend_type = "MULTIPLY"
    lk.new(fac, cav.inputs["Fac"])
    lk.new(grime.outputs["Color"], cav.inputs["Color1"]); cav.inputs["Color2"].default_value = (0.46, 0.44, 0.41, 1)
    lk.new(cav.outputs["Color"], bsdf.inputs["Base Color"])

    rgh = nds.new("ShaderNodeMixRGB"); rgh.inputs["Color1"].default_value = (0.82, 0.82, 0.82, 1)
    lk.new(fac, rgh.inputs["Fac"]); rgh.inputs["Color2"].default_value = (0.95, 0.95, 0.95, 1)
    lk.new(rgh.outputs["Color"], bsdf.inputs["Roughness"])

    inv = nds.new("ShaderNodeInvert"); lk.new(fac, inv.inputs["Color"])
    dome = nds.new("ShaderNodeTexVoronoi"); dome.feature = "DISTANCE_TO_EDGE"; dome.inputs["Scale"].default_value = 4.0
    lk.new(WV, dome.inputs["Vector"])
    h1 = nds.new("ShaderNodeMixRGB"); h1.inputs["Fac"].default_value = 0.05
    lk.new(inv.outputs["Color"], h1.inputs["Color1"]); lk.new(dome.outputs["Distance"], h1.inputs["Color2"])
    b1 = nds.new("ShaderNodeBump"); b1.inputs["Strength"].default_value = 1.1; b1.inputs["Distance"].default_value = 0.10
    lk.new(h1.outputs["Color"], b1.inputs["Height"])
    grit = nds.new("ShaderNodeTexNoise"); grit.inputs["Scale"].default_value = 38; grit.inputs["Detail"].default_value = 5
    lk.new(WV, grit.inputs["Vector"])
    b2 = nds.new("ShaderNodeBump"); b2.inputs["Strength"].default_value = 0.10
    lk.new(grit.outputs["Fac"], b2.inputs["Height"]); lk.new(b1.outputs["Normal"], b2.inputs["Normal"])
    lk.new(b2.outputs["Normal"], bsdf.inputs["Normal"])

def build_oak(nds, lk, bsdf):
    """Dark aged oak: vertical grain bands + fine noise grain + strong bump so the frame reads under any light."""
    tc = nds.new("ShaderNodeTexCoord")
    mp = nds.new("ShaderNodeMapping"); mp.inputs["Scale"].default_value = (1.0, 8.0, 1.0)
    lk.new(tc.outputs["UV"], mp.inputs["Vector"])
    wave = nds.new("ShaderNodeTexWave"); wave.wave_type = "BANDS"; wave.bands_direction = "Y"
    wave.inputs["Scale"].default_value = 6.0; wave.inputs["Distortion"].default_value = 2.5; wave.inputs["Detail"].default_value = 3.0
    lk.new(mp.outputs["Vector"], wave.inputs["Vector"])
    ramp = nds.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.3; ramp.color_ramp.elements[0].color = (0.075, 0.045, 0.024, 1)
    ramp.color_ramp.elements[1].position = 0.7; ramp.color_ramp.elements[1].color = (0.19, 0.12, 0.065, 1)
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

def build_shingle(nds, lk, bsdf):
    """Wood shingle roof: overlapping plank-row (brick-pattern) coursing in warm weathered wood tones,
    per-shingle tonal variance + a few grey-weathered patches, strong cavity bump for row-edge relief."""
    tc = nds.new("ShaderNodeTexCoord")
    warpn = nds.new("ShaderNodeTexNoise"); warpn.inputs["Scale"].default_value = 6.0; warpn.inputs["Detail"].default_value = 3.0
    lk.new(tc.outputs["UV"], warpn.inputs["Vector"])
    wsc = nds.new("ShaderNodeVectorMath"); wsc.operation = "SCALE"; wsc.inputs["Scale"].default_value = 0.04
    lk.new(warpn.outputs["Color"], wsc.inputs[0])
    warp = nds.new("ShaderNodeVectorMath"); warp.operation = "ADD"
    lk.new(tc.outputs["UV"], warp.inputs[0]); lk.new(wsc.outputs["Vector"], warp.inputs[1])
    WV = warp.outputs["Vector"]

    shin = nds.new("ShaderNodeTexBrick"); shin.inputs["Scale"].default_value = 6.0
    shin.inputs["Mortar Size"].default_value = 0.04; shin.inputs["Mortar Smooth"].default_value = 0.12
    shin.inputs["Brick Width"].default_value = 0.50; shin.inputs["Row Height"].default_value = 0.30
    shin.inputs["Color1"].default_value = (0.15, 0.10, 0.055, 1); shin.inputs["Color2"].default_value = (0.35, 0.25, 0.145, 1)
    shin.inputs["Mortar"].default_value = (0.06, 0.04, 0.022, 1)
    lk.new(WV, shin.inputs["Vector"]); fac = shin.outputs["Fac"]

    cells = nds.new("ShaderNodeTexVoronoi"); cells.inputs["Scale"].default_value = 7.0
    lk.new(WV, cells.inputs["Vector"])
    cellv = nds.new("ShaderNodeRGBToBW"); lk.new(cells.outputs["Color"], cellv.inputs["Color"])
    cmap = nds.new("ShaderNodeMapRange"); lk.new(cellv.outputs["Val"], cmap.inputs["Value"])
    cmap.inputs["To Min"].default_value = 0.72; cmap.inputs["To Max"].default_value = 1.18

    # weathering: SUBTLE grey-brown patches only — never approaches white, or it washes out the whole roof
    weath = nds.new("ShaderNodeTexNoise"); weath.inputs["Scale"].default_value = 2.4; weath.inputs["Detail"].default_value = 6
    lk.new(WV, weath.inputs["Vector"])
    wramp = nds.new("ShaderNodeValToRGB")
    wramp.color_ramp.elements[0].position = 0.55; wramp.color_ramp.elements[0].color = (0.34, 0.30, 0.24, 1)
    wramp.color_ramp.elements[1].position = 0.86; wramp.color_ramp.elements[1].color = (0.46, 0.40, 0.32, 1)
    lk.new(weath.outputs["Fac"], wramp.inputs["Fac"])

    tint = nds.new("ShaderNodeMixRGB"); tint.blend_type = "MULTIPLY"; tint.inputs["Fac"].default_value = 1.0
    lk.new(shin.outputs["Color"], tint.inputs["Color1"]); lk.new(cmap.outputs["Result"], tint.inputs["Color2"])
    weathmix = nds.new("ShaderNodeMixRGB"); weathmix.blend_type = "MIX"; weathmix.inputs["Fac"].default_value = 0.16
    lk.new(tint.outputs["Color"], weathmix.inputs["Color1"]); lk.new(wramp.outputs["Color"], weathmix.inputs["Color2"])
    cav = nds.new("ShaderNodeMixRGB"); cav.blend_type = "MULTIPLY"
    lk.new(fac, cav.inputs["Fac"])
    lk.new(weathmix.outputs["Color"], cav.inputs["Color1"]); cav.inputs["Color2"].default_value = (0.14, 0.11, 0.09, 1)
    lk.new(cav.outputs["Color"], bsdf.inputs["Base Color"])

    rgh = nds.new("ShaderNodeMixRGB"); rgh.inputs["Color1"].default_value = (0.60, 0.60, 0.60, 1)
    lk.new(fac, rgh.inputs["Fac"]); rgh.inputs["Color2"].default_value = (0.85, 0.85, 0.85, 1)
    lk.new(rgh.outputs["Color"], bsdf.inputs["Roughness"])

    inv = nds.new("ShaderNodeInvert"); lk.new(fac, inv.inputs["Color"])
    dome = nds.new("ShaderNodeTexVoronoi"); dome.feature = "DISTANCE_TO_EDGE"; dome.inputs["Scale"].default_value = 7.0
    lk.new(WV, dome.inputs["Vector"])
    h1 = nds.new("ShaderNodeMixRGB"); h1.inputs["Fac"].default_value = 0.08
    lk.new(inv.outputs["Color"], h1.inputs["Color1"]); lk.new(dome.outputs["Distance"], h1.inputs["Color2"])
    b1 = nds.new("ShaderNodeBump"); b1.inputs["Strength"].default_value = 1.0; b1.inputs["Distance"].default_value = 0.09
    lk.new(h1.outputs["Color"], b1.inputs["Height"])
    grit = nds.new("ShaderNodeTexNoise"); grit.inputs["Scale"].default_value = 45; grit.inputs["Detail"].default_value = 5
    lk.new(WV, grit.inputs["Vector"])
    b2 = nds.new("ShaderNodeBump"); b2.inputs["Strength"].default_value = 0.09
    lk.new(grit.outputs["Fac"], b2.inputs["Height"]); lk.new(b1.outputs["Normal"], b2.inputs["Normal"])
    lk.new(b2.outputs["Normal"], bsdf.inputs["Normal"])

IMG_STONE = bake_material("Fieldstone", build_fieldstone)
IMG_OAK = bake_material("Oak", build_oak)
IMG_SHINGLE = bake_material("Shingle", build_shingle)

MAT_STONE = tiled_material("FieldstoneTiled", IMG_STONE, tile_m=1.1)
MAT_OAK = tiled_material("OakTiled", IMG_OAK, tile_m=0.5)
MAT_SHINGLE = tiled_material("ShingleTiled", IMG_SHINGLE, tile_m=1.3)
M_IRON = solid("Iron", (0.075, 0.072, 0.070), 0.4, 0.85)
M_ROPE = solid("Rope", (0.52, 0.42, 0.27), 0.92, 0.0)
M_VOID = solid("WellDark", (0.02, 0.02, 0.03), 0.95, 0.0)

# ================================================================================
# ---- dimensions (metres) -------------------------------------------------------
# ================================================================================
R_OUT, WALL_T, WALL_H = 0.70, 0.18, 1.00          # shaft outer radius / wall thickness / wall height
R_IN = R_OUT - WALL_T
COPE_R, COPE_H, COPE_Z0 = 0.78, 0.12, 0.96         # coping lip ring (slight overlap with wall top)
R_VOID = R_IN - 0.02                               # dark interior void radius (reads as an open dark mouth)

POST_X, POST_SIZE, POST_H = 0.74, 0.14, 1.85       # posts stand just outside/embedded in the wall
HEADER_Z = POST_H + 0.06                           # tie-beam atop the posts
ROOF_BASE_Z = HEADER_Z + 0.06
PITCH, EAVE_X, EAVE_Y = 0.58, 0.15, 0.25            # roof rise / eave overhang beyond posts / beyond shaft

AXLE_Z = 1.32                                       # winch roller height (above wall, below header)
AXLE_R = 0.11
AXLE_HALF_LEN = POST_X - POST_SIZE / 2 - 0.02       # spans between the posts' inner faces

STONE_PARTS, TIMBER_PARTS = [], []

# ---- well shaft: fieldstone wall, hollowed so the mouth reads open ------------
wall = cyl("Wall", (0, 0, WALL_H / 2), R_OUT, WALL_H, verts=32)
wall_cut = cyl("wallCut", (0, 0, WALL_H / 2 + 0.05), R_IN, WALL_H + 0.3, verts=32)
boolean(wall, wall_cut)
STONE_PARTS.append(wall)

cope = cyl("Coping", (0, 0, COPE_Z0 + COPE_H / 2), COPE_R, COPE_H, verts=32)
cope_cut = cyl("copeCut", (0, 0, COPE_Z0 + COPE_H / 2), R_IN, COPE_H + 0.2, verts=32)
boolean(cope, cope_cut)
STONE_PARTS.append(cope)

void = cyl("WellVoid", (0, 0, (0.04 + COPE_Z0 + COPE_H) / 2), R_VOID, (COPE_Z0 + COPE_H) - 0.04, verts=32)
apply_tiled(void, M_VOID)

# ---- posts + header (tie beam) -------------------------------------------------
for sx in (-1, 1):
    p = box("post", (sx * POST_X, 0, POST_H / 2), (POST_SIZE, POST_SIZE, POST_H))
    TIMBER_PARTS.append(p)
header = box("Header", (0, 0, HEADER_Z), (POST_X * 2 + POST_SIZE, POST_SIZE * 0.9, 0.12))
TIMBER_PARTS.append(header)

# ---- winch: timber roller/axle + iron mount brackets + crank + rope + bucket --
axle = cyl("Axle", (0, 0, AXLE_Z), AXLE_R, AXLE_HALF_LEN * 2, verts=20, rotation=(0, math.pi / 2, 0))
TIMBER_PARTS.append(axle)

for sx in (-1, 1):
    bracket = box("bracket", (sx * (POST_X - POST_SIZE / 2 - 0.03), 0, AXLE_Z), (0.10, 0.22, 0.22))
    bracket.data.materials.append(M_IRON)
    cap = cyl("axleCap", (sx * (AXLE_HALF_LEN + 0.015), 0, AXLE_Z), AXLE_R + 0.015, 0.03, verts=20, rotation=(0, math.pi / 2, 0))
    cap.data.materials.append(M_IRON)

# crank on the +X side: axle stub pokes PAST the post's outer face so the crank reads clearly in
# silhouette instead of hiding flush against the post; a bent iron rod (up-stub + parallel grip).
crank_x = POST_X + POST_SIZE / 2 + 0.14
stub = cyl("axleStub", ((AXLE_HALF_LEN + crank_x) / 2, 0, AXLE_Z), AXLE_R * 0.55, crank_x - AXLE_HALF_LEN, verts=16, rotation=(0, math.pi / 2, 0))
stub.data.materials.append(M_IRON)
arm = cyl("crankArm", (crank_x, 0, AXLE_Z + 0.14), 0.045, 0.28, verts=12)
arm.data.materials.append(M_IRON)
grip = cyl("crankGrip", (crank_x + 0.10, 0, AXLE_Z + 0.28), 0.035, 0.20, verts=12, rotation=(0, math.pi / 2, 0))
grip.data.materials.append(M_IRON)

# rope: a couple of wraps around the axle + a short hanging length up near the rim (kept short so the
# bucket rides just below the mouth, visible against the dark void instead of buried out of camera view)
for wx in (-0.06, 0.06):
    wrap = torus("ropeWrap", (wx, 0, AXLE_Z), AXLE_R + 0.024, 0.022, rotation=(0, math.pi / 2, 0))
    wrap.data.materials.append(M_ROPE)
ROPE_TOP, ROPE_BOT = AXLE_Z - AXLE_R, 1.05
rope = cyl("ropeHang", (0, 0, (ROPE_TOP + ROPE_BOT) / 2), 0.022, ROPE_TOP - ROPE_BOT, verts=10)
rope.data.materials.append(M_ROPE)

# bonus bucket: tapered timber pail + iron hoop + bail handle, hanging just below the rim (visible)
BUCKET_TOP, BUCKET_H = ROPE_BOT, 0.24
bucket = cone("Bucket", (0, 0, BUCKET_TOP - BUCKET_H / 2), 0.17, 0.12, BUCKET_H, verts=20)
apply_tiled(bucket, MAT_OAK, cube_size=0.3)
hoop = torus("bucketHoop", (0, 0, BUCKET_TOP - 0.055), 0.165, 0.014, rotation=(math.pi / 2, 0, 0))
hoop.data.materials.append(M_IRON)
bail = torus("bucketBail", (0, 0, BUCKET_TOP + 0.03), 0.12, 0.013, rotation=(math.pi / 2, 0, 0))
bail.data.materials.append(M_IRON)

# ---- roof: solid triangular prism (ridge along X, matching the post line) -----
me = bpy.data.meshes.new("Roof"); roof = bpy.data.objects.new("Roof", me)
bpy.context.collection.objects.link(roof)
xL, xR = -(POST_X + POST_SIZE / 2 + EAVE_X), (POST_X + POST_SIZE / 2 + EAVE_X)
yF, yB = (R_OUT + EAVE_Y), -(R_OUT + EAVE_Y)
zb, zt = ROOF_BASE_Z, ROOF_BASE_Z + PITCH
bm = bmesh.new()
vs = [bm.verts.new(p) for p in [
    (xL, yF, zb), (xL, yB, zb), (0, 0, zt),
    (xR, yF, zb), (xR, yB, zb), (0, 0, zt)]]
bm.faces.new((vs[0], vs[1], vs[2]))            # left gable triangle
bm.faces.new((vs[3], vs[5], vs[4]))            # right gable triangle
bm.faces.new((vs[0], vs[2], vs[5], vs[3]))     # front slope
bm.faces.new((vs[1], vs[4], vs[5], vs[2]))     # back slope
bm.faces.new((vs[0], vs[3], vs[4], vs[1]))     # bottom (sits on the header)
bm.to_mesh(me); bm.free()
me.uv_layers.new(name="UVMap")

bpy.context.view_layer.objects.active = roof
bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.cube_project(cube_size=0.8, correct_aspect=True, scale_to_bounds=False)
bpy.ops.object.mode_set(mode="OBJECT")
me.materials.append(MAT_SHINGLE); me.materials.append(MAT_OAK)   # 0=shingle (slopes), 1=oak (gable verges)
for i, f in enumerate(me.polygons):
    f.material_index = 1 if i in (0, 1) else 0
bevel(roof, 0.03, 1)

# ---- assemble: join same-material groups, then bevel for a clean edge-highlight ----
stone_j = join_all(STONE_PARTS, "WellStone")
apply_tiled(stone_j, MAT_STONE, cube_size=1.1)
bevel(stone_j, 0.02, 1)

timber_j = join_all(TIMBER_PARTS, "TimberFrame")
apply_tiled(timber_j, MAT_OAK, cube_size=0.5)
bevel(timber_j, 0.015, 2)

# ---- export GLB (Y-up, embedded materials + textures) -------------------------
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_yup=True, export_apply=True)
print(f"well: wrote {OUT}")
