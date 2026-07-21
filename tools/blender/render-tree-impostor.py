"""Pinned Blender CPU renderer for Limina upper-hemisphere tree impostor cells.

The host orchestrator owns packing, GLB publication, hashes, and QC. This subprocess only imports
one accepted GLB and writes deterministic transparent PNG view cells. It never uses CUDA/OptiX.
"""
import argparse
import json
import math
import os
import sys

import bpy
from mathutils import Vector


def parse_args():
    tail = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--grid", type=int, required=True)
    parser.add_argument("--cell-size", type=int, required=True)
    parser.add_argument("--samples", type=int, default=32)
    parser.add_argument("--seed", type=int, default=1)
    return parser.parse_args(tail)


def decode_upper_hemi_octa(u, v):
    qx, qy = u * 2.0 - 1.0, v * 2.0 - 1.0
    x, z = (qx + qy) * 0.5, (qx - qy) * 0.5
    y = max(0.0, 1.0 - abs(x) - abs(z))
    return Vector((x, y, z)).normalized()


def reset_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.cameras, bpy.data.lights):
        for block in list(datablocks):
            if block.users == 0:
                datablocks.remove(block)


def import_glb(path):
    bpy.ops.import_scene.gltf(filepath=path)
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not meshes:
        raise RuntimeError("tree impostor input contains no mesh objects")
    return meshes


def world_bounds(objects):
    minimum = Vector((math.inf, math.inf, math.inf))
    maximum = Vector((-math.inf, -math.inf, -math.inf))
    for obj in objects:
        for corner in obj.bound_box:
            point = obj.matrix_world @ Vector(corner)
            for axis in range(3):
                minimum[axis] = min(minimum[axis], point[axis])
                maximum[axis] = max(maximum[axis], point[axis])
    if any(not math.isfinite(value) for value in (*minimum, *maximum)):
        raise RuntimeError("tree impostor input bounds are not finite")
    return minimum, maximum


def source_socket(material, name, default):
    if not material.use_nodes or material.node_tree is None:
        return None, default
    principled = next((node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED"), None)
    socket = principled.inputs.get(name) if principled else None
    if socket is None:
        return None, default
    return (socket.links[0].from_socket if socket.is_linked else None), socket.default_value


def make_pass_material(source, mode, near_depth, depth_range):
    material = source.copy()
    material.name = f"limina-impostor-{mode}:{source.name}"
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    base_link, base_default = source_socket(material, "Base Color", (0.5, 0.5, 0.5, 1.0))
    alpha_link, alpha_default = source_socket(material, "Alpha", 1.0)
    output = next((node for node in nodes if node.type == "OUTPUT_MATERIAL"), None) or nodes.new("ShaderNodeOutputMaterial")
    for link in list(output.inputs["Surface"].links):
        links.remove(link)
    emission = nodes.new("ShaderNodeEmission")
    if mode == "albedo":
        if base_link is not None:
            links.new(base_link, emission.inputs["Color"])
        else:
            emission.inputs["Color"].default_value = base_default
    else:
        geometry = nodes.new("ShaderNodeNewGeometry")
        transform = nodes.new("ShaderNodeVectorTransform")
        transform.vector_type = "NORMAL"
        transform.convert_from = "WORLD"
        transform.convert_to = "CAMERA"
        links.new(geometry.outputs["Normal"], transform.inputs["Vector"])
        separate = nodes.new("ShaderNodeSeparateXYZ")
        links.new(transform.outputs["Vector"], separate.inputs["Vector"])
        map_x, map_y = nodes.new("ShaderNodeMath"), nodes.new("ShaderNodeMath")
        map_x.operation = map_y.operation = "MULTIPLY_ADD"
        map_x.inputs[1].default_value = map_y.inputs[1].default_value = 0.5
        map_x.inputs[2].default_value = map_y.inputs[2].default_value = 0.5
        links.new(separate.outputs["X"], map_x.inputs[0]); links.new(separate.outputs["Y"], map_y.inputs[0])
        camera = nodes.new("ShaderNodeCameraData")
        subtract = nodes.new("ShaderNodeMath"); subtract.operation = "SUBTRACT"; subtract.inputs[1].default_value = near_depth
        divide = nodes.new("ShaderNodeMath"); divide.operation = "DIVIDE"; divide.inputs[1].default_value = depth_range
        clamp = nodes.new("ShaderNodeClamp")
        links.new(camera.outputs["View Z Depth"], subtract.inputs[0]); links.new(subtract.outputs[0], divide.inputs[0]); links.new(divide.outputs[0], clamp.inputs["Value"])
        combine = nodes.new("ShaderNodeCombineColor"); combine.mode = "RGB"
        links.new(map_x.outputs[0], combine.inputs["Red"]); links.new(map_y.outputs[0], combine.inputs["Green"]); links.new(clamp.outputs["Result"], combine.inputs["Blue"])
        links.new(combine.outputs["Color"], emission.inputs["Color"])
    emission.inputs["Strength"].default_value = 1.0
    transparent = nodes.new("ShaderNodeBsdfTransparent")
    mix = nodes.new("ShaderNodeMixShader")
    links.new(transparent.outputs[0], mix.inputs[1]); links.new(emission.outputs[0], mix.inputs[2])
    if alpha_link is not None:
        links.new(alpha_link, mix.inputs[0])
    else:
        mix.inputs[0].default_value = float(alpha_default)
    links.new(mix.outputs[0], output.inputs["Surface"])
    material.surface_render_method = "DITHERED"
    return material


def configure_scene(args, center, radius):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = args.samples
    scene.cycles.seed = args.seed
    scene.cycles.use_denoising = False
    scene.render.resolution_x = args.cell_size
    scene.render.resolution_y = args.cell_size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = True
    scene.render.image_settings.color_depth = "8"
    scene.render.resolution_percentage = 100
    scene.render.use_file_extension = True
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0
    scene.view_settings.gamma = 1
    camera_data = bpy.data.cameras.new("limina-impostor-camera")
    camera = bpy.data.objects.new("limina-impostor-camera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = radius * 2.15
    camera_data.lens = 50
    return scene, camera


def main():
    args = parse_args()
    if args.grid < 2 or args.grid > 16 or args.cell_size < 32 or args.cell_size > 512:
        raise RuntimeError("grid/cell-size outside production contract")
    os.makedirs(args.output_dir, exist_ok=True)
    reset_scene()
    meshes = import_glb(os.path.abspath(args.input))
    minimum, maximum = world_bounds(meshes)
    center = (minimum + maximum) * 0.5
    radius = max((maximum - minimum).length * 0.5, 0.01)
    distance = radius * 3.0
    near_depth, depth_range = distance - radius * 1.2, radius * 2.4
    scene, camera = configure_scene(args, center, radius)
    original_slots = [(obj, list(obj.data.materials)) for obj in meshes]
    unique_materials = {material for _, slots in original_slots for material in slots if material is not None}
    albedo = {material: make_pass_material(material, "albedo", near_depth, depth_range) for material in unique_materials}
    normal = {material: make_pass_material(material, "normal-depth", near_depth, depth_range) for material in unique_materials}

    def assign(mapping):
        for obj, slots in original_slots:
            for index, source in enumerate(slots):
                if source is not None:
                    obj.data.materials[index] = mapping[source]

    directions = []
    for row in range(args.grid):
        for column in range(args.grid):
            direction = decode_upper_hemi_octa((column + 0.5) / args.grid, (row + 0.5) / args.grid)
            directions.append([round(value, 8) for value in direction])
            camera.location = center + direction * distance
            camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
            index = row * args.grid + column
            assign(albedo)
            scene.render.filepath = os.path.join(args.output_dir, f"albedo-{index:03d}.png")
            bpy.ops.render.render(write_still=True)
            assign(normal)
            scene.render.filepath = os.path.join(args.output_dir, f"normal-depth-{index:03d}.png")
            bpy.ops.render.render(write_still=True)
    print("LIMINA_TREE_IMPOSTOR_SUMMARY=" + json.dumps({
        "schema": "limina.tree-impostor-render/1", "engine": "CYCLES", "device": "CPU", "samples": args.samples,
        "grid": args.grid, "cellSize": args.cell_size, "seed": args.seed,
        "bounds": {"min": list(minimum), "max": list(maximum)}, "directions": directions,
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
