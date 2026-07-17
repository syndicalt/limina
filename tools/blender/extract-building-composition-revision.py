"""Extract only bounded C1 instance-root transforms from a saved Blender source.

This does not export geometry. It fails closed unless the exact C1 r3 dependency,
mesh, material, hierarchy, semantic, socket, and collider closure is unchanged.
"""
import bpy
import hashlib
import json
import math
import os
import struct
import sys
from mathutils import Matrix, Vector

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCHEMA = "limina.blender-composition-edit-extraction/v1"
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


def portable(path):
    absolute = os.path.abspath(path)
    if os.path.commonpath((REPO, absolute)) != REPO:
        raise RuntimeError(f"bounded C1 resource escapes repository: {path}")
    return os.path.relpath(absolute, REPO).replace(os.sep, "/")


def load_exact(path, expected, label):
    absolute = os.path.abspath(path)
    if digest(absolute) != expected:
        raise RuntimeError(f"{label} exact bytes drifted")
    with open(absolute, "r", encoding="utf8") as handle:
        return json.load(handle)


def resolve_resource(record, label):
    path = os.path.abspath(os.path.join(REPO, *record["path"].split("/")))
    if os.path.commonpath((REPO, path)) != REPO or digest(path) != record["sha256"]:
        raise RuntimeError(f"{label} exact resource drifted")
    return path


def glb_document(path):
    raw = open(path, "rb").read()
    magic, version, total = struct.unpack_from("<4sII", raw, 0)
    if magic != b"glTF" or version != 2 or total != len(raw):
        raise RuntimeError("protected M1 runtime is not GLB2")
    offset, document = 12, None
    while offset < total:
        length, kind = struct.unpack_from("<II", raw, offset)
        offset += 8
        data, offset = raw[offset:offset + length], offset + length
        if kind == 0x4E4F534A:
            document = json.loads(data.decode("utf8").rstrip(" \0"))
    if not isinstance(document, dict):
        raise RuntimeError("protected M1 runtime lacks JSON")
    return document


def source_node_table(document):
    nodes = document.get("nodes", [])
    parents = [None] * len(nodes)
    for parent_index, node in enumerate(nodes):
        for child in node.get("children", []):
            if parents[child] is not None:
                raise RuntimeError("protected M1 source node has multiple parents")
            parents[child] = parent_index
    entries = [{"index": index, "name": node.get("name"), "semanticId": node.get("extras", {}).get("limina.id"), "semanticRole": node.get("extras", {}).get("limina.role"), "parentIndex": parents[index], "children": node.get("children", []), "nodeSha256": canonical_hash(node)} for index, node in enumerate(nodes)]
    return {"sha256": canonical_hash(entries), "entries": entries}


def fingerprint_source_nodes(objects, table):
    bpy.context.view_layer.update()
    by_index = {obj.get("limina.sourceGlbNodeIndex"): obj for obj in objects}
    if set(by_index) != set(range(len(table["entries"]))) or len(by_index) != len(objects):
        raise RuntimeError("protected M1 source-node inventory drifted")
    hasher = hashlib.sha256()
    for entry in table["entries"]:
        obj = by_index[entry["index"]]
        if obj.name != entry["name"] or obj.get("limina.id") != entry["semanticId"] or obj.get("limina.role") != entry["semanticRole"]:
            raise RuntimeError(f"protected M1 semantic node drifted: {entry['index']}")
        parent_index = obj.parent.get("limina.sourceGlbNodeIndex") if obj.parent in objects else None
        children = sorted(child.get("limina.sourceGlbNodeIndex") for child in obj.children if child in objects)
        if parent_index != entry["parentIndex"] or children != sorted(entry["children"]):
            raise RuntimeError(f"protected M1 hierarchy drifted: {entry['index']}")
        update_bytes(hasher, json.dumps({"index": entry["index"], "name": obj.name, "type": obj.type, "semanticId": obj.get("limina.id"), "semanticRole": obj.get("limina.role"), "parentIndex": parent_index, "children": children}, sort_keys=True, separators=(",", ":")))
        for row in obj.matrix_local:
            for number in row:
                hasher.update(struct.pack("<d", float(number)))
    return "sha256:" + hasher.hexdigest()


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
    hasher, material_cache, object_set = hashlib.sha256(), {}, set(objects)
    roots = [obj for obj in objects if obj.parent not in object_set]
    if len(roots) != 1:
        raise RuntimeError("protected source fingerprint requires one hierarchy root")
    root_inverse = roots[0].matrix_world.inverted()
    for obj in sorted((obj for obj in objects if obj.type == "MESH"), key=lambda item: item.get(source_property, "")):
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


def inventory_hash(values):
    if any(not isinstance(value, str) or not value for value in values) or len(set(values)) != len(values):
        raise RuntimeError("protected semantic inventory is absent or duplicated")
    return "sha256:" + hashlib.sha256(json.dumps(sorted(values), separators=(",", ":")).encode("utf8")).hexdigest()


def e2b(value):
    return Vector((value[0], -value[2], value[1]))


def expected_instance_matrix(placement):
    rotation = B @ Matrix.Rotation(float(placement["yawRadians"]), 3, "Y") @ BI
    return Matrix.Translation(e2b(placement["position"])) @ rotation.to_4x4()


def close_matrix(left, right, epsilon=1e-6):
    return all(abs(float(left[row][column]) - float(right[row][column])) <= epsilon for row in range(4) for column in range(4))


manifest_path, build_path, output_path = map(os.path.abspath, (arg("--base-manifest"), arg("--base-build-evidence"), arg("--out")))
manifest = load_exact(manifest_path, "sha256:12b822f1fc688d0b4fed45f8d4bfc1a1c7acf8a781d443c55e2ca2d90f002a3e", "C1 r3 manifest")
build = load_exact(build_path, "sha256:7c18144a19ab9b8dadfd274734d24b66b4186ab91df1dfb936cd1502501ffd39", "C1 r3 build evidence")
scene = bpy.context.scene
if scene.get("limina.handoffSchema") != "limina.blender-building-composition-handoff/v2" or scene.get("limina.compositionManifestHash") != canonical_hash(manifest) or scene.get("limina.compositionManifestRawSha256") != digest(manifest_path):
    raise RuntimeError("saved Blender source is not the exact C1 r3 handoff")
if json.loads(scene.get("limina.compositionManifestJson", "null")) != manifest:
    raise RuntimeError("embedded composition manifest drifted")

adapter = build["adapterOutput"]
expected_catalog = dict(sorted((entry["artifactId"], entry["sourceBlendHash"]) for entry in adapter["instances"]))
expected_protected = {
    "handoffSchema": "limina.blender-building-composition-handoff/v2",
    "compositionRootId": manifest["id"],
    "materializedShellFingerprint": adapter["materializedShellFingerprint"],
    "materializedShellNodeTableHash": adapter["materializedShellNodeTableHash"],
    "materializedShellNodeFingerprint": adapter["materializedShellNodeFingerprint"],
    "sourceShellBlendHash": build["sourceValidation"]["sourceShellBlendHash"],
    "sourceCatalogBlendHashes": expected_catalog,
    "instances": adapter["instances"],
}
for key in ("materializedShellFingerprint", "materializedShellNodeTableHash", "materializedShellNodeFingerprint"):
    if scene.get("limina." + key) != expected_protected[key]:
        raise RuntimeError(f"protected shell property drifted: {key}")
if scene.get("limina.sourceShellBlendHash") != expected_protected["sourceShellBlendHash"] or json.loads(scene.get("limina.sourceCatalogBlendHashesJson", "null")) != expected_catalog:
    raise RuntimeError("protected dependency hashes drifted")

composition_root = next((obj for obj in scene.objects if obj.get("limina.id") == manifest["id"]), None)
if composition_root is None or composition_root.parent is not None or composition_root.get("limina.role") != "building-composition" or not close_matrix(composition_root.matrix_local, Matrix.Identity(4)):
    raise RuntimeError("protected composition root drifted")
shell_objects = [obj for obj in scene.objects if obj.get("limina.sourceGlbNodeIndex") is not None]
if source_fingerprint(shell_objects, "limina.id") != expected_protected["materializedShellFingerprint"]:
    raise RuntimeError("protected shell mesh/material closure drifted")
material_runtime_path = resolve_resource(manifest["dependencies"]["materialPalette"]["runtimeGlb"], "protected M1 runtime")
node_table = source_node_table(glb_document(material_runtime_path))
if node_table["sha256"] != expected_protected["materializedShellNodeTableHash"] or fingerprint_source_nodes(shell_objects, node_table) != expected_protected["materializedShellNodeFingerprint"]:
    raise RuntimeError("protected shell semantic/hierarchy closure drifted")

records = {entry["id"]: entry for entry in adapter["instances"]}
catalog = {entry["artifact"]["artifactId"]: entry for entry in manifest["dependencies"]["catalog"]}
edits = []
for instance in manifest["instances"]:
    record = records.get(instance["id"])
    root_id = f"{manifest['id']}/{instance['id']}"
    root = next((obj for obj in scene.objects if obj.get("limina.id") == root_id), None)
    if record is None or root is None or root.parent is not composition_root or root.get("limina.role") != "composition-instance":
        raise RuntimeError(f"{instance['id']} protected instance root drifted")
    if root.get("limina.instanceId") != instance["id"] or root.get("limina.catalogRole") != instance["role"] or root.get("limina.artifactId") != instance["catalogArtifactId"]:
        raise RuntimeError(f"{instance['id']} protected role/artifact semantics drifted")
    if json.loads(root.get("limina.placementJson", "null")) != instance["placement"] or json.loads(root.get("limina.bindingsJson", "null")) != instance["bindings"] or json.loads(root.get("limina.constraintsJson", "null")) != instance["constraints"]:
        raise RuntimeError(f"{instance['id']} protected placement metadata drifted")
    composed = [obj for obj in scene.objects if obj.get("limina.compositionInstanceId") == instance["id"]]
    source_ids = [obj.get("limina.sourceId") for obj in composed]
    if inventory_hash(source_ids) != record["sourceInventorySha256"] or len(composed) != record["objects"] or len([obj for obj in composed if obj.type == "MESH"]) != record["meshes"] or len([obj for obj in composed if obj.get("limina.role") == "socket"]) != record["sockets"] or len([obj for obj in composed if obj.get("limina.role") == "collider"]) != record["colliders"]:
        raise RuntimeError(f"{instance['id']} protected semantic inventory drifted")
    if source_fingerprint(composed, "limina.sourceId") != record["composedFingerprint"]:
        raise RuntimeError(f"{instance['id']} protected mesh/material closure drifted")
    source_path = resolve_resource(catalog[instance["catalogArtifactId"]]["sourceBlend"], f"{instance['id']} protected source blend")
    before = set(bpy.data.objects)
    with bpy.data.libraries.load(source_path, link=False) as (source, target):
        target.objects = list(source.objects)
    source_objects = [obj for obj in target.objects if obj is not None and obj not in before]
    temporary = bpy.data.collections.new("__LIMINA_BOUNDED_SOURCE__" + instance["id"].replace("/", "_"))
    scene.collection.children.link(temporary)
    for obj in source_objects:
        temporary.objects.link(obj)
    try:
        source_by_id = {obj.get("limina.id"): obj for obj in source_objects}
        composed_by_id = {obj.get("limina.sourceId"): obj for obj in composed}
        if set(source_by_id) != set(composed_by_id) or inventory_hash(list(source_by_id)) != record["sourceInventorySha256"] or source_fingerprint(source_objects, "limina.id") != record["sourceFingerprint"]:
            raise RuntimeError(f"{instance['id']} differs from exact approved source")
        for source_id, source_obj in source_by_id.items():
            composed_obj = composed_by_id[source_id]
            if source_obj.type != composed_obj.type:
                raise RuntimeError(f"{instance['id']} protected object type drifted for {source_id}")
            source_parent = source_obj.parent.get("limina.id") if source_obj.parent else None
            composed_parent = composed_obj.parent.get("limina.sourceId") if composed_obj.parent in composed else None
            if source_parent != composed_parent:
                raise RuntimeError(f"{instance['id']} protected hierarchy drifted for {source_id}")
            allowed_added = {"limina.id", "limina.sourceId", "limina.compositionInstanceId"}
            unsupported = set(composed_obj.keys()) - set(source_obj.keys()) - allowed_added
            if unsupported:
                raise RuntimeError(f"{instance['id']} invented protected properties for {source_id}: {','.join(sorted(unsupported))}")
            for key in source_obj.keys():
                if key != "limina.id" and (key not in composed_obj or json.dumps(jsonable(composed_obj[key]), sort_keys=True) != json.dumps(jsonable(source_obj[key]), sort_keys=True)):
                    raise RuntimeError(f"{instance['id']} protected semantic property drifted for {source_id}: {key}")
    finally:
        for obj in source_objects:
            bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.collections.remove(temporary)
    matrix = root.matrix_local.copy()
    translation = matrix.to_translation()
    scale = matrix.to_scale()
    yaw = math.atan2(float(matrix[1][0]), float(matrix[0][0]))
    placement = {"position": [float(translation.x), float(translation.z), float(-translation.y)], "yawRadians": yaw, "scale": [float(scale.x), float(scale.y), float(scale.z)]}
    if any(abs(value - 1.0) > 1e-6 for value in placement["scale"]):
        raise RuntimeError(f"{instance['id']} scale edits are forbidden")
    placement["scale"] = [1, 1, 1]
    if abs(placement["position"][1] - instance["placement"]["position"][1]) > 1e-6 or not close_matrix(matrix, expected_instance_matrix(placement)):
        raise RuntimeError(f"{instance['id']} permits only engine X/Z/yaw root edits")
    placement["position"][1] = instance["placement"]["position"][1]
    edits.append({"id": instance["id"], **placement})

blend_path = os.path.abspath(bpy.data.filepath)
if not blend_path or not os.path.isfile(blend_path):
    raise RuntimeError("bounded C1 extraction requires a saved Blender file")
extraction = {"schema": SCHEMA, "source": {
    "baseManifest": {"path": portable(manifest_path), "sha256": digest(manifest_path)},
    "baseBuildEvidence": {"path": portable(build_path), "sha256": digest(build_path)},
    "blend": {"path": portable(blend_path), "sha256": digest(blend_path)},
    "extractor": {"path": portable(__file__), "sha256": digest(__file__)},
}, "protected": expected_protected, "edits": edits}
os.makedirs(os.path.dirname(output_path), exist_ok=True)
with open(output_path, "x", encoding="utf8") as handle:
    json.dump(extraction, handle, indent=2)
    handle.write("\n")
print("LIMINA_BOUNDED_COMPOSITION_EXTRACTION=" + json.dumps({"schema": SCHEMA, "instances": len(edits), "output": output_path}, separators=(",", ":")))
