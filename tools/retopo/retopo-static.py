#!/usr/bin/env python3
"""Deterministic, CPU-only retopo and PBR bake for static opaque GLBs."""

import argparse
import hashlib
import json
import math
import os
import sys
from pathlib import Path

import bpy


CAP_M = 60.0
DEGENERATE_M = 0.02


def fail(message):
    raise RuntimeError(message)


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--summary", required=True)
    parser.add_argument("--seed", required=True, type=int)
    parser.add_argument("--target-faces", required=True, type=int)
    parser.add_argument("--resolution", required=True, type=int)
    parser.add_argument("--bake-samples", required=True, type=int)
    parser.add_argument("--cage-extrusion", required=True, type=float)
    return parser.parse_args(argv)


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def finite(values):
    for value in values:
        try:
            scalar = float(value)
        except (TypeError, ValueError):
            if not finite(value):
                return False
        else:
            if not math.isfinite(scalar):
                return False
    return True


def mesh_metrics(obj):
    vertices = len(obj.data.vertices)
    triangles = sum(max(0, len(poly.vertices) - 2) for poly in obj.data.polygons)
    return {"vertices": vertices, "triangles": triangles, "faces": len(obj.data.polygons)}


def validate_scene():
    if bpy.data.armatures or bpy.data.actions:
        fail("input contains a rig or animation")
    mesh_objects = []
    for obj in bpy.context.scene.objects:
        if obj.type not in {"MESH", "EMPTY"}:
            fail(f"input contains unsupported object type {obj.type}")
        if not finite(obj.matrix_world):
            fail(f"object {obj.name!r} has a non-finite transform")
        if obj.type == "MESH":
            if obj.data.shape_keys is not None:
                fail(f"mesh {obj.name!r} contains shape keys")
            if not obj.data.polygons:
                fail(f"mesh {obj.name!r} contains no faces")
            mesh_objects.append(obj)
    if not mesh_objects:
        fail("input contains no mesh")

    mins = [math.inf, math.inf, math.inf]
    maxs = [-math.inf, -math.inf, -math.inf]
    triangle_count = 0
    for obj in mesh_objects:
        triangle_count += mesh_metrics(obj)["triangles"]
        for vertex in obj.data.vertices:
            point = obj.matrix_world @ vertex.co
            if not finite(point):
                fail(f"mesh {obj.name!r} contains a non-finite vertex")
            for axis in range(3):
                mins[axis] = min(mins[axis], point[axis])
                maxs[axis] = max(maxs[axis], point[axis])
    dimensions = [maxs[i] - mins[i] for i in range(3)]
    if triangle_count == 0:
        fail("input contains no triangles")
    if max(dimensions) < DEGENERATE_M:
        fail("input bounds are degenerate")
    if any(value > CAP_M for value in dimensions) or any(abs(value) > CAP_M for value in mins + maxs):
        fail(f"input bounds exceed the {CAP_M:g} metre static-asset limit")
    return mesh_objects, {
        "meshCount": len(mesh_objects),
        "triangles": triangle_count,
        "boundsMinM": [round(value, 6) for value in mins],
        "boundsMaxM": [round(value, 6) for value in maxs],
    }


def join_meshes(objects, name):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.convert(target="MESH")
    if len(objects) > 1:
        bpy.ops.object.join()
    joined = bpy.context.view_layer.objects.active
    joined.name = name
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return joined


def image(name, resolution, color_space="Non-Color"):
    result = bpy.data.images.new(name, width=resolution, height=resolution, alpha=False, float_buffer=False)
    result.colorspace_settings.name = color_space
    result.generated_color = (0.0, 0.0, 0.0, 1.0)
    return result


def bake_map(high, low, target_material, target_image, bake_type, cage_extrusion):
    nodes = target_material.node_tree.nodes
    target = nodes.new("ShaderNodeTexImage")
    target.image = target_image
    nodes.active = target
    bpy.ops.object.select_all(action="DESELECT")
    high.select_set(True)
    low.select_set(True)
    bpy.context.view_layer.objects.active = low
    bpy.context.scene.render.bake.margin = 4
    bpy.context.scene.render.bake.use_clear = True
    kwargs = {
        "type": bake_type,
        "use_selected_to_active": True,
        "cage_extrusion": cage_extrusion,
    }
    if bake_type == "DIFFUSE":
        bpy.context.scene.render.bake.use_pass_direct = False
        bpy.context.scene.render.bake.use_pass_indirect = False
        bpy.context.scene.render.bake.use_pass_color = True
    if bake_type == "NORMAL":
        kwargs.update(normal_space="TANGENT", normal_r="POS_X", normal_g="POS_Y", normal_b="POS_Z")
    bpy.ops.object.bake(**kwargs)
    nodes.remove(target)


def pack_orm(ao, roughness, resolution):
    packed = image("limina_orm", resolution)
    ao_pixels = list(ao.pixels)
    rough_pixels = list(roughness.pixels)
    pixels = [0.0] * len(ao_pixels)
    for offset in range(0, len(pixels), 4):
        pixels[offset] = ao_pixels[offset]
        pixels[offset + 1] = rough_pixels[offset]
        pixels[offset + 2] = 0.0
        pixels[offset + 3] = 1.0
    packed.pixels.foreach_set(pixels)
    packed.update()
    return packed


def clean_material(albedo, normal, orm):
    material = bpy.data.materials.new("limina_static_opaque")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    shader = nodes.new("ShaderNodeBsdfPrincipled")
    base = nodes.new("ShaderNodeTexImage")
    base.image = albedo
    normal_tex = nodes.new("ShaderNodeTexImage")
    normal_tex.image = normal
    normal_map = nodes.new("ShaderNodeNormalMap")
    orm_tex = nodes.new("ShaderNodeTexImage")
    orm_tex.image = orm
    separate = nodes.new("ShaderNodeSeparateColor")
    links.new(base.outputs["Color"], shader.inputs["Base Color"])
    links.new(normal_tex.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], shader.inputs["Normal"])
    links.new(orm_tex.outputs["Color"], separate.inputs["Color"])
    links.new(separate.outputs["Green"], shader.inputs["Roughness"])
    links.new(separate.outputs["Blue"], shader.inputs["Metallic"])
    links.new(shader.outputs["BSDF"], output.inputs["Surface"])

    group_tree = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
    group_tree.interface.new_socket(name="Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
    occlusion = nodes.new("ShaderNodeGroup")
    occlusion.node_tree = group_tree
    links.new(separate.outputs["Red"], occlusion.inputs["Occlusion"])
    return material


def run(args):
    if not (0 <= args.seed <= 2_147_483_647):
        fail("seed must be in [0, 2147483647]")
    if not (64 <= args.target_faces <= 2_000_000):
        fail("target-faces must be in [64, 2000000]")
    if args.resolution < 16 or args.resolution > 8192 or args.resolution & (args.resolution - 1):
        fail("resolution must be a power of two in [16, 8192]")
    if not (1 <= args.bake_samples <= 4096):
        fail("bake-samples must be in [1, 4096]")
    if not math.isfinite(args.cage_extrusion) or not (0.0 < args.cage_extrusion <= 1.0):
        fail("cage-extrusion must be finite and in (0, 1]")

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(Path(args.input).resolve()), import_shading="NORMALS")
    source_objects, input_metrics = validate_scene()
    high = join_meshes(source_objects, "limina_bake_source")
    low = high.copy()
    low.data = high.data.copy()
    bpy.context.collection.objects.link(low)
    low.name = "limina_static_opaque"
    bpy.ops.object.select_all(action="DESELECT")
    low.select_set(True)
    bpy.context.view_layer.objects.active = low
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.remove_doubles(threshold=0.000001)
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.quadriflow_remesh(
        mode="FACES",
        target_faces=args.target_faces,
        seed=args.seed,
        use_preserve_sharp=True,
        use_preserve_boundary=True,
        preserve_attributes=False,
        smooth_normals=True,
    )
    if not low.data.polygons:
        fail("QuadriFlow produced no faces")

    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66.0), island_margin=0.02, area_weight=0.0, correct_aspect=True, scale_to_bounds=True)
    bpy.ops.object.mode_set(mode="OBJECT")

    bake_material = bpy.data.materials.new("limina_bake_target")
    bake_material.use_nodes = True
    low.data.materials.clear()
    low.data.materials.append(bake_material)
    albedo = image("limina_albedo", args.resolution, "sRGB")
    normal = image("limina_normal", args.resolution)
    roughness = image("limina_roughness", args.resolution)
    ao = image("limina_ao", args.resolution)

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE_NEXT" if not hasattr(scene, "cycles") else "CYCLES"
    scene.render.engine = "CYCLES"
    scene.render.threads_mode = "FIXED"
    scene.render.threads = 1
    scene.cycles.device = "CPU"
    scene.cycles.samples = args.bake_samples
    scene.cycles.seed = args.seed
    scene.render.image_settings.file_format = "PNG"
    bake_map(high, low, bake_material, albedo, "DIFFUSE", args.cage_extrusion)
    bake_map(high, low, bake_material, normal, "NORMAL", args.cage_extrusion)
    bake_map(high, low, bake_material, roughness, "ROUGHNESS", args.cage_extrusion)
    bake_map(high, low, bake_material, ao, "AO", args.cage_extrusion)
    orm = pack_orm(ao, roughness, args.resolution)

    output_material = clean_material(albedo, normal, orm)
    low.data.materials.clear()
    low.data.materials.append(output_material)
    bpy.ops.object.select_all(action="DESELECT")
    low.select_set(True)
    bpy.context.view_layer.objects.active = low
    bpy.ops.export_scene.gltf(
        filepath=str(Path(args.output).resolve()),
        export_format="GLB",
        use_selection=True,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_yup=True,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_tangents=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_extras=False,
        export_cameras=False,
        export_lights=False,
        export_try_sparse_sk=False,
        check_existing=False,
    )
    summary = {
        "schema": "limina.retopo-blender/1",
        "blenderVersion": bpy.app.version_string,
        "input": input_metrics,
        "output": {**mesh_metrics(low), "sha256": sha256(args.output)},
        "recipe": {
            "quadriflow": {"seed": args.seed, "targetFaces": args.target_faces, "threads": 1},
            "uv": {"method": "SMART_PROJECT", "angleLimitDegrees": 66.0, "islandMargin": 0.02},
            "bake": {"engine": "CYCLES", "device": "CPU", "selectedToActive": True,
                     "cageExtrusionM": args.cage_extrusion, "resolution": args.resolution,
                     "samples": args.bake_samples, "seed": args.seed,
                     "maps": ["albedo", "tangentNormalOpenGL", "roughness", "ao"],
                     "ormChannels": {"r": "ao", "g": "roughness", "b": "metallicZero"}},
        },
    }
    Path(args.summary).write_text(json.dumps(summary, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")


if __name__ == "__main__":
    try:
        run(parse_args())
    except Exception as error:
        print(f"retopo failed: {error}", file=sys.stderr)
        sys.exit(1)
