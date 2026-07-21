"""Author Limina's FB-2 production cottage (author/export only; never a Blender render).

The visual hierarchy is deliberately richer than FB-1, while the embedded
limina.functional-building/v1 contract remains the sole gameplay authority.

  blender --background --factory-startup --python tools/blender/functional-cottage-gorgon.py -- \
    --out assets/buildings/functional-cottage-gorgon-v2.glb
"""
import bpy, json, math, os, struct, sys
from mathutils import Matrix

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[argv.index("--out") + 1] if "--out" in argv else "assets/buildings/functional-cottage-gorgon-v2.glb"

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
for collection in (bpy.data.meshes, bpy.data.materials):
    for item in list(collection):
        collection.remove(item)

TEXTURE_SIZE = 96

def _linear_to_srgb(value):
    # Blender image pixels are authored as linear floats, but the glTF exporter packs these generated
    # images without applying a display transform. Pre-encode albedo so the runtime's required sRGB
    # decode reconstructs the intended linear reflectance. Data maps remain untouched below.
    return 12.92 * value if value <= 0.0031308 else 1.055 * (value ** (1.0 / 2.4)) - 0.055

def _hash(x, y, seed):
    return (math.sin(x * 127.1 + y * 311.7 + seed * 17.17) * 43758.5453) % 1.0

def _noise(x, y, seed):
    ix, iy = math.floor(x), math.floor(y); fx, fy = x - ix, y - iy
    fx, fy = fx*fx*(3-2*fx), fy*fy*(3-2*fy)
    a, b = _hash(ix, iy, seed), _hash(ix+1, iy, seed)
    c, d = _hash(ix, iy+1, seed), _hash(ix+1, iy+1, seed)
    return ((a*(1-fx)+b*fx)*(1-fy)+(c*(1-fx)+d*fx)*fy) * 2.0 - 1.0

def _surface(name, x, y, seed):
    """Material-specific height and colour modulation; no shared diagonal signature."""
    lower = name.lower()
    if "slate" in lower:
        rows = 10; ry = int(y*rows); fy = (y*rows) % 1.0
        shifted = (x + (0.045 if ry % 2 else 0.0)) * 7.0; fx = shifted % 1.0
        seam = min(fx, 1-fx, fy); edge = -0.82 if seam < 0.065 else 0.18
        tile = _hash(math.floor(shifted), ry, seed) * 2 - 1
        return edge + tile*0.16, 0.92 + tile*0.15 + (-0.18 if seam < 0.065 else 0)
    if "plaster" in lower or "lime" in lower:
        macro = _noise(x*2.2, y*2.2, seed); mottle = _noise(x*7.0, y*6.0, seed+3)
        runoff = max(0.0, _noise(x*9.0, 0.2, seed+8)) * (1-y)**2
        damp = max(0.0, 0.24-y) * 1.7
        return macro*.45+mottle*.18-runoff*.22, 0.98+macro*.10-mottle*.04-runoff*.20-damp*.18
    if "glass" in lower:
        pane = _hash(math.floor(x*4), math.floor(y*4), seed) * 2 - 1
        lead = min((x*4)%1, 1-(x*4)%1, (y*4)%1, 1-(y*4)%1)
        return (-0.45 if lead < .045 else pane*.08), 1.0 + pane*.24
    if "stone" in lower:
        coarse = _noise(x*5.0, y*4.0, seed); pits = _noise(x*19.0, y*17.0, seed+4)
        return coarse*.42+pits*.16, 0.96+coarse*.14+pits*.05
    if "oak" in lower:
        grain = math.sin((x*18.0 + _noise(x*2,y*2,seed)*1.2)*math.tau)
        knots = _noise(x*4.0,y*5.0,seed+9)
        return grain*.28+knots*.18, 0.96+grain*.10+knots*.10
    if "brick" in lower:
        row = int(y*9); fx = ((x + (0.055 if row%2 else 0))*6)%1; fy=(y*9)%1
        seam = min(fx,1-fx,fy,1-fy); tone = _hash(math.floor(x*6),row,seed)*2-1
        return (-.65 if seam<.06 else tone*.12), 0.94+tone*.12
    value = _noise(x*7.0, y*7.0, seed)
    return value*.3, 0.96+value*.10

def _packed_map(name, kind, color, roughness, seed):
    image = bpy.data.images.new(f"{name} {kind}", TEXTURE_SIZE, TEXTURE_SIZE, alpha=False)
    pixels = []
    step = 1.0 / TEXTURE_SIZE
    for row in range(TEXTURE_SIZE):
        y = (row + 0.5) * step
        for col in range(TEXTURE_SIZE):
            x = (col + 0.5) * step
            h, shade = _surface(name, x, y, seed)
            if kind == "albedo":
                linear = tuple(max(0.0, min(1.0, channel * shade)) for channel in color)
                pixels.extend((*(_linear_to_srgb(channel) for channel in linear), 1.0))
            elif kind == "roughness":
                value = max(0.04, min(1.0, roughness + h * 0.075))
                pixels.extend((value, value, value, 1.0))
            else:
                dx = _surface(name, x + step, y, seed)[0] - _surface(name, x - step, y, seed)[0]
                dy = _surface(name, x, y + step, seed)[0] - _surface(name, x, y - step, seed)[0]
                nx, ny, nz = -dx * 1.4, -dy * 1.4, 1.0
                inv = 1.0 / math.sqrt(nx*nx + ny*ny + nz*nz)
                pixels.extend((nx*inv*0.5 + 0.5, ny*inv*0.5 + 0.5, nz*inv*0.5 + 0.5, 1.0))
    image.pixels = pixels
    image.pack()
    if kind != "albedo": image.colorspace_settings.name = "Non-Color"
    return image

def material(name, color, roughness=0.8, metallic=0.0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1.0)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    seed = sum((index + 1) * ord(char) for index, char in enumerate(name)) % 997
    albedo = mat.node_tree.nodes.new("ShaderNodeTexImage"); albedo.name = f"{name} authored albedo"; albedo.image = _packed_map(name, "albedo", color, roughness, seed)
    rgh = mat.node_tree.nodes.new("ShaderNodeTexImage"); rgh.name = f"{name} authored roughness"; rgh.image = _packed_map(name, "roughness", color, roughness, seed)
    normal_tex = mat.node_tree.nodes.new("ShaderNodeTexImage"); normal_tex.name = f"{name} authored normal"; normal_tex.image = _packed_map(name, "normal", color, roughness, seed)
    normal = mat.node_tree.nodes.new("ShaderNodeNormalMap"); normal.inputs["Strength"].default_value = 0.42
    mat.node_tree.links.new(albedo.outputs["Color"], bsdf.inputs["Base Color"])
    mat.node_tree.links.new(rgh.outputs["Color"], bsdf.inputs["Roughness"])
    mat.node_tree.links.new(normal_tex.outputs["Color"], normal.inputs["Color"])
    mat.node_tree.links.new(normal.outputs["Normal"], bsdf.inputs["Normal"])
    return mat

STONE = material("Local fieldstone", (0.23, 0.25, 0.22), 0.96)
STONE_DARK = material("Fieldstone shadow", (0.12, 0.14, 0.12), 0.98)
PLASTER = material("Aged ochre limewash", (0.63, 0.52, 0.32), 0.91)
PLASTER_INNER = material("Interior lime plaster", (0.57, 0.52, 0.39), 0.93)
OAK = material("Weathered structural oak", (0.105, 0.048, 0.018), 0.82)
OAK_LIGHT = material("Worn oak edges", (0.22, 0.105, 0.038), 0.78)
SLATE = material("Mossed blue slate", (0.075, 0.105, 0.105), 0.91)
SLATE_EDGE = material("Slate edge", (0.035, 0.052, 0.052), 0.94)
GLASS = material("Leadlight glass", (0.14, 0.24, 0.28), 0.34)
IRON = material("Blackened iron", (0.035, 0.032, 0.028), 0.48, 0.82)
EARTH = material("Hearth brick", (0.28, 0.105, 0.052), 0.93)

def box(name, center, dimensions, mat, parent=None, bevel=0.0):
    # Engine/glTF Y-up coordinates -> Blender Z-up.
    bcenter = (center[0], -center[2], center[1])
    bdims = (dimensions[0], dimensions[2], dimensions[1])
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=bcenter)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = bdims
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        mod = obj.modifiers.new("hand-hewn edges", "BEVEL")
        mod.width = bevel; mod.segments = 1
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
    # Metric, deterministic cube projection: authored maps repeat at a stable one-metre density
    # instead of stretching one 96px tile independently across every wall and roof panel.
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.cube_project(cube_size=1.0, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    obj.data.materials.append(mat)
    if parent is not None:
        world = obj.matrix_world.copy(); obj.parent = parent; obj.matrix_world = world
    return obj

def beam(name, a, b, width, depth, mat=OAK, parent=None):
    # Beam in the X/Y facade plane at a constant engine Z.
    mx, my, mz = ((a[i] + b[i]) * 0.5 for i in range(3))
    length = math.hypot(b[0] - a[0], b[1] - a[1])
    o = box(name, (mx, my, mz), (length, width, depth), mat, parent, 0.018)
    o.rotation_euler[1] = math.atan2(b[1] - a[1], b[0] - a[0])
    return o

def gable(name, x, mat, parent=None):
    """Closed triangular end wall, authored directly in engine coordinates then converted to Blender."""
    half = 0.125
    engine = [(x+sx, y, z) for sx in (-half, half) for y, z in
              ((3.15, -2.875), (3.15, 2.875), (5.76, 0.0))]
    vertices = [(px, -pz, py) for px, py, pz in engine]
    faces = [(0,2,1), (3,4,5), (0,1,4,3), (1,2,5,4), (2,0,3,5)]
    mesh = bpy.data.meshes.new(name+" mesh"); mesh.from_pydata(vertices, [], faces); mesh.update()
    obj = bpy.data.objects.new(name, mesh); bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    if parent is not None: obj.parent = parent
    return obj

root = bpy.data.objects.new("building/root", None)
bpy.context.collection.objects.link(root)

# Architectural shell: 8 x 6 metres, 3.15 m walls, south/front entry.
box("visual/floor", (0, -0.10, 0), (8.0, 0.20, 6.0), STONE, root)
box("visual/interior-floor", (0, 0.035, 0), (7.48, 0.07, 5.48), OAK_LIGHT, root)
box("visual/north", (0, 1.575, 2.875), (8.0, 3.15, 0.25), PLASTER, root)
box("visual/east", (3.875, 1.575, 0), (0.25, 3.15, 5.75), PLASTER, root)
box("visual/west", (-3.875, 1.575, 0), (0.25, 3.15, 5.75), PLASTER, root)
box("visual/south-left", (-2.35, 1.575, -2.875), (3.30, 3.15, 0.25), PLASTER, root)
box("visual/south-right", (2.35, 1.575, -2.875), (3.30, 3.15, 0.25), PLASTER, root)
box("visual/south-lintel", (0, 2.69, -2.875), (1.40, 0.92, 0.25), PLASTER, root)
# Both end triangles are real wall geometry, not dark open space under the pitched roof.
for side, x in (("west", -3.875), ("east", 3.875)):
    gable(f"visual/gable-{side}", x, PLASTER, root)
    box(f"timber/gable-{side}-king", (x + (-0.14 if x < 0 else 0.14), 4.38, 0),
        (0.16, 2.44, 0.18), OAK, root, 0.018)
    for slope, z in ((-1, -1.42), (1, 1.42)):
        member = box(f"timber/gable-{side}-slope-{slope}",
            (x + (-0.14 if x < 0 else 0.14), 4.43, z), (0.16, 0.18, 3.80), OAK, root, 0.018)
        member.rotation_euler[0] = slope * pitch if 'pitch' in globals() else slope * math.radians(42.0)

# Rough fieldstone plinth: deterministic but deliberately non-modular widths, depths, offsets, and
# alternating material values prevent the toy-block border visible in the first candidate.
stone_widths = (0.46, 0.67, 0.55, 0.73, 0.49, 0.62, 0.58, 0.70, 0.51, 0.65, 0.54, 0.69, 0.57)
for side, z in (("south", -3.01), ("north", 3.01)):
    cursor = -4.02
    for i, width in enumerate(stone_widths):
        x = cursor + width * 0.5; cursor += width + 0.035
        depth = 0.27 + 0.035*((i*5)%3)
        box(f"detail/plinth-{side}-{i:02}", (x, 0.25 + 0.032*((i*7)%3), z + (0.025 if i%2 else -0.018)),
            (width, 0.43 + 0.065*((i*3)%4), depth), STONE if (i*5)%4 else STONE_DARK, root, 0.045)
for side, x in (("west", -4.01), ("east", 4.01)):
    for i in range(9):
        z = -2.61 + i * 0.645 + (0.025 if i%2 else -0.02)
        box(f"detail/plinth-{side}-{i:02}", (x, 0.28 + 0.03*(i%2), z),
            (0.27 + .035*(i%3), 0.44 + 0.065*((i*5)%4), 0.48 + .08*((i*7)%3)),
            STONE if (i*5)%4 else STONE_DARK, root, 0.045)

# Half-timber grid on every elevation; braces break the procedural box silhouette.
for x in (-3.72, -2.15, 0, 2.15, 3.72):
    box(f"timber/front-stud-{x}", (x, 1.77, -3.02), (0.18, 2.72, 0.16), OAK, root, 0.02)
    box(f"timber/back-stud-{x}", (x, 1.77, 3.02), (0.18, 2.72, 0.16), OAK, root, 0.02)
for z in (-2.62, -1.32, 0, 1.32, 2.62):
    box(f"timber/west-stud-{z}", (-4.02, 1.77, z), (0.16, 2.72, 0.18), OAK, root, 0.02)
    box(f"timber/east-stud-{z}", (4.02, 1.77, z), (0.16, 2.72, 0.18), OAK, root, 0.02)
for y in (0.60, 1.72, 3.03):
    box(f"timber/front-rail-{y}", (0, y, -3.02), (8.18, 0.18, 0.16), OAK, root, 0.02)
    box(f"timber/back-rail-{y}", (0, y, 3.02), (8.18, 0.18, 0.16), OAK, root, 0.02)
    box(f"timber/west-rail-{y}", (-4.02, y, 0), (0.16, 0.18, 6.18), OAK, root, 0.02)
    box(f"timber/east-rail-{y}", (4.02, y, 0), (0.16, 0.18, 6.18), OAK, root, 0.02)
for side_z in (-3.02, 3.02):
    for x0, flip in ((-3.65, 1), (2.18, -1)):
        beam(f"timber/brace-{side_z}-{x0}", (x0, 0.68, side_z), (x0 + 1.28, 1.66, side_z), 0.16, 0.17, parent=root)

# Leaded windows: dark recessed glazing, oak frame, stone sill. Collision remains the wall.
def window(prefix, x, y, z, front=True):
    if front:
        box(prefix+"/glass", (x, y, z), (1.34, 1.10, 0.055), GLASS, root)
        box(prefix+"/sill", (x, y-0.62, z-0.06), (1.58, 0.15, 0.34), STONE, root, 0.025)
        box(prefix+"/mullion", (x, y, z-0.095), (0.075, 1.13, 0.07), OAK, root)
        box(prefix+"/transom", (x, y, z-0.095), (1.36, 0.075, 0.07), OAK, root)
    else:
        box(prefix+"/glass", (x, y, z), (0.055, 1.10, 1.34), GLASS, root)
        box(prefix+"/sill", (x, y-0.62, z), (0.34, 0.15, 1.58), STONE, root, 0.025)
        box(prefix+"/mullion", (x, y, z), (0.07, 1.13, 0.075), OAK, root)
        box(prefix+"/transom", (x, y, z), (0.07, 0.075, 1.36), OAK, root)
window("window/front-west", -2.45, 1.73, -3.145)
window("window/front-east", 2.45, 1.73, -3.145)
window("window/back-west", -2.45, 1.73, 3.145)
window("window/back-east", 2.45, 1.73, 3.145)
window("window/east", 4.145, 1.73, 0, False)
window("window/west", -4.145, 1.73, 0, False)

# Deep doorway frame and threshold communicate a real traversable portal.
box("entry/threshold", (0, 0.055, -3.08), (1.42, 0.11, 0.55), STONE, root, 0.025)
# A raised oak landing projects through the portal, visually separating usable interior from terrain.
box("entry/vestibule-floor", (0, 0.105, -2.12), (1.30, 0.16, 2.35), OAK_LIGHT, root, 0.018)
for x in (-0.77, 0.77):
    box(f"entry/jamb-{x}", (x, 1.26, -3.07), (0.20, 2.52, 0.28), OAK, root, 0.025)
box("entry/head", (0, 2.48, -3.07), (1.72, 0.24, 0.28), OAK, root, 0.025)

# Pitched slate roof (Blender X rotation corresponds to engine roof pitch across Z).
pitch = math.radians(42.0)
for side, sign in (("front", 1), ("back", -1)):
    roof = box(f"roof/{side}", (0, 4.36, -sign*1.58), (8.72, 0.18, 4.34), SLATE, root, 0.018)
    # Front rises from its south eave to the ridge; back mirrors it. The opposite signs expose the
    # downward undersides to an exterior camera and invert the roof into a valley.
    roof.rotation_euler[0] = -sign * pitch
# Individually readable overlapping eave slates and ridge caps break the monolithic slab silhouette.
for i in range(20):
    x = -4.13 + i * 0.435
    for side, z in (("front", -3.40), ("back", 3.40)):
        tile = box(f"roof/eave-{side}-{i:02}", (x, 3.035 + 0.012*(i%2), z),
            (0.47, 0.105, 0.31 + 0.018*(i%3)), SLATE if i%4 else SLATE_EDGE, root, 0.012)
for i in range(13):
    x = -4.05 + i * 0.675
    box(f"roof/ridge-cap-{i:02}", (x, 5.84 + 0.012*(i%2), 0),
        (0.73, 0.20, 0.34), SLATE_EDGE if i%3 else SLATE, root, 0.025)

# Chimney/hearth anchors the interior and strengthens the exterior silhouette.
box("chimney/stack", (2.68, 4.78, 0.86), (0.88, 3.15, 0.78), EARTH, root, 0.035)
box("chimney/cap", (2.68, 6.34, 0.86), (1.08, 0.18, 0.98), STONE, root, 0.025)
box("interior/hearth", (2.72, 0.16, 2.37), (1.60, 0.30, 0.92), STONE, root, 0.04)
box("interior/fireback", (2.72, 0.90, 2.72), (1.52, 1.48, 0.18), STONE_DARK, root, 0.03)
box("interior/mantel", (2.72, 1.68, 2.53), (1.85, 0.18, 0.42), OAK, root, 0.025)
# Warm interior value planes are visible through the open portal and prevent a black/terrain read.
box("interior/back-limewash", (0, 1.48, 2.72), (5.20, 2.62, 0.06), PLASTER_INNER, root, 0.012)
box("interior/runner", (0, 0.085, 0.10), (1.05, 0.035, 4.75), EARTH, root, 0.012)
box("interior/bench-seat", (-2.55, 0.62, 1.92), (1.62, 0.16, 0.46), OAK_LIGHT, root, 0.025)
for x in (-3.12, -1.98):
    box(f"interior/bench-leg-{x}", (x, 0.31, 1.92), (0.14, 0.62, 0.32), OAK, root, 0.018)

# Door pivot is exactly at the west hinge. All decorative parts are children of the leaf and inherit
# its canonical open clip; none are merged into the static shell.
door = box("door/front", (0, 0, 0), (1.30, 2.32, 0.12), OAK_LIGHT, root, 0.02)
door.data.transform(Matrix.Translation((0.65, 0, 1.16)))
door.location = (-0.65, 3.145, 0.0)
for i in range(4):
    panel = box(f"door/front/plank-{i}", (-0.48 + i*0.32, 1.16, -3.225), (0.055, 2.18, 0.035), OAK, None, 0.008)
    world = panel.matrix_world.copy(); panel.parent = door; panel.matrix_world = world
for y in (0.31, 1.14, 2.03):
    strap = box(f"door/front/strap-{y}", (-0.02, y, -3.30), (1.14, 0.07, 0.025), IRON, None, 0.008)
    world = strap.matrix_world.copy(); strap.parent = door; strap.matrix_world = world
box("door/front/latch", (0.42, 1.18, -3.34), (0.12, 0.18, 0.08), IRON, door, 0.015)
# A proud Z-brace preserves the leaf silhouette when opened and eliminates the ambiguous flat panel.
beam("door/front/brace-a", (-0.49, 0.38, -3.34), (0.49, 1.12, -3.34), 0.11, 0.055, OAK, door)
beam("door/front/brace-b", (0.49, 1.18, -3.34), (-0.49, 1.94, -3.34), 0.11, 0.055, OAK, door)

door.rotation_euler[2] = 0.0
door.keyframe_insert(data_path="rotation_euler", index=2, frame=1)
door.rotation_euler[2] = -math.radians(70.0)
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
    "buildingId": "cottage/gorgon-one-room/v2", "rootNodeId": "building/root",
    "roomIds": ["room/main"], "portalIds": ["portal/exterior"], "entryAnchor": [0, 0, -3.72]
}
semantic = {
    "building/root": {"id": "building/root", "role": "root"},
    "room/main": {"id": "room/main", "role": "room"},
    "portal/exterior": {"id": "portal/exterior", "role": "portal"},
    "door/front": {"id": "door/front", "role": "door", "roomId": "room/main", "portalId": "portal/exterior",
        "hinge": [-0.65, 0, -3.145], "center": [0.65, 1.16, 0], "halfExtents": [0.65, 1.16, 0.06],
        "closedYaw": 0, "openYaw": -math.radians(70.0)},
}
colliders = {
    "collider/floor": ([0, -0.10, 0], [4.0, 0.10, 3.0]),
    "collider/north": ([0, 1.575, 2.875], [4.0, 1.575, 0.125]),
    "collider/east": ([3.875, 1.575, 0], [0.125, 1.575, 2.875]),
    "collider/west": ([-3.875, 1.575, 0], [0.125, 1.575, 2.875]),
    "collider/south-left": ([-2.35, 1.575, -2.875], [1.65, 1.575, 0.125]),
    "collider/south-right": ([2.35, 1.575, -2.875], [1.65, 1.575, 0.125]),
    "collider/south-lintel": ([0, 2.69, -2.875], [0.70, 0.46, 0.125]),
    "collider/ceiling": ([0, 3.10, 0], [4.0, 0.10, 3.0]),
}
for name, (center, half) in colliders.items():
    semantic[name] = {"id": name, "role": "collider", "shape": "box", "center": center, "halfExtents": half}
names = {node.get("name"): node for node in doc.get("nodes", [])}
for name, data in semantic.items():
    target = names.get(name)
    if target is None:
        target = {"name": name}; doc.setdefault("nodes", []).append(target)
    target.setdefault("extras", {})["limina"] = data
json_chunk = pad4(json.dumps(doc, separators=(",", ":"), ensure_ascii=True).encode("utf-8"), 0x20)
rebuilt = [(kind, json_chunk if kind == 0x4E4F534A else data) for kind, data in chunks]
body = b"".join(struct.pack("<II", len(data), kind) + data for kind, data in rebuilt)
open(OUT, "wb").write(struct.pack("<III", magic, version, 12 + len(body)) + body)
print(f"functional-cottage-gorgon: wrote {OUT}")
