import argparse
import bpy
import sys

parser = argparse.ArgumentParser()
parser.add_argument("--output", required=True)
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
args = parser.parse_args(argv)

bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=4, radius=1.0)
obj = bpy.context.object
obj.name = "retopo_test_source"
material = bpy.data.materials.new("source_pbr")
material.use_nodes = True
shader = material.node_tree.nodes.get("Principled BSDF")
shader.inputs["Base Color"].default_value = (0.12, 0.38, 0.08, 1.0)
shader.inputs["Roughness"].default_value = 0.67
obj.data.materials.append(material)
bpy.ops.export_scene.gltf(
    filepath=args.output,
    export_format="GLB",
    use_selection=True,
    export_animations=False,
    export_skins=False,
    export_morph=False,
    export_yup=True,
    export_apply=True,
    export_try_sparse_sk=False,
    check_existing=False,
)
