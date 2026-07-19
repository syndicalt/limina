"""One-way Limina architecture IR -> Blender GLB adapter. This file realizes solved geometry only."""
import bpy, hashlib, json, math, os, sys, struct
from mathutils import Vector

if bpy.app.version_string != "4.0.2": raise RuntimeError("Limina architecture adapter requires Blender 4.0.2")

args=sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else []
def arg(flag):
    if flag not in args or args.index(flag)+1>=len(args): raise RuntimeError("usage: blender --background --python tools/blender/architecture-adapter.py -- --input <compiled.json> --out <asset.glb> --blend-out <source.blend>")
    return os.path.abspath(args[args.index(flag)+1])
INPUT,OUT,BLEND_OUT=arg("--input"),arg("--out"),arg("--blend-out")
with open(INPUT,"r",encoding="utf8") as f: payload=json.load(f)
if payload.get("schema")!="limina.blender-architecture-input/v1": raise RuntimeError("unsupported architecture adapter input")
contract=payload.get("functionalContract")
multi_room=payload.get("multiRoom")
if contract and contract.get("schema")=="limina.functional-building/v2":
    if not isinstance(multi_room,dict) or multi_room.get("schema")!="limina.blender-multi-room-realization/v1": raise RuntimeError("v2 functional contract requires explicit multi-room realization authority")
    for key,records in (("verticalLinkIds",contract.get("verticalLinks",[])),("spawnAnchorIds",contract.get("spawnAnchors",[])),("visibilityCellIds",contract.get("visibilityCells",[]))):
        if multi_room.get(key)!=[record.get("id") for record in records]: raise RuntimeError("v2 multi-room realization inventory drifted: "+key)
    if contract.get("verticalLinks") and not multi_room.get("partitionedFloors"): raise RuntimeError("v2 vertical links require partitioned upper-floor authority")
    primitive_ids=[primitive.get("id") for primitive in payload.get("primitives",[])]
    if len(primitive_ids)!=len(set(primitive_ids)): raise RuntimeError("architecture adapter input contains duplicate primitive ids")
    primitive_set=set(primitive_ids)
    for link in contract.get("verticalLinks",[]):
        prefix="stairs/"+link["id"]+"/"
        realized=[primitive_id for primitive_id in primitive_ids if primitive_id.startswith(prefix)]
        flights=link.get("flights")
        intermediate=link.get("intermediateLandings",[])
        expected=link["riserCount"]+2+len(intermediate)
        if len(realized)!=expected or prefix+"landing-bottom" not in primitive_set or prefix+"landing-top" not in primitive_set: raise RuntimeError("v2 vertical link lacks compiler-owned tread and landing geometry: "+link["id"])
        if flights:
            if len(flights)<2 or len(intermediate)!=len(flights)-1 or not link.get("approaches"): raise RuntimeError("v2 multi-flight link lacks landing/approach authority: "+link["id"])
            for flight_index,flight in enumerate(flights):
                for tread_index in range(flight["riserCount"]):
                    if prefix+f"flight-{flight_index}/tread-{tread_index}" not in primitive_set: raise RuntimeError("v2 multi-flight link lacks exact tread geometry: "+link["id"])
            for landing_index in range(len(intermediate)):
                if prefix+f"landing-intermediate-{landing_index}" not in primitive_set: raise RuntimeError("v2 multi-flight link lacks exact turn landing: "+link["id"])
    for floor in multi_room.get("partitionedFloors",[]):
        if floor["prohibitedFullFloorId"] in primitive_set: raise RuntimeError("partitioned upper floor retained prohibited full slab: "+floor["prohibitedFullFloorId"])
        if not floor.get("fragmentIds") or any(fragment not in primitive_set for fragment in floor["fragmentIds"]): raise RuntimeError("partitioned upper floor lacks compiler-owned fragments: "+floor["volumeId"])
elif multi_room is not None:
    raise RuntimeError("multi-room realization authority requires a v2 functional contract")
bpy.ops.object.select_all(action="SELECT");bpy.ops.object.delete(use_global=False)
for collection in (bpy.data.meshes,bpy.data.materials,bpy.data.images):
    for item in list(collection): collection.remove(item)

REPO=os.path.abspath(os.path.join(os.path.dirname(__file__),"..",".."));MATERIAL_ROOT=os.path.join(REPO,"assets","materials");MATERIAL_MANIFESTS=[]
def pbr_material(name,pack,tint=(1,1,1,1),normal_strength=.62):
    directory=os.path.join(MATERIAL_ROOT,pack);manifest_path=os.path.join(directory,"material-pack.json")
    with open(manifest_path,"rb") as f: manifest_bytes=f.read()
    manifest=json.loads(manifest_bytes);digest=hashlib.sha256(manifest_bytes).hexdigest();MATERIAL_MANIFESTS.append((pack,digest))
    material=bpy.data.materials.new(name);material.use_nodes=True;material.diffuse_color=tint
    shader=material.node_tree.nodes["Principled BSDF"];shader.inputs["Base Color"].default_value=tint;shader.inputs["Metallic"].default_value=0
    for slot,color_space in (("albedo","sRGB"),("roughness","Non-Color"),("normal","Non-Color")):
        record=manifest["maps"][slot];path=os.path.join(REPO,"assets",record["assetId"])
        with open(path,"rb") as f: source=f.read()
        if "sha256:"+hashlib.sha256(source).hexdigest()!=record["sha256"]: raise RuntimeError(f"material source hash drift: {pack}/{slot}")
        image=bpy.data.images.load(path,check_existing=False);image.name=f"{name} {slot}";image.colorspace_settings.name=color_space;image.pack()
        texture=material.node_tree.nodes.new("ShaderNodeTexImage");texture.name=f"{name} {slot}";texture.image=image
        if slot=="albedo": material.node_tree.links.new(texture.outputs["Color"],shader.inputs["Base Color"])
        elif slot=="roughness": material.node_tree.links.new(texture.outputs["Color"],shader.inputs["Roughness"])
        else:
            normal=material.node_tree.nodes.new("ShaderNodeNormalMap");normal.inputs["Strength"].default_value=normal_strength
            material.node_tree.links.new(texture.outputs["Color"],normal.inputs["Color"]);material.node_tree.links.new(normal.outputs["Normal"],shader.inputs["Normal"])
    material["limina_material_pack"]=pack;material["limina_material_manifest_sha256"]=digest
    return material
def simple_material(name,rgb,rough=.82,metal=0,alpha=1,emission=0):
    material=bpy.data.materials.new(name);material.use_nodes=True;material.diffuse_color=(*rgb,alpha)
    shader=material.node_tree.nodes["Principled BSDF"];shader.inputs["Base Color"].default_value=(*rgb,alpha);shader.inputs["Roughness"].default_value=rough;shader.inputs["Metallic"].default_value=metal
    if emission:
        socket=shader.inputs.get("Emission Color") or shader.inputs.get("Emission");strength=shader.inputs.get("Emission Strength")
        if socket is not None: socket.default_value=(*rgb,1)
        if strength is not None: strength.default_value=emission
    if alpha<1:
        shader.inputs["Alpha"].default_value=alpha
        for attribute,value in (("surface_render_method","BLENDED"),("blend_method","BLEND")):
            if hasattr(material,attribute):
                try: setattr(material,attribute,value)
                except Exception: pass
        if hasattr(material,"use_transparency_overlap"): material.use_transparency_overlap=False
        if hasattr(material,"show_transparent_back"): material.show_transparent_back=True
    return material
MATERIALS={
    "foundation":pbr_material("V4 fieldstone","cottage-fieldstone"),"mortar-reveal":pbr_material("V4 lime mortar","cottage-white-plaster"),
    "wall-exterior":pbr_material("V4 warm lime plaster","cottage-white-plaster"),"wall-interior":pbr_material("V4 interior lime","cottage-white-plaster"),
    "structure-trim":pbr_material("V4 structural oak","cottage-structural-oak"),"door-surface":pbr_material("V4 door oak","cottage-structural-oak"),
    "timber-frame-exterior":pbr_material("V4 exterior frame oak","cottage-structural-oak"),
    "floor-furnishing":pbr_material("V4 worn oak","cottage-worn-planks"),"furniture-wood":pbr_material("V4 furniture oak","cottage-structural-oak"),"domestic-ceramic":simple_material("V4 warm ceramic",(.34,.18,.09),.74),"domestic-ceramic-dark":simple_material("V4 ceramic interior",(.045,.024,.015),.88),
    "textile-wool":simple_material("V4 woven wool",(.23,.055,.035),.92),"wax":simple_material("V4 beeswax",(.76,.52,.16),.72),"roof":pbr_material("V4 blue slate","cottage-grey-roof"),"roof-flashing":simple_material("V4 weathered lead",(.16,.18,.18),.62,.25),
    "hearth-masonry":pbr_material("V4 chimney brick","cottage-medieval-brick"),"hearth-soot":simple_material("V4 hearth soot",(.012,.009,.007),.96),
    # The flame meshes must retain hue and internal detail after engine tonemapping.
    # Bounded emission supplies the visible flame; the compiler-owned point light
    # supplies only local firebox spill instead of turning the aperture white.
    "hearth-embers":simple_material("V4 hearth embers",(.72,.065,.008),.54,emission=.55),"flame-outer":simple_material("V4 flame outer",(.78,.18,.018),.52,alpha=.72,emission=.85),
    "flame-inner":simple_material("V4 flame inner",(.88,.48,.045),.48,alpha=.78,emission=.85),"glazing":simple_material("V4 leadlight glass",(.12,.20,.22),.22,alpha=.24),
    "door-hardware":simple_material("V4 black iron",(.035,.032,.028),.46,.85),
}
def material_for(record):
    role=record.get("materialRole")
    if role not in MATERIALS: raise RuntimeError(f"primitive {record.get('id')} has unsupported material role {role}")
    return MATERIALS[role]
def semantic(obj,record):
    obj["limina_architecture_id"]=record["id"];obj["limina_derived_from"]=json.dumps(record.get("derivedFrom",[]),separators=(",",":"))
    obj["limina_lod_levels"]=json.dumps(record.get("lodLevels",[]),separators=(",",":"))
    obj["limina.id"]=record["id"];obj["limina.role"]="architecture-primitive";obj["limina.derivedFrom"]=record.get("derivedFrom",[]);obj["limina.owner"]=(record.get("derivedFrom") or [record["id"]])[0];obj["limina.editPolicy"]="protected-generated";obj["limina.lodLevels"]=record.get("lodLevels",[])
    frame=record.get("uvFrame")
    if frame:
        obj["limina_roof_anchor_engine"]=frame["anchor"];obj["limina_roof_ridge_world"]=frame["ridge"];obj["limina_roof_slope_world"]=frame["slope"];obj["limina_roof_metres_per_repeat"]=frame["metresPerRepeat"]
def box(record):
    c,h=record["center"],record["halfExtents"];bpy.ops.mesh.primitive_cube_add(size=1,location=(c[0],-c[2],c[1]));o=bpy.context.object;o.name=record["id"];o.dimensions=(h[0]*2,h[2]*2,h[1]*2);o.rotation_euler[2]=-record.get("yawRadians",0);o.rotation_euler[1]=-record.get("doorPlaneAngleRadians",0);bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);o.data.materials.append(material_for(record));semantic(o,record)
def slab(record):
    n=Vector((record["normal"][0],-record["normal"][2],record["normal"][1])).normalized();half=record["thickness"]/2
    top=[Vector((p[0],-p[2],p[1]))+n*half for p in record["boundary"]];bottom=[Vector((p[0],-p[2],p[1]))-n*half for p in record["boundary"]];verts=[tuple(v) for v in top+bottom];count=len(top)
    faces=[tuple(range(count)),tuple(range(count,2*count))[::-1]]+[(i,(i+1)%count,(i+1)%count+count,i+count) for i in range(count)]
    mesh=bpy.data.meshes.new(record["id"]+" mesh");mesh.from_pydata(verts,[],faces);mesh.update();o=bpy.data.objects.new(record["id"],mesh);bpy.context.collection.objects.link(o);o.data.materials.append(material_for(record));semantic(o,record)
def polygon_slab(record):
    boundary=record["boundary"];bottom=record["bottomY"];top=record["topY"]
    lower=[(p[0],-p[1],bottom) for p in boundary];upper=[(p[0],-p[1],top) for p in boundary];count=len(boundary)
    faces=[tuple(range(count-1,-1,-1)),tuple(range(count,2*count))]+[(i,(i+1)%count,(i+1)%count+count,i+count) for i in range(count)]
    mesh=bpy.data.meshes.new(record["id"]+" mesh");mesh.from_pydata(lower+upper,[],faces);mesh.update();o=bpy.data.objects.new(record["id"],mesh);bpy.context.collection.objects.link(o);o.data.materials.append(material_for(record));semantic(o,record)
def linear_member(record):
    a=Vector((record["from"][0],-record["from"][2],record["from"][1]));b=Vector((record["to"][0],-record["to"][2],record["to"][1]));delta=b-a
    bpy.ops.mesh.primitive_cube_add(size=1,location=(a+b)/2);o=bpy.context.object;o.name=record["id"];o.dimensions=(delta.length,record["width"],record["depth"]);bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);o.rotation_mode="QUATERNION";o.rotation_quaternion=Vector((1,0,0)).rotation_difference(delta.normalized());o.data.materials.append(material_for(record));semantic(o,record)
def oriented_cylinder(record):
    a=Vector((record["from"][0],-record["from"][2],record["from"][1]));b=Vector((record["to"][0],-record["to"][2],record["to"][1]));delta=b-a
    bpy.ops.mesh.primitive_cylinder_add(vertices=record["vertices"],radius=record["radius"],depth=delta.length,location=(a+b)/2);o=bpy.context.object;o.name=record["id"];o.rotation_mode="QUATERNION";o.rotation_quaternion=Vector((0,0,1)).rotation_difference(delta.normalized());o.data.materials.append(material_for(record));semantic(o,record)
def tapered_flame(record):
    base=record["baseCenter"];height=record["height"];bpy.ops.mesh.primitive_cone_add(vertices=record["vertices"],radius1=record["baseRadius"],radius2=.018,depth=height,location=(base[0],-base[2],base[1]+height/2));o=bpy.context.object;o.name=record["id"]
    offset=record["tipOffset"]
    for vertex in o.data.vertices:
        if vertex.co.z>0: vertex.co.x+=offset[0];vertex.co.y-=offset[2];vertex.co.z+=offset[1]
    o.data.materials.append(material_for(record));semantic(o,record)
def lathed_profile(record):
    center=record["center"];profile=record["profile"];segments=record["vertices"];verts=[]
    for radius,height in profile:
        for index in range(segments):
            angle=2*math.pi*index/segments;verts.append((center[0]+radius*math.cos(angle),-center[2]-radius*math.sin(angle),center[1]+height))
    faces=[]
    for ring in range(len(profile)-1):
        for index in range(segments):
            nxt=(index+1)%segments;a=ring*segments+index;b=ring*segments+nxt;c=(ring+1)*segments+nxt;d=(ring+1)*segments+index;faces.append((a,b,c,d))
    faces.append(tuple(range(segments-1,-1,-1)));top=(len(profile)-1)*segments;faces.append(tuple(top+index for index in range(segments)))
    mesh=bpy.data.meshes.new(record["id"]+" mesh");mesh.from_pydata(verts,[],faces);mesh.update();o=bpy.data.objects.new(record["id"],mesh);bpy.context.collection.objects.link(o);o.data.materials.append(material_for(record));semantic(o,record)
    for polygon in mesh.polygons: polygon.use_smooth=True
for primitive in payload["primitives"]:
    {"box":box,"plane-slab":slab,"polygon-slab":polygon_slab,"linear-member":linear_member,"oriented-cylinder":oriented_cylinder,"tapered-flame":tapered_flame,"lathed-profile":lathed_profile}[primitive["kind"]](primitive)
for door in payload.get("doors",[]):
    hinge=door["hinge"];orientation=bpy.data.objects.new(door["id"]+"/orientation",None);bpy.context.collection.objects.link(orientation);orientation.location=(hinge[0],-hinge[2],hinge[1]);orientation.rotation_euler[2]=-door["leaf"].get("yawRadians",0)
    local=door["localCenter"];leaf={**door["leaf"],"id":door["id"],"center":local,"yawRadians":0,"materialRole":"door-surface"};box(leaf);pivot=bpy.context.object;offset=pivot.location.copy()
    for vertex in pivot.data.vertices: vertex.co+=offset
    pivot.location=(0,0,0);pivot.parent=orientation;pivot["limina_opening_id"]=door["openingId"]
    for detail in door.get("planks",[])+door.get("ironwork",[]):
        box(detail);part=bpy.context.object;part.parent=pivot
    pivot.rotation_euler[2]=door["closedYaw"];pivot.keyframe_insert(data_path="rotation_euler",index=2,frame=1);pivot.rotation_euler[2]=door["openYaw"];pivot.keyframe_insert(data_path="rotation_euler",index=2,frame=25);pivot.animation_data.action.name=door["id"]+"/open";pivot.rotation_euler[2]=door["closedYaw"]
for light in payload.get("practicalLights",[]):
    data=bpy.data.lights.new(light["id"]+" data",type="POINT");data.color=light["color"];data.energy=light["intensityCandela"]/54.35;data.shadow_soft_size=.55;data.use_custom_distance=True;data.cutoff_distance=light["range"]
    node=bpy.data.objects.new(light["id"],data);bpy.context.collection.objects.link(node);position=light["position"];node.location=(position[0],-position[2],position[1]);node["limina.id"]=light["id"];node["limina.role"]="practical-light";node["limina.editPolicy"]="bounded-validate"
if contract:
    root=bpy.data.objects.new(contract["rootNodeId"],None);bpy.context.collection.objects.link(root);root["limina.id"]=contract["rootNodeId"];root["limina.role"]="root";root["limina.editPolicy"]="protected-generated"
    for semantic_id in contract["roomIds"]+contract["portalIds"]:
        node=bpy.data.objects.new(semantic_id,None);bpy.context.collection.objects.link(node);node.parent=root;node["limina.id"]=semantic_id;node["limina.role"]="room" if semantic_id in contract["roomIds"] else "portal";node["limina.editPolicy"]="protected-generated"
    for collider in contract["colliders"]:
        node=bpy.data.objects.new(collider["id"],None);bpy.context.collection.objects.link(node);node.parent=root;node["limina.id"]=collider["id"];node["limina.role"]="collider";node["limina.editPolicy"]="protected-generated";node["limina.colliderCenter"]=collider["center"];node["limina.colliderHalfExtents"]=collider["halfExtents"]
        if "rotation" in collider: node["limina.colliderRotation"]=collider["rotation"]
    if contract["schema"]=="limina.functional-building/v2":
        for role,records in (("vertical-link",contract["verticalLinks"]),("spawn-anchor",contract["spawnAnchors"]),("visibility-cell",contract["visibilityCells"])):
            for record in records:
                node=bpy.data.objects.new(record["id"],None);bpy.context.collection.objects.link(node);node.parent=root;node["limina.id"]=record["id"];node["limina.role"]=role;node["limina.editPolicy"]="protected-generated"
    bpy.context.view_layer.update()
    for candidate in list(bpy.context.scene.objects):
        if candidate is root or candidate.parent is not None or candidate.name in contract["roomIds"] or candidate.name in contract["portalIds"]: continue
        world=candidate.matrix_world.copy();candidate.parent=root;candidate.matrix_world=world
WORLD_UV={"V4 fieldstone":2.35,"V4 lime mortar":2.80,"V4 warm lime plaster":3.20,"V4 interior lime":3.20,"V4 blue slate":2.20,"V4 chimney brick":1.85}
TIMBER_UV={"V4 structural oak":2.40,"V4 exterior frame oak":2.40,"V4 door oak":2.40,"V4 worn oak":2.40,"V4 furniture oak":1.60}
def craft_edges(obj):
    semantic_id=obj.get("limina.id",obj.name)
    if obj.type!="MESH" or not (semantic_id.startswith("furnishing/") or semantic_id.startswith("interior-structure/") or semantic_id.startswith("perceptual-timber-frame/") or semantic_id.startswith("domestic-prop/")): return
    dimensions=[value for value in obj.dimensions if value>1e-5]
    if not dimensions: return
    width=min(.022,max(.006,min(dimensions)*.12));bpy.context.view_layer.objects.active=obj;obj.select_set(True)
    modifier=obj.modifiers.new("authored edge easing","BEVEL");modifier.width=width;modifier.segments=2;modifier.limit_method="ANGLE"
    bpy.ops.object.modifier_apply(modifier=modifier.name);obj.select_set(False)
for candidate in list(bpy.context.scene.objects): craft_edges(candidate)
def author_uv0(obj):
    if obj.type!="MESH" or not obj.data.materials: return
    material=obj.data.materials[0];name=material.name
    if name not in WORLD_UV and name not in TIMBER_UV: return
    uv=obj.data.uv_layers.get("UVMap") or obj.data.uv_layers.new(name="UVMap")
    if name=="V4 blue slate":
        if "limina_roof_anchor_engine" not in obj: raise RuntimeError(f"roof primitive {obj.name} lacks compiler-owned UV frame")
        engine_anchor=obj["limina_roof_anchor_engine"];engine_ridge=obj["limina_roof_ridge_world"];engine_slope=obj["limina_roof_slope_world"]
        anchor=Vector((engine_anchor[0],-engine_anchor[2],engine_anchor[1]));ridge=Vector((engine_ridge[0],-engine_ridge[2],engine_ridge[1])).normalized();slope=Vector((engine_slope[0],-engine_slope[2],engine_slope[1])).normalized();scale=float(obj["limina_roof_metres_per_repeat"])
        for polygon in obj.data.polygons:
            for loop_index in polygon.loop_indices:
                point=obj.matrix_world @ obj.data.vertices[obj.data.loops[loop_index].vertex_index].co;relative=point-anchor;uv.data[loop_index].uv=(relative.dot(ridge)/scale,relative.dot(slope)/scale)
        material["limina_surface_mapping"]="roof-plane-ridge-slope";material["limina_metres_per_repeat"]=scale
    elif name in WORLD_UV:
        scale=WORLD_UV[name];normal_matrix=obj.matrix_world.to_3x3().inverted().transposed()
        for polygon in obj.data.polygons:
            normal=normal_matrix @ polygon.normal;dominant=max(range(3),key=lambda axis:abs(normal[axis]))
            for loop_index in polygon.loop_indices:
                point=obj.matrix_world @ obj.data.vertices[obj.data.loops[loop_index].vertex_index].co
                coordinates=(-point.y,point.z) if dominant==0 else ((point.x,point.z) if dominant==1 else (point.x,-point.y));uv.data[loop_index].uv=(coordinates[0]/scale,coordinates[1]/scale)
        material["limina_surface_mapping"]="building-space-dominant-axis";material["limina_metres_per_repeat"]=scale
    else:
        scale=TIMBER_UV[name];bounds=[max(vertex.co[axis] for vertex in obj.data.vertices)-min(vertex.co[axis] for vertex in obj.data.vertices) for axis in range(3)];grain=max(range(3),key=lambda axis:bounds[axis]);cross=max((axis for axis in range(3) if axis!=grain),key=lambda axis:bounds[axis])
        for polygon in obj.data.polygons:
            face_axis=max(range(3),key=lambda axis:abs(polygon.normal[axis]))
            if face_axis==grain:
                u_axis,v_axis=(axis for axis in range(3) if axis!=grain)
            else:
                u_axis=next(axis for axis in range(3) if axis!=grain and axis!=face_axis);v_axis=grain
            for loop_index in polygon.loop_indices:
                point=obj.data.vertices[obj.data.loops[loop_index].vertex_index].co;uv.data[loop_index].uv=(point[u_axis]/scale,point[v_axis]/scale)
        material["limina_surface_mapping"]="member-local-face-aware";material["limina_metres_per_repeat"]=scale
for candidate in bpy.context.scene.objects: author_uv0(candidate)
AUTHORING_COLLECTIONS=("00_READ_ME","10_GENERATED_STRUCTURE","20_ARTIST_SURFACES","30_INTERIOR_DRESSING","40_ARTICULATION","COLLISION","SOCKETS","VFX_ANCHORS","90_EXPORT")
collections={}
for name in AUTHORING_COLLECTIONS:
    collection=bpy.data.collections.get(name) or bpy.data.collections.new(name)
    if collection.name not in bpy.context.scene.collection.children: bpy.context.scene.collection.children.link(collection)
    collections[name]=collection
for obj in list(bpy.context.scene.objects):
    role=obj.get("limina.role","");name=obj.name
    target="COLLISION" if role=="collider" else ("40_ARTICULATION" if name.startswith("door/") else ("30_INTERIOR_DRESSING" if name.startswith(("furnishing/","domestic-prop/","fireplace/")) else ("90_EXPORT" if role in ("root","room","portal") else "10_GENERATED_STRUCTURE")))
    if obj.name not in collections[target].objects: collections[target].objects.link(obj)
bpy.context.scene["limina_architecture_spec_hash"]=payload["specHash"];bpy.context.scene["limina_architecture_ir_hash"]=payload["irHash"]
bpy.context.scene["limina.handoffSchema"]="limina.blender-authoring-handoff/v1";bpy.context.scene["limina.units"]="meter";bpy.context.scene["limina.upAxis"]="Y";bpy.context.scene["limina.genericGltfExportAllowed"]=False
for material in bpy.data.materials:
    material["limina.role"]=next((role for role,value in MATERIALS.items() if value is material),"unassigned");material["limina.editPolicy"]="bounded-validate"
bpy.ops.wm.save_as_mainfile(filepath=BLEND_OUT,compress=True)
bpy.ops.export_scene.gltf(filepath=OUT,export_format="GLB",export_yup=True,export_extras=True,export_apply=False,export_animations=True,export_lights=True)
if contract:
    def pad4(data,byte): return data+bytes([byte])*((4-len(data)%4)%4)
    raw=open(OUT,"rb").read();magic,version,total=struct.unpack_from("<III",raw,0);offset=12;chunks=[]
    while offset<len(raw):
        length,kind=struct.unpack_from("<II",raw,offset);chunks.append((kind,raw[offset+8:offset+8+length]));offset+=8+length
    document=json.loads(next(data for kind,data in chunks if kind==0x4E4F534A).decode().rstrip(" \0"))
    asset_extras=document["asset"].setdefault("extras",{})
    embedded_contract={
        key:value
        for key,value in contract.items()
        if contract["schema"]!="limina.functional-building/v2" or key not in {"colliders","doors"}
    }
    asset_extras["liminaFunctionalBuilding"]=embedded_contract
    asset_extras["liminaMaterialSources"]={
        "schema":"limina.material-sources/v1",
        "packs":[
            {"id":pack,"manifestSha256":digest}
            for pack,digest in sorted(set(MATERIAL_MANIFESTS))
        ],
    }
    visual=payload.get("visualContract")
    if visual: asset_extras["liminaFunctionalBuildingVisual"]=visual
    by_name={};by_semantic={};primitive_by_id={record["id"]:record for record in payload["primitives"]}
    for node in document.get("nodes",[]):
        name=node.get("name")
        if name in by_name: raise RuntimeError("duplicate exported node name "+str(name))
        by_name[name]=node
        extras=node.get("extras",{});architecture_id=extras.get("limina_architecture_id");semantic_id=extras.get("limina.id") or architecture_id
        if semantic_id:
            if semantic_id in by_semantic: raise RuntimeError("duplicate exported semantic id "+str(semantic_id))
            by_semantic[semantic_id]=node
        if architecture_id:
            metadata=node.setdefault("extras",{}).setdefault("limina",{"id":architecture_id,"role":"architecture-primitive","lodLevels":json.loads(node.get("extras",{}).get("limina_lod_levels","[]"))})
            source=primitive_by_id.get(architecture_id)
            if contract["schema"]=="limina.functional-building/v2" and source and source["kind"]=="box": metadata["box"]={"center":source["center"],"halfExtents":source["halfExtents"],"yawRadians":source.get("yawRadians",0)}
    def semantic(node_id,role,extra=None):
        # Blender truncates long object names. Stable semantic extras, not display
        # names, are the authority for compiler-generated ids.
        node=by_semantic.get(node_id)
        if node is None: node=by_name.get(node_id)
        if node is None:
            node=next((candidate for candidate in document.get("nodes",[]) if candidate.get("extras",{}).get("limina.id")==node_id or candidate.get("extras",{}).get("limina_architecture_id")==node_id),None)
        if node is None: raise RuntimeError("missing semantic node "+node_id)
        node.setdefault("extras",{})["limina"]={"id":node_id,"role":role,**(extra or {})}
    semantic(contract["rootNodeId"],"root")
    for room in contract["roomIds"]: semantic(room,"room")
    for portal in contract["portalIds"]: semantic(portal,"portal")
    if contract["schema"]=="limina.functional-building/v2":
        for role,records in (("vertical-link",contract["verticalLinks"]),("spawn-anchor",contract["spawnAnchors"]),("visibility-cell",contract["visibilityCells"])):
            for record in records: semantic(record["id"],role)
    for collider in contract["colliders"]: semantic(collider["id"],"collider",{"shape":"box","center":collider["center"],"halfExtents":collider["halfExtents"],**({"rotation":collider["rotation"]} if "rotation" in collider else {})})
    for door in contract["doors"]: semantic(door["id"],"door",{"roomId":door["roomId"],"portalId":door["portalId"],"hinge":door["hinge"],"center":door["center"],"halfExtents":door["halfExtents"],"closedYaw":door["closedYaw"],"openYaw":door["openYaw"]})
    if visual:
        referenced=[]
        for opening in visual["openings"]:
            referenced.extend(opening["revealNodeIds"])
            for key in ("glazingNodeId","leafNodeId"):
                if opening.get(key): referenced.append(opening[key])
            for key in ("frameNodeIds","mullionNodeIds","cameNodeIds","plankNodeIds","ironworkNodeIds"): referenced.extend(opening.get(key,[]))
        interior=visual["interior"];referenced.extend(interior["walkableNodeIds"]+interior["ceilingNodeIds"]+interior["shellNodeIds"]+interior["furnishingNodeIds"]);hearth=interior.get("hearth")
        if hearth: referenced.extend(hearth["surroundNodeIds"]+hearth["fuelNodeIds"]+[hearth["emberNodeId"],hearth["lightNodeId"]]+hearth["flameNodeIds"])
        referenced.append(visual["lod"]["lod0RootNodeId"])
        for node_id in dict.fromkeys(referenced):
            node=by_semantic.get(node_id)
            if node is None: node=by_name.get(node_id)
            if node is None: raise RuntimeError("missing visual semantic node "+node_id)
            node.setdefault("extras",{}).setdefault("limina",{"id":node_id,"role":"visual-building-part"})
    encoded=pad4(json.dumps(document,separators=(",",":")).encode(),0x20);rebuilt=[(kind,encoded if kind==0x4E4F534A else data) for kind,data in chunks];body=b"".join(struct.pack("<II",len(data),kind)+data for kind,data in rebuilt);open(OUT,"wb").write(struct.pack("<III",magic,version,12+len(body))+body)
print(json.dumps({"schema":"limina.blender-architecture-output/v1","specHash":payload["specHash"],"irHash":payload["irHash"],"objects":len(bpy.context.scene.objects),"output":OUT,"blendOutput":BLEND_OUT}))
