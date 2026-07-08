# make_fixtures.py — deterministic synthetic TEST FIXTURES for the engine-core gate suite.
#
#   blender --background --factory-startup --python tools/blender/make_fixtures.py -- [--outdir assets/fixtures]
#
# These are NOT content. They are the minimal GLBs the gates load so the engine-core test suite never
# depends on generated project assets (see plan-afc036e6b9c7451c "Engine <-> Content Decoupling"). Each
# is built to the EXACT measured requirement of the gate that consumes it:
#   * mesh.glb            — a 1.2 m untextured box (ONE solid material, zero base-color maps). Serves
#                           p11_gltf_texture (the "no map" roles), p87_glb_part (fit/scale math), p40
#                           (a loadable/instanceable mesh) and p17b (any *.glb bytes).
#   * textured-cube.glb   — a 0.5 m box carrying a real embedded (bufferView) base-color image with
#                           non-zero pixels + UVs. Serves p11_gltf_texture's decoded-albedo assertion.
#   * building.glb        — an ~8.5 x 5.5 x 6.5 m box, subdivided past the fidelity floor
#                           (>=500 verts / >=200 tris / >=2 materials, each declaring a baseColorTexture,
#                           roughness 0.8, white factor). Serves p90 (round-trip + plausibility bbox,
#                           no sidecar) and p91's PASS case (building fidelity floor + theme envelope).
# All are metre-scale with their base at ground (z=0) so check:assets stays clean. Fully deterministic.

import bpy
import sys
import os

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
def arg(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default

OUTDIR = arg("--outdir", "assets/fixtures")
os.makedirs(OUTDIR, exist_ok=True)


def clean():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for d in list(coll):
            coll.remove(d)


def solid_material(name, rgb):
    """A Principled material with a SOLID base colour and NO image texture (0 base-color maps)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (rgb[0], rgb[1], rgb[2], 1.0)
    b.inputs["Roughness"].default_value = 0.8
    if "Metallic" in b.inputs:
        b.inputs["Metallic"].default_value = 0.0
    return m


def gen_image(name, rgb):
    """A 16x16 solid non-black image, packed so GLB export embeds it as a bufferView PNG."""
    img = bpy.data.images.new(name, width=16, height=16, alpha=False)
    px = []
    for _ in range(16 * 16):
        px += [rgb[0], rgb[1], rgb[2], 1.0]
    img.pixels = px
    img.pack()
    return img


def textured_material(name, img):
    """A Principled material with a WHITE base-color FACTOR + an Image Texture base-color MAP.

    White factor keeps p91's theme check on the permissive texture-only envelope (roughness in
    [0.10, 0.98]); the declared baseColorTexture satisfies requiresAlbedoMap."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (1.0, 1.0, 1.0, 1.0)
    b.inputs["Roughness"].default_value = 0.8
    if "Metallic" in b.inputs:
        b.inputs["Metallic"].default_value = 0.0
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    nt.links.new(tex.outputs["Color"], b.inputs["Base Color"])
    return m


def uv_unwrap(obj):
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=1.15)
    bpy.ops.object.mode_set(mode="OBJECT")


def new_box(name, dims):
    """A box of world size `dims`, base sitting on z=0, transforms applied."""
    bpy.ops.mesh.primitive_cube_add(size=2.0, location=(0, 0, 0))
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (dims[0] / 2.0, dims[1] / 2.0, dims[2] / 2.0)
    bpy.ops.object.transform_apply(scale=True)
    obj.location.z = dims[2] / 2.0  # base to ground
    bpy.ops.object.transform_apply(location=True)
    return obj


def export(path):
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", export_yup=True,
        export_materials="EXPORT", export_texcoords=True, export_normals=True,
        export_apply=True,
    )
    print("make_fixtures: wrote", path)


# ---- mesh.glb : 1.2 m untextured box, one solid material -----------------------------------------
clean()
box = new_box("fixture_mesh", (1.2, 1.2, 1.2))
box.data.materials.append(solid_material("fixture_solid", (0.55, 0.55, 0.58)))
export(os.path.join(OUTDIR, "mesh.glb"))

# ---- textured-cube.glb : 0.5 m box with a real embedded base-color image -------------------------
clean()
tcube = new_box("fixture_textured", (0.5, 0.5, 0.5))
uv_unwrap(tcube)
tcube.data.materials.append(textured_material("fixture_tex", gen_image("fixture_albedo", (0.85, 0.5, 0.2))))
export(os.path.join(OUTDIR, "textured-cube.glb"))

# ---- building.glb : ~8.5 x 5.5 x 6.5 m, past the building fidelity floor, 2 textured materials ----
clean()
# Blender (X, Y, Z) -> glTF Y-up (X, Z, Y): pass (8.5, 6.5, 5.5) so the exported [W,H,D] is
# [8.5, 5.5, 6.5] — comfortably inside p90's plausibility windows W[7.5,9.5]/H[4.5,7.0]/D[5.5,8.0].
bld = new_box("fixture_building", (8.5, 6.5, 5.5))
# Subdivide well past 500 verts / 200 tris.
bpy.context.view_layer.objects.active = bld
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.mesh.subdivide(number_cuts=10)
bpy.ops.object.mode_set(mode="OBJECT")
uv_unwrap(bld)
wall = textured_material("fixture_wall", gen_image("fixture_wall_tex", (0.72, 0.66, 0.55)))
roof = textured_material("fixture_roof", gen_image("fixture_roof_tex", (0.35, 0.22, 0.16)))
bld.data.materials.append(wall)
bld.data.materials.append(roof)
# Assign the roof material to the top band of faces (z near the top) so there are >= 2 real materials.
top_z = max((bld.matrix_world @ v.co).z for v in bld.data.vertices)
for poly in bld.data.polygons:
    cz = sum((bld.matrix_world @ bld.data.vertices[i].co).z for i in poly.vertices) / len(poly.vertices)
    poly.material_index = 1 if cz > top_z - 0.75 else 0
export(os.path.join(OUTDIR, "building.glb"))

print("make_fixtures: done ->", OUTDIR)
