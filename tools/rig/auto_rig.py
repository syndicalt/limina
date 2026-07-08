# auto_rig.py — turn a STATIC humanoid GLB (e.g. a 3D AI Studio image-to-3D commoner) into a RIGGED,
# ANIMATED GLB that world/character-body.ts consumes directly. Self-hosted, non-Adobe (Blender only).
#
#   blender --background --factory-startup --python tools/rig/auto_rig.py -- \
#       --in assets/<static>.glb --out assets/<rigged>.glb [--height 1.75]
#
# Pipeline: import GLB (Y-up) → join meshes → normalize height → build a parametric BIPED armature fit to
# the mesh bounding box → parent with AUTOMATIC WEIGHTS (bone-heat skinning) → author looping Idle + Walk
# actions as pose-bone keyframes → export GLB (Y-up, embedded PBR textures, both clips as named animations).
# character-body.findClip matches "idle"/"walk" by name, so the actions are named exactly that.
#
# v1 scope: a single standard biped, procedural (deterministic, no external mocap) Idle/Walk. Weight quality
# on a legs-together generated mesh is approximate — good at gameplay distance; a dedicated hand/finger or
# face rig is out of scope. Everything is parametric on the bbox so it generalises to other humanoids.

import bpy, sys, math, os
from mathutils import Vector

# THE shared rig contract (one source of truth with character_assemble.py). Import from alongside
# this script regardless of Blender's cwd.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rig_contract as RC

# ---- args (after the `--`) --------------------------------------------------
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
def arg(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default
IN = arg("--in"); OUT = arg("--out"); TARGET_H = float(arg("--height", "1.75"))
if not IN or not OUT:
    print("auto_rig: --in and --out are required"); sys.exit(2)

# ---- clean the factory scene -------------------------------------------------
bpy.ops.object.select_all(action="SELECT"); bpy.ops.object.delete()
for coll in (bpy.data.meshes, bpy.data.armatures, bpy.data.actions):
    for d in list(coll): coll.remove(d)

# ---- import + join meshes ----------------------------------------------------
bpy.ops.import_scene.gltf(filepath=IN)
meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
if not meshes:
    print("auto_rig: no mesh in", IN); sys.exit(2)
bpy.ops.object.select_all(action="DESELECT")
for m in meshes: m.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
if len(meshes) > 1: bpy.ops.object.join()
mesh = bpy.context.view_layer.objects.active
# Apply any import transform so bbox math is in world space.
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# ---- bbox (Blender is Z-up after the glTF Y-up import) -----------------------
bb = [mesh.matrix_world @ Vector(c) for c in mesh.bound_box]
minz = min(v.z for v in bb); maxz = max(v.z for v in bb)
minx = min(v.x for v in bb); maxx = max(v.x for v in bb)
miny = min(v.y for v in bb); maxy = max(v.y for v in bb)
H = maxz - minz; W = maxx - minx; cx = (minx + maxx) / 2.0; cy = (miny + maxy) / 2.0
if H < 1e-4: print("auto_rig: degenerate height"); sys.exit(2)

# Normalize to TARGET_H and drop feet to z=0 so the rig math is in real metres.
s = TARGET_H / H
mesh.scale = (s, s, s)
bpy.ops.object.transform_apply(scale=True)
bb = [mesh.matrix_world @ Vector(c) for c in mesh.bound_box]
minz = min(v.z for v in bb); maxz = max(v.z for v in bb)
mesh.location.z -= minz
bpy.ops.object.transform_apply(location=True)
H = TARGET_H; W = W * s

# ---- parametric biped armature — THE shared rig contract (rig_contract.build_biped) ----
arm_data = bpy.data.armatures.new("CharacterArmature")
arm = bpy.data.objects.new("CharacterArmature", arm_data)
bpy.context.collection.objects.link(arm)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="EDIT")
RC.build_biped(arm_data.edit_bones, H, W, cx, cy)
bpy.ops.object.mode_set(mode="OBJECT")

# ---- skin: automatic (bone-heat) weights -------------------------------------
bpy.ops.object.select_all(action="DESELECT")
mesh.select_set(True); arm.select_set(True)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.parent_set(type="ARMATURE_AUTO")

# ---- skirt cleanup + Idle/Walk — THE shared rig contract (one source of truth) ----
RC.reassign_skirt_to_hips(mesh)
RC.build_locomotion(bpy, arm, H)

# ---- export: GLB, Y-up, embedded textures, BOTH actions as named clips --------
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(
    filepath=OUT, export_format="GLB", export_yup=True,
    export_animations=True, export_animation_mode="ACTIONS",
    export_bake_animation=True, export_apply=False,
)
print(f"auto_rig: wrote {OUT} (H={TARGET_H} clips=Idle,Walk bones={len(arm_data.bones)})")
