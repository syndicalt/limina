# character.py — model a WHOLE clothed NPC (the commoner from art-direction/.../commoner-2.jpg) from scratch
# in headless Blender, no generation. Technique: SKIN modifier over stick-figure edge chains (per-joint
# radius) + Subdivision → smooth organic forms, one material per garment. Proves Blender can author a full
# riggable humanoid; quality is stylized (not a sculpted face) — the generation path stays the high-fi option.
#
#   blender --background --factory-startup --python tools/blender/character.py -- --out assets/commoner-modeled.glb
# Then rig with tools/rig/rig-character.sh, or --rig here is out of scope (use the existing rigger).

import bpy, sys, math

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[argv.index("--out") + 1] if "--out" in argv else "assets/commoner-modeled.glb"

bpy.ops.object.select_all(action="SELECT"); bpy.ops.object.delete()
for c in (bpy.data.meshes, bpy.data.materials):
    for d in list(c):
        try: c.remove(d)
        except Exception: pass

def mat(name, rgb, rough=0.9):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1); b.inputs["Roughness"].default_value = rough
    return m
M_WOOL = mat("Tunic", (0.33, 0.33, 0.35))          # grey wool
M_HOOD = mat("Hood",  (0.52, 0.43, 0.26))          # tan/mustard wool
M_HOSE = mat("Hose",  (0.60, 0.55, 0.45))          # natural oatmeal
M_LEATHER = mat("Leather", (0.28, 0.16, 0.08), 0.6)  # belt + shoes
M_SKIN = mat("Skin", (0.70, 0.52, 0.40), 0.6)
M_BEARD = mat("Beard", (0.42, 0.22, 0.10), 0.8)    # reddish

def skin_part(name, verts, edges, radii, root, material, subsurf=2, smooth=True):
    me = bpy.data.meshes.new(name); ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    me.from_pydata(verts, edges, [])
    ob.modifiers.new("skin", "SKIN")
    sk = me.skin_vertices[0].data
    for i, (rx, ry) in enumerate(radii): sk[i].radius = (rx, ry)
    sk[root].use_root = True
    sub = ob.modifiers.new("sub", "SUBSURF"); sub.levels = subsurf; sub.render_levels = subsurf
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.modifier_apply(modifier="skin"); bpy.ops.object.modifier_apply(modifier="sub")
    if smooth: bpy.ops.object.shade_smooth()
    me.materials.append(material)
    return ob

def prim(kind, loc, scale, material, rot=(0, 0, 0), **kw):
    getattr(bpy.ops.mesh, kind)(location=loc, rotation=rot, **kw)
    ob = bpy.context.active_object; ob.scale = scale
    bpy.ops.object.transform_apply(scale=True); bpy.ops.object.shade_smooth()
    ob.data.materials.append(material); return ob

R = lambda r: (r, r)

# ── TUNIC: knee-hem flare → waist → chest → neck, plus two sleeves hanging at the sides (slight A-pose) ──
tunic_v = [(0,0,0.54),(0,0,1.02),(0,0,1.34),(0,0,1.52),             # 0 hem,1 waist,2 chest,3 neck
           (-0.17,0,1.40),(-0.19,0,1.10),(-0.21,0.02,0.80),         # 4-6 L arm (shoulder→elbow→wrist)
           ( 0.17,0,1.40),( 0.19,0,1.10),( 0.21,0.02,0.80)]         # 7-9 R arm
tunic_e = [(0,1),(1,2),(2,3),(2,4),(4,5),(5,6),(2,7),(7,8),(8,9)]
tunic_r = [R(0.30),R(0.19),R(0.21),R(0.075),R(0.095),R(0.075),R(0.055),R(0.095),R(0.075),R(0.055)]
skin_part("Tunic", tunic_v, tunic_e, tunic_r, 1, M_WOOL)

# ── HOSE: hip hub → two legs to the ankles (visible below the hem) ──
hose_v = [(0,0,1.00),(-0.11,0,0.92),(-0.12,0,0.46),(-0.12,0,0.10),  # 0 hub,1-3 L leg
          ( 0.11,0,0.92),( 0.12,0,0.46),( 0.12,0,0.10)]             # 4-6 R leg
hose_e = [(0,1),(1,2),(2,3),(0,4),(4,5),(5,6)]
hose_r = [R(0.11),R(0.10),R(0.07),R(0.055),R(0.10),R(0.07),R(0.055)]
skin_part("Hose", hose_v, hose_e, hose_r, 0, M_HOSE)

# ── head, hands (skin) — face is +Y (front) ──
head = prim("primitive_ico_sphere_add", (0, 0.02, 1.65), (0.10, 0.11, 0.12), M_SKIN, subdivisions=3)
prim("primitive_ico_sphere_add", (-0.215, 0.04, 0.76), (0.05, 0.055, 0.05), M_SKIN, subdivisions=2)
prim("primitive_ico_sphere_add", ( 0.215, 0.04, 0.76), (0.05, 0.055, 0.05), M_SKIN, subdivisions=2)
# eyes (dark, front of face)
M_EYE = mat("Eye", (0.05, 0.04, 0.03), 0.3)
prim("primitive_ico_sphere_add", (-0.038, 0.11, 1.675), (0.017, 0.017, 0.017), M_EYE, subdivisions=2)
prim("primitive_ico_sphere_add", ( 0.038, 0.11, 1.675), (0.017, 0.017, 0.017), M_EYE, subdivisions=2)

# ── hood: cowl covering back+top of head, pulled BACK so the face is exposed, + flat shoulder cape ──
prim("primitive_ico_sphere_add", (0, -0.09, 1.71), (0.135, 0.15, 0.15), M_HOOD, subdivisions=3)
prim("primitive_cone_add", (0, -0.02, 1.40), (0.34, 0.36, 0.12), M_HOOD, radius1=1.0, radius2=0.42, depth=1.0)

# ── beard (reddish) over the jaw/chin, front ──
prim("primitive_ico_sphere_add", (0, 0.075, 1.585), (0.095, 0.075, 0.085), M_BEARD, subdivisions=2)

# ── belt (thin leather ring at the waist) ──
prim("primitive_torus_add", (0, 0, 1.00), (1, 1, 1), M_LEATHER, major_radius=0.205, minor_radius=0.022)

# ── turnshoes (brown leather) ──
prim("primitive_cube_add", (-0.12, 0.05, 0.035), (0.055, 0.13, 0.038), M_LEATHER)
prim("primitive_cube_add", ( 0.12, 0.05, 0.035), (0.055, 0.13, 0.038), M_LEATHER)

# ── export ──
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_yup=True, export_apply=True)
print(f"character: wrote {OUT}")
