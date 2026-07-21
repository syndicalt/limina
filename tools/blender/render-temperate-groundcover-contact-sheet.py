import argparse
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--asset-root", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])


def point_at(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def import_asset(path):
    before = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=str(path), import_shading="NORMALS")
    imported = [obj for obj in bpy.context.scene.objects if obj not in before]
    root = bpy.data.objects.new(f"root-{path.stem}", None)
    bpy.context.scene.collection.objects.link(root)
    for obj in [candidate for candidate in imported if candidate.parent is None]:
        obj.parent = root
    return root


def duplicate(root, location, rotation=0, scale=1):
    clone = root.copy()
    bpy.context.scene.collection.objects.link(clone)
    for child in root.children:
        copy = child.copy()
        copy.data = child.data
        bpy.context.scene.collection.objects.link(copy)
        copy.parent = clone
    clone.location = location
    clone.rotation_euler[2] = rotation
    clone.scale = (scale, scale, scale)


def main():
    cfg = parse_args()
    asset_root = Path(cfg.asset_root).resolve()
    output = Path(cfg.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 32
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1920
    scene.render.resolution_y = 1080
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(output)
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = 0.9

    ground_material = bpy.data.materials.new("forest-loam")
    ground_material.diffuse_color = (0.055, 0.075, 0.025, 1)
    ground_material.roughness = 0.95
    bpy.ops.mesh.primitive_plane_add(size=22, location=(0, 0, -0.02))
    bpy.context.object.data.materials.append(ground_material)

    fern = import_asset(asset_root / "fern-02-lod0.glb")
    shrub = import_asset(asset_root / "shrub-03-lod0.glb")
    moss = import_asset(asset_root / "moss-01-lod0.glb")
    fern.hide_render = shrub.hide_render = moss.hide_render = True

    for index, (x, y, rotation, scale) in enumerate([
        (-4.1, 0.3, 0.2, 1.0), (-3.3, -0.7, 2.1, 0.85), (-2.4, 0.45, 4.4, 1.15),
    ]): duplicate(fern, (x, y, 0), rotation, scale)
    for x, y, rotation, scale in [
        (-0.7, 0.2, 0.5, 1.45), (0.35, -0.45, 2.6, 1.15), (1.1, 0.35, 4.7, 1.3),
    ]: duplicate(shrub, (x, y, 0), rotation, scale)
    for index in range(22):
        x = 2.2 + (index % 6) * 0.46 + 0.12 * math.sin(index * 1.7)
        y = -0.8 + (index // 6) * 0.52 + 0.09 * math.cos(index * 2.1)
        duplicate(moss, (x, y, 0), index * 0.83, 0.85 + (index % 4) * 0.12)

    world = bpy.data.worlds.new("groundcover-studio")
    scene.world = world
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = (0.025, 0.04, 0.055, 1)
    background.inputs["Strength"].default_value = 0.45

    bpy.ops.object.light_add(type="AREA", location=(-5, -5, 8))
    key = bpy.context.object
    key.data.energy = 1700
    key.data.size = 6
    key.data.color = (1.0, 0.86, 0.66)
    point_at(key, (0, 0, 0.4))
    bpy.ops.object.light_add(type="AREA", location=(5, -2, 4))
    fill = bpy.context.object
    fill.data.energy = 900
    fill.data.size = 5
    fill.data.color = (0.55, 0.75, 1.0)
    point_at(fill, (0, 0, 0.3))

    bpy.ops.object.camera_add(location=(0, -12.5, 3.2))
    camera = bpy.context.object
    camera.data.lens = 58
    point_at(camera, (0, 0, 0.38))
    scene.camera = camera
    bpy.ops.render.render(write_still=True)
    print(f"LIMINA_CONTACT_SHEET={output}")


if __name__ == "__main__":
    main()
