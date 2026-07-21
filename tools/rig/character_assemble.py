# character_assemble.py — compose modular character PARTS into ONE rigged, animated NPC GLB.
#
#   blender --background --factory-startup --python tools/rig/character_assemble.py -- \
#       --spec <spec.json> --parts-dir <dir> --out assets/<npc>.glb [--height 1.75]
#
# The humanoid analogue of the building.assemble kit-parts pattern: an agent's feature spec selects
# authored PART GLBs (a body + head + hair + garments + accessories), each modelled to the FROZEN rig
# contract (rig_contract.py — arms-down, feet at z=0, height-normalised). This script loads the chosen
# parts, joins them into one mesh, builds ONE instance of the shared biped, skins with automatic
# weights, applies the spec's per-zone outfit tints + skin tone, copies in the deterministic Idle/Walk,
# and exports one GLB the Character AssetSource consumes. Build → bake → QC → import, like every asset.
#
# spec.json (the realized slice of CharacterBrief.appearance):
#   { "height": 1.75,
#     "parts": ["body.villager.m", "head.weathered.02", "hair.short.grey", "tunic.wool", "hose.oatmeal", "boots.brown"],
#     "skinTone": [0.80, 0.62, 0.50],                         # linear rgb, optional
#     "outfit": { "tunic": [0.31,0.36,0.45], "hose": [0.62,0.58,0.47], "boots": [0.24,0.16,0.11] } }
# Each parts entry resolves to <parts-dir>/<id>.glb. A part whose id starts with an outfit-zone name
# (tunic/hose/boots/cloak/robe/hat/apron…) is tinted by that zone's colour if the spec supplies one.

import bpy, sys, os, json
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rig_contract as RC

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
def arg(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default

SPEC_PATH = arg("--spec"); PARTS_DIR = arg("--parts-dir"); OUT = arg("--out")
if not SPEC_PATH or not PARTS_DIR or not OUT:
    print("character_assemble: --spec, --parts-dir and --out are required"); sys.exit(2)
with open(SPEC_PATH) as fh:
    spec = json.load(fh)
TARGET_H = float(arg("--height", str(spec.get("height", 1.75))))
parts = spec.get("parts", [])
if not parts:
    print("character_assemble: spec has no parts"); sys.exit(2)

# ---- clean the factory scene -------------------------------------------------
bpy.ops.object.select_all(action="SELECT"); bpy.ops.object.delete()
for coll in (bpy.data.meshes, bpy.data.armatures, bpy.data.actions, bpy.data.materials, bpy.data.images):
    for d in list(coll): coll.remove(d)

# ---- import every part; remember which mesh objects came from which part id ----
part_objs = {}  # part_id -> [mesh objects]
for pid in parts:
    path = os.path.join(PARTS_DIR, pid + ".glb")
    if not os.path.exists(path):
        print(f"character_assemble: MISSING part {pid} at {path}"); sys.exit(2)
    before = set(o.name for o in bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.context.scene.objects if o.name not in before and o.type == "MESH"]
    if not new:
        print(f"character_assemble: part {pid} imported no mesh"); sys.exit(2)
    part_objs[pid] = new

# Apply import transforms so bbox math is world-space.
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# ---- per-part outfit / skin tint BEFORE joining (so a zone colours only its own part) ----
def solid_material(name, rgb):
    m = bpy.data.materials.new(name); m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    if bsdf: bsdf.inputs["Base Color"].default_value = (rgb[0], rgb[1], rgb[2], 1.0)
    m.diffuse_color = (rgb[0], rgb[1], rgb[2], 1.0)
    return m

outfit = spec.get("outfit", {}) or {}
skin = spec.get("skinTone")
ZONE_PREFIXES = ("tunic", "hose", "boots", "cloak", "robe", "hat", "apron", "belt", "gloves", "mail")
for pid, objs in part_objs.items():
    tint = None
    for zone in ZONE_PREFIXES:
        if pid.startswith(zone) and zone in outfit:
            tint = outfit[zone]; break
    if tint is None and skin is not None and (pid.startswith("body") or pid.startswith("head") or pid.startswith("hand")):
        tint = skin  # bare skin parts pick up the skin tone
    if tint is not None:
        mat = solid_material("tint_" + pid, tint)
        for o in objs:
            o.data.materials.clear(); o.data.materials.append(mat)

# ---- join all parts into one mesh --------------------------------------------
all_meshes = [o for objs in part_objs.values() for o in objs]
bpy.ops.object.select_all(action="DESELECT")
for o in all_meshes: o.select_set(True)
bpy.context.view_layer.objects.active = all_meshes[0]
if len(all_meshes) > 1: bpy.ops.object.join()
mesh = bpy.context.view_layer.objects.active
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# ---- normalize height + drop feet to z=0 (Blender Z-up after glTF Y-up import) ----
bb = [mesh.matrix_world @ Vector(c) for c in mesh.bound_box]
minz = min(v.z for v in bb); maxz = max(v.z for v in bb)
minx = min(v.x for v in bb); maxx = max(v.x for v in bb)
miny = min(v.y for v in bb); maxy = max(v.y for v in bb)
H0 = maxz - minz; W = maxx - minx; cx = (minx + maxx) / 2.0; cy = (miny + maxy) / 2.0
if H0 < 1e-4: print("character_assemble: degenerate height"); sys.exit(2)
s = TARGET_H / H0
mesh.scale = (s, s, s); bpy.ops.object.transform_apply(scale=True)
bb = [mesh.matrix_world @ Vector(c) for c in mesh.bound_box]
minz = min(v.z for v in bb)
mesh.location.z -= minz; bpy.ops.object.transform_apply(location=True)
H = TARGET_H; W = W * s

# ---- build ONE shared biped, skin with automatic weights ---------------------
arm_data = bpy.data.armatures.new("CharacterArmature")
arm = bpy.data.objects.new("CharacterArmature", arm_data)
bpy.context.collection.objects.link(arm)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="EDIT")
RC.build_biped(arm_data.edit_bones, H, W, cx, cy)
bpy.ops.object.mode_set(mode="OBJECT")

bpy.ops.object.select_all(action="DESELECT")
mesh.select_set(True); arm.select_set(True)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.parent_set(type="ARMATURE_AUTO")

RC.reassign_skirt_to_hips(mesh)
RC.build_locomotion(bpy, arm, H)

# ---- export: GLB, Y-up, embedded, BOTH clips ---------------------------------
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(
    filepath=OUT, export_format="GLB", export_yup=True,
    export_animations=True, export_animation_mode="ACTIONS",
    export_bake_animation=True, export_apply=False,
)
print(f"character_assemble: wrote {OUT} (H={TARGET_H} parts={len(parts)} clips=Idle,Walk bones={len(arm_data.bones)})")
