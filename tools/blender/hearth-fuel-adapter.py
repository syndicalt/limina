"""Build the deterministic V1 hearth fuel source without rendering.

The adapter starts from an empty Blender file, verifies every approved input
named by ``limina.hearth-fuel-recipe/v1``, authors an irregular ember bed,
individually semantic coal pockets, and three profiled fuel logs, then saves an editable source .blend and exports an engine-consumable
GLB carrying the same semantic part ids.  Flames, light, smoke, and soot remain
runtime-owned and are intentionally absent from this source asset.
"""
import bpy
import hashlib
import json
import math
import os
import re
import struct
import sys
from mathutils import Vector

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
HASH_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
ID_RE = re.compile(r"^[a-z0-9][a-z0-9._/-]{0,159}$")
EXPECTED_FRAME = {
    "units": "meter", "up": [0, 1, 0],
    "anchorSemanticId": "anchor/vfx/hall-hearth",
    "socketSemanticId": "socket/wall/hall-hearth",
    "origin": [2.95, 1.2, 3.18], "right": [1, 0, 0], "forward": [0, 0, -1],
}


def arg(flag):
    if flag not in ARGS or ARGS.index(flag) + 1 >= len(ARGS):
        raise RuntimeError("usage: hearth-fuel-adapter.py --recipe <json> --out <glb> --blend-out <blend>")
    return os.path.abspath(ARGS[ARGS.index(flag) + 1])


def sha_bytes(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def digest(path):
    with open(path, "rb") as handle:
        return sha_bytes(handle.read())


def canonical_hash(value):
    return sha_bytes(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf8"))


def exact(value, required, optional, label):
    if not isinstance(value, dict):
        raise RuntimeError(f"{label} must be an object")
    missing, unknown = sorted(set(required) - set(value)), sorted(set(value) - set(required) - set(optional))
    if missing or unknown:
        raise RuntimeError(f"{label} key drift; missing={missing}, unknown={unknown}")


def finite_vector(value, count, label):
    if not isinstance(value, list) or len(value) != count or any(isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(item) for item in value):
        raise RuntimeError(f"{label} must be a finite {count}-vector")
    return [float(item) for item in value]


def portable_resource(value, label):
    exact(value, {"path", "sha256", "artifactId"}, set(), label)
    if not isinstance(value["path"], str) or os.path.isabs(value["path"]) or "\\" in value["path"] or ".." in value["path"].split("/"):
        raise RuntimeError(f"{label}.path must be repository-relative")
    if not HASH_RE.fullmatch(value["sha256"]) or not ID_RE.fullmatch(value["artifactId"]):
        raise RuntimeError(f"{label} identity is invalid")
    path = os.path.abspath(os.path.join(REPO, *value["path"].split("/")))
    if os.path.commonpath((REPO, path)) != REPO or not os.path.isfile(path) or digest(path) != value["sha256"]:
        raise RuntimeError(f"{label} exact bytes drifted")
    return path


def glb_document(path, label):
    raw = open(path, "rb").read()
    if len(raw) < 20 or struct.unpack_from("<4sII", raw, 0) != (b"glTF", 2, len(raw)):
        raise RuntimeError(f"{label} is not an exact GLB v2 envelope")
    offset, document = 12, None
    while offset < len(raw):
        length, kind = struct.unpack_from("<II", raw, offset)
        offset += 8
        chunk = raw[offset:offset + length]
        offset += length
        if kind == 0x4E4F534A:
            document = json.loads(chunk.decode("utf8").rstrip(" \0"))
    if not isinstance(document, dict):
        raise RuntimeError(f"{label} has no JSON document")
    return document


def validate_authority(recipe):
    authority = recipe["authority"]
    exact(authority, {"shell", "interiorPlan", "materialsRuntime", "materialsLock"}, set(), "recipe.authority")
    paths = {key: portable_resource(authority[key], f"recipe.authority.{key}") for key in authority}
    shell = glb_document(paths["shell"], "approved shell-r4")
    materials_runtime = glb_document(paths["materialsRuntime"], "approved M1-r2 runtime")
    shell_ids = {node.get("extras", {}).get("limina.id") for node in shell.get("nodes", [])}
    required_shell = {"fireplace/hall-hearth/base", "fireplace/hall-hearth/fireback", "fireplace/hall-hearth/lining-left", "fireplace/hall-hearth/lining-right", "fireplace/hall-hearth/lintel", "fireplace/hall-hearth/throat", "fireplace/hall-hearth/smoke-shelf"}
    if not required_shell.issubset(shell_ids):
        raise RuntimeError("approved shell-r4 lacks the audited hearth semantics")
    material_sources = materials_runtime.get("asset", {}).get("extras", {}).get("liminaMaterialSources")
    if not isinstance(material_sources, dict) or material_sources.get("schema") != "limina.material-sources/v1":
        raise RuntimeError("approved M1-r2 runtime lacks its exact material-source closure")
    with open(paths["interiorPlan"], "r", encoding="utf8") as handle:
        plan = json.load(handle)
    if plan.get("planId") != authority["interiorPlan"]["artifactId"] or plan.get("revision") != 4:
        raise RuntimeError("approved I1-r4 plan identity drifted")
    anchors = {item.get("id"): item for item in plan.get("anchors", [])}
    sockets = {item.get("id"): item for item in plan.get("surfaceSockets", [])}
    anchor, socket = anchors.get(EXPECTED_FRAME["anchorSemanticId"]), sockets.get(EXPECTED_FRAME["socketSemanticId"])
    if anchor is None or socket is None or anchor.get("position") != EXPECTED_FRAME["origin"] or anchor.get("direction") != EXPECTED_FRAME["forward"] or socket.get("position") != EXPECTED_FRAME["origin"] or socket.get("normal") != EXPECTED_FRAME["forward"]:
        raise RuntimeError("approved I1-r4 hearth anchor/socket drifted")
    with open(paths["materialsLock"], "r", encoding="utf8") as handle:
        lock = json.load(handle)
    roles = {item.get("role"): item for item in lock.get("materials", lock.get("roles", []))}
    if "hearth-embers" not in roles:
        # Current lock stores the role array under materialRoles.
        roles = {item.get("role"): item for item in lock.get("materialRoles", [])}
    for material in recipe["materials"]:
        authority_role, approved = material["authorityRole"], roles.get(material["authorityRole"])
        parameters = {key: material[key] for key in ("baseColorSrgb", "roughness", "metallic", "emissionSrgb", "emissionStrength")}
        if authority_role not in {"hearth-embers", "hearth-soot"} or not approved or any(parameters[key] != approved.get("parameters", {}).get(key) for key in parameters):
            raise RuntimeError(f"recipe material {material['role']} drifted from approved M1 role {authority_role}")
    return paths


def validate_recipe(value):
    exact(value, {"schema", "id", "revision", "status", "coordinateFrame", "authority", "firebox", "materials", "parts", "aggregateBounds", "export"}, set(), "recipe")
    if value["schema"] != "limina.hearth-fuel-recipe/v1" or value["id"] != "fire/functional-hall-house-v4/hearth-fuel/r1" or value["revision"] != 1 or value["status"] != "authoring-recipe":
        raise RuntimeError("unsupported hearth fuel recipe identity")
    if value["coordinateFrame"] != EXPECTED_FRAME:
        raise RuntimeError("hearth fuel coordinate frame drifted")
    firebox = value["firebox"]
    exact(firebox, {"openingBounds", "conservativeFuelBounds", "supportY", "requiredClearanceM"}, set(), "recipe.firebox")
    for key in ("openingBounds", "conservativeFuelBounds", "aggregateBounds"):
        bounds = firebox[key] if key in firebox else value[key]
        exact(bounds, {"min", "max"}, set(), f"recipe.{key}")
        lo, hi = finite_vector(bounds["min"], 3, f"recipe.{key}.min"), finite_vector(bounds["max"], 3, f"recipe.{key}.max")
        if any(lo[index] >= hi[index] for index in range(3)):
            raise RuntimeError(f"recipe.{key} is empty")
    materials = value["materials"]
    if not isinstance(materials, list) or len(materials) != 3:
        raise RuntimeError("recipe must define exactly three deterministic materials")
    roles = set()
    for index, material in enumerate(materials):
        exact(material, {"role", "name", "baseColorSrgb", "roughness", "metallic", "emissionSrgb", "emissionStrength", "authorityRole"}, set(), f"recipe.materials[{index}]")
        if not ID_RE.fullmatch(material["role"]) or material["role"] in roles:
            raise RuntimeError("recipe material roles must be unique stable ids")
        roles.add(material["role"])
        finite_vector(material["baseColorSrgb"], 3, "material.baseColorSrgb")
        finite_vector(material["emissionSrgb"], 3, "material.emissionSrgb")
    parts = value["parts"]
    if not isinstance(parts, list) or len(parts) < 12 or len({part.get("id") for part in parts}) != len(parts):
        raise RuntimeError("recipe must define an irregular ember bed, three logs, and at least eight unique coal pockets")
    kinds = [part.get("kind") for part in parts]
    if kinds.count("ember-bed") != 1 or kinds.count("log") != 3 or kinds.count("coal-pocket") < 8:
        raise RuntimeError("hearth fuel kind inventory drifted")
    for index, part in enumerate(parts):
        common = {"id", "kind", "center", "materialRoles"}
        if part.get("kind") == "ember-bed":
            shape = {"halfExtents", "radialScales", "topScale", "topOffset"}
        elif part.get("kind") == "log":
            shape = {"axis", "lengthM", "radiusM", "radialSegments", "ringProfile", "sideMaterialRole", "endgrainMaterialRole"}
        else:
            shape = {"halfExtents", "yawRadians", "radialScales", "topOffset"}
        exact(part, common | shape, set(), f"recipe.parts[{index}]")
        if not ID_RE.fullmatch(part["id"]) or not part["id"].startswith("fire/hall-hearth/fuel/"):
            raise RuntimeError("fuel part id is not semantic and hearth-scoped")
        finite_vector(part["center"], 3, "part.center")
        if not set(part["materialRoles"]).issubset(roles):
            raise RuntimeError("fuel part references an unknown material role")
        if part["kind"] == "ember-bed":
            finite_vector(part["halfExtents"], 3, "part.halfExtents")
            if not isinstance(part["radialScales"], list) or len(part["radialScales"]) != 16 or len(set(part["radialScales"])) < 6:
                raise RuntimeError("ember bed requires a nonuniform 16-sample perimeter")
            finite_vector(part["topOffset"], 2, "part.topOffset")
            if not 0 < part["topScale"] < 1:
                raise RuntimeError("ember bed top scale is invalid")
        elif part["kind"] == "log":
            axis = Vector(finite_vector(part["axis"], 3, "part.axis"))
            if abs(axis.length - 1) > 0.000002 or part["radialSegments"] != 16 or part["lengthM"] <= 0 or part["radiusM"] <= 0:
                raise RuntimeError("log geometry contract drifted")
            profile = part["ringProfile"]
            if not isinstance(profile, list) or len(profile) < 7 or profile[0].get("t") != -0.5 or profile[-1].get("t") != 0.5:
                raise RuntimeError("log requires an endpoint-complete nonuniform ring profile")
            previous = -math.inf
            for ring in profile:
                exact(ring, {"t", "radiusScale", "offsetA", "offsetB", "twistRadians"}, set(), "log.ringProfile")
                if ring["t"] <= previous or not 0.7 <= ring["radiusScale"] <= 1.15:
                    raise RuntimeError("log ring profile is not ordered and bounded")
                previous = ring["t"]
            if len({ring["radiusScale"] for ring in profile}) < 5 or len({ring["twistRadians"] for ring in profile}) < 5:
                raise RuntimeError("log profile lacks deterministic taper/twist variation")
            if part["sideMaterialRole"] != "hearth-soot-char" or part["endgrainMaterialRole"] != "hearth-soot-endgrain":
                raise RuntimeError("log char/endgrain assignment drifted")
        elif part["kind"] == "coal-pocket":
            finite_vector(part["halfExtents"], 3, "part.halfExtents")
            finite_vector(part["topOffset"], 2, "part.topOffset")
            if not isinstance(part["radialScales"], list) or len(part["radialScales"]) != 8 or len(set(part["radialScales"])) < 6:
                raise RuntimeError("coal pocket requires an individually irregular perimeter")
        else:
            raise RuntimeError("unsupported fuel part kind")
    export = value["export"]
    exact(export, {"rootSemanticId", "assetId", "blendId"}, set(), "recipe.export")
    if export["rootSemanticId"] != value["id"] or not export["assetId"].endswith("fire-r1/hearth-fuel-r1.glb") or not export["blendId"].endswith("fire-r1/hearth-fuel-r1.blend"):
        raise RuntimeError("recipe export identity drifted")
    validate_authority(value)
    return value


def material_from(spec):
    material = bpy.data.materials.new(spec["name"])
    material.use_nodes = True
    material["limina.materialRole"] = spec["authorityRole"]
    material["limina.materialVariant"] = spec["role"]
    material["limina.authorityRole"] = spec["authorityRole"]
    node = material.node_tree.nodes.get("Principled BSDF")
    node.inputs["Base Color"].default_value = (*spec["baseColorSrgb"], 1.0)
    node.inputs["Roughness"].default_value = spec["roughness"]
    node.inputs["Metallic"].default_value = spec["metallic"]
    emission = node.inputs.get("Emission Color") or node.inputs.get("Emission")
    if emission is not None:
        emission.default_value = (*spec["emissionSrgb"], 1.0)
    strength = node.inputs.get("Emission Strength")
    if strength is not None:
        strength.default_value = spec["emissionStrength"]
    return material


def stamp(obj, part, recipe_hash):
    obj.name = part["id"]
    obj["limina.id"] = part["id"]
    obj["limina.role"] = "hearth-fuel-part"
    obj["limina.kind"] = part["kind"]
    obj["limina.recipeHash"] = recipe_hash
    obj["limina.materialRolesJson"] = json.dumps(part["materialRoles"], separators=(",", ":"))
    obj["limina.editPolicy"] = "bounded-validate"


def make_ember(part, materials, recipe_hash):
    center, half, segments = Vector(part["center"]), Vector(part["halfExtents"]), 16
    vertices = []
    for ring_index, (y, scale) in enumerate(((-half.y, 1.0), (half.y, part["topScale"]))):
        for index in range(segments):
            angle = 2 * math.pi * index / segments
            radial = part["radialScales"][index]
            offset_x, offset_z = part["topOffset"] if ring_index else (0, 0)
            vertices.append((center.x + offset_x + half.x * scale * radial * math.cos(angle), center.y + y, center.z + offset_z + half.z * scale * radial * math.sin(angle)))
    faces = []
    for index in range(segments):
        nxt = (index + 1) % segments
        faces.append((index, nxt, segments + nxt, segments + index))
    faces.extend([tuple(range(segments - 1, -1, -1)), tuple(range(segments, 2 * segments))])
    mesh = bpy.data.meshes.new(part["id"] + "/mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(part["id"], mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(materials["hearth-embers"])
    stamp(obj, part, recipe_hash)
    return obj


def make_log(part, materials, recipe_hash):
    center, axis, segments = Vector(part["center"]), Vector(part["axis"]).normalized(), part["radialSegments"]
    basis_a = Vector((0, 1, 0))
    if abs(axis.dot(basis_a)) > 0.95:
        basis_a = Vector((1, 0, 0))
    basis_a = (basis_a - axis * axis.dot(basis_a)).normalized()
    basis_b = axis.cross(basis_a).normalized()
    vertices = []
    for ring in part["ringProfile"]:
        ring_center = center + axis * (ring["t"] * part["lengthM"]) + basis_a * ring["offsetA"] + basis_b * ring["offsetB"]
        for index in range(segments):
            angle = 2 * math.pi * index / segments + ring["twistRadians"]
            # Four deterministic shallow char furrows break the lathed silhouette.
            furrow = 1.0 - (0.055 if index % 4 == 0 else 0.0)
            radial = part["radiusM"] * ring["radiusScale"] * furrow
            point = ring_center + basis_a * (math.cos(angle) * radial) + basis_b * (math.sin(angle) * radial)
            vertices.append(tuple(point))
    faces, assignments, rings = [], [], len(part["ringProfile"])
    for ring_index in range(rings - 1):
        for index in range(segments):
            nxt = (index + 1) % segments
            faces.append((ring_index * segments + index, ring_index * segments + nxt, (ring_index + 1) * segments + nxt, (ring_index + 1) * segments + index))
            assignments.append(0)
    faces.extend([tuple(range(segments - 1, -1, -1)), tuple(range((rings - 1) * segments, rings * segments))])
    assignments.extend([1, 1])
    mesh = bpy.data.meshes.new(part["id"] + "/mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(part["id"], mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(materials[part["sideMaterialRole"]])
    obj.data.materials.append(materials[part["endgrainMaterialRole"]])
    for polygon, assignment in zip(obj.data.polygons, assignments):
        polygon.material_index = assignment
    obj["limina.ringProfileJson"] = json.dumps(part["ringProfile"], sort_keys=True, separators=(",", ":"))
    obj["limina.endgrainPolygonCount"] = 2
    stamp(obj, part, recipe_hash)
    return obj


def make_coal(part, materials, recipe_hash):
    center, half, segments = Vector(part["center"]), Vector(part["halfExtents"]), 8
    cosine, sine = math.cos(part["yawRadians"]), math.sin(part["yawRadians"])
    vertices = [(center.x, center.y - half.y, center.z)]
    for ring_index, (height, scale) in enumerate(((-0.55, 0.7), (0.0, 1.0), (0.58, 0.66))):
        shift_x = part["topOffset"][0] * max(ring_index - 1, 0)
        shift_z = part["topOffset"][1] * max(ring_index - 1, 0)
        for index in range(segments):
            angle = 2 * math.pi * index / segments
            radial = part["radialScales"][index]
            local_x, local_z = half.x * scale * radial * math.cos(angle), half.z * scale * radial * math.sin(angle)
            x = center.x + shift_x + cosine * local_x + sine * local_z
            z = center.z + shift_z - sine * local_x + cosine * local_z
            vertices.append((x, center.y + half.y * height, z))
    top_index = len(vertices)
    vertices.append((center.x + part["topOffset"][0], center.y + half.y, center.z + part["topOffset"][1]))
    faces, assignments = [], []
    for index in range(segments):
        nxt = (index + 1) % segments
        faces.append((0, 1 + nxt, 1 + index)); assignments.append(0)
    for ring_index in range(2):
        start, upper = 1 + ring_index * segments, 1 + (ring_index + 1) * segments
        for index in range(segments):
            nxt = (index + 1) % segments
            faces.append((start + index, start + nxt, upper + nxt, upper + index)); assignments.append(0 if ring_index == 0 else (1 if index % 3 else 0))
    top_start = 1 + 2 * segments
    for index in range(segments):
        nxt = (index + 1) % segments
        faces.append((top_start + index, top_start + nxt, top_index)); assignments.append(1)
    mesh = bpy.data.meshes.new(part["id"] + "/mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(part["id"], mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(materials["hearth-soot-char"])
    obj.data.materials.append(materials["hearth-embers"])
    for polygon, assignment in zip(obj.data.polygons, assignments):
        polygon.material_index = assignment
    obj["limina.coalProfileJson"] = json.dumps({"radialScales": part["radialScales"], "topOffset": part["topOffset"], "yawRadians": part["yawRadians"]}, sort_keys=True, separators=(",", ":"))
    stamp(obj, part, recipe_hash)
    return obj


recipe_path, out_path, blend_path = arg("--recipe"), arg("--out"), arg("--blend-out")
for output in (out_path, blend_path):
    if os.path.exists(output):
        raise RuntimeError(f"append-only hearth fuel output already exists: {output}")
with open(recipe_path, "rb") as handle:
    recipe_bytes = handle.read()
recipe = validate_recipe(json.loads(recipe_bytes))
recipe_hash = canonical_hash(recipe)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.scene.unit_settings.system = "METRIC"
bpy.context.scene.unit_settings.scale_length = 1.0
materials = {spec["role"]: material_from(spec) for spec in recipe["materials"]}
root = bpy.data.objects.new(recipe["export"]["rootSemanticId"], None)
bpy.context.collection.objects.link(root)
root["limina.id"] = recipe["export"]["rootSemanticId"]
root["limina.role"] = "hearth-fuel-root"
root["limina.schema"] = recipe["schema"]
root["limina.recipeHash"] = recipe_hash
root["limina.recipeRawSha256"] = sha_bytes(recipe_bytes)
root["limina.authorityJson"] = json.dumps(recipe["authority"], sort_keys=True, separators=(",", ":"))
root["limina.coordinateFrameJson"] = json.dumps(recipe["coordinateFrame"], sort_keys=True, separators=(",", ":"))
root["limina.aggregateBoundsJson"] = json.dumps(recipe["aggregateBounds"], sort_keys=True, separators=(",", ":"))
root["limina.runtimeOwnedJson"] = json.dumps(["flames", "light", "smoke", "soot-heat-treatment"], separators=(",", ":"))

objects = []
for part in recipe["parts"]:
    if part["kind"] == "ember-bed":
        obj = make_ember(part, materials, recipe_hash)
    elif part["kind"] == "log":
        obj = make_log(part, materials, recipe_hash)
    else:
        obj = make_coal(part, materials, recipe_hash)
    obj.parent = root
    objects.append(obj)

bpy.context.scene["limina.handoffSchema"] = "limina.blender-hearth-fuel-handoff/v1"
bpy.context.scene["limina.recipeHash"] = recipe_hash
bpy.context.scene["limina.recipeRawSha256"] = sha_bytes(recipe_bytes)
bpy.context.scene["limina.units"] = "meter"
bpy.context.view_layer.update()
aggregate_min, aggregate_max = Vector(recipe["aggregateBounds"]["min"]), Vector(recipe["aggregateBounds"]["max"])
for obj in objects:
    for corner in obj.bound_box:
        world = obj.matrix_world @ Vector(corner)
        if any(world[axis] < aggregate_min[axis] - 0.000001 or world[axis] > aggregate_max[axis] + 0.000001 for axis in range(3)):
            raise RuntimeError(f"authored fuel geometry escapes audited aggregate bounds: {obj.get('limina.id')}")
if any(obj.type in {"CAMERA", "LIGHT"} for obj in bpy.data.objects):
    raise RuntimeError("hearth fuel source must not contain cameras or lights")
os.makedirs(os.path.dirname(blend_path), exist_ok=True)
os.makedirs(os.path.dirname(out_path), exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=blend_path, check_existing=False)
bpy.ops.export_scene.gltf(filepath=out_path, export_format="GLB", export_extras=True, export_yup=True, export_apply=False, export_cameras=False, export_lights=False)

attestation = {
    "schema": "limina.blender-hearth-fuel-output/v1",
    "id": recipe["id"],
    "recipeHash": recipe_hash,
    "recipeRawSha256": sha_bytes(recipe_bytes),
    "parts": [part["id"] for part in recipe["parts"]],
    "materials": sorted(materials),
    "aggregateBounds": recipe["aggregateBounds"],
    "rendered": False,
    "gpuUsed": False,
    "blendOutput": blend_path,
    "output": out_path,
}
print("LIMINA_HEARTH_FUEL_OUTPUT=" + json.dumps(attestation, sort_keys=True, separators=(",", ":")))
