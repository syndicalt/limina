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

# ---- rich procedural Norman ashlar — depth from DARK CAVITY MORTAR + strong multi-octave normal + ----
#      per-block tonal variation + weathering. The flat 2-tone+weak-bump version read "painted on".
m = bpy.data.materials.new("StoneProc"); m.use_nodes = True
nt = m.node_tree; N = nt.nodes; L = nt.links
bsdf = N.get("Principled BSDF")
def mix(a, b, fac, blend="MIX"):
    x = N.new("ShaderNodeMixRGB"); x.blend_type = blend; x.inputs["Fac"].default_value = fac
    if not isinstance(a, float): L.new(a, x.inputs["Color1"])
    else: x.inputs["Color1"].default_value = (a, a, a, 1)
    if hasattr(b, "__len__") and not hasattr(b, "bl_idname"): x.inputs["Color2"].default_value = (*b, 1)
    elif isinstance(b, float): x.inputs["Color2"].default_value = (b, b, b, 1)
    else: L.new(b, x.inputs["Color2"])
    return x.outputs["Color"]

brick = N.new("ShaderNodeTexBrick")
brick.inputs["Scale"].default_value = 3.0
brick.inputs["Mortar Size"].default_value = 0.045     # wider joints read at distance
brick.inputs["Mortar Smooth"].default_value = 0.10
brick.inputs["Brick Width"].default_value = 0.52; brick.inputs["Row Height"].default_value = 0.26
brick.inputs["Color1"].default_value = (0.40, 0.36, 0.28, 1)
brick.inputs["Color2"].default_value = (0.49, 0.45, 0.36, 1)
brick.inputs["Mortar"].default_value = (0.08, 0.075, 0.065, 1)   # near-black cavity mortar
fac = brick.outputs["Fac"]                              # ~1 in mortar, ~0 on the block faces

# per-block + large weathering variation (stains, damp streaks)
weath = N.new("ShaderNodeTexNoise"); weath.inputs["Scale"].default_value = 2.3; weath.inputs["Detail"].default_value = 8
stain = N.new("ShaderNodeValToRGB")                     # ColorRamp → grime mask
stain.color_ramp.elements[0].position = 0.42; stain.color_ramp.elements[1].position = 0.72
L.new(weath.outputs["Fac"], stain.inputs["Fac"])
# base color: brick, tinted darker by grime, then hard-darkened in the mortar cavity (fake AO)
col = mix(brick.outputs["Color"], (0.20, 0.18, 0.15), 0.0)          # start = brick color
col = mix(col, (0.22, 0.20, 0.16), 0.35)                            # blend toward a grime tone …
gr = N.new("ShaderNodeMixRGB"); gr.blend_type = "MULTIPLY"; L.new(stain.outputs["Color"], gr.inputs["Fac"])
L.new(col, gr.inputs["Color1"]); gr.inputs["Color2"].default_value = (0.55, 0.52, 0.45, 1)
cavity = N.new("ShaderNodeMixRGB"); cavity.blend_type = "MULTIPLY"; L.new(fac, cavity.inputs["Fac"])
L.new(gr.outputs["Color"], cavity.inputs["Color1"]); cavity.inputs["Color2"].default_value = (0.28, 0.26, 0.22, 1)
L.new(cavity.outputs["Color"], bsdf.inputs["Base Color"])

# roughness: stone ~0.8, mortar rougher, grime rougher
rmix = N.new("ShaderNodeMixRGB"); rmix.inputs["Color1"].default_value = (0.8,)*3 + (1,)
L.new(fac, rmix.inputs["Fac"]); rmix.inputs["Color2"].default_value = (0.96,)*3 + (1,)
L.new(rmix.outputs["Color"], bsdf.inputs["Roughness"])

# NORMAL: strong mortar recess (blocks raised) + fine surface grit, two chained bumps
inv = N.new("ShaderNodeInvert"); L.new(fac, inv.inputs["Color"])   # blocks=1 (high), mortar=0 (low)
grit = N.new("ShaderNodeTexNoise"); grit.inputs["Scale"].default_value = 42; grit.inputs["Detail"].default_value = 6
pit = N.new("ShaderNodeTexVoronoi"); pit.inputs["Scale"].default_value = 26
b1 = N.new("ShaderNodeBump"); b1.inputs["Strength"].default_value = 1.6; b1.inputs["Distance"].default_value = 0.12
L.new(inv.outputs["Color"], b1.inputs["Height"])
b2 = N.new("ShaderNodeBump"); b2.inputs["Strength"].default_value = 0.35
gmix = mix(grit.outputs["Fac"], pit.outputs["Distance"], 0.5)
L.new(gmix, b2.inputs["Height"]); L.new(b1.outputs["Normal"], b2.inputs["Normal"])
L.new(b2.outputs["Normal"], bsdf.inputs["Normal"])
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
