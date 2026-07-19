"""Compose an approved materialized shell and arbitrary approved furniture instances.

This adapter consumes ``limina.building-composition-manifest/v2``.  The exact M1
runtime GLB is imported as the shell beauty source; shell-r4's source .blend is
verified and retained as provenance but is never opened or exported in its
unmaterialized state.  Each catalog source is appended into a protected derived
.blend, namespaced under an instance root, and checked for source-local geometry,
material, hierarchy, and semantic-property preservation before export.
"""
import bpy
import atexit
import hashlib
import json
import math
import os
import re
import shutil
import struct
import sys
import tempfile
from mathutils import Matrix, Vector

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.dirname(__file__))
from m1_ktx2_import_bridge import derive_import_bridge
HASH_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
ID_RE = re.compile(r"^[a-z0-9][a-z0-9._/-]{0,159}$")
B = Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))
BI = B.inverted()


def raw_arg(flag):
    if flag not in ARGS or ARGS.index(flag) + 1 >= len(ARGS):
        raise RuntimeError(f"missing {flag}")
    return ARGS[ARGS.index(flag) + 1]


def output_path(flag):
    return os.path.abspath(raw_arg(flag))


def digest(path):
    with open(path, "rb") as handle:
        return "sha256:" + hashlib.sha256(handle.read()).hexdigest()


def canonical_hash(value):
    data = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf8")
    return "sha256:" + hashlib.sha256(data).hexdigest()


def require_object(value, label):
    if not isinstance(value, dict):
        raise RuntimeError(f"{label} must be an object")
    return value


def require_exact_keys(value, required, optional, label):
    missing = sorted(set(required) - set(value))
    unknown = sorted(set(value) - set(required) - set(optional))
    if missing:
        raise RuntimeError(f"{label} missing keys: {','.join(missing)}")
    if unknown:
        raise RuntimeError(f"{label} unsupported keys: {','.join(unknown)}")


def require_id(value, label):
    if not isinstance(value, str) or not ID_RE.fullmatch(value):
        raise RuntimeError(f"{label} must be a stable lowercase id")


def require_hash(value, label):
    if not isinstance(value, str) or not HASH_RE.fullmatch(value):
        raise RuntimeError(f"{label} must be lowercase sha256")


def resolve_portable(path, label):
    if not isinstance(path, str) or not path or os.path.isabs(path) or "\\" in path or ".." in path.split("/"):
        raise RuntimeError(f"{label} must be a repository-relative portable path")
    resolved = os.path.abspath(os.path.join(REPO, *path.split("/")))
    if os.path.commonpath((REPO, resolved)) != REPO or not os.path.isfile(resolved):
        raise RuntimeError(f"{label} does not resolve to a repository file")
    return resolved


def resource(value, label):
    value = require_object(value, label)
    require_exact_keys(value, {"path", "sha256"}, set(), label)
    require_hash(value["sha256"], label + ".sha256")
    path = resolve_portable(value["path"], label + ".path")
    if digest(path) != value["sha256"]:
        raise RuntimeError(f"{label} byte hash drifted")
    return path


def stage_ref(value, expected_kind, label):
    value = require_object(value, label)
    require_exact_keys(value, {"artifactPath", "artifactSha256", "artifactId", "kind", "status", "contractHash", "contentHash"}, set(), label)
    path = resolve_portable(value["artifactPath"], label + ".artifactPath")
    require_hash(value["artifactSha256"], label + ".artifactSha256")
    if digest(path) != value["artifactSha256"]:
        raise RuntimeError(f"{label} artifact byte hash drifted")
    require_id(value["artifactId"], label + ".artifactId")
    if value["kind"] != expected_kind or value["status"] != "approved":
        raise RuntimeError(f"{label} must be an approved {expected_kind}")
    with open(path, "r", encoding="utf8") as handle:
        artifact = json.load(handle)
    if artifact.get("schema") != "limina.building-stage-artifact/v1":
        raise RuntimeError(f"{label} has unsupported stage artifact schema")
    for key in ("artifactId", "kind", "status", "contractHash", "contentHash"):
        if artifact.get(key) != value[key]:
            raise RuntimeError(f"{label} disagrees with manifest field {key}")
    return artifact


def approval(value, artifact_ref, gate, label):
    path = resource(value, label)
    with open(path, "r", encoding="utf8") as handle:
        decision = json.load(handle)
    if decision.get("schema") != "limina.building-hitl-decision/v1" or decision.get("decision") != "approve" or decision.get("gate") != gate:
        raise RuntimeError(f"{label} must be an exact {gate} approval")
    if decision.get("blockingFindings") not in (None, []):
        raise RuntimeError(f"{label} approval contains blocking findings")
    for key in ("artifactId", "contractHash", "contentHash"):
        if decision.get(key) != artifact_ref[key]:
            raise RuntimeError(f"{label} disagrees with approved artifact field {key}")
    return path


def glb_document(path, label):
    raw = open(path, "rb").read()
    if len(raw) < 20:
        raise RuntimeError(f"{label} is not a GLB")
    magic, version, total = struct.unpack_from("<4sII", raw, 0)
    if magic != b"glTF" or version != 2 or total != len(raw):
        raise RuntimeError(f"{label} has an invalid GLB envelope")
    offset, document = 12, None
    while offset < total:
        length, kind = struct.unpack_from("<II", raw, offset)
        offset += 8
        data = raw[offset:offset + length]
        offset += length
        if kind == 0x4E4F534A:
            document = json.loads(data.decode("utf8").rstrip(" \0"))
    if not isinstance(document, dict):
        raise RuntimeError(f"{label} has no JSON document")
    return document


def material_runtime_closure(document):
    extras = document.get("asset", {}).get("extras", {})
    sources = extras.get("liminaMaterialSources")
    if not isinstance(sources, dict) or sources.get("schema") != "limina.material-sources/v1" or not sources.get("packs"):
        raise RuntimeError("approved M1 runtime GLB lacks material-source provenance")
    if "KHR_texture_basisu" not in document.get("extensionsUsed", []):
        raise RuntimeError("approved M1 runtime GLB lacks its KTX2 material closure")
    if not document.get("nodes") or not document.get("meshes") or not document.get("materials") or not document.get("textures") or not document.get("images"):
        raise RuntimeError("approved M1 runtime GLB is not a materialized shell")
    return {"packs": len(sources["packs"]), "materials": len(document["materials"]), "textures": len(document["textures"]), "images": len(document["images"]), "nodes": len(document["nodes"]), "meshes": len(document["meshes"])}


def source_node_table(document):
    nodes = document.get("nodes")
    if not isinstance(nodes, list) or not nodes:
        raise RuntimeError("approved M1 node table is absent")
    names = [node.get("name") for node in nodes]
    semantic_ids = [node.get("extras", {}).get("limina.id") for node in nodes if node.get("extras", {}).get("limina.id") is not None]
    if any(not isinstance(name, str) or not name for name in names) or len(set(names)) != len(names):
        raise RuntimeError("approved M1 node names are absent or duplicated")
    if any(not isinstance(value, str) or not value for value in semantic_ids) or len(set(semantic_ids)) != len(semantic_ids):
        raise RuntimeError("approved M1 node semantic ids are invalid or duplicated")
    parents = [None] * len(nodes)
    for parent_index, node in enumerate(nodes):
        children = node.get("children", [])
        if not isinstance(children, list) or any(not isinstance(child, int) or isinstance(child, bool) or child < 0 or child >= len(nodes) for child in children) or len(set(children)) != len(children):
            raise RuntimeError("approved M1 node children are invalid")
        for child in children:
            if parents[child] is not None:
                raise RuntimeError("approved M1 node has multiple parents")
            parents[child] = parent_index
    entries = [{"index": index, "name": node["name"], "semanticId": node.get("extras", {}).get("limina.id"), "semanticRole": node.get("extras", {}).get("limina.role"), "parentIndex": parents[index], "children": node.get("children", []), "nodeSha256": canonical_hash(node)} for index, node in enumerate(nodes)]
    return {"sha256": canonical_hash(entries), "entries": entries, "structural": [entry for entry in entries if entry["semanticId"] is None]}


def stamp_and_fingerprint_source_nodes(objects, table):
    bpy.context.view_layer.update()
    by_name = {obj.name: obj for obj in objects}
    if len(by_name) != len(objects) or set(by_name) != {entry["name"] for entry in table["entries"]}:
        raise RuntimeError("Blender M1 import does not map one-to-one to the exact source node table")
    index_by_object = {}
    for entry in table["entries"]:
        obj = by_name[entry["name"]]
        if obj.get("limina.id") != entry["semanticId"] or obj.get("limina.role") != entry["semanticRole"]:
            raise RuntimeError(f"Blender M1 import semantic extras drifted for source node {entry['index']}")
        obj["limina.sourceGlbNodeIndex"] = entry["index"]
        index_by_object[obj] = entry["index"]
    hasher = hashlib.sha256()
    for entry in table["entries"]:
        obj = by_name[entry["name"]]
        parent_index = index_by_object.get(obj.parent)
        child_indices = sorted(index_by_object[child] for child in obj.children if child in index_by_object)
        if parent_index != entry["parentIndex"] or child_indices != sorted(entry["children"]):
            raise RuntimeError(f"Blender M1 import hierarchy drifted for source node {entry['index']}")
        update_bytes(hasher, json.dumps({"index": entry["index"], "name": obj.name, "type": obj.type, "semanticId": obj.get("limina.id"), "semanticRole": obj.get("limina.role"), "parentIndex": parent_index, "children": child_indices}, sort_keys=True, separators=(",", ":")))
        for row in obj.matrix_local:
            for number in row:
                hasher.update(struct.pack("<d", float(number)))
    return "sha256:" + hasher.hexdigest()


def validate_manifest(value):
    value = require_object(value, "manifest")
    require_exact_keys(value, {"schema", "id", "revision", "buildingId", "coordinateSystem", "dependencies", "instances", "legacyExclusions"}, {"supersedes", "metadata"}, "manifest")
    if value["schema"] != "limina.building-composition-manifest/v2":
        raise RuntimeError("composition adapter requires manifest v2")
    require_id(value["id"], "manifest.id")
    require_id(value["buildingId"], "manifest.buildingId")
    if not isinstance(value["revision"], int) or isinstance(value["revision"], bool) or value["revision"] < 1:
        raise RuntimeError("manifest.revision must be positive")
    if value["coordinateSystem"] != {"units": "meter", "up": "Y", "front": "-Z"}:
        raise RuntimeError("composition coordinate system must be meter/Y-up/-Z-front")
    dependencies = require_object(value["dependencies"], "dependencies")
    require_exact_keys(dependencies, {"shell", "materialPalette", "interiorPlan", "catalog"}, set(), "dependencies")

    shell = require_object(dependencies["shell"], "dependencies.shell")
    require_exact_keys(shell, {"artifact", "approvalDecision", "sourceBlend", "runtimeGlb"}, set(), "dependencies.shell")
    shell_artifact = stage_ref(shell["artifact"], "shell", "dependencies.shell.artifact")
    shell_paths = {"approvalDecision": approval(shell["approvalDecision"], shell["artifact"], "A1-shell", "dependencies.shell.approvalDecision"), "sourceBlend": resource(shell["sourceBlend"], "dependencies.shell.sourceBlend"), "runtimeGlb": resource(shell["runtimeGlb"], "dependencies.shell.runtimeGlb")}
    if shell["runtimeGlb"]["sha256"] != shell["artifact"]["contentHash"]:
        raise RuntimeError("shell runtime GLB does not match approved A1")

    materials = require_object(dependencies["materialPalette"], "dependencies.materialPalette")
    require_exact_keys(materials, {"artifact", "approvalDecision", "materialsLock", "runtimeGlb"}, set(), "dependencies.materialPalette")
    material_artifact = stage_ref(materials["artifact"], "material-palette", "dependencies.materialPalette.artifact")
    material_paths = {"approvalDecision": approval(materials["approvalDecision"], materials["artifact"], "M1-materials", "dependencies.materialPalette.approvalDecision"), "materialsLock": resource(materials["materialsLock"], "dependencies.materialPalette.materialsLock"), "runtimeGlb": resource(materials["runtimeGlb"], "dependencies.materialPalette.runtimeGlb")}
    if materials["runtimeGlb"]["sha256"] != materials["artifact"]["contentHash"]:
        raise RuntimeError("material runtime GLB does not match approved M1")
    approved_shell = material_artifact.get("metadata", {}).get("approvedShell", {})
    if any(approved_shell.get(key) != shell["artifact"][key] for key in ("artifactId", "contractHash", "contentHash")):
        raise RuntimeError("approved M1 is not derived from the exact approved A1 shell")
    derived = material_artifact.get("metadata", {}).get("derivedRuntime", {})
    if derived.get("path") != materials["runtimeGlb"]["path"] or derived.get("sha256") != materials["runtimeGlb"]["sha256"]:
        raise RuntimeError("approved M1 derived runtime metadata drifted")
    lock = material_artifact.get("metadata", {}).get("materialsLock", {})
    if lock.get("path") != materials["materialsLock"]["path"] or lock.get("sha256") != materials["materialsLock"]["sha256"]:
        raise RuntimeError("approved M1 materials lock drifted")
    material_document = glb_document(material_paths["runtimeGlb"], "approved M1 runtime")
    material_inventory = material_runtime_closure(material_document)
    material_node_table = source_node_table(material_document)

    interior = require_object(dependencies["interiorPlan"], "dependencies.interiorPlan")
    require_exact_keys(interior, {"artifact", "approvalDecision", "plan"}, set(), "dependencies.interiorPlan")
    stage_ref(interior["artifact"], "interior-plan", "dependencies.interiorPlan.artifact")
    interior_paths = {"approvalDecision": approval(interior["approvalDecision"], interior["artifact"], "I1-layout", "dependencies.interiorPlan.approvalDecision"), "plan": resource(interior["plan"], "dependencies.interiorPlan.plan")}
    if interior["plan"]["sha256"] != interior["artifact"]["contentHash"]:
        raise RuntimeError("interior plan does not match approved I1")

    catalog = dependencies["catalog"]
    if not isinstance(catalog, list) or not catalog:
        raise RuntimeError("dependencies.catalog must be non-empty")
    catalog_by_id, catalog_paths = {}, {}
    for index, entry in enumerate(catalog):
        label = f"dependencies.catalog[{index}]"
        require_exact_keys(require_object(entry, label), {"role", "artifact", "approvalDecision", "designContract", "buildEvidence", "functionalEvidence", "sourceBlend", "runtimeGlb"}, set(), label)
        require_id(entry["role"], label + ".role")
        stage_ref(entry["artifact"], "furniture-pack", label + ".artifact")
        artifact_id = entry["artifact"]["artifactId"]
        if artifact_id in catalog_by_id:
            raise RuntimeError("duplicate catalog artifact id")
        paths = {key: resource(entry[key], label + "." + key) for key in ("approvalDecision", "designContract", "buildEvidence", "functionalEvidence", "sourceBlend", "runtimeGlb")}
        approval(entry["approvalDecision"], entry["artifact"], "F1-asset", label + ".approvalDecision")
        if entry["runtimeGlb"]["sha256"] != entry["artifact"]["contentHash"]:
            raise RuntimeError(f"{label} runtime GLB does not match approved F1")
        with open(paths["designContract"], "r", encoding="utf8") as handle:
            contract = json.load(handle)
        with open(paths["buildEvidence"], "r", encoding="utf8") as handle:
            build = json.load(handle)
        with open(paths["functionalEvidence"], "r", encoding="utf8") as handle:
            functional = json.load(handle)
        if contract.get("schema") != "limina.furniture-design-contract/v1" or contract.get("role") != entry["role"]:
            raise RuntimeError(f"{label} design contract role drifted")
        if build.get("schema") != "limina.furniture-contract-build-evidence/v1" or build.get("sourceBlend", {}).get("sha256") != entry["sourceBlend"]["sha256"] or build.get("asset", {}).get("sha256") != entry["runtimeGlb"]["sha256"]:
            raise RuntimeError(f"{label} build evidence drifted")
        checks = functional.get("checks", [])
        if functional.get("schema") != "limina.furniture-functional-evidence/v1" or functional.get("verdict") != "pass" or not checks or any(check.get("passed") is not True or check.get("findings") not in (None, []) for check in checks):
            raise RuntimeError(f"{label} lacks an all-checks-passed functional proof")
        catalog_by_id[artifact_id] = entry
        catalog_paths[artifact_id] = paths

    instances = value["instances"]
    if not isinstance(instances, list) or not instances:
        raise RuntimeError("composition requires instances")
    seen_instances = set()
    for index, instance in enumerate(instances):
        label = f"instances[{index}]"
        require_exact_keys(require_object(instance, label), {"id", "kind", "role", "catalogArtifactId", "placement", "replacesSemanticIds", "bindings", "constraints"}, set(), label)
        require_id(instance["id"], label + ".id")
        if instance["id"] in seen_instances:
            raise RuntimeError("composition instance ids must be unique")
        seen_instances.add(instance["id"])
        if instance["kind"] != "furniture" or instance["catalogArtifactId"] not in catalog_by_id or catalog_by_id[instance["catalogArtifactId"]]["role"] != instance["role"]:
            raise RuntimeError(f"{label} catalog role binding drifted")
        placement = require_object(instance["placement"], label + ".placement")
        require_exact_keys(placement, {"position", "yawRadians", "scale"}, set(), label + ".placement")
        for key in ("position", "scale"):
            if not isinstance(placement[key], list) or len(placement[key]) != 3 or any(isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(number) for number in placement[key]):
                raise RuntimeError(f"{label}.placement.{key} must be a finite vec3")
        if placement["scale"] != [1, 1, 1] or isinstance(placement["yawRadians"], bool) or not isinstance(placement["yawRadians"], (int, float)) or not math.isfinite(placement["yawRadians"]):
            raise RuntimeError(f"{label} placement must have finite yaw and unit scale")
        if not isinstance(instance["replacesSemanticIds"], list) or len(set(instance["replacesSemanticIds"])) != len(instance["replacesSemanticIds"]):
            raise RuntimeError(f"{label}.replacesSemanticIds must be a unique array")
        for semantic_id in instance["replacesSemanticIds"]:
            require_id(semantic_id, label + ".replacesSemanticIds")
        require_object(instance["bindings"], label + ".bindings")
        require_object(instance["constraints"], label + ".constraints")
    exclusions = value["legacyExclusions"]
    if not isinstance(exclusions, list) or not exclusions or len(set(exclusions)) != len(exclusions):
        raise RuntimeError("legacyExclusions must be a non-empty unique array")
    for semantic_id in exclusions:
        require_id(semantic_id, "legacyExclusions")
    return {"shellArtifact": shell_artifact, "shellPaths": shell_paths, "materialArtifact": material_artifact, "materialPaths": material_paths, "materialInventory": material_inventory, "materialNodeTable": material_node_table, "interiorPaths": interior_paths, "catalog": catalog_by_id, "catalogPaths": catalog_paths, "instances": instances}


def e2b(value):
    return Vector((value[0], -value[2], value[1]))


def expected_instance_matrix(placement):
    rotation = B @ Matrix.Rotation(float(placement["yawRadians"]), 3, "Y") @ BI
    return Matrix.Translation(e2b(placement["position"])) @ rotation.to_4x4()


def update_bytes(hasher, value):
    hasher.update(value if isinstance(value, bytes) else str(value).encode("utf8"))
    hasher.update(b"\0")


def jsonable(value):
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    try:
        return [jsonable(entry) for entry in value]
    except TypeError:
        return str(value)


def image_signature(image):
    if image is None:
        return None
    packed = image.packed_file
    if packed is not None:
        payload = bytes(packed.data)
        content = "sha256:" + hashlib.sha256(payload).hexdigest()
    else:
        path = bpy.path.abspath(image.filepath_raw or image.filepath)
        content = digest(path) if path and os.path.isfile(path) else None
    return {"size": list(image.size), "channels": image.channels, "colorspace": image.colorspace_settings.name, "alpha": image.alpha_mode, "content": content}


def material_signature(material):
    if material is None:
        return None
    result = {"useNodes": material.use_nodes, "diffuse": list(material.diffuse_color), "properties": {key: jsonable(material[key]) for key in sorted(material.keys())}}
    if not material.use_nodes or material.node_tree is None:
        return result
    nodes = list(material.node_tree.nodes)
    node_index = {node: index for index, node in enumerate(nodes)}
    result["nodes"] = [{"type": node.bl_idname, "label": node.label, "inputs": [(socket.identifier, jsonable(getattr(socket, "default_value", None))) for socket in node.inputs], "image": image_signature(getattr(node, "image", None))} for node in nodes]
    result["links"] = sorted((node_index[link.from_node], link.from_socket.identifier, node_index[link.to_node], link.to_socket.identifier) for link in material.node_tree.links)
    return result


def source_fingerprint(objects, source_property):
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    hasher = hashlib.sha256()
    object_set = set(objects)
    roots = [obj for obj in objects if obj.parent not in object_set]
    if len(roots) != 1:
        raise RuntimeError("source fingerprint requires one hierarchy root")
    root_inverse = roots[0].matrix_world.inverted()
    meshes = sorted((obj for obj in objects if obj.type == "MESH"), key=lambda obj: obj.get(source_property, ""))
    material_cache = {}
    for obj in meshes:
        update_bytes(hasher, obj.get(source_property))
        for row in root_inverse @ obj.matrix_world:
            for number in row:
                hasher.update(struct.pack("<d", float(number)))
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh(preserve_all_data_layers=True, depsgraph=depsgraph)
        try:
            hasher.update(struct.pack("<II", len(mesh.vertices), len(mesh.polygons)))
            for vertex in mesh.vertices:
                for number in vertex.co:
                    hasher.update(struct.pack("<d", float(number)))
            for polygon in mesh.polygons:
                hasher.update(struct.pack("<I", len(polygon.vertices)))
                for index in polygon.vertices:
                    hasher.update(struct.pack("<I", int(index)))
        finally:
            evaluated.to_mesh_clear()
        signatures = []
        for slot in obj.material_slots:
            key = slot.material.as_pointer() if slot.material else 0
            if key not in material_cache:
                material_cache[key] = material_signature(slot.material)
            signatures.append(material_cache[key])
        update_bytes(hasher, json.dumps(signatures, sort_keys=True, separators=(",", ":")))
    return "sha256:" + hasher.hexdigest()


def semantic_inventory(objects, source_property):
    ids = [obj.get(source_property) for obj in objects]
    if any(not isinstance(value, str) or not value for value in ids) or len(set(ids)) != len(ids):
        raise RuntimeError("source semantic inventory is absent or duplicated")
    payload = json.dumps(sorted(ids), separators=(",", ":")).encode("utf8")
    return {"ids": ids, "sha256": "sha256:" + hashlib.sha256(payload).hexdigest()}


def semantic_matches_exclusion(semantic_id, exclusion):
    return semantic_id == exclusion or semantic_id.startswith(exclusion + "/") or semantic_id == "furnishing/" + exclusion or semantic_id.startswith("furnishing/" + exclusion + "/")


def collection(name):
    existing = bpy.data.collections.get(name)
    if existing is not None:
        return existing
    result = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(result)
    return result


def link_only(obj, target):
    for owner in list(obj.users_collection):
        owner.objects.unlink(obj)
    target.objects.link(obj)


MANIFEST_PATH, OUT, BLEND_OUT = output_path("--manifest"), output_path("--out"), output_path("--blend-out")
if os.path.commonpath((REPO, MANIFEST_PATH)) != REPO:
    raise RuntimeError("manifest must be inside the repository")
with open(MANIFEST_PATH, "rb") as handle:
    manifest_bytes = handle.read()
manifest = json.loads(manifest_bytes.decode("utf8"))
resolved = validate_manifest(manifest)
manifest_raw_hash = "sha256:" + hashlib.sha256(manifest_bytes).hexdigest()
manifest_hash = canonical_hash(manifest)
material_runtime_path = resolved["materialPaths"]["runtimeGlb"]
all_input_paths = {
    MANIFEST_PATH,
    *resolved["shellPaths"].values(), *resolved["materialPaths"].values(), *resolved["interiorPaths"].values(),
    *[path for paths in resolved["catalogPaths"].values() for path in paths.values()],
    *[resolve_portable(reference["artifactPath"], "approved artifact") for reference in [manifest["dependencies"]["shell"]["artifact"], manifest["dependencies"]["materialPalette"]["artifact"], manifest["dependencies"]["interiorPlan"]["artifact"], *[entry["artifact"] for entry in manifest["dependencies"]["catalog"]]]],
}
if OUT in all_input_paths or BLEND_OUT in all_input_paths:
    raise RuntimeError("composition outputs may not replace approved inputs")
source_hashes_before = {path: digest(path) for path in all_input_paths}

# M1 raw bytes remain the authority. Blender 4.0 cannot import its required
# KHR_texture_basisu payload, so derive a temporary PNG-backed GLB using only the
# package-local hash-pinned KTX 4.4.2 binary. Never open the unmaterialized A1
# .blend and never fall back if this exact derivation fails.
material_bridge_dir = tempfile.mkdtemp(prefix="limina-m1-import-bridge-")
atexit.register(shutil.rmtree, material_bridge_dir, ignore_errors=True)
material_import_path, material_bridge_identity = derive_import_bridge(
    material_runtime_path,
    manifest["dependencies"]["materialPalette"]["runtimeGlb"]["sha256"],
    material_bridge_dir,
    REPO,
)
bpy.ops.wm.read_factory_settings(use_empty=True)
before_shell = set(bpy.data.objects)
try:
    bpy.ops.import_scene.gltf(filepath=material_import_path)
except Exception as error:
    raise RuntimeError(f"approved M1 deterministic import bridge failed; refusing unmaterialized fallback: {error}") from error
shell_objects = [obj for obj in bpy.context.scene.objects if obj not in before_shell]
if not shell_objects or any(obj.type in {"CAMERA", "LIGHT"} for obj in shell_objects):
    raise RuntimeError("approved M1 runtime did not produce a camera/light-free materialized shell")
shell_node_fingerprint = stamp_and_fingerprint_source_nodes(shell_objects, resolved["materialNodeTable"])
shell_inventory = semantic_inventory([obj for obj in shell_objects if obj.get("limina.id") is not None], "limina.id")
shell_roots = [obj for obj in shell_objects if obj.parent is None]
if len(shell_roots) != 1 or shell_roots[0].get("limina.id") != "building/root":
    raise RuntimeError("approved M1 runtime shell root drifted")
if not bpy.data.materials or not bpy.data.images:
    raise RuntimeError("approved M1 runtime import did not establish material/image datablocks")
materialized_images = {getattr(node, "image", None) for obj in shell_objects if obj.type == "MESH" for slot in obj.material_slots if slot.material and slot.material.use_nodes and slot.material.node_tree for node in slot.material.node_tree.nodes if getattr(node, "image", None) is not None}
image_proofs = [image_signature(image) for image in materialized_images]
if len(materialized_images) != material_bridge_identity["imagesCount"] or material_bridge_identity["imagesCount"] != resolved["materialInventory"]["images"] or any(proof["content"] is None or min(proof["size"]) < 2 for proof in image_proofs):
    raise RuntimeError("approved M1 runtime import did not establish every exact material image")

shell_collection = collection("10_MATERIALIZED_SHELL")
dressing_collection = collection("30_INTERIOR_DRESSING")
socket_collection = collection("SOCKETS")
collision_collection = collection("COLLISION")
export_collection = collection("90_EXPORT")
for obj in shell_objects:
    link_only(obj, shell_collection)
replacements = list(dict.fromkeys(manifest["legacyExclusions"] + [semantic_id for instance in resolved["instances"] for semantic_id in instance["replacesSemanticIds"]]))
removed_semantics = []
for obj in list(shell_objects):
    semantic_id = str(obj.get("limina.id", ""))
    if semantic_id and any(semantic_matches_exclusion(semantic_id, value) for value in replacements):
        removed_semantics.append(semantic_id)
        shell_objects.remove(obj)
        bpy.data.objects.remove(obj, do_unlink=True)
shell_inventory = semantic_inventory([obj for obj in shell_objects if obj.get("limina.id") is not None], "limina.id")
shell_fingerprint = source_fingerprint(shell_objects, "limina.id")

composition_id = manifest["id"]
composition_root = bpy.data.objects.new(composition_id, None)
export_collection.objects.link(composition_root)
composition_root["limina.id"] = composition_id
composition_root["limina.role"] = "building-composition"
composition_root["limina.manifestHash"] = manifest_hash
composition_root["limina.buildingId"] = manifest["buildingId"]
composition_root["limina.editPolicy"] = "protected-generated"

instance_records = []
catalog_fingerprints = {}
for instance in resolved["instances"]:
    catalog = resolved["catalog"][instance["catalogArtifactId"]]
    source_path = resolved["catalogPaths"][instance["catalogArtifactId"]]["sourceBlend"]
    before = set(bpy.data.objects)
    with bpy.data.libraries.load(source_path, link=False) as (source, target):
        target.objects = list(source.objects)
    appended = [obj for obj in target.objects if obj is not None and obj not in before]
    if not appended or any(obj.type in {"CAMERA", "LIGHT"} for obj in appended):
        raise RuntimeError(f"{instance['id']} approved source inventory is empty or contains a camera/light")
    inventory = semantic_inventory(appended, "limina.id")
    roots = [obj for obj in appended if obj.parent is None]
    if len(roots) != 1 or roots[0].get("limina.role") != catalog["role"]:
        raise RuntimeError(f"{instance['id']} must have exactly one unparented {catalog['role']} root")
    source_root = roots[0]
    appended_set = set(appended)
    for obj in appended:
        cursor = obj
        seen = set()
        while cursor.parent is not None and cursor.parent in appended_set and cursor not in seen:
            seen.add(cursor)
            cursor = cursor.parent
        if cursor is not source_root:
            raise RuntimeError(f"{instance['id']} source contains a hierarchy island")
        role = obj.get("limina.role")
        target_collection = export_collection if obj is source_root else socket_collection if role == "socket" else collision_collection if role == "collider" else dressing_collection if obj.type == "MESH" else None
        if target_collection is None:
            raise RuntimeError(f"{instance['id']} has unsupported non-mesh semantic role {role}")
        link_only(obj, target_collection)
    fingerprint = source_fingerprint(appended, "limina.id")
    catalog_fingerprints.setdefault(instance["catalogArtifactId"], fingerprint)
    if catalog_fingerprints[instance["catalogArtifactId"]] != fingerprint:
        raise RuntimeError(f"{instance['id']} repeated catalog import drifted")

    instance_root_id = f"{composition_id}/{instance['id']}"
    instance_root = bpy.data.objects.new(instance_root_id, None)
    export_collection.objects.link(instance_root)
    instance_root.parent = composition_root
    instance_root.matrix_basis = expected_instance_matrix(instance["placement"])
    instance_root["limina.id"] = instance_root_id
    instance_root["limina.role"] = "composition-instance"
    instance_root["limina.instanceId"] = instance["id"]
    instance_root["limina.catalogRole"] = catalog["role"]
    instance_root["limina.artifactId"] = instance["catalogArtifactId"]
    instance_root["limina.artifactContentHash"] = catalog["artifact"]["contentHash"]
    instance_root["limina.placementJson"] = json.dumps(instance["placement"], sort_keys=True, separators=(",", ":"))
    instance_root["limina.bindingsJson"] = json.dumps(instance["bindings"], sort_keys=True, separators=(",", ":"))
    instance_root["limina.constraintsJson"] = json.dumps(instance["constraints"], sort_keys=True, separators=(",", ":"))
    instance_root["limina.editPolicy"] = "bounded-validate"
    for obj in appended:
        source_id = obj.get("limina.id")
        composed_id = f"{instance_root_id}/{source_id}"
        obj["limina.sourceId"] = source_id
        obj["limina.id"] = composed_id
        obj["limina.compositionInstanceId"] = instance["id"]
        obj.name = composed_id
    bpy.context.view_layer.update()
    namespaced_fingerprint = source_fingerprint(appended, "limina.sourceId")
    if namespaced_fingerprint != fingerprint:
        raise RuntimeError(f"{instance['id']} namespacing changed approved source-local content: {fingerprint} -> {namespaced_fingerprint}")
    source_root_local = source_root.matrix_local.copy()
    source_root.parent = instance_root
    source_root.matrix_parent_inverse = Matrix.Identity(4)
    source_root.matrix_local = source_root_local
    composed_fingerprint = source_fingerprint(appended, "limina.sourceId")
    instance_records.append({
        "id": instance["id"],
        "rootId": instance_root_id,
        "artifactId": instance["catalogArtifactId"],
        "role": catalog["role"],
        "sourceBlendHash": catalog["sourceBlend"]["sha256"],
        "sourceRootId": source_root.get("limina.sourceId"),
        "sourceFingerprint": fingerprint,
        "composedFingerprint": composed_fingerprint,
        "sourceInventorySha256": inventory["sha256"],
        "objects": len(appended),
        "meshes": len([obj for obj in appended if obj.type == "MESH"]),
        "sockets": len([obj for obj in appended if obj.get("limina.role") == "socket"]),
        "colliders": len([obj for obj in appended if obj.get("limina.role") == "collider"]),
    })

for exclusion in manifest["legacyExclusions"]:
    if any(semantic_matches_exclusion(str(obj.get("limina.id", "")), exclusion) or semantic_matches_exclusion(str(obj.get("limina.sourceId", "")), exclusion) for obj in bpy.context.scene.objects):
        raise RuntimeError(f"legacy semantic survived composition: {exclusion}")

scene = bpy.context.scene
scene["limina.handoffSchema"] = "limina.blender-building-composition-handoff/v2"
scene["limina.compositionManifestHash"] = manifest_hash
scene["limina.compositionManifestRawSha256"] = manifest_raw_hash
scene["limina.compositionManifestJson"] = json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
scene["limina.compositionInstancesJson"] = json.dumps(instance_records, sort_keys=True, separators=(",", ":"))
scene["limina.materializedShellRuntimeGlbHash"] = manifest["dependencies"]["materialPalette"]["runtimeGlb"]["sha256"]
scene["limina.materializedShellImportBridgeJson"] = json.dumps(material_bridge_identity, sort_keys=True, separators=(",", ":"))
scene["limina.materializedShellFingerprint"] = shell_fingerprint
scene["limina.materializedShellNodeTableHash"] = resolved["materialNodeTable"]["sha256"]
scene["limina.materializedShellNodeFingerprint"] = shell_node_fingerprint
scene["limina.materializedShellStructuralNodesJson"] = json.dumps(resolved["materialNodeTable"]["structural"], sort_keys=True, separators=(",", ":"))
scene["limina.materializedShellInventoryJson"] = json.dumps({"ids": sorted(shell_inventory["ids"]), "sha256": shell_inventory["sha256"]}, separators=(",", ":"))
scene["limina.materialRuntimeInventoryJson"] = json.dumps(resolved["materialInventory"], sort_keys=True, separators=(",", ":"))
scene["limina.sourceShellBlendHash"] = manifest["dependencies"]["shell"]["sourceBlend"]["sha256"]
scene["limina.sourceCatalogBlendHashesJson"] = json.dumps({artifact_id: entry["sourceBlend"]["sha256"] for artifact_id, entry in resolved["catalog"].items()}, sort_keys=True, separators=(",", ":"))
scene["limina.coordinateContract"] = "engine[x,y-up,z,front=-z]=>blender[x,-z,y]"
scene["limina.genericGltfExportAllowed"] = False

if {path: digest(path) for path in all_input_paths} != source_hashes_before:
    raise RuntimeError("composition mutated an approved source")
if any(obj.type in {"CAMERA", "LIGHT"} for obj in scene.objects):
    raise RuntimeError("composition contains a camera or light")
os.makedirs(os.path.dirname(BLEND_OUT), exist_ok=True)
os.makedirs(os.path.dirname(OUT), exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=BLEND_OUT, compress=True)
if {path: digest(path) for path in all_input_paths} != source_hashes_before:
    raise RuntimeError("saving derived source changed an approved input")
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_yup=True, export_extras=True, export_apply=False, export_animations=True, export_lights=False, export_cameras=False)


def patch_glb(path):
    raw = open(path, "rb").read()
    magic, version, total = struct.unpack_from("<4sII", raw, 0)
    if magic != b"glTF" or version != 2 or total != len(raw):
        raise RuntimeError("invalid exported GLB")
    offset, chunks = 12, []
    while offset < total:
        length, kind = struct.unpack_from("<II", raw, offset)
        offset += 8
        chunks.append((kind, raw[offset:offset + length]))
        offset += length
    document = json.loads(next(data for kind, data in chunks if kind == 0x4E4F534A).decode().rstrip(" \0"))
    extras = document["asset"].setdefault("extras", {})
    extras["liminaBuildingComposition"] = manifest
    extras["liminaBuildingCompositionProvenance"] = {
        "schema": "limina.building-composition-provenance/v2",
        "manifestHash": manifest_hash,
        "manifestRawSha256": manifest_raw_hash,
        "materializedShellRuntimeGlb": manifest["dependencies"]["materialPalette"]["runtimeGlb"],
        "materializedShellImportBridge": material_bridge_identity,
        "shellSourceBlend": manifest["dependencies"]["shell"]["sourceBlend"],
        "materializedShellFingerprint": shell_fingerprint,
        "materializedShellNodeTableHash": resolved["materialNodeTable"]["sha256"],
        "materializedShellNodeFingerprint": shell_node_fingerprint,
        "materializedShellStructuralNodes": resolved["materialNodeTable"]["structural"],
        "materialRuntimeInventory": resolved["materialInventory"],
        "instances": instance_records,
        "adapterSha256": digest(os.path.abspath(__file__)),
        "removedSemanticIds": sorted(removed_semantics),
    }
    encoded = json.dumps(document, separators=(",", ":"), ensure_ascii=False).encode("utf8")
    encoded += b" " * ((4 - len(encoded) % 4) % 4)
    rebuilt = [(0x4E4F534A, encoded)] + [(kind, data) for kind, data in chunks if kind != 0x4E4F534A]
    body = b"".join(struct.pack("<II", len(data), kind) + data for kind, data in rebuilt)
    with open(path, "wb") as handle:
        handle.write(struct.pack("<4sII", b"glTF", 2, 12 + len(body)) + body)


patch_glb(OUT)
if {path: digest(path) for path in all_input_paths} != source_hashes_before:
    raise RuntimeError("export changed an approved input")
print("LIMINA_BUILDING_COMPOSITION_OUTPUT=" + json.dumps({
    "schema": "limina.blender-building-composition-output/v2",
    "manifestHash": manifest_hash,
    "manifestRawSha256": manifest_raw_hash,
    "materializedShellRuntimeGlbHash": manifest["dependencies"]["materialPalette"]["runtimeGlb"]["sha256"],
    "materializedShellImportBridge": material_bridge_identity,
    "materializedShellFingerprint": shell_fingerprint,
    "materializedShellNodeTableHash": resolved["materialNodeTable"]["sha256"],
    "materializedShellNodeFingerprint": shell_node_fingerprint,
    "materializedShellStructuralNodes": resolved["materialNodeTable"]["structural"],
    "instances": instance_records,
    "removedSemanticIds": sorted(removed_semantics),
    "blendOutput": BLEND_OUT,
    "output": OUT,
}, separators=(",", ":")))
