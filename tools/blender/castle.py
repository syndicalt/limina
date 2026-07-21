# castle.py — a fully-featured NORMAN KEEP authored in headless Blender, textured with baked ashlar.
# The build agent authoring a bespoke landmark as a whole GLB the engine consumes. Non-Adobe end to end.
#
#   blender --background --factory-startup --python tools/build/castle.py -- --out assets/norman-keep-1.glb
#
# Parts: square donjon (hollow walls) · clasping corner turrets w/ pyramidal caps · crenellated battlements
# (parapet + merlons) · pilaster buttresses · arrow-slits · round-arched forebuilding entrance + steps ·
# string courses · earthen motte. Masonry = a procedural ashlar tile baked once (albedo/normal/rough) then
# tiled across cube-projected UVs (REPEAT) at true world scale — so one small texture set covers everything.

import bpy, bmesh, sys, math
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[argv.index("--out") + 1] if "--out" in argv else "assets/norman-keep-1.glb"
TILE_M = 2.4  # world size one masonry tile covers

# ---- reset -------------------------------------------------------------------
bpy.ops.object.select_all(action="SELECT"); bpy.ops.object.delete()
for c in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
    for d in list(c):
        try: c.remove(d)
        except Exception: pass

def solid(name, rgb, rough=0.9, metal=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1); b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    return m
M_SLATE = solid("Slate", (0.19, 0.21, 0.25), 0.6)

# ---- geometry helpers --------------------------------------------------------
STONE_PARTS = []
def box(name, center, size, collect=True):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=center)
    o = bpy.context.active_object; o.name = name; o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    if collect: STONE_PARTS.append(o)
    return o

def boolean(target, cutter, op="DIFFERENCE"):
    md = target.modifiers.new("b", "BOOLEAN"); md.operation = op; md.object = cutter; md.solver = "EXACT"
    bpy.context.view_layer.objects.active = target
    bpy.ops.object.modifier_apply(modifier=md.name)
    bpy.data.objects.remove(cutter, do_unlink=True)

def bevel(o, w=0.03, s=1):
    bpy.context.view_layer.objects.active = o
    md = o.modifiers.new("bv", "BEVEL"); md.width = w; md.segments = s; md.limit_method = "ANGLE"
    bpy.ops.object.modifier_apply(modifier=md.name)

# ---- dimensions --------------------------------------------------------------
KW, KD, KH, T = 11.0, 11.0, 15.0, 1.2      # keep footprint, height, wall thickness
# --no-motte: omit the earthen mound so the keep sits directly on the ENGINE terrain (grass grows to its
# base). The baked-in motte only suits an isolated plane render; on real terrain it floats + takes no grass.
NO_MOTTE = "--no-motte" in argv
MOTTE_H = 0.0 if NO_MOTTE else 2.2
z0 = MOTTE_H                                 # keep base height (motte top, or ground)
TUR = 2.6; TURH = KH + 3.2                   # corner turret size, top height
PAR_H, MER_H, MER_W, GAP = 0.7, 0.9, 0.9, 0.7   # parapet, merlon height/width, crenel gap

# ---- motte (earthen mound) — a low frustum ----------------------------------
if not NO_MOTTE:
    bpy.ops.mesh.primitive_cone_add(vertices=48, radius1=15, radius2=11, depth=MOTTE_H, location=(0, 0, MOTTE_H/2))
    motte = bpy.context.active_object; motte.name = "Motte"
    motte.data.materials.append(solid("Earth", (0.30, 0.34, 0.17), 0.95))

# ---- keep: a SOLID block (exterior landmark; no interior yet) so every opening reads as a blind recess
#      rather than a see-through void into dark backfaces.
keep = box("Keep", (0, 0, z0 + KH/2), (KW, KD, KH))

# arrow-slits: thin tall recesses on all four faces, two courses
def slit(face_sgn, axis, u, z):
    if axis == "y":  # front/back faces (+/-Y)
        boolean(keep, box("s", (u, face_sgn*KD/2, z), (0.22, T*2.2, 1.7), collect=False))
    else:            # side faces (+/-X)
        boolean(keep, box("s", (face_sgn*KW/2, u, z), (T*2.2, 0.22, 1.7), collect=False))
for zc in (z0 + 5.2, z0 + 9.6):
    for u in (-2.6, 0, 2.6):
        slit(1, "y", u, zc); slit(-1, "y", u, zc)
        slit(1, "x", u, zc); slit(-1, "x", u, zc)

# round-arched upper windows on front (+Y) — arch = box minus a cylinder-topped cutter
def arch_opening(cx, cz, w, h, face="y", sgn=1, depth=T*2.2):
    rect = box("ar", (cx, sgn*KW/2, cz - 0.2) if face == "y" else (sgn*KW/2, cx, cz - 0.2),
               (w, depth, h) if face == "y" else (depth, w, h), collect=False)
    bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=w/2, depth=depth,
        location=(cx, sgn*KW/2, cz + h/2 - 0.2) if face == "y" else (sgn*KW/2, cx, cz + h/2 - 0.2),
        rotation=(math.pi/2, 0, 0) if face == "y" else (0, math.pi/2, 0))
    cyl = bpy.context.active_object
    md = rect.modifiers.new("u", "BOOLEAN"); md.operation = "UNION"; md.object = cyl; md.solver = "EXACT"
    bpy.context.view_layer.objects.active = rect; bpy.ops.object.modifier_apply(modifier=md.name)
    bpy.data.objects.remove(cyl, do_unlink=True)
    boolean(keep, rect)
arch_opening(-2.8, z0 + 11.0, 1.4, 1.8, "y", 1)
arch_opening(2.8, z0 + 11.0, 1.4, 1.8, "y", 1)

# pilaster buttresses — flat vertical strips, 2 per face between the corner turrets
for s in (-1, 1):
    for u in (-2.7, 2.7):
        box("bt", (u, s*(KD/2 + 0.2), z0 + KH/2 - 0.6), (1.1, 0.5, KH - 1.2))   # front/back
        box("bt", (s*(KW/2 + 0.2), u, z0 + KH/2 - 0.6), (0.5, 1.1, KH - 1.2))   # sides

# string courses — thin protruding rings at two levels
for zc in (z0 + 5.0, z0 + 10.0):
    box("sc", (0, 0, zc), (KW + 0.5, KD + 0.5, 0.35))
    boolean(STONE_PARTS[-1], box("sci", (0, 0, zc), (KW - 0.5, KD - 0.5, 0.9), collect=False))

# ---- crenellated battlements (parapet ring + merlons) ------------------------
def parapet_ring(cx, cy, zt, W, D, t, ph):
    box("pp", (cx, cy + D/2 - t/2, zt + ph/2), (W, t, ph))
    box("pp", (cx, cy - D/2 + t/2, zt + ph/2), (W, t, ph))
    box("pp", (cx + W/2 - t/2, cy, zt + ph/2), (t, D - 2*t, ph))
    box("pp", (cx - W/2 + t/2, cy, zt + ph/2), (t, D - 2*t, ph))

def merlons(cx, cy, zt, W, D, t, mh, mw, gap):
    zc = zt + PAR_H + mh/2
    n = max(1, int((W) // (mw + gap)))
    span = n * (mw + gap) - gap
    start = -span/2 + mw/2
    for i in range(n):
        u = start + i * (mw + gap)
        box("mr", (cx + u, cy + D/2 - t/2, zc), (mw, t, mh))
        box("mr", (cx + u, cy - D/2 + t/2, zc), (mw, t, mh))
        box("mr", (cx + D/2 - t/2, cy + u, zc), (t, mw, mh))
        box("mr", (cx - D/2 + t/2, cy + u, zc), (t, mw, mh))

parapet_ring(0, 0, z0 + KH, KW, KD, 0.5, PAR_H)
merlons(0, 0, z0 + KH, KW, KD, 0.5, MER_H, MER_W, GAP)

# ---- corner turrets (clasping) + pyramidal caps ------------------------------
caps = []
for sx in (-1, 1):
    for sy in (-1, 1):
        px, py = sx * (KW/2 - TUR/2), sy * (KD/2 - TUR/2)   # flush with the keep faces (clasping), rise above
        box("tur", (px, py, z0 + TURH/2), (TUR, TUR, TURH))
        parapet_ring(px, py, z0 + TURH, TUR, TUR, 0.35, 0.6)
        # pyramidal cap
        bpy.ops.mesh.primitive_cone_add(vertices=4, radius1=TUR*0.72, radius2=0, depth=1.8,
            location=(px, py, z0 + TURH + 0.9), rotation=(0, 0, math.pi/4))
        cap = bpy.context.active_object; cap.name = "cap"; cap.data.materials.append(M_SLATE); caps.append(cap)

# ---- forebuilding + round-arched entrance + steps ---------------------------
FB_W, FB_D, FB_H = 4.2, 3.0, 8.5
fy = KD/2 + FB_D/2 - 0.3
box("fb", (0, fy, z0 + FB_H/2), (FB_W, FB_D, FB_H))
# arched doorway through the forebuilding front
dz = z0 + 1.9
door_rect = box("dr", (0, fy + FB_D/2, dz - 0.4), (1.6, FB_D*1.4, 2.4), collect=False)
bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=0.8, depth=FB_D*1.4,
    location=(0, fy + FB_D/2, dz + 0.8), rotation=(math.pi/2, 0, 0))
cyl = bpy.context.active_object
md = door_rect.modifiers.new("u", "BOOLEAN"); md.operation = "UNION"; md.object = cyl; md.solver = "EXACT"
bpy.context.view_layer.objects.active = door_rect; bpy.ops.object.modifier_apply(modifier=md.name)
bpy.data.objects.remove(cyl, do_unlink=True)
# cut the doorway out of BOTH forebuilding and keep
boolean(STONE_PARTS[-1], door_rect)  # STONE_PARTS[-1] is the forebuilding box "fb"
# steps up the motte to the entrance — discrete stone treads descending outward to the ground
for i in range(7):
    zt = z0 + 0.2 - i * 0.32
    if zt <= 0.12: break
    box("step", (0, KD/2 + FB_D - 0.5 + i * 0.55, zt/2), (3.2, 0.6 + i*0.05, zt))

# timber door leaf set in the arch
door = box("Door", (0, fy + FB_D/2 - 0.15, dz - 0.3), (1.5, 0.18, 2.3), collect=False)
door.data.materials.append(solid("Wood", (0.24, 0.14, 0.07), 0.8))

# ---- join all stone parts into ONE object -----------------------------------
bpy.ops.object.select_all(action="DESELECT")
for o in STONE_PARTS: o.select_set(True)   # caps stay separate (slate), joined stone gets baked ashlar
bpy.context.view_layer.objects.active = STONE_PARTS[0]
bpy.ops.object.join()
stone = bpy.context.view_layer.objects.active; stone.name = "Keep"

# ---- bake a procedural ashlar TILE, then tile it across the stone ------------
def bake_tile(res=1024):
    bpy.ops.mesh.primitive_plane_add(size=2, location=(200, 0, 0))
    pl = bpy.context.active_object
    m = bpy.data.materials.new("proc"); m.use_nodes = True; nt = m.node_tree; nds = nt.nodes; lk = nt.links
    bsdf = nds["Principled BSDF"]
    # Irregular hand-laid ASHLAR (not subway tile): DOMAIN-WARPED joints + dressed calm faces + dark cavity
    # mortar (fake AO) + strong recess normal + subtle per-cell tone. See tools/blender/bake_test.py.
    def mix(a, b, fac, blend="MIX"):
        x = nds.new("ShaderNodeMixRGB"); x.blend_type = blend; x.inputs["Fac"].default_value = fac
        if isinstance(a, float): x.inputs["Color1"].default_value = (a, a, a, 1)
        else: lk.new(a, x.inputs["Color1"])
        if isinstance(b, tuple): x.inputs["Color2"].default_value = (*b, 1)
        elif isinstance(b, float): x.inputs["Color2"].default_value = (b, b, b, 1)
        else: lk.new(b, x.inputs["Color2"])
        return x.outputs["Color"]
    tc = nds.new("ShaderNodeTexCoord")
    wn = nds.new("ShaderNodeTexNoise"); wn.inputs["Scale"].default_value = 5.0; wn.inputs["Detail"].default_value = 3.0
    wsc = nds.new("ShaderNodeVectorMath"); wsc.operation = "SCALE"
    lk.new(wn.outputs["Color"], wsc.inputs[0]); wsc.inputs["Scale"].default_value = 0.065
    warp = nds.new("ShaderNodeVectorMath"); warp.operation = "ADD"
    lk.new(tc.outputs["UV"], warp.inputs[0]); lk.new(wsc.outputs["Vector"], warp.inputs[1]); WV = warp.outputs["Vector"]
    brick = nds.new("ShaderNodeTexBrick"); brick.inputs["Scale"].default_value = 2.1   # larger blocks (PG target)
    brick.inputs["Mortar Size"].default_value = 0.03; brick.inputs["Mortar Smooth"].default_value = 0.25
    brick.inputs["Brick Width"].default_value = 0.62; brick.inputs["Row Height"].default_value = 0.32
    brick.inputs["Color1"].default_value = (0.34, 0.345, 0.35, 1); brick.inputs["Color2"].default_value = (0.44, 0.445, 0.45, 1)
    brick.inputs["Mortar"].default_value = (0.13, 0.13, 0.135, 1)   # cool grey, thin dark-grey joints
    lk.new(WV, brick.inputs["Vector"]); fac = brick.outputs["Fac"]
    cells = nds.new("ShaderNodeTexVoronoi"); cells.inputs["Scale"].default_value = 4.0; lk.new(WV, cells.inputs["Vector"])
    cellv = nds.new("ShaderNodeRGBToBW"); lk.new(cells.outputs["Color"], cellv.inputs["Color"])
    cmap = nds.new("ShaderNodeMapRange"); lk.new(cellv.outputs["Val"], cmap.inputs["Value"])
    cmap.inputs["To Min"].default_value = 0.76; cmap.inputs["To Max"].default_value = 1.07
    weath = nds.new("ShaderNodeTexNoise"); weath.inputs["Scale"].default_value = 2.3; weath.inputs["Detail"].default_value = 8
    stain = nds.new("ShaderNodeValToRGB"); stain.color_ramp.elements[0].position = 0.4; stain.color_ramp.elements[1].position = 0.78
    lk.new(weath.outputs["Fac"], stain.inputs["Fac"])
    # vertical weathering streaks
    smap = nds.new("ShaderNodeMapping"); smap.inputs["Scale"].default_value = (2.5, 0.12, 2.5); lk.new(WV, smap.inputs["Vector"])
    sn = nds.new("ShaderNodeTexNoise"); sn.inputs["Scale"].default_value = 3.5; sn.inputs["Detail"].default_value = 5
    lk.new(smap.outputs["Vector"], sn.inputs["Vector"])
    sramp = nds.new("ShaderNodeValToRGB")
    sramp.color_ramp.elements[0].position = 0.32; sramp.color_ramp.elements[0].color = (0.55, 0.55, 0.58, 1)
    sramp.color_ramp.elements[1].position = 0.6;  sramp.color_ramp.elements[1].color = (1, 1, 1, 1)
    lk.new(sn.outputs["Fac"], sramp.inputs["Fac"])
    tint = mix(brick.outputs["Color"], cmap.outputs["Result"], 1.0, "MULTIPLY")
    grime = nds.new("ShaderNodeMixRGB"); grime.blend_type = "MULTIPLY"; lk.new(stain.outputs["Color"], grime.inputs["Fac"])
    lk.new(tint, grime.inputs["Color1"]); grime.inputs["Color2"].default_value = (0.74, 0.74, 0.76, 1)
    strk = nds.new("ShaderNodeMixRGB"); strk.blend_type = "MULTIPLY"; strk.inputs["Fac"].default_value = 0.7
    lk.new(grime.outputs["Color"], strk.inputs["Color1"]); lk.new(sramp.outputs["Color"], strk.inputs["Color2"])
    cav = nds.new("ShaderNodeMixRGB"); cav.blend_type = "MULTIPLY"; lk.new(fac, cav.inputs["Fac"])
    lk.new(strk.outputs["Color"], cav.inputs["Color1"]); cav.inputs["Color2"].default_value = (0.42, 0.42, 0.45, 1)
    lk.new(cav.outputs["Color"], bsdf.inputs["Base Color"])
    rgh = nds.new("ShaderNodeMixRGB"); rgh.inputs["Color1"].default_value = (0.84,)*3+(1,)
    lk.new(fac, rgh.inputs["Fac"]); rgh.inputs["Color2"].default_value = (0.97,)*3+(1,); lk.new(rgh.outputs["Color"], bsdf.inputs["Roughness"])
    inv = nds.new("ShaderNodeInvert"); lk.new(fac, inv.inputs["Color"])
    dome = nds.new("ShaderNodeTexVoronoi"); dome.feature = "DISTANCE_TO_EDGE"; dome.inputs["Scale"].default_value = 3.0; lk.new(WV, dome.inputs["Vector"])
    undul = nds.new("ShaderNodeTexNoise"); undul.inputs["Scale"].default_value = 13.0; undul.inputs["Detail"].default_value = 4
    grit = nds.new("ShaderNodeTexNoise"); grit.inputs["Scale"].default_value = 40; grit.inputs["Detail"].default_value = 6
    h1 = mix(inv.outputs["Color"], dome.outputs["Distance"], 0.05)   # faces stay FLAT (dressed ashlar)
    b1 = nds.new("ShaderNodeBump"); b1.inputs["Strength"].default_value = 1.35; b1.inputs["Distance"].default_value = 0.13; lk.new(h1, b1.inputs["Height"])
    h2 = mix(undul.outputs["Fac"], grit.outputs["Fac"], 0.6)
    b2 = nds.new("ShaderNodeBump"); b2.inputs["Strength"].default_value = 0.11
    lk.new(h2, b2.inputs["Height"]); lk.new(b1.outputs["Normal"], b2.inputs["Normal"]); lk.new(b2.outputs["Normal"], bsdf.inputs["Normal"])
    pl.data.materials.append(m)
    sc = bpy.context.scene; sc.render.engine = "CYCLES"; sc.cycles.device = "CPU"; sc.cycles.samples = 16
    imgs = {}
    for bt, nm, nc, extra in [("DIFFUSE", "alb", False, {"pass_filter": {"COLOR"}}),
                              ("NORMAL", "nrm", True, {}), ("ROUGHNESS", "rgh", True, {})]:
        img = bpy.data.images.new(nm, res, res); img.colorspace_settings.name = "Non-Color" if nc else "sRGB"
        tx = nt.nodes.new("ShaderNodeTexImage"); tx.image = img; tx.select = True; nt.nodes.active = tx
        bpy.context.view_layer.objects.active = pl
        bpy.ops.object.bake(type=bt, width=res, height=res, margin=4, use_clear=True, **extra)
        imgs[nm] = img
    bpy.data.objects.remove(pl, do_unlink=True)
    return imgs

tile = bake_tile()
for im in tile.values(): im.pack()

# stone material: tiling images at world scale (1 tile = TILE_M metres)
sm = bpy.data.materials.new("Ashlar"); sm.use_nodes = True; nt = sm.node_tree; n = nt.nodes; l = nt.links
b = n["Principled BSDF"]
uv = n.new("ShaderNodeTexCoord"); mp = n.new("ShaderNodeMapping")
mp.inputs["Scale"].default_value = (1.0/TILE_M, 1.0/TILE_M, 1.0/TILE_M)
l.new(uv.outputs["UV"], mp.inputs["Vector"])
def tex(img, non_color):
    t = n.new("ShaderNodeTexImage"); t.image = img; t.extension = "REPEAT"
    if non_color: t.image.colorspace_settings.name = "Non-Color"
    l.new(mp.outputs["Vector"], t.inputs["Vector"]); return t
l.new(tex(tile["alb"], False).outputs["Color"], b.inputs["Base Color"])
l.new(tex(tile["rgh"], True).outputs["Color"], b.inputs["Roughness"])
nmn = n.new("ShaderNodeNormalMap"); l.new(tex(tile["nrm"], True).outputs["Color"], nmn.inputs["Color"])
l.new(nmn.outputs["Normal"], b.inputs["Normal"])

# cube-project the whole keep at world scale (1 UV unit = 1 m), then the Mapping scale tiles it
bpy.context.view_layer.objects.active = stone
bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.cube_project(cube_size=1.0, correct_aspect=True, scale_to_bounds=False)
bpy.ops.object.mode_set(mode="OBJECT")
stone.data.materials.clear(); stone.data.materials.append(sm)
bevel(stone, 0.02, 1)

# ---- export ------------------------------------------------------------------
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_yup=True, export_apply=True)
print(f"castle: wrote {OUT}")
