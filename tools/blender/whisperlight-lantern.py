# whisperlight-lantern.py — THE WHISPERLIGHT LANTERN POST (req_42934_5, category prop).
# An elegant ~5m Eldrath road lantern authored in headless Blender — kin to veilstone-monolith.py
# (same weathered basalt family, same blue-glow magic language) but slender and lighting-focused.
#
#   blender --background --factory-startup --python tools/blender/whisperlight-lantern.py -- --out assets/whisperlight-lantern.glb
#
# Anatomy (base at z=0, origin centered):
#   - stone pedestal ~0.9w x 0.62h: plinth + tapered mid block + cap, carved trim frames + face
#     diamonds, partial dim-biolum moss (family tie to the monolith's vines).
#   - dark-metal shaft 0.62 -> 4.20: REAL fluted geometry (8 flutes, cos-modulated lathe) with a
#     gentle spiral twist and slight taper; collar rings; sparse glowing blue rune glyphs (each rune
#     = 1-3 small emissive strokes, individually distinguishable) up two sides; glowing vines wrap
#     the lower third (monolith moss material — kinship).
#   - lantern head 4.34 -> ~5.08 (~0.74h x ~0.56w): flared capital, 6 S-curve metalwork brackets,
#     hex base plate, 6 thin corner posts + muntin bars + corner braces (reads as METALWORK), thin
#     translucent glass panes, hex roof cone + finial; inside, THE STAR: a large hex-bipyramid
#     crystal with a warm GOLD emissive core; 5 floating gold motes (real tiny emissive meshes).
#
# ENGINE-TRANSLATION RULES (GLB -> three.js): no volumes/particles/lights/bloom — all glow is baked
# EMISSIVE material. ACES rule (see veilstone-monolith.py v3 notes): three.js's ACES tonemap crushes
# bright near-equal RGB to white; separate the channels (one near zero) and keep color*strength
# moderate. Gold = high R / mid G / near-zero B. Rune blue = near-zero R / mid G / high B.
# Metal note: engine lighting is simple; full metallic=1 near-black would render as a void, so the
# dark metal bakes its color with metallic OFF and the consumption material sets a moderate 0.6.

import bpy, bmesh, sys, math, random
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[argv.index("--out") + 1] if "--out" in argv else "assets/whisperlight-lantern.glb"
RES = 512
random.seed(429345)  # req_42934_5 — deterministic

# ---- reset -------------------------------------------------------------------
bpy.ops.object.select_all(action="SELECT"); bpy.ops.object.delete()
for c in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.curves):
    for d in list(c):
        try: c.remove(d)
        except Exception: pass

# ================================================================================
# ---- generic helpers (same pattern as cottage.py / veilstone-monolith.py) -----
# ================================================================================
def box(name, center, size):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=center)
    o = bpy.context.active_object; o.name = name; o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    return o

def box_rot(name, center, size, rot_deg, mat=None):
    """Placed+rotated+scaled once, applied together (the transform_apply gotcha only bites objects
    that get REPOSITIONED after an early scale-only apply — these never move again)."""
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=center)
    o = bpy.context.active_object; o.name = name; o.scale = size
    o.rotation_euler = tuple(math.radians(a) for a in rot_deg)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if mat: o.data.materials.append(mat)
    return o

def bevel(o, w=0.02, s=1):
    bpy.context.view_layer.objects.active = o
    md = o.modifiers.new("bv", "BEVEL"); md.width = w; md.segments = s; md.limit_method = "ANGLE"
    bpy.ops.object.modifier_apply(modifier=md.name)

def smooth_obj(o, angle_deg=40):
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True); bpy.context.view_layer.objects.active = o
    try: bpy.ops.object.shade_auto_smooth(angle=math.radians(angle_deg))
    except Exception:
        try: bpy.ops.object.shade_smooth()
        except Exception: pass

def emissive(name, base_rgb, emit_rgb, strength, rough=0.35, metal=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*base_rgb, 1.0)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    b.inputs["Emission Color"].default_value = (*emit_rgb, 1.0)
    b.inputs["Emission Strength"].default_value = strength
    return m

def bake_material(name, build, res=RES, use_normal=True):
    bpy.ops.mesh.primitive_plane_add(size=2, location=(200, 0, 0))
    pl = bpy.context.active_object
    m = bpy.data.materials.new(name); m.use_nodes = True; nt = m.node_tree; nds = nt.nodes; lk = nt.links
    bsdf = nds["Principled BSDF"]
    build(nds, lk, bsdf)
    pl.data.materials.append(m)
    sc = bpy.context.scene; sc.render.engine = "CYCLES"; sc.cycles.device = "CPU"; sc.cycles.samples = 16
    imgs = {}
    passes = [("DIFFUSE", "alb", False, {"pass_filter": {"COLOR"}}), ("ROUGHNESS", "rgh", True, {})]
    if use_normal: passes.append(("NORMAL", "nrm", True, {}))
    for bt, nm, nc, extra in passes:
        img = bpy.data.images.new(f"{name}_{nm}", res, res)
        img.colorspace_settings.name = "Non-Color" if nc else "sRGB"
        tx = nds.new("ShaderNodeTexImage"); tx.image = img; tx.select = True; nds.active = tx
        bpy.context.view_layer.objects.active = pl
        bpy.ops.object.bake(type=bt, width=res, height=res, margin=4, use_clear=True, **extra)
        img.pack()
        imgs[nm] = img
    bpy.data.objects.remove(pl, do_unlink=True)
    return imgs

def tiled_material(name, imgs, tile_m=1.0, metallic=0.0):
    sm = bpy.data.materials.new(name); sm.use_nodes = True; nt = sm.node_tree; n = nt.nodes; l = nt.links
    b = n["Principled BSDF"]
    b.inputs["Metallic"].default_value = metallic
    uv = n.new("ShaderNodeTexCoord"); mp = n.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (1.0 / tile_m, 1.0 / tile_m, 1.0 / tile_m)
    l.new(uv.outputs["UV"], mp.inputs["Vector"])
    def tex(img, nc):
        t = n.new("ShaderNodeTexImage"); t.image = img; t.extension = "REPEAT"
        if nc: t.image.colorspace_settings.name = "Non-Color"
        l.new(mp.outputs["Vector"], t.inputs["Vector"]); return t
    l.new(tex(imgs["alb"], False).outputs["Color"], b.inputs["Base Color"])
    l.new(tex(imgs["rgh"], True).outputs["Color"], b.inputs["Roughness"])
    if "nrm" in imgs:
        nrm = n.new("ShaderNodeNormalMap")
        l.new(tex(imgs["nrm"], True).outputs["Color"], nrm.inputs["Color"])
        l.new(nrm.outputs["Normal"], b.inputs["Normal"])
    return sm

def apply_tiled(obj, mat):
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.cube_project(cube_size=1.0, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    obj.data.materials.clear(); obj.data.materials.append(mat)

def join_all(name, parts):
    parts = [p for p in parts if p is not None]
    if not parts: return None
    bpy.ops.object.select_all(action="DESELECT")
    for o in parts: o.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    parts[0].name = name
    return parts[0]

# ================================================================================
# ---- baked materials -----------------------------------------------------------
# ================================================================================
def build_basalt(nds, lk, bsdf):
    """Weathered gray stone — same family as veilstone-monolith's basalt (same graph shape, veins
    confined to slender crack lines, calm bump), a touch lighter for a crafted pedestal read."""
    tc = nds.new("ShaderNodeTexCoord")
    noise1 = nds.new("ShaderNodeTexNoise"); noise1.inputs["Scale"].default_value = 6; noise1.inputs["Detail"].default_value = 6
    lk.new(tc.outputs["UV"], noise1.inputs["Vector"])
    ramp1 = nds.new("ShaderNodeValToRGB")
    ramp1.color_ramp.elements[0].position = 0.35; ramp1.color_ramp.elements[0].color = (0.05, 0.05, 0.056, 1)
    ramp1.color_ramp.elements[1].position = 0.65; ramp1.color_ramp.elements[1].color = (0.13, 0.13, 0.145, 1)
    lk.new(noise1.outputs["Fac"], ramp1.inputs["Fac"])
    # v2: at pedestal scale (0.9m) the monolith's vein density read as cracked marble — fewer,
    # thinner, dimmer veins so the family cue stays a whisper.
    vor = nds.new("ShaderNodeTexVoronoi"); vor.feature = "DISTANCE_TO_EDGE"; vor.inputs["Scale"].default_value = 1.1
    lk.new(tc.outputs["UV"], vor.inputs["Vector"])
    veinramp = nds.new("ShaderNodeValToRGB")
    veinramp.color_ramp.elements[0].position = 0.004; veinramp.color_ramp.elements[0].color = (1, 1, 1, 1)
    veinramp.color_ramp.elements[1].position = 0.014; veinramp.color_ramp.elements[1].color = (0, 0, 0, 1)
    lk.new(vor.outputs["Distance"], veinramp.inputs["Fac"])
    veincolor = nds.new("ShaderNodeMixRGB"); veincolor.blend_type = "MIX"
    lk.new(ramp1.outputs["Color"], veincolor.inputs["Color1"])
    veincolor.inputs["Color2"].default_value = (0.17, 0.32, 0.5, 1)
    lk.new(veinramp.outputs["Color"], veincolor.inputs["Fac"])
    lk.new(veincolor.outputs["Color"], bsdf.inputs["Base Color"])
    rgh = nds.new("ShaderNodeValToRGB")
    rgh.color_ramp.elements[0].position = 0.4; rgh.color_ramp.elements[0].color = (0.7, 0.7, 0.7, 1)
    rgh.color_ramp.elements[1].position = 0.6; rgh.color_ramp.elements[1].color = (0.9, 0.9, 0.9, 1)
    lk.new(noise1.outputs["Fac"], rgh.inputs["Fac"])
    lk.new(rgh.outputs["Color"], bsdf.inputs["Roughness"])
    bump1 = nds.new("ShaderNodeBump"); bump1.inputs["Strength"].default_value = 0.18
    lk.new(noise1.outputs["Fac"], bump1.inputs["Height"])
    bump2 = nds.new("ShaderNodeBump"); bump2.inputs["Strength"].default_value = 0.1
    lk.new(vor.outputs["Distance"], bump2.inputs["Height"]); lk.new(bump1.outputs["Normal"], bump2.inputs["Normal"])
    lk.new(bump2.outputs["Normal"], bsdf.inputs["Normal"])

def build_darkmetal(nds, lk, bsdf):
    """Near-black elegant metal with subtle warm bronze streaks + fine vertical brushed grain.
    Baked with metallic OFF (a metallic DIFFUSE pass bakes black); the consumption material adds
    Metallic=0.6 — moderate on purpose so the engine's simple lighting doesn't void it out."""
    tc = nds.new("ShaderNodeTexCoord")
    # large soft tonal variation
    noise1 = nds.new("ShaderNodeTexNoise"); noise1.inputs["Scale"].default_value = 5; noise1.inputs["Detail"].default_value = 4
    lk.new(tc.outputs["UV"], noise1.inputs["Vector"])
    ramp1 = nds.new("ShaderNodeValToRGB")
    # v2: the v1 albedo rendered as a featureless BLACK silhouette in the engine (simple lighting +
    # metallic 0.6 + near-zero albedo). Lifted floor and warmer top so the fluting can shade.
    ramp1.color_ramp.elements[0].position = 0.35; ramp1.color_ramp.elements[0].color = (0.04, 0.037, 0.042, 1)
    ramp1.color_ramp.elements[1].position = 0.7; ramp1.color_ramp.elements[1].color = (0.1, 0.086, 0.078, 1)
    lk.new(noise1.outputs["Fac"], ramp1.inputs["Fac"])
    # sparse bronze/silver worn-edge streaks — vertically stretched noise, tight highlight window
    mpv = nds.new("ShaderNodeMapping"); mpv.inputs["Scale"].default_value = (26, 1.2, 1)
    lk.new(tc.outputs["UV"], mpv.inputs["Vector"])
    noise2 = nds.new("ShaderNodeTexNoise"); noise2.inputs["Scale"].default_value = 3; noise2.inputs["Detail"].default_value = 5
    lk.new(mpv.outputs["Vector"], noise2.inputs["Vector"])
    streakramp = nds.new("ShaderNodeValToRGB")
    streakramp.color_ramp.elements[0].position = 0.55; streakramp.color_ramp.elements[0].color = (0, 0, 0, 1)
    streakramp.color_ramp.elements[1].position = 0.72; streakramp.color_ramp.elements[1].color = (1, 1, 1, 1)
    lk.new(noise2.outputs["Fac"], streakramp.inputs["Fac"])
    bronze = nds.new("ShaderNodeMixRGB"); bronze.blend_type = "MIX"
    lk.new(ramp1.outputs["Color"], bronze.inputs["Color1"])
    bronze.inputs["Color2"].default_value = (0.21, 0.13, 0.06, 1)   # worn bronze glint
    lk.new(streakramp.outputs["Color"], bronze.inputs["Fac"])
    # a second, rarer cool-silver streak
    noise3 = nds.new("ShaderNodeTexNoise"); noise3.inputs["Scale"].default_value = 4.3; noise3.inputs["Detail"].default_value = 4
    lk.new(mpv.outputs["Vector"], noise3.inputs["Vector"])
    silverramp = nds.new("ShaderNodeValToRGB")
    silverramp.color_ramp.elements[0].position = 0.72; silverramp.color_ramp.elements[0].color = (0, 0, 0, 1)
    silverramp.color_ramp.elements[1].position = 0.85; silverramp.color_ramp.elements[1].color = (1, 1, 1, 1)
    lk.new(noise3.outputs["Fac"], silverramp.inputs["Fac"])
    silver = nds.new("ShaderNodeMixRGB"); silver.blend_type = "MIX"
    lk.new(bronze.outputs["Color"], silver.inputs["Color1"])
    silver.inputs["Color2"].default_value = (0.28, 0.29, 0.33, 1)
    lk.new(silverramp.outputs["Color"], silver.inputs["Fac"])
    lk.new(silver.outputs["Color"], bsdf.inputs["Base Color"])
    # roughness: mostly satin, streaks polished
    rgh = nds.new("ShaderNodeValToRGB")
    rgh.color_ramp.elements[0].position = 0.3; rgh.color_ramp.elements[0].color = (0.45, 0.45, 0.45, 1)
    rgh.color_ramp.elements[1].position = 0.75; rgh.color_ramp.elements[1].color = (0.24, 0.24, 0.24, 1)
    lk.new(noise2.outputs["Fac"], rgh.inputs["Fac"])
    lk.new(rgh.outputs["Color"], bsdf.inputs["Roughness"])
    # fine brushed grain
    bump1 = nds.new("ShaderNodeBump"); bump1.inputs["Strength"].default_value = 0.1
    lk.new(noise2.outputs["Fac"], bump1.inputs["Height"])
    lk.new(bump1.outputs["Normal"], bsdf.inputs["Normal"])

IMG_BASALT = bake_material("Basalt", build_basalt)
MAT_STONE = tiled_material("BasaltPedestal", IMG_BASALT, tile_m=1.5)
IMG_METAL = bake_material("DarkMetal", build_darkmetal)
MAT_METAL = tiled_material("DarkMetal", IMG_METAL, tile_m=0.7, metallic=0.35)

# ---- emissives (ACES-safe: channel-separated, moderate total radiance) ---------
# v3: crystal rendered as a FLAT yellow blob (uniform emission erases facets) — two-tone now:
# bright gold upper + deeper amber lower gives a lit-core gradient; strength trimmed so ACES keeps
# the hue deep gold instead of pale yellow. Runes at 1.7 crushed to pale cyan — back to 1.25.
MAT_CRYSTAL = emissive("CrystalGold",  (0.26, 0.13, 0.02), (1.0, 0.45, 0.02), 1.45, rough=0.14)  # THE STAR
MAT_CRYSTAL2 = emissive("CrystalAmber", (0.2, 0.08, 0.01), (1.0, 0.3, 0.01), 1.0, rough=0.14)
MAT_MOTE    = emissive("MoteGold",    (0.22, 0.11, 0.02), (1.0, 0.55, 0.03), 1.8, rough=0.3)
MAT_RUNE    = emissive("RuneBlue",    (0.02, 0.06, 0.14), (0.02, 0.35, 0.95), 1.25, rough=0.35) # monolith kin
# v2: v1 vines rendered as a bright mint candy-cane — deeper green, dimmer, thinner below
MAT_VINE    = emissive("VineGlow",    (0.015, 0.07, 0.03), (0.04, 0.7, 0.2), 0.75, rough=0.7)   # monolith moss kin
MAT_MOSS    = emissive("MossDim",     (0.03, 0.09, 0.04), (0.06, 0.7, 0.2), 0.45, rough=0.85)
# thin warm glass panes: v1's bright cream base at alpha .22 hid the crystal — much darker/thinner
# tint now, faint emission kept so the pane still reads lit; BLEND alpha set below
MAT_GLASS   = emissive("WarmGlass",   (0.4, 0.3, 0.18), (1.0, 0.55, 0.05), 0.22, rough=0.06)
MAT_GLASS.node_tree.nodes["Principled BSDF"].inputs["Alpha"].default_value = 0.1
for attr, val in (("blend_method", "BLEND"), ("surface_render_method", "BLENDED")):
    try: setattr(MAT_GLASS, attr, val)
    except Exception: pass

# ================================================================================
# ---- dimensions (metres) -------------------------------------------------------
# ================================================================================
BASE_TOP = 0.62          # pedestal: plinth 0.16 + mid 0.36 + cap 0.10
SHAFT_Z0, SHAFT_Z1 = 0.60, 4.20            # shaft (tucks 2cm into the cap)
SHAFT_H = SHAFT_Z1 - SHAFT_Z0
R0, R1 = 0.10, 0.066                        # shaft base/top radius (slight taper)
FLUTES, FLUTE_AMP = 8, 0.22                 # real fluted geometry (v4: deep enough to scallop the silhouette)
TWIST = 2 * math.pi * 1.8                   # flute phase drift -> gentle spiral
CAP_Z0, CAP_Z1 = 4.20, 4.34                 # flared capital
PLATE_Z0, PLATE_Z1 = 4.34, 4.39             # hex base plate
POST_Z0, POST_Z1 = 4.39, 4.75               # lantern cage
RIM_Z0, RIM_Z1 = 4.75, 4.79                 # top rim plate
ROOF_Z0, ROOF_Z1 = 4.79, 4.97               # hex roof cone
HEX_R = 0.24                                 # cage corner-post circumradius

def shaft_R(t): return R0 + (R1 - R0) * t

# ================================================================================
# ---- stone pedestal -------------------------------------------------------------
# ================================================================================
BASE_PARTS = []
plinth = box("plinth", (0, 0, 0.08), (0.9, 0.9, 0.16)); bevel(plinth, 0.022, 2)
apply_tiled(plinth, MAT_STONE); BASE_PARTS.append(plinth)

# tapered mid block: 4-vert cone = square pyramid frustum (rotated 45 deg so faces align to axes)
bpy.ops.mesh.primitive_cone_add(vertices=4, radius1=0.36 * math.sqrt(2), radius2=0.30 * math.sqrt(2),
                                depth=0.36, location=(0, 0, 0.34))
mid = bpy.context.active_object; mid.name = "midblock"
mid.rotation_euler = (0, 0, math.radians(45))
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
bevel(mid, 0.015, 1); apply_tiled(mid, MAT_STONE); BASE_PARTS.append(mid)

cap = box("cap", (0, 0, 0.57), (0.68, 0.68, 0.10)); bevel(cap, 0.02, 2)
apply_tiled(cap, MAT_STONE); BASE_PARTS.append(cap)

# carved trim: raised frame strips on the plinth's 4 faces + a raised diamond on each mid face
for k in range(4):
    az = k * 90; c, s = math.cos(math.radians(az)), math.sin(math.radians(az))
    fo = 0.45 + 0.006  # plinth face offset
    for dz, ln in ((0.035, 0.62), (-0.035, 0.62)):
        BASE_PARTS.append(box_rot("trim", (fo * c, fo * s, 0.08 + dz), (0.014, ln, 0.014), (0, 0, az)))
    for du in (-0.31, 0.31):
        BASE_PARTS.append(box_rot("trim", (fo * c - du * s, fo * s + du * c, 0.08), (0.014, 0.014, 0.084), (0, 0, az)))
    # diamond on the tapered mid face (face tilts ~9.5 deg inward at the top)
    fm = 0.33 + 0.006
    BASE_PARTS.append(box_rot("diamond", (fm * c, fm * s, 0.34), (0.014, 0.1, 0.1), (-9.5, 45, az)))
for p in BASE_PARTS[3:]:
    apply_tiled(p, MAT_STONE)

# partial moss on the pedestal (dim biolum — family tie, not a light source)
MOSS_PARTS = []
for i in range(9):
    ang = random.uniform(0, 2 * math.pi)
    rad = random.uniform(0.34, 0.48); z = random.uniform(0.03, 0.5)
    if z > 0.2: rad = random.uniform(0.28, 0.37)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=random.uniform(0.05, 0.11),
                                          location=(rad * math.cos(ang), rad * math.sin(ang), z))
    o = bpy.context.active_object; o.name = "moss"; o.scale = (1, 1, 0.35)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    o.data.materials.append(MAT_MOSS); MOSS_PARTS.append(o)
for i in range(3):  # a little moss creeping at the foot
    ang = random.uniform(0, 2 * math.pi); rad = random.uniform(0.42, 0.5)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=random.uniform(0.08, 0.13),
                                          location=(rad * math.cos(ang), rad * math.sin(ang), 0.02))
    o = bpy.context.active_object; o.scale = (1, 1, 0.3)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    o.data.materials.append(MAT_MOSS); MOSS_PARTS.append(o)

# ================================================================================
# ---- fluted, gently twisted metal shaft (real lathe geometry) -------------------
# ================================================================================
def make_fluted_shaft(name, n_theta=64, n_z=36):
    bm = bmesh.new()
    rows = []
    for j in range(n_z + 1):
        t = j / n_z
        z = SHAFT_Z0 + SHAFT_H * t
        R = shaft_R(t)
        row = []
        for i in range(n_theta):
            th = 2 * math.pi * i / n_theta
            r = R * (1.0 + FLUTE_AMP * math.cos(FLUTES * th + TWIST * t))
            row.append(bm.verts.new((r * math.cos(th), r * math.sin(th), z)))
        rows.append(row)
    for j in range(n_z):
        for i in range(n_theta):
            a, b_ = rows[j][i], rows[j][(i + 1) % n_theta]
            c_, d = rows[j + 1][(i + 1) % n_theta], rows[j + 1][i]
            bm.faces.new((a, b_, c_, d))
    # caps
    bm.faces.new(tuple(reversed(rows[0])))
    bm.faces.new(tuple(rows[n_z]))
    bm.normal_update()
    f0 = [f for f in bm.faces if len(f.verts) == 4][0]
    ctr = sum((v.co for v in f0.verts), Vector()) / 4
    if f0.normal.dot(Vector((ctr.x, ctr.y, 0))) < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(ob)
    return ob

SHAFT_PARTS = []
shaft = make_fluted_shaft("shaft")
apply_tiled(shaft, MAT_METAL); smooth_obj(shaft, 40)
SHAFT_PARTS.append(shaft)

# collar rings (metal) — base of shaft, top of vine zone, below the capital
def collar(z, grow=0.014, minor=0.013):
    t = max(0.0, min(1.0, (z - SHAFT_Z0) / SHAFT_H))
    R = shaft_R(t) * (1 + FLUTE_AMP) + grow
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=minor,
                                     major_segments=28, minor_segments=6, location=(0, 0, z))
    o = bpy.context.active_object; o.name = "collar"
    apply_tiled(o, MAT_METAL); smooth_obj(o, 50)
    return o
SHAFT_PARTS += [collar(0.70, 0.018, 0.016), collar(1.92), collar(4.08)]

# ---- sparse rune glyphs: two vertical lines, each rune = 1-3 small strokes -----
RUNE_PARTS = []
def rune_column(az_deg, z_list, seed):
    rnd = random.Random(seed)
    az = math.radians(az_deg)
    for z in z_list:
        t = (z - SHAFT_Z0) / SHAFT_H
        Rr = shaft_R(t) * (1 + FLUTE_AMP) + 0.002
        n_strokes = rnd.choice([1, 2, 2, 3])
        for s_i in range(n_strokes):
            # v2: v1 strokes (~4-7cm x 1cm) were invisible past 3m — scaled up ~40%
            h = rnd.uniform(0.055, 0.095)
            w = rnd.uniform(0.013, 0.02)
            tilt = rnd.choice([0, 0, 22, -22, 45, -45])
            off = (s_i - (n_strokes - 1) / 2) * 0.03
            x = Rr * math.cos(az) - off * math.sin(az)
            y = Rr * math.sin(az) + off * math.cos(az)
            RUNE_PARTS.append(box_rot("rune", (x, y, z), (0.014, w, h), (tilt, 0, az_deg), MAT_RUNE))

rune_column(0,   [2.05, 2.32, 2.62, 2.9, 3.2, 3.5, 3.78, 4.0], seed=42)
rune_column(126, [1.55, 1.88, 2.5, 2.95, 3.42], seed=93)

# ---- glowing vines wrapping the lower third -------------------------------------
def make_vine(name, ang0, rad0, radn, z0, height, turns, bevel_r, mat, n_pts=14):
    curve = bpy.data.curves.new(name, "CURVE"); curve.dimensions = "3D"
    sp = curve.splines.new("BEZIER"); sp.bezier_points.add(n_pts - 1)
    pts = []
    rnd = random.Random(hash(name) & 0xffff)
    for i in range(n_pts):
        t = i / (n_pts - 1)
        # v2: perfect helix read as a candy-cane stripe — irregular climb + radial wobble now
        ang = ang0 + turns * 2 * math.pi * t + rnd.uniform(-0.22, 0.22)
        rad = rad0 + (radn - rad0) * t + rnd.uniform(-0.008, 0.014)
        zz = z0 + height * (t + rnd.uniform(-0.02, 0.02))
        co = (rad * math.cos(ang), rad * math.sin(ang), zz)
        p = sp.bezier_points[i]; p.co = co
        p.handle_left_type = "AUTO"; p.handle_right_type = "AUTO"
        pts.append(co)
    curve.bevel_depth = bevel_r; curve.bevel_resolution = 1; curve.resolution_u = 6
    ob = bpy.data.objects.new(name, curve); bpy.context.collection.objects.link(ob)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.select_all(action="DESELECT"); ob.select_set(True)
    bpy.ops.object.convert(target="MESH")
    ob.data.materials.append(mat)
    return ob, pts

VINE_PARTS = []
vine_paths = []
for i in range(2):
    ang0 = i * math.pi + random.uniform(-0.3, 0.3)
    ob, pts = make_vine(f"vine{i}", ang0, 0.126, 0.105, SHAFT_Z0 + 0.04, 1.28,
                        1.7 + random.uniform(-0.2, 0.25), 0.011, MAT_VINE)
    VINE_PARTS.append(ob); vine_paths.append(pts)
# small glowing leaves along the vines
for pts in vine_paths:
    for k in range(2, len(pts) - 1, 3):
        x, y, z = pts[k]
        d = math.hypot(x, y); ux, uy = x / d, y / d
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=random.uniform(0.022, 0.034),
                                              location=(x + ux * 0.02, y + uy * 0.02, z))
        o = bpy.context.active_object; o.scale = (1, 1, 0.5)
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        o.data.materials.append(MAT_VINE); VINE_PARTS.append(o)

# ================================================================================
# ---- lantern head: capital, brackets, hex cage, glass, crystal, roof ------------
# ================================================================================
HEAD_PARTS = []

def add_cone(name, loc, r1, r2, depth, verts, mat=None, rot_z=0.0, flip=False):
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r1, radius2=r2, depth=depth, location=loc)
    o = bpy.context.active_object; o.name = name
    if flip: o.rotation_euler = (math.pi, 0, rot_z)
    elif rot_z: o.rotation_euler = (0, 0, rot_z)
    if mat: o.data.materials.append(mat)
    return o

# flared capital at the shaft top
capital = add_cone("capital", (0, 0, (CAP_Z0 + CAP_Z1) / 2), 0.078, 0.155, CAP_Z1 - CAP_Z0, 24)
apply_tiled(capital, MAT_METAL); smooth_obj(capital, 45); HEAD_PARTS.append(capital)

# hex base plate + top rim (rotated 30 deg so flats face the viewer axes)
def hex_plate(name, z0, z1, r):
    bpy.ops.mesh.primitive_cylinder_add(vertices=6, radius=r, depth=z1 - z0, location=(0, 0, (z0 + z1) / 2))
    o = bpy.context.active_object; o.name = name
    o.rotation_euler = (0, 0, math.radians(30))
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    apply_tiled(o, MAT_METAL)
    return o
HEAD_PARTS.append(hex_plate("basePlate", PLATE_Z0, PLATE_Z1, 0.28))
HEAD_PARTS.append(hex_plate("topRim", RIM_Z0, RIM_Z1, 0.26))

# 6 S-curve metalwork brackets: capital -> under the base-plate edge
def bracket(az_deg):
    az = math.radians(az_deg)
    base_pts = [(0.09, 4.245), (0.15, 4.24), (0.21, 4.27), (0.255, 4.33), (0.255, 4.355)]
    curve = bpy.data.curves.new("bracket", "CURVE"); curve.dimensions = "3D"
    sp = curve.splines.new("BEZIER"); sp.bezier_points.add(len(base_pts) - 1)
    for i, (r, z) in enumerate(base_pts):
        p = sp.bezier_points[i]; p.co = (r * math.cos(az), r * math.sin(az), z)
        p.handle_left_type = "AUTO"; p.handle_right_type = "AUTO"
    curve.bevel_depth = 0.011; curve.bevel_resolution = 1; curve.resolution_u = 6
    ob = bpy.data.objects.new("bracket", curve); bpy.context.collection.objects.link(ob)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.select_all(action="DESELECT"); ob.select_set(True)
    bpy.ops.object.convert(target="MESH")
    apply_tiled(ob, MAT_METAL)
    return ob
for k in range(6):
    HEAD_PARTS.append(bracket(30 + k * 60))

# cage: 6 thin corner posts + muntin bars + corner braces (METALWORK, not a box)
GLASS_PARTS = []
post_h = POST_Z1 - POST_Z0
for k in range(6):
    az_deg = 30 + k * 60; az = math.radians(az_deg)
    x, y = HEX_R * math.cos(az), HEX_R * math.sin(az)
    HEAD_PARTS.append(box_rot("post", (x, y, (POST_Z0 + POST_Z1) / 2), (0.024, 0.024, post_h), (0, 0, az_deg)))
    # small diagonal brace at each post top
    bx, by = (HEX_R - 0.035) * math.cos(az), (HEX_R - 0.035) * math.sin(az)
    HEAD_PARTS.append(box_rot("brace", (bx, by, POST_Z1 - 0.045), (0.012, 0.012, 0.1), (0, 38, az_deg)))
for k in range(6):
    az_mid = math.radians(k * 60)
    apo = HEX_R * math.cos(math.radians(30))
    mx, my = apo * math.cos(az_mid), apo * math.sin(az_mid)
    side_w = HEX_R - 0.05
    # muntin bar (panel division) at mid height + a lower rail
    HEAD_PARTS.append(box_rot("muntin", (mx, my, POST_Z0 + post_h * 0.62), (0.012, side_w, 0.014), (0, 0, k * 60)))
    HEAD_PARTS.append(box_rot("rail", (mx, my, POST_Z0 + 0.03), (0.014, side_w, 0.02), (0, 0, k * 60)))
    # thin warm glass pane
    gx, gy = (apo - 0.012) * math.cos(az_mid), (apo - 0.012) * math.sin(az_mid)
    GLASS_PARTS.append(box_rot("pane", (gx, gy, (POST_Z0 + POST_Z1) / 2), (0.005, side_w, post_h - 0.02),
                               (0, 0, k * 60), MAT_GLASS))
for p in HEAD_PARTS[9:]:
    if not p.data.materials: apply_tiled(p, MAT_METAL)

# THE STAR: hex-bipyramid gold crystal on a small mount
CRYSTAL_PARTS = []
mount = add_cone("mount", (0, 0, 4.415), 0.06, 0.028, 0.05, 12)
apply_tiled(mount, MAT_METAL); HEAD_PARTS.append(mount)
CRYSTAL_PARTS.append(add_cone("crystalUp", (0, 0, 4.60 + 0.115), 0.13, 0.016, 0.23, 6, MAT_CRYSTAL, rot_z=0.3))
CRYSTAL_PARTS.append(add_cone("crystalDn", (0, 0, 4.60 - 0.08), 0.13, 0.028, 0.16, 6, MAT_CRYSTAL2, rot_z=0.3, flip=True))
# a mid "girdle" ring of small amber facets where the two pyramids meet — silhouette sparkle
for k in range(6):
    ga = math.radians(k * 60 + 30) + 0.3
    gx, gy = 0.125 * math.cos(ga), 0.125 * math.sin(ga)
    CRYSTAL_PARTS.append(box_rot("facet", (gx, gy, 4.60), (0.03, 0.03, 0.05), (0, 40, k * 60 + 47), MAT_CRYSTAL2))
# two tiny satellite shards inside the cage for facet sparkle
for dx, dy, dz, h in ((0.14, 0.06, 4.46, 0.1), (-0.13, -0.09, 4.48, 0.085)):
    CRYSTAL_PARTS.append(add_cone("shard", (dx, dy, dz + h / 2), 0.03, 0.005, h, 6, MAT_CRYSTAL, rot_z=random.uniform(0, 3)))

# roof: hex cone with eaves overhang + finial (rod, ball, spike, glowing tip)
roof = add_cone("roof", (0, 0, (ROOF_Z0 + ROOF_Z1) / 2), 0.30, 0.035, ROOF_Z1 - ROOF_Z0, 6, rot_z=math.radians(30))
apply_tiled(roof, MAT_METAL); HEAD_PARTS.append(roof)
roof_lip = hex_plate("roofLip", ROOF_Z0 - 0.012, ROOF_Z0 + 0.012, 0.305)
HEAD_PARTS.append(roof_lip)
bpy.ops.mesh.primitive_cylinder_add(vertices=10, radius=0.014, depth=0.07, location=(0, 0, ROOF_Z1 + 0.035))
rod = bpy.context.active_object; rod.name = "finialRod"; apply_tiled(rod, MAT_METAL); HEAD_PARTS.append(rod)
bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=0.032, location=(0, 0, ROOF_Z1 + 0.09))
ball = bpy.context.active_object; ball.name = "finialBall"; apply_tiled(ball, MAT_METAL); smooth_obj(ball, 60); HEAD_PARTS.append(ball)
spike = add_cone("finialSpike", (0, 0, ROOF_Z1 + 0.155), 0.016, 0.002, 0.09, 8)
apply_tiled(spike, MAT_METAL); HEAD_PARTS.append(spike)
# a whisper of gold at the very tip
bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=0.012, location=(0, 0, ROOF_Z1 + 0.205))
tip = bpy.context.active_object; tip.name = "finialTip"; tip.data.materials.append(MAT_MOTE)
CRYSTAL_PARTS.append(tip)

# warm light-spill disc on the cage floor (sells "lit from inside" without a light object)
bpy.ops.mesh.primitive_cylinder_add(vertices=6, radius=0.17, depth=0.006, location=(0, 0, PLATE_Z1 + 0.004))
spill = bpy.context.active_object; spill.name = "glowFloor"
spill.rotation_euler = (0, 0, math.radians(30))
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
# v4: 0.9 washed the whole cage as bright as the crystal — the STAR must be the brightest thing
spill.data.materials.append(emissive("FloorGlow", (0.3, 0.16, 0.04), (1.0, 0.5, 0.03), 0.5, rough=0.4))
CRYSTAL_PARTS.append(spill)

# floating light motes near the head (REAL tiny emissive meshes)
MOTE_PARTS = []
for i in range(5):
    ang = random.uniform(0, 2 * math.pi)
    rad = random.uniform(0.3, 0.52)
    z = random.uniform(4.3, 5.12)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=random.uniform(0.016, 0.03),
                                          location=(rad * math.cos(ang), rad * math.sin(ang), z))
    o = bpy.context.active_object; o.name = f"mote{i}"
    o.data.materials.append(MAT_MOTE); MOTE_PARTS.append(o)

# ================================================================================
# ---- join + export ---------------------------------------------------------------
# ================================================================================
join_all("Pedestal", BASE_PARTS)
join_all("MossPatches", MOSS_PARTS)
join_all("Shaft", SHAFT_PARTS)
join_all("Runes", RUNE_PARTS)
join_all("Vines", VINE_PARTS)
join_all("LanternHead", HEAD_PARTS)
join_all("GlassPanes", GLASS_PARTS)
join_all("Crystal", CRYSTAL_PARTS)
join_all("Motes", MOTE_PARTS)

def tri_count(me):
    me.calc_loop_triangles()
    return len(me.loop_triangles)
total_tris = sum(tri_count(o.data) for o in bpy.data.objects if o.type == "MESH")
print(f"whisperlight-lantern: total tris ~= {total_tris}")
print(f"whisperlight-lantern: tip z ~= {ROOF_Z1 + 0.21:.2f}")

bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_yup=True, export_apply=True)
print(f"whisperlight-lantern: wrote {OUT}")
