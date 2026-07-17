import argparse
import math
import os
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--asset-root", required=True)
    parser.add_argument("--output", required=True)
    values = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    return parser.parse_args(values)


def point_at(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def material(name, color, roughness=0.8):
    value = bpy.data.materials.new(name)
    value.diffuse_color = (*color, 1)
    value.use_nodes = True
    shader = value.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*color, 1)
    shader.inputs["Roughness"].default_value = roughness
    return value


def import_tree(path, x):
    before = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=str(path), import_shading="NORMALS")
    imported = [obj for obj in bpy.context.scene.objects if obj not in before]
    roots = [obj for obj in imported if obj.parent is None]
    root = bpy.data.objects.new(f"root-{path.stem}", None)
    bpy.context.scene.collection.objects.link(root)
    for obj in roots:
        obj.parent = root
    root.location.x = x
    for obj in imported:
        if obj.type == "MESH":
            obj.visible_shadow = True
            for slot in obj.material_slots:
                if slot.material:
                    slot.material.use_nodes = True
    return root


def main():
    cfg = args()
    root = Path(cfg.asset_root).resolve()
    output = Path(cfg.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE_NEXT" if False else "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 32
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 2048
    scene.render.resolution_y = 1024
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.render.filepath = str(output)
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = 0.8

    ground_mat = material("forest-floor", (0.055, 0.085, 0.035), 0.96)
    bpy.ops.mesh.primitive_plane_add(size=150, location=(0, 0, -0.03))
    ground = bpy.context.object
    ground.data.materials.append(ground_mat)

    names = ["oak-101.glb", "oak-203.glb", "ash-307.glb", "ash-409.glb"]
    for name, x in zip(names, (-24, -8, 8, 24)):
        import_tree(root / name, x)

    world = bpy.data.worlds.new("temperate-studio")
    scene.world = world
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = (0.055, 0.075, 0.09, 1)
    background.inputs["Strength"].default_value = 0.5

    bpy.ops.object.light_add(type="AREA", location=(-22, -24, 28))
    key = bpy.context.object
    key.data.energy = 4200
    key.data.shape = "DISK"
    key.data.size = 18
    key.data.color = (1.0, 0.82, 0.64)
    point_at(key, (0, 0, 8))

    bpy.ops.object.light_add(type="AREA", location=(25, -12, 18))
    fill = bpy.context.object
    fill.data.energy = 2600
    fill.data.size = 22
    fill.data.color = (0.55, 0.72, 1.0)
    point_at(fill, (0, 0, 9))

    bpy.ops.object.light_add(type="SUN", location=(0, 0, 30))
    sun = bpy.context.object
    sun.data.energy = 1.2
    sun.data.angle = math.radians(4)
    sun.rotation_euler = (math.radians(28), math.radians(-18), math.radians(-32))

    bpy.ops.object.camera_add(location=(0, -110, 11.5))
    camera = bpy.context.object
    camera.data.lens = 62
    camera.data.sensor_width = 36
    point_at(camera, (0, 0, 8.5))
    scene.camera = camera

    bpy.ops.render.render(write_still=True)
    print(f"LIMINA_CONTACT_SHEET={output}")


if __name__ == "__main__":
    main()
