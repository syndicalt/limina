# watchtower.py — a frontier WATCHTOWER authored in headless Blender: stone plinth base, tapering
# timber-framed shaft, railed lookout platform on knee-braced overhang, hipped shingle roof. Textured with
# THREE baked procedural tile sets (ashlar stone / vertical-plank oak / coursed shingle) — real Image
# Texture nodes (albedo+normal+roughness), cube-projected UVs at true world scale, tiled via Mapping.
# The build agent authoring a bespoke landmark as a whole GLB the engine only CONSUMES. Non-Adobe end to end.
#
#   blender --background --factory-startup --python tools/blender/watchtower.py -- --out assets/watchtower-authored.glb

import bpy, bmesh, sys, math

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[argv.index("--out") + 1] if "--out" in argv else "assets/watchtower-authored.glb"

# ---- reset --------------------------------------------------------------------
bpy.ops.object.select_all(action="SELECT"); bpy.ops.object.delete()
for c in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
    for d in list(c):
        try: c.remove(d)
        except Exception: pass

# ---- geometry helpers -----------------------------------------------------------
def box(name, center, size, material=None):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=center)
    o = bpy.context.active_object; o.name = name; o.scale = size
    # NOTE: this Blender build defaults transform_apply's location/rotation to True (not False as in
    # older Blender) -- must pin them explicitly or object.location/rotation_euler gets silently baked
    # to zero, which then makes any LATER post-hoc rotation_euler assignment swing around the world
    # origin instead of the piece's own center.
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if material: o.data.materials.append(material)
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

def cube_uv(obj, cube_size=1.0):
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.cube_project(cube_size=cube_size, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")

def join_all(objs, name):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    out = bpy.context.view_layer.objects.active; out.name = name
    return out

def recess(target, cx, cz, w, h, axis, sign, at, depth, panel_mat=None):
    """Blind recess (does NOT punch through) cut into `target`'s face at half-width `at` along `axis`.
    axis='y' -> +/-Y face (sign selects); axis='x' -> +/-X face."""
    if axis == "y":
        cutter = box("cut", (cx, sign * at, cz), (w, depth * 2, h))
        boolean(target, cutter)
        if panel_mat: box("panel", (cx, sign * (at - depth * 0.45), cz), (w * 0.82, 0.05, h * 0.82), panel_mat)
    else:
        cutter = box("cut", (sign * at, cx, cz), (depth * 2, w, h))
        boolean(target, cutter)
        if panel_mat: box("panel", (sign * (at - depth * 0.45), cx, cz), (0.05, w * 0.82, h * 0.82), panel_mat)

# ---- baked procedural tile textures (Cycles bake -> real Image Texture nodes) --
def mix(nds, lk, a, b, fac, blend="MIX"):
    x = nds.new("ShaderNodeMixRGB"); x.blend_type = blend; x.inputs["Fac"].default_value = fac
    if isinstance(a, float): x.inputs["Color1"].default_value = (a, a, a, 1)
    else: lk.new(a, x.inputs["Color1"])
    if isinstance(b, tuple): x.inputs["Color2"].default_value = (*b, 1)
    elif isinstance(b, float): x.inputs["Color2"].default_value = (b, b, b, 1)
    else: lk.new(b, x.inputs["Color2"])
    return x.outputs["Color"]

def bake_tile(kind, res=768):
    bpy.ops.mesh.primitive_plane_add(size=2, location=(300 + {"stone":0,"timber":6,"roof":12}[kind], 0, 0))
    pl = bpy.context.active_object
    m = bpy.data.materials.new(f"proc_{kind}"); m.use_nodes = True
    nt = m.node_tree; N = nt.nodes; L = nt.links
    bsdf = N["Principled BSDF"]
    tc = N.new("ShaderNodeTexCoord")
    # domain warp so joints/grain aren't a perfect machine grid
    wn = N.new("ShaderNodeTexNoise"); wn.inputs["Scale"].default_value = 5.0; wn.inputs["Detail"].default_value = 3.0
    wsc = N.new("ShaderNodeVectorMath"); wsc.operation = "SCALE"
    L.new(wn.outputs["Color"], wsc.inputs[0]); wsc.inputs["Scale"].default_value = 0.06
    warp = N.new("ShaderNodeVectorMath"); warp.operation = "ADD"
    L.new(tc.outputs["UV"], warp.inputs[0]); L.new(wsc.outputs["Vector"], warp.inputs[1])
    WV = warp.outputs["Vector"]

    if kind == "stone":
        brick = N.new("ShaderNodeTexBrick")
        brick.inputs["Scale"].default_value = 2.1
        brick.inputs["Mortar Size"].default_value = 0.03; brick.inputs["Mortar Smooth"].default_value = 0.25
        brick.inputs["Brick Width"].default_value = 0.62; brick.inputs["Row Height"].default_value = 0.32
        brick.inputs["Color1"].default_value = (0.50, 0.47, 0.43, 1)
        brick.inputs["Color2"].default_value = (0.60, 0.57, 0.52, 1)
        brick.inputs["Mortar"].default_value = (0.16, 0.15, 0.14, 1)
        L.new(WV, brick.inputs["Vector"]); fac = brick.outputs["Fac"]
        cells = N.new("ShaderNodeTexVoronoi"); cells.inputs["Scale"].default_value = 4.0; L.new(WV, cells.inputs["Vector"])
        cellv = N.new("ShaderNodeRGBToBW"); L.new(cells.outputs["Color"], cellv.inputs["Color"])
        cmap = N.new("ShaderNodeMapRange"); L.new(cellv.outputs["Val"], cmap.inputs["Value"])
        cmap.inputs["To Min"].default_value = 0.78; cmap.inputs["To Max"].default_value = 1.08
        weath = N.new("ShaderNodeTexNoise"); weath.inputs["Scale"].default_value = 2.3; weath.inputs["Detail"].default_value = 8
        stain = N.new("ShaderNodeValToRGB"); stain.color_ramp.elements[0].position = 0.4; stain.color_ramp.elements[1].position = 0.78
        L.new(weath.outputs["Fac"], stain.inputs["Fac"])
        smap = N.new("ShaderNodeMapping"); smap.inputs["Scale"].default_value = (2.5, 0.12, 2.5); L.new(WV, smap.inputs["Vector"])
        sn = N.new("ShaderNodeTexNoise"); sn.inputs["Scale"].default_value = 3.5; sn.inputs["Detail"].default_value = 5
        L.new(smap.outputs["Vector"], sn.inputs["Vector"])
        sramp = N.new("ShaderNodeValToRGB")
        sramp.color_ramp.elements[0].position = 0.32; sramp.color_ramp.elements[0].color = (0.55, 0.55, 0.55, 1)
        sramp.color_ramp.elements[1].position = 0.6; sramp.color_ramp.elements[1].color = (1, 1, 1, 1)
        L.new(sn.outputs["Fac"], sramp.inputs["Fac"])
        tint = mix(N, L, brick.outputs["Color"], cmap.outputs["Result"], 1.0, "MULTIPLY")
        grime = N.new("ShaderNodeMixRGB"); grime.blend_type = "MULTIPLY"; L.new(stain.outputs["Color"], grime.inputs["Fac"])
        L.new(tint, grime.inputs["Color1"]); grime.inputs["Color2"].default_value = (0.78, 0.76, 0.72, 1)
        strk = N.new("ShaderNodeMixRGB"); strk.blend_type = "MULTIPLY"; strk.inputs["Fac"].default_value = 0.65
        L.new(grime.outputs["Color"], strk.inputs["Color1"]); L.new(sramp.outputs["Color"], strk.inputs["Color2"])
        cav = N.new("ShaderNodeMixRGB"); cav.blend_type = "MULTIPLY"; L.new(fac, cav.inputs["Fac"])
        L.new(strk.outputs["Color"], cav.inputs["Color1"]); cav.inputs["Color2"].default_value = (0.46, 0.44, 0.42, 1)
        L.new(cav.outputs["Color"], bsdf.inputs["Base Color"])
        rgh = N.new("ShaderNodeMixRGB"); rgh.inputs["Color1"].default_value = (0.82,) * 3 + (1,)
        L.new(fac, rgh.inputs["Fac"]); rgh.inputs["Color2"].default_value = (0.95,) * 3 + (1,)
        L.new(rgh.outputs["Color"], bsdf.inputs["Roughness"])
        inv = N.new("ShaderNodeInvert"); L.new(fac, inv.inputs["Color"])
        dome = N.new("ShaderNodeTexVoronoi"); dome.feature = "DISTANCE_TO_EDGE"; dome.inputs["Scale"].default_value = 3.0
        L.new(WV, dome.inputs["Vector"])
        undul = N.new("ShaderNodeTexNoise"); undul.inputs["Scale"].default_value = 13.0; undul.inputs["Detail"].default_value = 4
        grit = N.new("ShaderNodeTexNoise"); grit.inputs["Scale"].default_value = 40; grit.inputs["Detail"].default_value = 6
        h1 = mix(N, L, inv.outputs["Color"], dome.outputs["Distance"], 0.05)
        b1 = N.new("ShaderNodeBump"); b1.inputs["Strength"].default_value = 1.3; b1.inputs["Distance"].default_value = 0.12
        L.new(h1, b1.inputs["Height"])
        h2 = mix(N, L, undul.outputs["Fac"], grit.outputs["Fac"], 0.6)
        b2 = N.new("ShaderNodeBump"); b2.inputs["Strength"].default_value = 0.10
        L.new(h2, b2.inputs["Height"]); L.new(b1.outputs["Normal"], b2.inputs["Normal"])
        L.new(b2.outputs["Normal"], bsdf.inputs["Normal"])

    elif kind == "timber":
        # vertical planks: Brick node w/ one tall row = clean plank joints, no horizontal coursing
        plank = N.new("ShaderNodeTexBrick")
        plank.inputs["Scale"].default_value = 3.2
        plank.inputs["Mortar Size"].default_value = 0.018; plank.inputs["Mortar Smooth"].default_value = 0.15
        plank.inputs["Brick Width"].default_value = 0.34; plank.inputs["Row Height"].default_value = 8.0
        plank.inputs["Color1"].default_value = (0.19, 0.11, 0.06, 1)
        plank.inputs["Color2"].default_value = (0.24, 0.145, 0.075, 1)
        plank.inputs["Mortar"].default_value = (0.07, 0.045, 0.03, 1)
        L.new(WV, plank.inputs["Vector"]); fac = plank.outputs["Fac"]
        # per-plank tonal variation
        cells = N.new("ShaderNodeTexVoronoi"); cells.inputs["Scale"].default_value = 3.0; L.new(WV, cells.inputs["Vector"])
        cellv = N.new("ShaderNodeRGBToBW"); L.new(cells.outputs["Color"], cellv.inputs["Color"])
        cmap = N.new("ShaderNodeMapRange"); L.new(cellv.outputs["Val"], cmap.inputs["Value"])
        cmap.inputs["To Min"].default_value = 0.72; cmap.inputs["To Max"].default_value = 1.15
        # vertical grain streaks (stretched noise along V)
        gmap = N.new("ShaderNodeMapping"); gmap.inputs["Scale"].default_value = (6.0, 0.1, 6.0); L.new(WV, gmap.inputs["Vector"])
        gn = N.new("ShaderNodeTexNoise"); gn.inputs["Scale"].default_value = 4.0; gn.inputs["Detail"].default_value = 6
        L.new(gmap.outputs["Vector"], gn.inputs["Vector"])
        gramp = N.new("ShaderNodeValToRGB")
        gramp.color_ramp.elements[0].position = 0.35; gramp.color_ramp.elements[0].color = (0.62, 0.62, 0.62, 1)
        gramp.color_ramp.elements[1].position = 0.68; gramp.color_ramp.elements[1].color = (1, 1, 1, 1)
        L.new(gn.outputs["Fac"], gramp.inputs["Fac"])
        # weathering grey patches
        weath = N.new("ShaderNodeTexNoise"); weath.inputs["Scale"].default_value = 1.8; weath.inputs["Detail"].default_value = 6
        stain = N.new("ShaderNodeValToRGB"); stain.color_ramp.elements[0].position = 0.45; stain.color_ramp.elements[1].position = 0.8
        L.new(weath.outputs["Fac"], stain.inputs["Fac"])
        tint = mix(N, L, plank.outputs["Color"], cmap.outputs["Result"], 1.0, "MULTIPLY")
        grain = N.new("ShaderNodeMixRGB"); grain.blend_type = "MULTIPLY"; grain.inputs["Fac"].default_value = 0.8
        L.new(tint, grain.inputs["Color1"]); L.new(gramp.outputs["Color"], grain.inputs["Color2"])
        wgr = N.new("ShaderNodeMixRGB"); wgr.blend_type = "MULTIPLY"; L.new(stain.outputs["Color"], wgr.inputs["Fac"])
        L.new(grain.outputs["Color"], wgr.inputs["Color1"]); wgr.inputs["Color2"].default_value = (0.52, 0.50, 0.47, 1)
        cav = N.new("ShaderNodeMixRGB"); cav.blend_type = "MULTIPLY"; L.new(fac, cav.inputs["Fac"])
        L.new(wgr.outputs["Color"], cav.inputs["Color1"]); cav.inputs["Color2"].default_value = (0.30, 0.28, 0.26, 1)
        L.new(cav.outputs["Color"], bsdf.inputs["Base Color"])
        rgh = N.new("ShaderNodeMixRGB"); rgh.inputs["Color1"].default_value = (0.72,) * 3 + (1,)
        L.new(fac, rgh.inputs["Fac"]); rgh.inputs["Color2"].default_value = (0.9,) * 3 + (1,)
        L.new(rgh.outputs["Color"], bsdf.inputs["Roughness"])
        inv = N.new("ShaderNodeInvert"); L.new(fac, inv.inputs["Color"])
        h1 = mix(N, L, inv.outputs["Color"], gramp.outputs["Color"], 0.35)
        b1 = N.new("ShaderNodeBump"); b1.inputs["Strength"].default_value = 0.9; b1.inputs["Distance"].default_value = 0.05
        L.new(h1, b1.inputs["Height"])
        grit = N.new("ShaderNodeTexNoise"); grit.inputs["Scale"].default_value = 60; grit.inputs["Detail"].default_value = 4
        b2 = N.new("ShaderNodeBump"); b2.inputs["Strength"].default_value = 0.06
        L.new(grit.outputs["Fac"], b2.inputs["Height"]); L.new(b1.outputs["Normal"], b2.inputs["Normal"])
        L.new(b2.outputs["Normal"], bsdf.inputs["Normal"])

    else:  # roof shingle/slate coursing
        shin = N.new("ShaderNodeTexBrick")
        shin.inputs["Scale"].default_value = 5.5
        shin.inputs["Mortar Size"].default_value = 0.035; shin.inputs["Mortar Smooth"].default_value = 0.2
        shin.inputs["Brick Width"].default_value = 0.5; shin.inputs["Row Height"].default_value = 0.28
        shin.inputs["Color1"].default_value = (0.15, 0.16, 0.19, 1)
        shin.inputs["Color2"].default_value = (0.20, 0.215, 0.245, 1)
        shin.inputs["Mortar"].default_value = (0.06, 0.065, 0.075, 1)
        L.new(WV, shin.inputs["Vector"]); fac = shin.outputs["Fac"]
        cells = N.new("ShaderNodeTexVoronoi"); cells.inputs["Scale"].default_value = 6.0; L.new(WV, cells.inputs["Vector"])
        cellv = N.new("ShaderNodeRGBToBW"); L.new(cells.outputs["Color"], cellv.inputs["Color"])
        cmap = N.new("ShaderNodeMapRange"); L.new(cellv.outputs["Val"], cmap.inputs["Value"])
        cmap.inputs["To Min"].default_value = 0.8; cmap.inputs["To Max"].default_value = 1.12
        moss = N.new("ShaderNodeTexNoise"); moss.inputs["Scale"].default_value = 2.0; moss.inputs["Detail"].default_value = 6
        mramp = N.new("ShaderNodeValToRGB"); mramp.color_ramp.elements[0].position = 0.5; mramp.color_ramp.elements[1].position = 0.72
        mramp.color_ramp.elements[0].color = (0.22, 0.24, 0.15, 1)
        L.new(moss.outputs["Fac"], mramp.inputs["Fac"])
        tint = mix(N, L, shin.outputs["Color"], cmap.outputs["Result"], 1.0, "MULTIPLY")
        mossmix = N.new("ShaderNodeMixRGB"); mossmix.blend_type = "MIX"; mossmix.inputs["Fac"].default_value = 0.22
        L.new(tint, mossmix.inputs["Color1"]); L.new(mramp.outputs["Color"], mossmix.inputs["Color2"])
        cav = N.new("ShaderNodeMixRGB"); cav.blend_type = "MULTIPLY"; L.new(fac, cav.inputs["Fac"])
        L.new(mossmix.outputs["Color"], cav.inputs["Color1"]); cav.inputs["Color2"].default_value = (0.35, 0.36, 0.4, 1)
        L.new(cav.outputs["Color"], bsdf.inputs["Base Color"])
        rgh = N.new("ShaderNodeMixRGB"); rgh.inputs["Color1"].default_value = (0.5,) * 3 + (1,)
        L.new(fac, rgh.inputs["Fac"]); rgh.inputs["Color2"].default_value = (0.72,) * 3 + (1,)
        L.new(rgh.outputs["Color"], bsdf.inputs["Roughness"])
        inv = N.new("ShaderNodeInvert"); L.new(fac, inv.inputs["Color"])
        dome = N.new("ShaderNodeTexVoronoi"); dome.feature = "DISTANCE_TO_EDGE"; dome.inputs["Scale"].default_value = 6.0
        L.new(WV, dome.inputs["Vector"])
        h1 = mix(N, L, inv.outputs["Color"], dome.outputs["Distance"], 0.08)
        b1 = N.new("ShaderNodeBump"); b1.inputs["Strength"].default_value = 1.0; b1.inputs["Distance"].default_value = 0.09
        L.new(h1, b1.inputs["Height"])
        grit = N.new("ShaderNodeTexNoise"); grit.inputs["Scale"].default_value = 35; grit.inputs["Detail"].default_value = 5
        b2 = N.new("ShaderNodeBump"); b2.inputs["Strength"].default_value = 0.08
        L.new(grit.outputs["Fac"], b2.inputs["Height"]); L.new(b1.outputs["Normal"], b2.inputs["Normal"])
        L.new(b2.outputs["Normal"], bsdf.inputs["Normal"])

    pl.data.materials.append(m)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"; scene.cycles.device = "CPU"; scene.cycles.samples = 20
    imgs = {}
    for bt, nm, nc, extra in [("DIFFUSE", "alb", False, {"pass_filter": {"COLOR"}}),
                              ("NORMAL", "nrm", True, {}), ("ROUGHNESS", "rgh", True, {})]:
        img = bpy.data.images.new(f"{kind}_{nm}", 768, 768)
        img.colorspace_settings.name = "Non-Color" if nc else "sRGB"
        tx = nt.nodes.new("ShaderNodeTexImage"); tx.image = img; tx.select = True; nt.nodes.active = tx
        bpy.context.view_layer.objects.active = pl
        bpy.ops.object.bake(type=bt, width=768, height=768, margin=4, use_clear=True, **extra)
        imgs[nm] = img
    bpy.data.objects.remove(pl, do_unlink=True)
    bpy.data.materials.remove(m)
    return imgs

def mat_from_tile(name, tile, tile_m):
    sm = bpy.data.materials.new(name); sm.use_nodes = True
    nt = sm.node_tree; n = nt.nodes; l = nt.links
    b = n["Principled BSDF"]
    uv = n.new("ShaderNodeTexCoord"); mp = n.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (1.0 / tile_m, 1.0 / tile_m, 1.0 / tile_m)
    l.new(uv.outputs["UV"], mp.inputs["Vector"])
    def tex(img, non_color):
        t = n.new("ShaderNodeTexImage"); t.image = img; t.extension = "REPEAT"
        if non_color: t.image.colorspace_settings.name = "Non-Color"
        l.new(mp.outputs["Vector"], t.inputs["Vector"]); return t
    l.new(tex(tile["alb"], False).outputs["Color"], b.inputs["Base Color"])
    l.new(tex(tile["rgh"], True).outputs["Color"], b.inputs["Roughness"])
    nmn = n.new("ShaderNodeNormalMap"); l.new(tex(tile["nrm"], True).outputs["Color"], nmn.inputs["Color"])
    l.new(nmn.outputs["Normal"], b.inputs["Normal"])
    return sm

STONE_TILE = bake_tile("stone")
TIMBER_TILE = bake_tile("timber")
ROOF_TILE = bake_tile("roof")
for tile in (STONE_TILE, TIMBER_TILE, ROOF_TILE):
    for im in tile.values(): im.pack()

M_STONE = mat_from_tile("Stone", STONE_TILE, 2.0)
M_TIMBER = mat_from_tile("Timber", TIMBER_TILE, 1.1)
M_ROOF = mat_from_tile("RoofShingle", ROOF_TILE, 0.9)
M_DARK = bpy.data.materials.new("Glass"); M_DARK.use_nodes = True
gb = M_DARK.node_tree.nodes["Principled BSDF"]
gb.inputs["Base Color"].default_value = (0.05, 0.06, 0.08, 1); gb.inputs["Roughness"].default_value = 0.25

# ================================================================================
# dimensions (metres) — frontier watchtower: stone plinth -> tapering timber shaft
# (2 stages) -> railed lookout platform -> hipped shingle roof.
BW, BD, BH = 3.6, 3.6, 1.8               # base plinth footprint / height
S1W, S1H = 3.2, 2.5                       # shaft stage 1 footprint / height
S2W, S2H = 2.7, 2.3                       # shaft stage 2 footprint / height (tapered)
PLW, PLH = 3.5, 0.2                       # platform slab footprint / thickness
RAIL_H = 0.9
POST = 0.12
ROOF_EAVE_W, ROOF_RISE = 4.1, 1.7

z_base0, z_base1 = 0.0, BH
z_s1_0, z_s1_1 = z_base1, z_base1 + S1H
z_s2_0, z_s2_1 = z_s1_1, z_s1_1 + S2H
z_plat0, z_plat1 = z_s2_1, z_s2_1 + PLH
z_rail0, z_rail1 = z_plat1, z_plat1 + RAIL_H
z_roof0 = z_rail1

STONE_PARTS, TIMBER_PARTS = [], []

# ---- BASE: stone plinth --------------------------------------------------------
base = box("Base", (0, 0, z_base1 / 2), (BW, BD, BH), M_STONE)
STONE_PARTS.append(base)
recess(base, 0.0, 0.95, 1.0, 1.55, "y", 1, BD / 2, 0.34, M_TIMBER)      # door (blind, timber panel)
recess(base, 0.0, 1.25, 0.18, 0.85, "x", 1, BW / 2, 0.32)                # arrow slit +X
recess(base, 0.0, 1.25, 0.18, 0.85, "x", -1, BW / 2, 0.32)               # arrow slit -X
recess(base, 0.0, 1.25, 0.18, 0.85, "y", -1, BD / 2, 0.32)               # arrow slit -Y (back)
# steps up to the door (stone treads, external-stair hint)
for i in range(4):
    zt = 0.42 - i * 0.14
    if zt <= 0.02: break
    box(f"step{i}", (0, BD / 2 + 0.55 - i * 0.42, zt / 2), (1.3, 0.42 + i * 0.05, zt), M_STONE)
    STONE_PARTS.append(bpy.data.objects[f"step{i}"])

# ---- SHAFT stage 1 (timber-framed, wider) --------------------------------------
s1 = box("Shaft1", (0, 0, z_s1_0 + S1H / 2), (S1W, S1W, S1H), M_TIMBER)
TIMBER_PARTS.append(s1)
recess(s1, 0.0, z_s1_0 + 1.5, 0.55, 0.85, "y", 1, S1W / 2, 0.28, M_DARK)   # window front
recess(s1, 0.0, z_s1_0 + 1.5, 0.55, 0.85, "y", -1, S1W / 2, 0.28, M_DARK)  # window back
# corner posts (proud, straddling each vertical edge)
for sx in (-1, 1):
    for sy in (-1, 1):
        p = box("post1", (sx * S1W / 2, sy * S1W / 2, z_s1_0 + S1H / 2), (POST, POST, S1H), M_TIMBER)
        TIMBER_PARTS.append(p)
# top/bottom rail ring
for zc in (z_s1_0 + 0.1, z_s1_1 - 0.1):
    for sy in (-1, 1):
        r = box("rail1", (0, sy * S1W / 2, zc), (S1W, POST, POST), M_TIMBER); TIMBER_PARTS.append(r)
    for sx in (-1, 1):
        r = box("rail1s", (sx * S1W / 2, 0, zc), (POST, S1W - 2 * POST, POST), M_TIMBER); TIMBER_PARTS.append(r)
# diagonal knee braces on front/back faces (proud of the wall)
w_b, h_b = S1W * 0.62, S1H * 0.7
L_b = math.sqrt(w_b ** 2 + h_b ** 2); ang = math.atan2(h_b, w_b)
for sy in (-1, 1):
    for sx in (-1, 1):
        br = box("brace1", (sx * w_b * 0.28, sy * (S1W / 2 + 0.03), z_s1_0 + h_b * 0.5 + 0.15),
                 (L_b * 0.55, 0.05, POST * 0.8), M_TIMBER)
        br.rotation_euler = (0, sx * sy * ang, 0)
        TIMBER_PARTS.append(br)

# ---- SHAFT stage 2 (tapered, narrower) -----------------------------------------
s2 = box("Shaft2", (0, 0, z_s2_0 + S2H / 2), (S2W, S2W, S2H), M_TIMBER)
TIMBER_PARTS.append(s2)
recess(s2, 0.0, z_s2_0 + 1.15, 0.5, 0.75, "y", 1, S2W / 2, 0.26, M_DARK)
for sx in (-1, 1):
    for sy in (-1, 1):
        p = box("post2", (sx * S2W / 2, sy * S2W / 2, z_s2_0 + S2H / 2), (POST, POST, S2H), M_TIMBER)
        TIMBER_PARTS.append(p)
for zc in (z_s2_0 + 0.08, z_s2_1 - 0.08):
    for sy in (-1, 1):
        r = box("rail2", (0, sy * S2W / 2, zc), (S2W, POST, POST), M_TIMBER); TIMBER_PARTS.append(r)
    for sx in (-1, 1):
        r = box("rail2s", (sx * S2W / 2, 0, zc), (POST, S2W - 2 * POST, POST), M_TIMBER); TIMBER_PARTS.append(r)

# ---- PLATFORM: overhanging floor + knee-brace corbels + railing ---------------
plat = box("Platform", (0, 0, z_plat0 + PLH / 2), (PLW, PLW, PLH), M_TIMBER)
TIMBER_PARTS.append(plat)
# corbel knee-braces from shaft top corners up-out to the platform underside (support read)
for sx in (-1, 1):
    for sy in (-1, 1):
        cbx, cby = sx * S2W / 2, sy * S2W / 2
        pbx, pby = sx * (PLW / 2 - 0.15), sy * (PLW / 2 - 0.15)
        dx, dy, dz = pbx - cbx, pby - cby, 0.28
        Lc = math.sqrt(dx * dx + dy * dy + dz * dz)
        cb = box("corbel", ((cbx + pbx) / 2, (cby + pby) / 2, z_plat0 - 0.14), (Lc * 0.8, 0.09, 0.09), M_TIMBER)
        cb.rotation_euler = (0, -math.atan2(dz, math.hypot(dx, dy)) * (1 if sx * sy > 0 else 1), math.atan2(dy, dx))
        TIMBER_PARTS.append(cb)
# railing: posts around the perimeter (4 sides, 3 posts/side incl. corners) + top/mid rail rings
n_per_side = 3
positions = []
half = PLW / 2 - 0.1
for i in range(n_per_side):
    u = -half + (2 * half) * i / (n_per_side - 1)
    positions.append((u, half)); positions.append((u, -half)); positions.append((half, u)); positions.append((-half, u))
seen = set()
for (px, py) in positions:
    key = (round(px, 2), round(py, 2))
    if key in seen: continue
    seen.add(key)
    rp = box("railpost", (px, py, z_rail0 + RAIL_H / 2), (POST, POST, RAIL_H), M_TIMBER)
    TIMBER_PARTS.append(rp)
for zc in (z_rail0 + RAIL_H - 0.08, z_rail0 + RAIL_H * 0.5):
    for sy in (-1, 1):
        r = box("railtop", (0, sy * half, zc), (2 * half, 0.06, 0.06), M_TIMBER); TIMBER_PARTS.append(r)
    for sx in (-1, 1):
        r = box("railtops", (sx * half, 0, zc), (0.06, 2 * half, 0.06), M_TIMBER); TIMBER_PARTS.append(r)

# ---- ROOF: hipped pyramid on the rail ring, generous overhang -----------------
bpy.ops.mesh.primitive_cone_add(vertices=4, radius1=ROOF_EAVE_W * 0.7071, radius2=0.05, depth=ROOF_RISE,
                                  location=(0, 0, z_roof0 + ROOF_RISE / 2), rotation=(0, 0, math.pi / 4))
roof = bpy.context.active_object; roof.name = "Roof"; roof.data.materials.append(M_ROOF)
# bake the 45deg rotation into the mesh itself (location stays a clean node transform): otherwise the
# rotation survives as an UNAPPLIED node-level transform in the export, and the local mesh AABB is a
# diamond's bounding SQUARE (not its actual footprint) -- any tool that unions the 8 local-box corners
# (rather than true per-vertex world positions) then overestimates this rotated primitive's world extent
# by sqrt(2). Baking rotation collapses local-box-corners back to the true (tight) footprint.
bpy.context.view_layer.objects.active = roof
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)

# ---- join same-material groups into clean final objects -----------------------
base_j = join_all(STONE_PARTS, "Base")
shaft_j = join_all(TIMBER_PARTS, "Shaft")

cube_uv(base_j, 1.0); bevel(base_j, 0.02, 1)
cube_uv(shaft_j, 1.0); bevel(shaft_j, 0.015, 1)
cube_uv(roof, 1.0)

# ---- export (Y-up, embedded/packed textures) -----------------------------------
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_yup=True, export_apply=True)
print(f"watchtower: wrote {OUT}")
