# blender_building.py — DE-RISK SPIKE: the build agent authoring a BESPOKE medieval cottage as a whole GLB
# through headless Blender (bpy), the way it currently hand-codes Three.js — but with a real modeler's tools
# (booleans, bevels, solidify, per-face materials). The engine only CONSUMES the exported GLB; Blender is an
# OFFLINE authoring hand (like asset-fetch / the rigger), never a runtime dep or an in-engine generator.
#
#   blender --background --factory-startup --python tools/build/blender_building.py -- --out assets/<x>.glb
#
# This is ONE authored building (a stone cottage with a pitched gable roof), not a general parametric
# generator. Materials are solid PBR for the spike; texture baking is the next layer (surface, not shape).

import bpy, bmesh, sys, math
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[argv.index("--out") + 1] if "--out" in argv else "assets/cottage-blender-1.glb"

# ---- clean scene -------------------------------------------------------------
bpy.ops.object.select_all(action="SELECT"); bpy.ops.object.delete()
for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.objects):
    for d in list(coll):
        try: coll.remove(d)
        except Exception: pass

def mat(name, rgb, rough=0.85, metal=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (*rgb, 1.0)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    return m
M_STONE = mat("Stone", (0.56, 0.53, 0.48), 0.92)
M_ROOF  = mat("Slate", (0.20, 0.22, 0.25), 0.65)
M_WOOD  = mat("Wood",  (0.28, 0.17, 0.09), 0.8)
M_DARK  = mat("Glass", (0.06, 0.07, 0.09), 0.3)

def box(name, center, size, material=None):
    """Axis-aligned box, `size` = full extents."""
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=center)
    o = bpy.context.active_object; o.name = name
    o.scale = (size[0], size[1], size[2])
    bpy.ops.object.transform_apply(scale=True)
    if material: o.data.materials.append(material)
    return o

def boolean(target, cutter, op="DIFFERENCE"):
    m = target.modifiers.new("bool", "BOOLEAN"); m.operation = op; m.object = cutter; m.solver = "EXACT"
    bpy.context.view_layer.objects.active = target
    bpy.ops.object.modifier_apply(modifier=m.name)
    bpy.data.objects.remove(cutter, do_unlink=True)

def bevel(o, width=0.03, segs=2):
    bpy.context.view_layer.objects.active = o
    m = o.modifiers.new("bev", "BEVEL"); m.width = width; m.segments = segs; m.limit_method = "ANGLE"
    bpy.ops.object.modifier_apply(modifier=m.name)

# ---- dimensions (metres) -----------------------------------------------------
W, D, H, T = 6.0, 4.5, 3.0, 0.32           # footprint W×D, wall height, wall thickness
PITCH, EAVE = 2.1, 0.45                      # roof rise, eaves/verge overhang

# ---- walls: solid block hollowed by an inner cutter, then openings -----------
walls = box("Walls", (0, 0, H/2), (W, D, H), M_STONE)
inner = box("Inner", (0, 0, H/2 + 0.2), (W - 2*T, D - 2*T, H))   # hollow (leave a floor lip)
boolean(walls, inner)

# door (front = +Y) + windows (front + gable sides). Cut, then inset a panel.
def opening(cx, cz, w, h, face, panel_mat):
    if face == "front":  # +Y wall
        cutter = box("cut", (cx, D/2, cz), (w, T*3, h))
        boolean(walls, cutter)
        box("panel", (cx, D/2 - T*0.35, cz), (w*0.92, 0.06, h*0.92), panel_mat)
    elif face == "side":  # +X or -X wall; cx is the sign
        sgn = cx
        cutter = box("cut", (sgn*W/2, 0, cz), (T*3, w, h))
        boolean(walls, cutter)
        box("panel", (sgn*(W/2 - T*0.35), 0, cz), (0.06, w*0.92, h*0.92), panel_mat)

opening(0.0, 1.05, 1.05, 2.05, "front", M_WOOD)     # door
opening(-1.9, 1.7, 0.9, 0.95, "front", M_DARK)      # front window L
opening(1.9, 1.7, 0.9, 0.95, "front", M_DARK)       # front window R
opening(1, 1.7, 0.9, 0.95, "side", M_DARK)          # +X side window
bevel(walls, 0.025, 2)

# ---- roof: solid triangular prism (ridge along X) → fills gables, has slopes -
me = bpy.data.meshes.new("Roof"); roof = bpy.data.objects.new("Roof", me)
bpy.context.collection.objects.link(roof)
xL, xR = -(W/2 + EAVE), (W/2 + EAVE)
yF, yB = (D/2 + EAVE), -(D/2 + EAVE)
zb, zt = H - 0.05, H + PITCH
bm = bmesh.new()
# 6 verts: (base-front, base-back, apex) at each X end
vs = [bm.verts.new(p) for p in [
    (xL, yF, zb), (xL, yB, zb), (xL, 0, zt),   # left end
    (xR, yF, zb), (xR, yB, zb), (xR, 0, zt)]]  # right end
bm.faces.new((vs[0], vs[1], vs[2]))            # left gable triangle
bm.faces.new((vs[3], vs[5], vs[4]))            # right gable triangle
slope_f = bm.faces.new((vs[0], vs[2], vs[5], vs[3]))  # front slope
slope_b = bm.faces.new((vs[1], vs[4], vs[5], vs[2]))  # back slope
bm.faces.new((vs[0], vs[3], vs[4], vs[1]))     # bottom (sits on walls)
bm.to_mesh(me); bm.free()
me.materials.append(M_ROOF); me.materials.append(M_STONE)  # 0=slate, 1=stone(gables)
# gable triangles (face idx 0,1) → stone; the rest → slate
for i, f in enumerate(me.polygons):
    f.material_index = 1 if i in (0, 1) else 0
bevel(roof, 0.05, 1)

# ---- chimney on the +X gable -------------------------------------------------
box("Chimney", (W/2 - 0.5, D/2 - 0.9, H + PITCH*0.7), (0.7, 0.7, PITCH*1.5), M_STONE)
bevel(bpy.data.objects["Chimney"], 0.03, 1)

# ---- export GLB (Y-up, embedded materials) -----------------------------------
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_yup=True, export_apply=True)
print(f"blender_building: wrote {OUT}")
