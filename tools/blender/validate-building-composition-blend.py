"""Fresh-process validation for a materialized, dynamic C1 composition .blend."""
import bpy
import atexit
import hashlib
import json
import math
import os
import shutil
import struct
import sys
import tempfile
from mathutils import Matrix, Vector

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.dirname(__file__))
from m1_ktx2_import_bridge import derive_import_bridge
B = Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))
BI = B.inverted()


def arg(flag):
    if flag not in ARGS or ARGS.index(flag) + 1 >= len(ARGS):
        raise RuntimeError(f"missing {flag}")
    return ARGS[ARGS.index(flag) + 1]


def digest(path):
    with open(path, "rb") as handle:
        return "sha256:" + hashlib.sha256(handle.read()).hexdigest()


def canonical_hash(value):
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def resolve(path):
    if not isinstance(path, str) or os.path.isabs(path) or "\\" in path or ".." in path.split("/"):
        raise RuntimeError("manifest contains a non-portable source path")
    result = os.path.abspath(os.path.join(REPO, *path.split("/")))
    if os.path.commonpath((REPO, result)) != REPO or not os.path.isfile(result):
        raise RuntimeError("manifest resource does not resolve inside repository")
    return result


def verify_resource(value, label):
    path = resolve(value["path"])
    if digest(path) != value["sha256"]:
        raise RuntimeError(f"{label} exact resource hash failed")
    return path


def verify_stage_ref(value, expected_kind, label):
    path = resolve(value["artifactPath"])
    if digest(path) != value["artifactSha256"]:
        raise RuntimeError(f"{label} artifact byte hash failed")
    with open(path, "r", encoding="utf8") as handle:
        artifact = json.load(handle)
    if artifact.get("schema") != "limina.building-stage-artifact/v1" or value.get("kind") != expected_kind or value.get("status") != "approved":
        raise RuntimeError(f"{label} is not an approved {expected_kind}")
    for key in ("artifactId", "kind", "status", "contractHash", "contentHash"):
        if artifact.get(key) != value.get(key):
            raise RuntimeError(f"{label} disagrees with manifest field {key}")
    return artifact


def verify_approval(value, artifact_ref, gate, label):
    path = verify_resource(value, label)
    with open(path, "r", encoding="utf8") as handle:
        decision = json.load(handle)
    if decision.get("schema") != "limina.building-hitl-decision/v1" or decision.get("decision") != "approve" or decision.get("gate") != gate or decision.get("blockingFindings") not in (None, []):
        raise RuntimeError(f"{label} is not an exact {gate} approval")
    for key in ("artifactId", "contractHash", "contentHash"):
        if decision.get(key) != artifact_ref.get(key):
            raise RuntimeError(f"{label} disagrees with approved artifact field {key}")
    return path


def glb_document(path):
    raw = open(path, "rb").read()
    magic, version, total = struct.unpack_from("<4sII", raw, 0)
    if magic != b"glTF" or version != 2 or total != len(raw):
        raise RuntimeError("approved M1 runtime has an invalid GLB envelope")
    offset, document = 12, None
    while offset < total:
        length, kind = struct.unpack_from("<II", raw, offset)
        offset += 8
        data = raw[offset:offset + length]
        offset += length
        if kind == 0x4E4F534A:
            document = json.loads(data.decode("utf8").rstrip(" \0"))
    if not isinstance(document, dict):
        raise RuntimeError("approved M1 runtime has no GLB JSON")
    return document


def material_runtime_inventory(document):
    sources = document.get("asset", {}).get("extras", {}).get("liminaMaterialSources")
    if not isinstance(sources, dict) or sources.get("schema") != "limina.material-sources/v1" or not sources.get("packs") or "KHR_texture_basisu" not in document.get("extensionsUsed", []):
        raise RuntimeError("approved M1 runtime lacks KTX2/material provenance")
    for key in ("nodes", "meshes", "materials", "textures", "images"):
        if not document.get(key):
            raise RuntimeError("approved M1 runtime is not a materialized shell")
    return {"packs": len(sources["packs"]), "materials": len(document["materials"]), "textures": len(document["textures"]), "images": len(document["images"]), "nodes": len(document["nodes"]), "meshes": len(document["meshes"])}


def source_node_table(document):
    nodes = document.get("nodes")
    if not isinstance(nodes, list) or not nodes:
        raise RuntimeError("approved M1 node table is absent")
    names = [node.get("name") for node in nodes]
    semantic_ids = [node.get("extras", {}).get("limina.id") for node in nodes if node.get("extras", {}).get("limina.id") is not None]
    if any(not isinstance(name, str) or not name for name in names) or len(set(names)) != len(names) or any(not isinstance(value, str) or not value for value in semantic_ids) or len(set(semantic_ids)) != len(semantic_ids):
        raise RuntimeError("approved M1 node names or semantic ids are invalid or duplicated")
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


def fingerprint_source_nodes(objects, table, stamp=False):
    bpy.context.view_layer.update()
    by_name = {obj.name: obj for obj in objects}
    if len(by_name) != len(objects) or set(by_name) != {entry["name"] for entry in table["entries"]}:
        raise RuntimeError("Blender M1 shell does not map one-to-one to the exact source node table")
    index_by_object = {}
    for entry in table["entries"]:
        obj = by_name[entry["name"]]
        if obj.get("limina.id") != entry["semanticId"] or obj.get("limina.role") != entry["semanticRole"]:
            raise RuntimeError(f"Blender M1 semantic extras drifted for source node {entry['index']}")
        if stamp:
            obj["limina.sourceGlbNodeIndex"] = entry["index"]
        if obj.get("limina.sourceGlbNodeIndex") != entry["index"]:
            raise RuntimeError(f"Blender M1 source-node index drifted for node {entry['index']}")
        index_by_object[obj] = entry["index"]
    hasher = hashlib.sha256()
    for entry in table["entries"]:
        obj = by_name[entry["name"]]
        parent_index = index_by_object.get(obj.parent)
        child_indices = sorted(index_by_object[child] for child in obj.children if child in index_by_object)
        if parent_index != entry["parentIndex"] or child_indices != sorted(entry["children"]):
            raise RuntimeError(f"Blender M1 hierarchy drifted for source node {entry['index']}")
        update_bytes(hasher, json.dumps({"index": entry["index"], "name": obj.name, "type": obj.type, "semanticId": obj.get("limina.id"), "semanticRole": obj.get("limina.role"), "parentIndex": parent_index, "children": child_indices}, sort_keys=True, separators=(",", ":")))
        for row in obj.matrix_local:
            for number in row:
                hasher.update(struct.pack("<d", float(number)))
    return "sha256:" + hasher.hexdigest()


def e2b(value):
    return Vector((value[0], -value[2], value[1]))


def expected_instance_matrix(placement):
    rotation = B @ Matrix.Rotation(float(placement["yawRadians"]), 3, "Y") @ BI
    return Matrix.Translation(e2b(placement["position"])) @ rotation.to_4x4()


def close_matrix(left, right, epsilon=1e-6):
    return all(abs(float(left[row][column]) - float(right[row][column])) <= epsilon for row in range(4) for column in range(4))


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
    if image.packed_file is not None:
        content = "sha256:" + hashlib.sha256(bytes(image.packed_file.data)).hexdigest()
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
    material_cache = {}
    object_set = set(objects)
    roots = [obj for obj in objects if obj.parent not in object_set]
    if len(roots) != 1:
        raise RuntimeError("source fingerprint requires one hierarchy root")
    root_inverse = roots[0].matrix_world.inverted()
    for obj in sorted((obj for obj in objects if obj.type == "MESH"), key=lambda obj: obj.get(source_property, "")):
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


def semantic_matches_exclusion(semantic_id, exclusion):
    return semantic_id == exclusion or semantic_id.startswith(exclusion + "/") or semantic_id == "furnishing/" + exclusion or semantic_id.startswith("furnishing/" + exclusion + "/")


def inventory_hash(ids):
    if any(not isinstance(value, str) or not value for value in ids) or len(set(ids)) != len(ids):
        raise RuntimeError("semantic inventory is absent or duplicated")
    payload = json.dumps(sorted(ids), separators=(",", ":")).encode("utf8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


manifest_path = os.path.abspath(arg("--manifest"))
if os.path.commonpath((REPO, manifest_path)) != REPO:
    raise RuntimeError("manifest must be inside the repository")
with open(manifest_path, "rb") as handle:
    manifest_bytes = handle.read()
manifest = json.loads(manifest_bytes.decode("utf8"))
if manifest.get("schema") != "limina.building-composition-manifest/v2" or not manifest.get("instances"):
    raise RuntimeError("validator requires a non-empty composition manifest v2")
manifest_hash = canonical_hash(manifest)
manifest_raw_hash = "sha256:" + hashlib.sha256(manifest_bytes).hexdigest()

shell = manifest["dependencies"]["shell"]
materials = manifest["dependencies"]["materialPalette"]
interior = manifest["dependencies"]["interiorPlan"]
shell_artifact = verify_stage_ref(shell["artifact"], "shell", "dependencies.shell.artifact")
verify_approval(shell["approvalDecision"], shell["artifact"], "A1-shell", "dependencies.shell.approvalDecision")
shell_source_path = verify_resource(shell["sourceBlend"], "dependencies.shell.sourceBlend")
verify_resource(shell["runtimeGlb"], "dependencies.shell.runtimeGlb")
if shell["runtimeGlb"]["sha256"] != shell["artifact"]["contentHash"]:
    raise RuntimeError("A1 runtime does not match its approved artifact")
material_artifact = verify_stage_ref(materials["artifact"], "material-palette", "dependencies.materialPalette.artifact")
verify_approval(materials["approvalDecision"], materials["artifact"], "M1-materials", "dependencies.materialPalette.approvalDecision")
verify_resource(materials["materialsLock"], "dependencies.materialPalette.materialsLock")
material_runtime_path = verify_resource(materials["runtimeGlb"], "dependencies.materialPalette.runtimeGlb")
if materials["runtimeGlb"]["sha256"] != materials["artifact"]["contentHash"] or any(material_artifact.get("metadata", {}).get("approvedShell", {}).get(key) != shell["artifact"][key] for key in ("artifactId", "contractHash", "contentHash")):
    raise RuntimeError("M1 runtime is not the exact approved material derivation of A1")
derived = material_artifact.get("metadata", {}).get("derivedRuntime", {})
lock = material_artifact.get("metadata", {}).get("materialsLock", {})
if derived.get("path") != materials["runtimeGlb"]["path"] or derived.get("sha256") != materials["runtimeGlb"]["sha256"] or lock.get("path") != materials["materialsLock"]["path"] or lock.get("sha256") != materials["materialsLock"]["sha256"]:
    raise RuntimeError("M1 derived runtime or materials-lock metadata drifted")
material_document = glb_document(material_runtime_path)
expected_material_inventory = material_runtime_inventory(material_document)
expected_material_node_table = source_node_table(material_document)
material_bridge_dir = tempfile.mkdtemp(prefix="limina-m1-validation-bridge-")
atexit.register(shutil.rmtree, material_bridge_dir, ignore_errors=True)
material_import_path, expected_material_bridge_identity = derive_import_bridge(
    material_runtime_path,
    materials["runtimeGlb"]["sha256"],
    material_bridge_dir,
    REPO,
)
verify_stage_ref(interior["artifact"], "interior-plan", "dependencies.interiorPlan.artifact")
verify_approval(interior["approvalDecision"], interior["artifact"], "I1-layout", "dependencies.interiorPlan.approvalDecision")
verify_resource(interior["plan"], "dependencies.interiorPlan.plan")
if interior["plan"]["sha256"] != interior["artifact"]["contentHash"]:
    raise RuntimeError("I1 plan does not match its approved artifact")

catalog_by_id, catalog_paths = {}, {}
for index, entry in enumerate(manifest["dependencies"]["catalog"]):
    label = f"dependencies.catalog[{index}]"
    verify_stage_ref(entry["artifact"], "furniture-pack", label + ".artifact")
    verify_approval(entry["approvalDecision"], entry["artifact"], "F1-asset", label + ".approvalDecision")
    paths = {key: verify_resource(entry[key], label + "." + key) for key in ("designContract", "buildEvidence", "functionalEvidence", "sourceBlend", "runtimeGlb")}
    if entry["runtimeGlb"]["sha256"] != entry["artifact"]["contentHash"]:
        raise RuntimeError(f"{label} runtime does not match approved artifact")
    with open(paths["designContract"], "r", encoding="utf8") as handle:
        contract = json.load(handle)
    with open(paths["buildEvidence"], "r", encoding="utf8") as handle:
        build = json.load(handle)
    with open(paths["functionalEvidence"], "r", encoding="utf8") as handle:
        functional = json.load(handle)
    checks = functional.get("checks", [])
    if contract.get("schema") != "limina.furniture-design-contract/v1" or contract.get("role") != entry["role"] or build.get("schema") != "limina.furniture-contract-build-evidence/v1" or build.get("sourceBlend", {}).get("sha256") != entry["sourceBlend"]["sha256"] or build.get("asset", {}).get("sha256") != entry["runtimeGlb"]["sha256"] or functional.get("schema") != "limina.furniture-functional-evidence/v1" or functional.get("verdict") != "pass" or not checks or any(check.get("passed") is not True or check.get("findings") not in (None, []) for check in checks):
        raise RuntimeError(f"{label} design/build/functional provenance drifted")
    catalog_by_id[entry["artifact"]["artifactId"]] = entry
    catalog_paths[entry["artifact"]["artifactId"]] = paths

scene = bpy.context.scene
if scene.get("limina.handoffSchema") != "limina.blender-building-composition-handoff/v2":
    raise RuntimeError("wrong composition handoff schema")
if scene.get("limina.compositionManifestHash") != manifest_hash or scene.get("limina.compositionManifestRawSha256") != manifest_raw_hash or json.loads(scene.get("limina.compositionManifestJson", "null")) != manifest:
    raise RuntimeError("composition manifest identity drifted")
if scene.get("limina.materializedShellRuntimeGlbHash") != materials["runtimeGlb"]["sha256"] or scene.get("limina.sourceShellBlendHash") != shell["sourceBlend"]["sha256"]:
    raise RuntimeError("materialized shell provenance drifted")
if json.loads(scene.get("limina.materializedShellImportBridgeJson", "null")) != expected_material_bridge_identity:
    raise RuntimeError("materialized shell deterministic import bridge identity drifted")
if json.loads(scene.get("limina.materialRuntimeInventoryJson", "null")) != expected_material_inventory:
    raise RuntimeError("materialized M1 inventory drifted")
if scene.get("limina.materializedShellNodeTableHash") != expected_material_node_table["sha256"] or json.loads(scene.get("limina.materializedShellStructuralNodesJson", "null")) != expected_material_node_table["structural"]:
    raise RuntimeError("materialized M1 source node-table or structural-node authority drifted")
if any(obj.type in {"CAMERA", "LIGHT"} for obj in scene.objects):
    raise RuntimeError("composition source contains a camera or light")
required_collections = {"10_MATERIALIZED_SHELL", "30_INTERIOR_DRESSING", "SOCKETS", "COLLISION", "90_EXPORT"}
if missing := sorted(required_collections - set(bpy.data.collections.keys())):
    raise RuntimeError("composition collections are missing: " + ",".join(missing))
current_shell_all = list(bpy.data.collections["10_MATERIALIZED_SHELL"].objects)
if fingerprint_source_nodes(current_shell_all, expected_material_node_table) != scene.get("limina.materializedShellNodeFingerprint"):
    raise RuntimeError("materialized M1 structural transform/hierarchy fingerprint drifted")

by_id = {}
for obj in scene.objects:
    semantic_id = obj.get("limina.id")
    if semantic_id:
        if semantic_id in by_id:
            raise RuntimeError(f"duplicate composed semantic id: {semantic_id}")
        by_id[semantic_id] = obj
composition_id = manifest["id"]
composition_root = by_id.get(composition_id)
if composition_root is None or composition_root.get("limina.role") != "building-composition":
    raise RuntimeError("composition root is absent")

for exclusion in manifest["legacyExclusions"]:
    if any(semantic_matches_exclusion(str(obj.get("limina.id", "")), exclusion) or semantic_matches_exclusion(str(obj.get("limina.sourceId", "")), exclusion) for obj in scene.objects):
        raise RuntimeError(f"legacy semantic survived: {exclusion}")

shell_record = json.loads(scene.get("limina.materializedShellInventoryJson", "null"))
shell_ids = shell_record.get("ids") if isinstance(shell_record, dict) else None
if not isinstance(shell_ids, list) or inventory_hash(shell_ids) != shell_record.get("sha256"):
    raise RuntimeError("recorded materialized shell inventory is invalid")
current_shell = [by_id.get(source_id) for source_id in shell_ids]
if any(obj is None for obj in current_shell) or any(obj.name not in bpy.data.collections["10_MATERIALIZED_SHELL"].objects for obj in current_shell):
    raise RuntimeError("materialized shell semantic inventory is incomplete or misplaced")
if source_fingerprint(current_shell_all, "limina.id") != scene.get("limina.materializedShellFingerprint"):
    raise RuntimeError("materialized shell geometry/material fingerprint drifted")

# Independently rederive the PNG-backed import GLB from the exact M1 authority in
# this fresh process and compare the composed shell. No shell-r4 fallback exists.
for obj in current_shell_all:
    obj.name = "__LIMINA_COMPOSED_SHELL__" + str(obj.get("limina.sourceGlbNodeIndex"))
before_shell = set(bpy.data.objects)
try:
    bpy.ops.import_scene.gltf(filepath=material_import_path)
except Exception as error:
    raise RuntimeError(f"fresh approved M1 deterministic import bridge failed: {error}") from error
source_shell = [obj for obj in bpy.context.scene.objects if obj not in before_shell]
if fingerprint_source_nodes(source_shell, expected_material_node_table, stamp=True) != scene.get("limina.materializedShellNodeFingerprint"):
    raise RuntimeError("fresh approved M1 node/structural fingerprint differs from composed shell authority")
for exclusion in manifest["legacyExclusions"]:
    for obj in list(source_shell):
        if semantic_matches_exclusion(str(obj.get("limina.id", "")), exclusion):
            source_shell.remove(obj)
            bpy.data.objects.remove(obj, do_unlink=True)
source_shell_semantic = [obj for obj in source_shell if obj.get("limina.id") is not None]
source_shell_ids = [obj.get("limina.id") for obj in source_shell_semantic]
if set(source_shell_ids) != set(shell_ids) or inventory_hash(source_shell_ids) != shell_record["sha256"] or source_fingerprint(source_shell, "limina.id") != scene.get("limina.materializedShellFingerprint"):
    raise RuntimeError("composed shell differs from the exact approved M1 runtime")
source_shell_by_id = {obj.get("limina.id"): obj for obj in source_shell_semantic}
for source_id, composed_obj in zip(shell_ids, current_shell):
    source_obj = source_shell_by_id[source_id]
    source_parent = source_obj.parent.get("limina.id") if source_obj.parent else None
    composed_parent = composed_obj.parent.get("limina.id") if composed_obj.parent and composed_obj.parent in current_shell else None
    if source_parent != composed_parent:
        raise RuntimeError(f"materialized shell hierarchy drifted for {source_id}")
    for key in source_obj.keys():
        if key not in composed_obj or json.dumps(composed_obj[key], default=list, sort_keys=True) != json.dumps(source_obj[key], default=list, sort_keys=True):
            raise RuntimeError(f"materialized shell semantic provenance drifted for {source_id}: {key}")

records = json.loads(scene.get("limina.compositionInstancesJson", "null"))
if not isinstance(records, list) or len(records) != len(manifest["instances"]):
    raise RuntimeError("dynamic composition instance records drifted")
records_by_id = {record.get("id"): record for record in records}
validation_records = []
for instance in manifest["instances"]:
    record = records_by_id.get(instance["id"])
    catalog = catalog_by_id.get(instance["catalogArtifactId"])
    if record is None or catalog is None or record.get("artifactId") != instance["catalogArtifactId"] or record.get("role") != instance["role"]:
        raise RuntimeError(f"{instance['id']} record/catalog binding drifted")
    instance_root_id = f"{composition_id}/{instance['id']}"
    instance_root = by_id.get(instance_root_id)
    if instance_root is None or instance_root.parent is not composition_root or instance_root.get("limina.role") != "composition-instance" or instance_root.get("limina.catalogRole") != instance["role"]:
        raise RuntimeError(f"{instance['id']} instance root is absent")
    if not close_matrix(instance_root.matrix_local, expected_instance_matrix(instance["placement"])) or list(instance_root.scale) != [1.0, 1.0, 1.0]:
        raise RuntimeError(f"{instance['id']} transform drifted or was rescaled: actual={list(map(list,instance_root.matrix_local))} expected={list(map(list,expected_instance_matrix(instance['placement'])))} scale={list(instance_root.scale)}")
    if instance_root.get("limina.artifactId") != instance["catalogArtifactId"] or instance_root.get("limina.artifactContentHash") != catalog["artifact"]["contentHash"] or json.loads(instance_root.get("limina.placementJson", "null")) != instance["placement"] or json.loads(instance_root.get("limina.bindingsJson", "null")) != instance["bindings"] or json.loads(instance_root.get("limina.constraintsJson", "null")) != instance["constraints"]:
        raise RuntimeError(f"{instance['id']} placement/binding/provenance properties drifted")
    composed = [obj for obj in scene.objects if obj.get("limina.compositionInstanceId") == instance["id"]]
    source_ids = [obj.get("limina.sourceId") for obj in composed]
    if inventory_hash(source_ids) != record.get("sourceInventorySha256") or len(composed) != record.get("objects"):
        raise RuntimeError(f"{instance['id']} semantic inventory drifted")
    if len([obj for obj in composed if obj.type == "MESH"]) != record.get("meshes") or len([obj for obj in composed if obj.get("limina.role") == "socket"]) != record.get("sockets") or len([obj for obj in composed if obj.get("limina.role") == "collider"]) != record.get("colliders"):
        raise RuntimeError(f"{instance['id']} dynamic role inventory drifted")
    roots = [obj for obj in composed if obj.parent is instance_root]
    if len(roots) != 1 or roots[0].get("limina.sourceId") != record.get("sourceRootId") or roots[0].get("limina.role") != instance["role"]:
        raise RuntimeError(f"{instance['id']} source root hierarchy drifted")
    for obj in composed:
        expected_id = f"{instance_root_id}/{obj.get('limina.sourceId')}"
        if obj.get("limina.id") != expected_id:
            raise RuntimeError(f"{instance['id']} namespace drifted for {obj.get('limina.sourceId')}")
        expected_collection = "SOCKETS" if obj.get("limina.role") == "socket" else "COLLISION" if obj.get("limina.role") == "collider" else "90_EXPORT" if obj in roots else "30_INTERIOR_DRESSING"
        if obj.name not in bpy.data.collections[expected_collection].objects:
            raise RuntimeError(f"{instance['id']} object is in the wrong collection")
    composed_fingerprint = source_fingerprint(composed, "limina.sourceId")
    if composed_fingerprint != record.get("composedFingerprint"):
        raise RuntimeError(f"{instance['id']} source-local content drifted")

    source_path = catalog_paths[instance["catalogArtifactId"]]["sourceBlend"]
    before = set(bpy.data.objects)
    with bpy.data.libraries.load(source_path, link=False) as (source, target):
        target.objects = list(source.objects)
    source_objects = [obj for obj in target.objects if obj is not None and obj not in before]
    temporary = bpy.data.collections.new("__LIMINA_VALIDATION_SOURCE__" + instance["id"].replace("/", "_"))
    scene.collection.children.link(temporary)
    for obj in source_objects:
        temporary.objects.link(obj)
    fresh_ids = [obj.get("limina.id") for obj in source_objects]
    if inventory_hash(fresh_ids) != record["sourceInventorySha256"] or source_fingerprint(source_objects, "limina.id") != record.get("sourceFingerprint"):
        raise RuntimeError(f"{instance['id']} differs from its exact approved source blend")
    source_by_id = {obj.get("limina.id"): obj for obj in source_objects}
    composed_by_source = {obj.get("limina.sourceId"): obj for obj in composed}
    if set(source_by_id) != set(composed_by_source):
        raise RuntimeError(f"{instance['id']} source semantic set drifted")
    for source_id, source_obj in source_by_id.items():
        composed_obj = composed_by_source[source_id]
        source_parent = source_obj.parent.get("limina.id") if source_obj.parent else None
        composed_parent = composed_obj.parent.get("limina.sourceId") if composed_obj.parent and composed_obj.parent in composed else None
        if source_parent != composed_parent:
            raise RuntimeError(f"{instance['id']} source hierarchy drifted for {source_id}")
        for key in source_obj.keys():
            if key == "limina.id":
                continue
            if key not in composed_obj or json.dumps(composed_obj[key], default=list, sort_keys=True) != json.dumps(source_obj[key], default=list, sort_keys=True):
                raise RuntimeError(f"{instance['id']} source custom property drifted for {source_id}: {key}")
    validation_records.append({"id": instance["id"], "rootId": instance_root_id, "objects": len(composed), "meshes": len([obj for obj in composed if obj.type == "MESH"]), "sockets": len([obj for obj in composed if obj.get("limina.role") == "socket"]), "colliders": len([obj for obj in composed if obj.get("limina.role") == "collider"]), "sourceFingerprint": record["sourceFingerprint"], "composedFingerprint": composed_fingerprint, "sourceInventorySha256": record["sourceInventorySha256"]})

expected_catalog_hashes = {artifact_id: entry["sourceBlend"]["sha256"] for artifact_id, entry in catalog_by_id.items()}
if json.loads(scene.get("limina.sourceCatalogBlendHashesJson", "null")) != expected_catalog_hashes or digest(shell_source_path) != shell["sourceBlend"]["sha256"]:
    raise RuntimeError("approved source immutability/provenance drifted")
print("LIMINA_BUILDING_COMPOSITION_BLEND_VALIDATION=" + json.dumps({"schema": "limina.blender-building-composition-source-validation/v2", "manifestHash": manifest_hash, "materializedShellRuntimeGlbHash": materials["runtimeGlb"]["sha256"], "materializedShellFingerprint": scene.get("limina.materializedShellFingerprint"), "materialRuntimeInventory": expected_material_inventory, "instances": validation_records, "sourceShellBlendHash": digest(shell_source_path)}, separators=(",", ":")))
