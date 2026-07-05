# bake_test.py — de-risk headless Cycles PBR baking. Procedural Norman ashlar (Brick Texture) on a cube →
# UV unwrap → bake ALBEDO + NORMAL + ROUGHNESS to images → rewire a clean Principled material to use the
# baked maps → export GLB. If this reads as textured stone in the engine, the same bake helper drives the
# castle. Run: blender --background --factory-startup --python tools/build/bake_test.py -- --out <x.glb>

import bpy, sys, os
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[argv.index("--out") + 1] if "--out" in argv else "assets/bake-test.glb"
RES = 1024

bpy.ops.object.select_all(action="SELECT"); bpy.ops.object.delete()

# ---- subject: a stone block -------------------------------------------------
bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 1))
obj = bpy.context.active_object
bpy.ops.object.shade_flat()

# ---- procedural Norman ashlar material (Brick Texture masonry) ---------------
m = bpy.data.materials.new("StoneProc"); m.use_nodes = True
nt = m.node_tree; nodes = nt.nodes; links = nt.links
bsdf = nodes.get("Principled BSDF")
brick = nodes.new("ShaderNodeTexBrick")
brick.inputs["Scale"].default_value = 3.0
brick.inputs["Mortar Size"].default_value = 0.03
brick.inputs["Color1"].default_value = (0.42, 0.38, 0.31, 1)   # stone tone A
brick.inputs["Color2"].default_value = (0.50, 0.46, 0.38, 1)   # stone tone B
brick.inputs["Mortar"].default_value = (0.20, 0.19, 0.17, 1)   # recessed mortar
noise = nodes.new("ShaderNodeTexNoise"); noise.inputs["Scale"].default_value = 14.0
mixcol = nodes.new("ShaderNodeMixRGB"); mixcol.blend_type = "MULTIPLY"; mixcol.inputs["Fac"].default_value = 0.25
links.new(brick.outputs["Color"], mixcol.inputs["Color1"])
links.new(noise.outputs["Fac"], mixcol.inputs["Color2"])
links.new(mixcol.outputs["Color"], bsdf.inputs["Base Color"])
bsdf.inputs["Roughness"].default_value = 0.88
# bump from mortar (brick Fac) + fine noise
bump = nodes.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.35
bumpmix = nodes.new("ShaderNodeMixRGB"); bumpmix.inputs["Fac"].default_value = 0.4
links.new(brick.outputs["Fac"], bumpmix.inputs["Color1"])
links.new(noise.outputs["Fac"], bumpmix.inputs["Color2"])
links.new(bumpmix.outputs["Color"], bump.inputs["Height"])
links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
obj.data.materials.clear(); obj.data.materials.append(m)

# ---- UV unwrap ---------------------------------------------------------------
bpy.context.view_layer.objects.active = obj
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
# Cube (box) projection: axis-aligned faces get uniform world-scale UVs (1 UV unit = 1 m via cube_size=1),
# so procedural masonry tiles consistently across every face — no per-island stretch. Ideal for boxy
# architecture; smart_project's variable island scale is what turned the brick into stripes.
bpy.ops.uv.cube_project(cube_size=1.0, correct_aspect=True, scale_to_bounds=False)
bpy.ops.object.mode_set(mode="OBJECT")

# ---- bake setup (Cycles CPU) -------------------------------------------------
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 24
scene.render.bake.use_selected_to_active = False

def bake_pass(bake_type, name, non_color, extra=None):
    img = bpy.data.images.new(name, RES, RES, alpha=False)
    img.colorspace_settings.name = "Non-Color" if non_color else "sRGB"
    tex = nt.nodes.new("ShaderNodeTexImage"); tex.image = img; tex.select = True; nt.nodes.active = tex
    kw = dict(type=bake_type, width=RES, height=RES, margin=6, use_clear=True)
    if extra: kw.update(extra)
    bpy.ops.object.bake(**kw)
    return img

albedo = bake_pass("DIFFUSE", "bake_albedo", False, {"pass_filter": {"COLOR"}})
normal = bake_pass("NORMAL", "bake_normal", True)
rough  = bake_pass("ROUGHNESS", "bake_rough", True)

# ---- rewire a CLEAN material that uses the baked maps ------------------------
bpy.data.materials.remove(m)
mb = bpy.data.materials.new("Stone"); mb.use_nodes = True
nt2 = mb.node_tree; n2 = nt2.nodes; l2 = nt2.links
b2 = n2.get("Principled BSDF")
ta = n2.new("ShaderNodeTexImage"); ta.image = albedo; l2.new(ta.outputs["Color"], b2.inputs["Base Color"])
tr = n2.new("ShaderNodeTexImage"); tr.image = rough; l2.new(tr.outputs["Color"], b2.inputs["Roughness"])
tn = n2.new("ShaderNodeTexImage"); tn.image = normal
nm = n2.new("ShaderNodeNormalMap"); l2.new(tn.outputs["Color"], nm.inputs["Color"]); l2.new(nm.outputs["Normal"], b2.inputs["Normal"])
obj.data.materials.clear(); obj.data.materials.append(mb)

# ---- export (pack baked images into the GLB) --------------------------------
for im in (albedo, normal, rough): im.pack()
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_yup=True, export_apply=True)
print(f"bake_test: wrote {OUT} (albedo+normal+rough @ {RES})")
