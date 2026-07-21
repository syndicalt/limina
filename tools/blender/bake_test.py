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

# DOMAIN WARP — the anti-"subway tile" move. Warping the coordinates feeding the brick turns a perfect
# machine grid into rough-hewn masonry: wavy joints, blocks of uneven apparent size, chipped edges.
tc = N.new("ShaderNodeTexCoord")
wn = N.new("ShaderNodeTexNoise"); wn.inputs["Scale"].default_value = 5.0; wn.inputs["Detail"].default_value = 3.0
wsc = N.new("ShaderNodeVectorMath"); wsc.operation = "SCALE"
L.new(wn.outputs["Color"], wsc.inputs[0]); wsc.inputs["Scale"].default_value = 0.065
warp = N.new("ShaderNodeVectorMath"); warp.operation = "ADD"
L.new(tc.outputs["UV"], warp.inputs[0]); L.new(wsc.outputs["Vector"], warp.inputs[1])
WV = warp.outputs["Vector"]

brick = N.new("ShaderNodeTexBrick")
brick.inputs["Scale"].default_value = 2.1                # LARGER blocks (Project Gorgon target)
brick.inputs["Mortar Size"].default_value = 0.03         # thin, subtle joints (not heavy black)
brick.inputs["Mortar Smooth"].default_value = 0.25
brick.inputs["Brick Width"].default_value = 0.62; brick.inputs["Row Height"].default_value = 0.32
brick.inputs["Color1"].default_value = (0.34, 0.345, 0.35, 1)   # COOL GREY ashlar
brick.inputs["Color2"].default_value = (0.44, 0.445, 0.45, 1)
brick.inputs["Mortar"].default_value = (0.13, 0.13, 0.135, 1)   # dark-grey joint
L.new(WV, brick.inputs["Vector"])
fac = brick.outputs["Fac"]

# per-region stone-colour variation (Voronoi cells ≈ several blocks) so it isn't one uniform tone
cells = N.new("ShaderNodeTexVoronoi"); cells.inputs["Scale"].default_value = 4.0
L.new(WV, cells.inputs["Vector"])
cellv = N.new("ShaderNodeRGBToBW"); L.new(cells.outputs["Color"], cellv.inputs["Color"])
cmap = N.new("ShaderNodeMapRange")                      # compress per-cell random to a SUBTLE tonal range
L.new(cellv.outputs["Val"], cmap.inputs["Value"]); cmap.inputs["To Min"].default_value = 0.76; cmap.inputs["To Max"].default_value = 1.07
# weathering grime patches
weath = N.new("ShaderNodeTexNoise"); weath.inputs["Scale"].default_value = 2.3; weath.inputs["Detail"].default_value = 8
stain = N.new("ShaderNodeValToRGB")
stain.color_ramp.elements[0].position = 0.4; stain.color_ramp.elements[1].position = 0.78
L.new(weath.outputs["Fac"], stain.inputs["Fac"])
# VERTICAL WEATHERING STREAKS — dark runs down the wall (the aged-castle read in the reference)
smap = N.new("ShaderNodeMapping"); smap.inputs["Scale"].default_value = (2.5, 0.12, 2.5)  # stretch in V → vertical
L.new(WV, smap.inputs["Vector"])
sn = N.new("ShaderNodeTexNoise"); sn.inputs["Scale"].default_value = 3.5; sn.inputs["Detail"].default_value = 5
L.new(smap.outputs["Vector"], sn.inputs["Vector"])
sramp = N.new("ShaderNodeValToRGB")                     # noise → streak mask (dark where low)
sramp.color_ramp.elements[0].position = 0.32; sramp.color_ramp.elements[0].color = (0.55, 0.55, 0.58, 1)
sramp.color_ramp.elements[1].position = 0.6;  sramp.color_ramp.elements[1].color = (1, 1, 1, 1)
L.new(sn.outputs["Fac"], sramp.inputs["Fac"])
# base: brick → subtle per-cell tint → grey grime → vertical streaks → soft dark joint cavity
tint = N.new("ShaderNodeMixRGB"); tint.blend_type = "MULTIPLY"; tint.inputs["Fac"].default_value = 1.0
L.new(brick.outputs["Color"], tint.inputs["Color1"]); L.new(cmap.outputs["Result"], tint.inputs["Color2"])
gr = N.new("ShaderNodeMixRGB"); gr.blend_type = "MULTIPLY"; L.new(stain.outputs["Color"], gr.inputs["Fac"])
L.new(tint.outputs["Color"], gr.inputs["Color1"]); gr.inputs["Color2"].default_value = (0.74, 0.74, 0.76, 1)
strk = N.new("ShaderNodeMixRGB"); strk.blend_type = "MULTIPLY"; strk.inputs["Fac"].default_value = 0.7
L.new(gr.outputs["Color"], strk.inputs["Color1"]); L.new(sramp.outputs["Color"], strk.inputs["Color2"])
cavity = N.new("ShaderNodeMixRGB"); cavity.blend_type = "MULTIPLY"; L.new(fac, cavity.inputs["Fac"])
L.new(strk.outputs["Color"], cavity.inputs["Color1"]); cavity.inputs["Color2"].default_value = (0.42, 0.42, 0.45, 1)
L.new(cavity.outputs["Color"], bsdf.inputs["Base Color"])

# roughness: stone vs rougher mortar
rmix = N.new("ShaderNodeMixRGB"); rmix.inputs["Color1"].default_value = (0.84,)*3 + (1,)
L.new(fac, rmix.inputs["Fac"]); rmix.inputs["Color2"].default_value = (0.97,)*3 + (1,)
L.new(rmix.outputs["Color"], bsdf.inputs["Roughness"])

# NORMAL: mortar recess (blocks raised) + PER-BLOCK proud/recess (edge-distance dome) + face undulation + grit
inv = N.new("ShaderNodeInvert"); L.new(fac, inv.inputs["Color"])
dome = N.new("ShaderNodeTexVoronoi"); dome.feature = "DISTANCE_TO_EDGE"; dome.inputs["Scale"].default_value = 3.0
L.new(WV, dome.inputs["Vector"])                       # centre-high, edge-low → domed, chamfered blocks
undul = N.new("ShaderNodeTexNoise"); undul.inputs["Scale"].default_value = 13.0; undul.inputs["Detail"].default_value = 4
grit = N.new("ShaderNodeTexNoise"); grit.inputs["Scale"].default_value = 40; grit.inputs["Detail"].default_value = 6
h1 = mix(inv.outputs["Color"], dome.outputs["Distance"], 0.05)     # recessed joints; faces stay FLAT (dressed ashlar)
b1 = N.new("ShaderNodeBump"); b1.inputs["Strength"].default_value = 1.35; b1.inputs["Distance"].default_value = 0.13
L.new(h1, b1.inputs["Height"])
h2 = mix(undul.outputs["Fac"], grit.outputs["Fac"], 0.6)           # just a hint of fine grit
b2 = N.new("ShaderNodeBump"); b2.inputs["Strength"].default_value = 0.11
L.new(h2, b2.inputs["Height"]); L.new(b1.outputs["Normal"], b2.inputs["Normal"])
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
