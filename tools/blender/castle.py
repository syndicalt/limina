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
MOTTE_H = 2.2
z0 = MOTTE_H                                 # keep sits on the motte top
TUR = 2.6; TURH = KH + 3.2                   # corner turret size, top height
PAR_H, MER_H, MER_W, GAP = 0.7, 0.9, 0.9, 0.7   # parapet, merlon height/width, crenel gap

# ---- motte (earthen mound) — a low frustum ----------------------------------
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
    brick = nds.new("ShaderNodeTexBrick"); brick.inputs["Scale"].default_value = 3.0
    brick.inputs["Mortar Size"].default_value = 0.028; brick.inputs["Bias"].default_value = 0.0
    brick.inputs["Brick Width"].default_value = 0.5; brick.inputs["Row Height"].default_value = 0.25
    brick.inputs["Color1"].default_value = (0.40, 0.36, 0.29, 1)
    brick.inputs["Color2"].default_value = (0.48, 0.44, 0.36, 1)
    brick.inputs["Mortar"].default_value = (0.17, 0.16, 0.14, 1)
    noise = nds.new("ShaderNodeTexNoise"); noise.inputs["Scale"].default_value = 10.0
    mul = nds.new("ShaderNodeMixRGB"); mul.blend_type = "MULTIPLY"; mul.inputs["Fac"].default_value = 0.22
    lk.new(brick.outputs["Color"], mul.inputs["Color1"]); lk.new(noise.outputs["Fac"], mul.inputs["Color2"])
    lk.new(mul.outputs["Color"], bsdf.inputs["Base Color"]); bsdf.inputs["Roughness"].default_value = 0.9
    bump = nds.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.5
    bmx = nds.new("ShaderNodeMixRGB"); bmx.inputs["Fac"].default_value = 0.35
    lk.new(brick.outputs["Fac"], bmx.inputs["Color1"]); lk.new(noise.outputs["Fac"], bmx.inputs["Color2"])
    lk.new(bmx.outputs["Color"], bump.inputs["Height"]); lk.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
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
