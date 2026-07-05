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

import bpy, sys, math
from mathutils import Vector

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
half = max(W * 0.5, 0.12)

# ---- parametric biped armature (heights are fractions of H from the feet) ----
arm_data = bpy.data.armatures.new("CharacterArmature")
arm = bpy.data.objects.new("CharacterArmature", arm_data)
bpy.context.collection.objects.link(arm)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="EDIT")
eb = arm_data.edit_bones

def bone(name, head, tail, parent=None):
    b = eb.new(name)
    b.head = Vector((head[0] + cx, head[1] + cy, head[2]))
    b.tail = Vector((tail[0] + cx, tail[1] + cy, tail[2]))
    if parent: b.parent = parent; b.use_connect = False
    return b

hipZ, chestZ, neckZ, headZ = 0.53*H, 0.70*H, 0.82*H, 0.88*H
kneeZ, ankleZ = 0.28*H, 0.04*H
shoZ, elbowZ, wristZ = 0.80*H, 0.62*H, 0.45*H
legX, shoX = half*0.42, half*0.80

pelvis = bone("Hips",    (0, 0, hipZ),  (0, 0, hipZ+0.04*H))
spine  = bone("Spine",   (0, 0, hipZ),  (0, 0, chestZ), pelvis)
chest  = bone("Chest",   (0, 0, chestZ),(0, 0, neckZ),  spine)
neck   = bone("Neck",    (0, 0, neckZ), (0, 0, headZ),  chest)
head_b = bone("Head",    (0, 0, headZ), (0, 0, 0.98*H), neck)
for sgn, sfx in ((-1, "L"), (1, "R")):
    ul = bone(f"UpperLeg_{sfx}", (sgn*legX, 0, hipZ),   (sgn*legX, 0, kneeZ),  pelvis)
    ll = bone(f"LowerLeg_{sfx}", (sgn*legX, 0, kneeZ),  (sgn*legX, 0, ankleZ), ul)
    bone(f"Foot_{sfx}",          (sgn*legX, 0, ankleZ), (sgn*legX, -0.12*H, 0.01*H), ll)
    ua = bone(f"UpperArm_{sfx}", (sgn*shoX, 0, shoZ),   (sgn*shoX, 0, elbowZ), chest)
    la = bone(f"LowerArm_{sfx}", (sgn*shoX, 0, elbowZ), (sgn*shoX, 0, wristZ), ua)
    bone(f"Hand_{sfx}",          (sgn*shoX, 0, wristZ), (sgn*shoX, 0, wristZ-0.06*H), la)
bpy.ops.object.mode_set(mode="OBJECT")

# ---- skin: automatic (bone-heat) weights -------------------------------------
bpy.ops.object.select_all(action="DESELECT")
mesh.select_set(True); arm.select_set(True)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.parent_set(type="ARMATURE_AUTO")

# ---- skirt cleanup: cloth pulled by BOTH legs is a hanging tunic/robe, not a leg — reassign its leg
#      weight to Hips so a long garment sways with the body instead of tearing between the two legs.
vg = mesh.vertex_groups
name2idx = {g.name: g.index for g in vg}
left = [name2idx[n] for n in ("UpperLeg_L", "LowerLeg_L", "Foot_L") if n in name2idx]
right = [name2idx[n] for n in ("UpperLeg_R", "LowerLeg_R", "Foot_R") if n in name2idx]
hips_i = name2idx.get("Hips")
if hips_i is not None:
    for v in mesh.data.vertices:
        w = {g.group: g.weight for g in v.groups}
        lw = sum(w.get(i, 0.0) for i in left); rw = sum(w.get(i, 0.0) for i in right)
        if min(lw, rw) > 0.12:  # both legs pull it → skirt/crotch cloth
            moved = lw + rw
            for i in left + right:
                if i in w: vg[i].remove([v.index])
            vg[hips_i].add([v.index], moved, "ADD")

# ---- author looping Idle + Walk as pose-bone keyframes -----------------------
scene = bpy.context.scene; scene.render.fps = 30
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="POSE")
pb = arm.pose.bones
for b in pb: b.rotation_mode = "XYZ"

def key(bone_name, frame, rx=0.0, ry=0.0, rz=0.0, loc=None):
    b = pb[bone_name]
    b.rotation_euler = (rx, ry, rz)
    b.keyframe_insert("rotation_euler", frame=frame)
    if loc is not None:
        b.location = loc; b.keyframe_insert("location", frame=frame)

def new_action(name):
    act = bpy.data.actions.new(name)
    arm.animation_data_create(); arm.animation_data.action = act
    for b in pb:  # reset pose
        b.rotation_euler = (0, 0, 0); b.location = (0, 0, 0)
    return act

# WALK — 24-frame loop; thighs/arms swing about local X (sagittal), knees bend, hips bob.
walk = new_action("Walk")
A, K = 0.42, 0.6
for (f, l_th, r_th) in [(1, A, -A), (7, 0, 0), (13, -A, A), (19, 0, 0), (25, A, -A)]:
    key("UpperLeg_L", f, rx=l_th); key("UpperLeg_R", f, rx=r_th)
    key("UpperArm_L", f, rx=-r_th*0.9); key("UpperArm_R", f, rx=-l_th*0.9)
for (f, l_kn, r_kn) in [(1, 0.15, 0.5), (7, 0.15, K), (13, 0.5, 0.15), (19, K, 0.15), (25, 0.15, 0.5)]:
    key("LowerLeg_L", f, rx=l_kn); key("LowerLeg_R", f, rx=r_kn)
for (f, dz) in [(1, -0.02*H), (7, 0.01*H), (13, -0.02*H), (19, 0.01*H), (25, -0.02*H)]:
    key("Hips", f, loc=(0, 0, dz))

# IDLE — 60-frame loop; subtle breathing + arm micro-sway.
idle = new_action("Idle")
for (f, sx) in [(1, 0.0), (30, 0.04), (60, 0.0)]:
    key("Spine", f, rx=sx); key("Chest", f, rx=sx*0.5)
for (f, ax) in [(1, 0.03), (30, 0.07), (60, 0.03)]:
    key("UpperArm_L", f, rx=ax); key("UpperArm_R", f, rx=ax)

bpy.ops.object.mode_set(mode="OBJECT")

# ---- export: GLB, Y-up, embedded textures, BOTH actions as named clips --------
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(
    filepath=OUT, export_format="GLB", export_yup=True,
    export_animations=True, export_animation_mode="ACTIONS",
    export_bake_animation=True, export_apply=False,
)
print(f"auto_rig: wrote {OUT} (H={TARGET_H} clips=Idle,Walk bones={len(arm_data.bones)})")
