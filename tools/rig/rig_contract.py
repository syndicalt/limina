# rig_contract.py — THE FROZEN RIG CONTRACT for every limina humanoid (the NPC character designer).
#
# ONE source of truth for the shared skeleton every authored character part is weighted to, and every
# assembly/rig script builds. auto_rig.py (rig a whole static humanoid) and character_assemble.py
# (compose modular parts → one rigged NPC) both import this, so a part authored to fit the rig and the
# rig the engine consumes can never drift. character-body.ts (the engine consumer) matches clips by the
# names "Idle"/"Walk" declared here.
#
# THE CONTRACT (do not change without re-authoring every part + re-baking every character GLB):
#   • Skeleton: a single standard biped, 17 bones (BONE_NAMES), parented as PARENT_OF.
#   • Bone positions are FRACTIONS of the character's standing height H, measured from the feet (z=0),
#     so the same rig fits any height. Lateral offsets scale with the mesh half-width.
#   • Rest pose: ARMS DOWN at the sides (an A-/relaxed pose, NOT a T-pose) — the arm bones point from
#     the shoulder DOWN to the elbow. Parts MUST be modelled arms-down to match, or auto-weights tear.
#   • Author-space: Blender Z-up, feet at z=0, height-normalised to the target height, facing -Y
#     (glTF Y-up +Z-forward after export). Meshes are joined before skinning.
#   • Clips: "Idle" (60-frame breathing loop) + "Walk" (24-frame stride), procedural + deterministic
#     (no external mocap), authored by build_locomotion(). Exported as named glTF animations.

from mathutils import Vector

# ── The 17-bone biped, in creation order (parents precede children). ──────────────────────────────
BONE_NAMES = [
    "Hips", "Spine", "Chest", "Neck", "Head",
    "UpperLeg_L", "LowerLeg_L", "Foot_L", "UpperArm_L", "LowerArm_L", "Hand_L",
    "UpperLeg_R", "LowerLeg_R", "Foot_R", "UpperArm_R", "LowerArm_R", "Hand_R",
]
PARENT_OF = {
    "Spine": "Hips", "Chest": "Spine", "Neck": "Chest", "Head": "Neck",
    "UpperLeg_L": "Hips", "LowerLeg_L": "UpperLeg_L", "Foot_L": "LowerLeg_L",
    "UpperArm_L": "Chest", "LowerArm_L": "UpperArm_L", "Hand_L": "LowerArm_L",
    "UpperLeg_R": "Hips", "LowerLeg_R": "UpperLeg_R", "Foot_R": "LowerLeg_R",
    "UpperArm_R": "Chest", "LowerArm_R": "UpperArm_R", "Hand_R": "LowerArm_R",
}

# ── Vertical joint heights as fractions of H (from the feet). ──────────────────────────────────────
HIP_F, CHEST_F, NECK_F, HEAD_F, HEADTOP_F = 0.53, 0.70, 0.82, 0.88, 0.98
KNEE_F, ANKLE_F = 0.28, 0.04
SHOULDER_F, ELBOW_F, WRIST_F = 0.80, 0.62, 0.45
# ── Lateral offsets as fractions of the mesh half-width. ─────────────────────────────────────────
LEG_X_F, SHOULDER_X_F = 0.42, 0.80

CLIP_IDLE = "Idle"
CLIP_WALK = "Walk"
FPS = 30


def half_width(mesh_width):
    """The lateral half-width the limb offsets scale against (floored so a legs-together mesh still
    gets shoulders/hips apart)."""
    return max(mesh_width * 0.5, 0.12)


def build_biped(edit_bones, H, W, cx, cy):
    """Create the frozen 17-bone biped in `edit_bones` (armature EDIT mode). H = standing height (m),
    W = mesh width, (cx,cy) = mesh horizontal centre. Returns the {name: EditBone} map. This is the
    ONE definition — auto_rig.py and character_assemble.py both call it."""
    half = half_width(W)
    hipZ, chestZ, neckZ, headZ = HIP_F * H, CHEST_F * H, NECK_F * H, HEAD_F * H
    kneeZ, ankleZ = KNEE_F * H, ANKLE_F * H
    shoZ, elbowZ, wristZ = SHOULDER_F * H, ELBOW_F * H, WRIST_F * H
    legX, shoX = half * LEG_X_F, half * SHOULDER_X_F

    def bone(name, head, tail, parent=None):
        b = edit_bones.new(name)
        b.head = Vector((head[0] + cx, head[1] + cy, head[2]))
        b.tail = Vector((tail[0] + cx, tail[1] + cy, tail[2]))
        if parent:
            b.parent = parent
            b.use_connect = False
        return b

    bones = {}
    bones["Hips"] = bone("Hips", (0, 0, hipZ), (0, 0, hipZ + 0.04 * H))
    bones["Spine"] = bone("Spine", (0, 0, hipZ), (0, 0, chestZ), bones["Hips"])
    bones["Chest"] = bone("Chest", (0, 0, chestZ), (0, 0, neckZ), bones["Spine"])
    bones["Neck"] = bone("Neck", (0, 0, neckZ), (0, 0, headZ), bones["Chest"])
    bones["Head"] = bone("Head", (0, 0, headZ), (0, 0, HEADTOP_F * H), bones["Neck"])
    for sgn, sfx in ((-1, "L"), (1, "R")):
        ul = bone(f"UpperLeg_{sfx}", (sgn * legX, 0, hipZ), (sgn * legX, 0, kneeZ), bones["Hips"])
        ll = bone(f"LowerLeg_{sfx}", (sgn * legX, 0, kneeZ), (sgn * legX, 0, ankleZ), ul)
        ft = bone(f"Foot_{sfx}", (sgn * legX, 0, ankleZ), (sgn * legX, -0.12 * H, 0.01 * H), ll)
        ua = bone(f"UpperArm_{sfx}", (sgn * shoX, 0, shoZ), (sgn * shoX, 0, elbowZ), bones["Chest"])
        la = bone(f"LowerArm_{sfx}", (sgn * shoX, 0, elbowZ), (sgn * shoX, 0, wristZ), ua)
        hd = bone(f"Hand_{sfx}", (sgn * shoX, 0, wristZ), (sgn * shoX, 0, wristZ - 0.06 * H), la)
        bones[f"UpperLeg_{sfx}"], bones[f"LowerLeg_{sfx}"], bones[f"Foot_{sfx}"] = ul, ll, ft
        bones[f"UpperArm_{sfx}"], bones[f"LowerArm_{sfx}"], bones[f"Hand_{sfx}"] = ua, la, hd
    return bones


def reassign_skirt_to_hips(mesh):
    """Cloth pulled by BOTH legs is a hanging tunic/robe, not a leg — move its leg weight to Hips so a
    long garment sways with the body instead of tearing between the legs. (Shared with auto_rig.py.)"""
    vg = mesh.vertex_groups
    name2idx = {g.name: g.index for g in vg}
    left = [name2idx[n] for n in ("UpperLeg_L", "LowerLeg_L", "Foot_L") if n in name2idx]
    right = [name2idx[n] for n in ("UpperLeg_R", "LowerLeg_R", "Foot_R") if n in name2idx]
    hips_i = name2idx.get("Hips")
    if hips_i is None:
        return
    for v in mesh.data.vertices:
        w = {g.group: g.weight for g in v.groups}
        lw = sum(w.get(i, 0.0) for i in left)
        rw = sum(w.get(i, 0.0) for i in right)
        if min(lw, rw) > 0.12:
            moved = lw + rw
            for i in left + right:
                if i in w:
                    vg[i].remove([v.index])
            vg[hips_i].add([v.index], moved, "ADD")


def build_locomotion(bpy, arm, H):
    """Author the frozen Idle + Walk clips as pose-bone keyframes on `arm`. Deterministic, no mocap.
    Leaves the armature in OBJECT mode. (Shared with auto_rig.py.)"""
    scene = bpy.context.scene
    scene.render.fps = FPS
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="POSE")
    pb = arm.pose.bones
    for b in pb:
        b.rotation_mode = "XYZ"

    def key(bone_name, frame, rx=0.0, ry=0.0, rz=0.0, loc=None):
        b = pb[bone_name]
        b.rotation_euler = (rx, ry, rz)
        b.keyframe_insert("rotation_euler", frame=frame)
        if loc is not None:
            b.location = loc
            b.keyframe_insert("location", frame=frame)

    def new_action(name):
        act = bpy.data.actions.new(name)
        arm.animation_data_create()
        arm.animation_data.action = act
        for b in pb:
            b.rotation_euler = (0, 0, 0)
            b.location = (0, 0, 0)
        return act

    # WALK — thighs/arms swing about local X (sagittal), knees bend, hips bob.
    new_action(CLIP_WALK)
    A = 0.42
    K = 0.6
    for (f, l_th, r_th) in [(1, A, -A), (7, 0, 0), (13, -A, A), (19, 0, 0), (25, A, -A)]:
        key("UpperLeg_L", f, rx=l_th); key("UpperLeg_R", f, rx=r_th)
        key("UpperArm_L", f, rx=-r_th * 0.9); key("UpperArm_R", f, rx=-l_th * 0.9)
    for (f, l_kn, r_kn) in [(1, 0.15, 0.5), (7, 0.15, K), (13, 0.5, 0.15), (19, K, 0.15), (25, 0.15, 0.5)]:
        key("LowerLeg_L", f, rx=l_kn); key("LowerLeg_R", f, rx=r_kn)
    for (f, dz) in [(1, -0.02 * H), (7, 0.01 * H), (13, -0.02 * H), (19, 0.01 * H), (25, -0.02 * H)]:
        key("Hips", f, loc=(0, 0, dz))

    # IDLE — subtle breathing + arm micro-sway.
    new_action(CLIP_IDLE)
    for (f, sx) in [(1, 0.0), (30, 0.04), (60, 0.0)]:
        key("Spine", f, rx=sx); key("Chest", f, rx=sx * 0.5)
    for (f, ax) in [(1, 0.03), (30, 0.07), (60, 0.03)]:
        key("UpperArm_L", f, rx=ax); key("UpperArm_R", f, rx=ax)

    bpy.ops.object.mode_set(mode="OBJECT")
