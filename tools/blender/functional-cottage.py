"""Build Limina's minimal functional-building fixture.

This is intentionally a small, inspectable vertical slice: one room, a decomposed shell, and one
separate door leaf whose origin is the hinge. The post-export step embeds the strict semantic
contract in the GLB JSON chunk; Blender geometry/names are not trusted as gameplay authority.

  blender --background --factory-startup --python tools/blender/functional-cottage.py -- \
    --out assets/buildings/functional-cottage-v1.glb
"""
import bpy, json, math, os, struct, sys

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[argv.index("--out") + 1] if "--out" in argv else "assets/buildings/functional-cottage-v1.glb"

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)

def material(name, color, roughness):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1.0)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    return mat

STONE = material("Foundation stone", (0.22, 0.24, 0.22), 0.92)
PLASTER = material("Warm lime plaster", (0.72, 0.63, 0.45), 0.84)
WOOD = material("Oak", (0.15, 0.07, 0.025), 0.76)
ROOF = material("Weathered slate", (0.10, 0.13, 0.14), 0.88)

def box(name, center, dimensions, mat, parent=None):
    # Engine/glTF is Y-up; Blender is Z-up. Blender's exporter maps (x,y,z) -> (x,z,-y).
    bcenter = (center[0], -center[2], center[1])
    bdims = (dimensions[0], dimensions[2], dimensions[1])
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=bcenter)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = bdims
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    if parent is not None: obj.parent = parent
    return obj

root = bpy.data.objects.new("building/root", None)
bpy.context.collection.objects.link(root)

# 8m x 6m shell, 3m wall, 1.2m x 2.2m south doorway.
box("visual/floor", (0, -0.10, 0), (8.0, 0.20, 6.0), STONE, root)
box("visual/north", (0, 1.5, 2.875), (8.0, 3.0, 0.25), PLASTER, root)
box("visual/east", (3.875, 1.5, 0), (0.25, 3.0, 5.75), PLASTER, root)
box("visual/west", (-3.875, 1.5, 0), (0.25, 3.0, 5.75), PLASTER, root)
box("visual/south-left", (-2.30, 1.5, -2.875), (3.40, 3.0, 0.25), PLASTER, root)
box("visual/south-right", (2.30, 1.5, -2.875), (3.40, 3.0, 0.25), PLASTER, root)
box("visual/south-lintel", (0, 2.60, -2.875), (1.20, 0.80, 0.25), WOOD, root)
box("visual/roof", (0, 3.25, 0), (8.5, 0.35, 6.5), ROOF, root)

# Door origin/pivot is exactly the west hinge at grade; mesh center is offset +X from the origin.
door = box("door/front", (0, 0, 0), (1.10, 2.10, 0.12), WOOD, root)
door.data.transform(__import__('mathutils').Matrix.Translation((0.55, 0, 1.05)))
door.location = (-0.55, 3.01, 0.0)

# A canonical authoring clip is retained for QC. Runtime state is deterministic and drives the same
# hinge sweep directly so worker physics never depends on animation sampling.
door.rotation_euler[2] = 0.0
door.keyframe_insert(data_path="rotation_euler", index=2, frame=1)
door.rotation_euler[2] = -math.pi / 2
door.keyframe_insert(data_path="rotation_euler", index=2, frame=25)
if door.animation_data and door.animation_data.action:
    door.animation_data.action.name = "door/front/open"
door.rotation_euler[2] = 0.0

os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=os.path.abspath(OUT), export_format="GLB", export_yup=True,
    export_animations=True, export_extras=True, export_apply=False)

def pad4(data, byte):
    return data + bytes([byte]) * ((4 - len(data) % 4) % 4)

raw = open(OUT, "rb").read()
magic, version, total = struct.unpack_from("<III", raw, 0)
assert magic == 0x46546C67 and version == 2 and total == len(raw)
offset, chunks = 12, []
while offset < len(raw):
    length, kind = struct.unpack_from("<II", raw, offset)
    chunks.append((kind, raw[offset + 8:offset + 8 + length]))
    offset += 8 + length
doc = json.loads(next(data for kind, data in chunks if kind == 0x4E4F534A).decode("utf-8").rstrip(" \0"))
doc.setdefault("asset", {}).setdefault("extras", {})["liminaFunctionalBuilding"] = {
    "schema": "limina.functional-building/v1", "units": "meter", "up": "Y",
    "buildingId": "cottage/one-room/v1", "rootNodeId": "building/root",
    "roomIds": ["room/main"], "portalIds": ["portal/exterior"], "entryAnchor": [0, 0, -3.6]
}
semantic = {
    "building/root": {"id": "building/root", "role": "root"},
    "room/main": {"id": "room/main", "role": "room"},
    "portal/exterior": {"id": "portal/exterior", "role": "portal"},
    "door/front": {"id": "door/front", "role": "door", "roomId": "room/main", "portalId": "portal/exterior",
        "hinge": [-0.55, 0, -3.01], "center": [0.55, 1.05, 0], "halfExtents": [0.55, 1.05, 0.06],
        "closedYaw": 0, "openYaw": -math.pi / 2},
}
colliders = {
    "collider/floor": ([0, -0.10, 0], [4.0, 0.10, 3.0]),
    "collider/north": ([0, 1.5, 2.875], [4.0, 1.5, 0.125]),
    "collider/east": ([3.875, 1.5, 0], [0.125, 1.5, 2.875]),
    "collider/west": ([-3.875, 1.5, 0], [0.125, 1.5, 2.875]),
    "collider/south-left": ([-2.30, 1.5, -2.875], [1.70, 1.5, 0.125]),
    "collider/south-right": ([2.30, 1.5, -2.875], [1.70, 1.5, 0.125]),
    "collider/south-lintel": ([0, 2.60, -2.875], [0.60, 0.40, 0.125]),
}
for name, (center, half) in colliders.items():
    semantic[name] = {"id": name, "role": "collider", "shape": "box", "center": center, "halfExtents": half}

names = {node.get("name"): node for node in doc.get("nodes", [])}
for name, data in semantic.items():
    target = names.get(name)
    if target is None:
        target = {"name": name}
        doc.setdefault("nodes", []).append(target)
    target.setdefault("extras", {})["limina"] = data

json_chunk = pad4(json.dumps(doc, separators=(",", ":"), ensure_ascii=True).encode("utf-8"), 0x20)
rebuilt = [(kind, json_chunk if kind == 0x4E4F534A else data) for kind, data in chunks]
body = b"".join(struct.pack("<II", len(data), kind) + data for kind, data in rebuilt)
open(OUT, "wb").write(struct.pack("<III", magic, version, 12 + len(body)) + body)
print(f"functional-cottage: wrote {OUT}")
