"""Author a typed Limina furniture contract into editable Blender source and GLB.

CPU-only authoring utility. Contract coordinates are right-handed engine X/Y-up/Z;
Blender coordinates are X/-Z/Y. For profile-extrusion, ``axis`` is the horizontal
axis of the 2-D profile (the other profile axis is Y); extrusion uses the remaining
horizontal axis. This explicit interpretation is recorded in scene metadata.
"""
import bpy, bmesh, hashlib, json, math, os, struct, sys
from mathutils import Matrix, Vector
from mathutils.geometry import tessellate_polygon

ARGS=sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else []
def raw_arg(flag):
    if flag not in ARGS or ARGS.index(flag)+1>=len(ARGS): raise RuntimeError(f"missing {flag}")
    return ARGS[ARGS.index(flag)+1]
def path_arg(flag): return os.path.abspath(raw_arg(flag))
INPUT,OUT,BLEND_OUT=path_arg("--input"),path_arg("--out"),path_arg("--blend-out")
with open(INPUT,"r",encoding="utf8") as handle: contract=json.load(handle)
if contract.get("schema")!="limina.furniture-design-contract/v1": raise RuntimeError("unsupported furniture contract")
CONTRACT_HASH=raw_arg("--contract-hash");VISUAL_HASH=contract["visualDesign"]["hash"]
REPO=os.path.abspath(os.path.join(os.path.dirname(__file__),"..",".."));MATERIAL_ROOT=os.path.join(REPO,"assets","materials")
B=Matrix(((1,0,0),(0,0,-1),(0,1,0)));BI=B.inverted()
def e2b(v): return Vector((v[0],-v[2],v[1]))
def digest(path):
    with open(path,"rb") as handle:return "sha256:"+hashlib.sha256(handle.read()).hexdigest()
def clean():
    bpy.ops.object.select_all(action="SELECT");bpy.ops.object.delete(use_global=False)
    for collection in list(bpy.data.collections): bpy.data.collections.remove(collection)
clean()
def collection(name):
    value=bpy.data.collections.new(name);bpy.context.scene.collection.children.link(value);return value
README=collection("00_READ_ME");GEOMETRY=collection("10_FURNITURE_GEOMETRY");SURFACES=collection("20_ARTIST_SURFACES");SOCKETS=collection("SOCKETS");COLLISION=collection("COLLISION");EXPORT=collection("90_EXPORT")
def link_only(obj,target):
    for owner in list(obj.users_collection): owner.objects.unlink(obj)
    target.objects.link(obj)
def material(role,tint):
    pack="cottage-structural-oak";directory=os.path.join(MATERIAL_ROOT,pack);manifest_path=os.path.join(directory,"material-pack.json")
    with open(manifest_path,"r",encoding="utf8") as handle: manifest=json.load(handle)
    mat=bpy.data.materials.new("Settle "+role);mat.use_nodes=True;mat.diffuse_color=(*tint,1)
    nodes=mat.node_tree.nodes;shader=nodes.get("Principled BSDF");shader.inputs["Base Color"].default_value=(*tint,1);shader.inputs["Roughness"].default_value=.72
    for slot in ("albedo","roughness","normal"):
        record=manifest["maps"][slot];path=os.path.join(REPO,"assets",record["assetId"].removeprefix("assets/"))
        if digest(path)!=record["sha256"]: raise RuntimeError(f"material hash drift: {slot}")
        image=bpy.data.images.load(path,check_existing=True);image.pack();tex=nodes.new("ShaderNodeTexImage");tex.image=image;tex.label=f"Poly Haven {slot}"
        if slot=="albedo": mat.node_tree.links.new(tex.outputs["Color"],shader.inputs["Base Color"])
        elif slot=="roughness": tex.image.colorspace_settings.name="Non-Color";mat.node_tree.links.new(tex.outputs["Color"],shader.inputs["Roughness"])
        else:
            tex.image.colorspace_settings.name="Non-Color";normal=nodes.new("ShaderNodeNormalMap");normal.inputs["Strength"].default_value=.65;mat.node_tree.links.new(tex.outputs["Color"],normal.inputs["Color"]);mat.node_tree.links.new(normal.outputs["Normal"],shader.inputs["Normal"])
    mat["limina.role"]=role;mat["limina.sourcePack"]=pack;mat["limina.sourceManifestSha256"]=digest(manifest_path);mat["limina.license"]="CC0-1.0";return mat
MATERIALS={"oak-frame":material("oak-frame",(.29,.13,.055)),"oak-panel":material("oak-panel",(.34,.16,.065)),"oak-endgrain":material("oak-endgrain",(.22,.09,.035))}
def mesh_object(name,verts,faces):
    mesh=bpy.data.meshes.new(name+" mesh");mesh.from_pydata([e2b(v) for v in verts],[],faces);mesh.validate(verbose=True);bm=bmesh.new();bm.from_mesh(mesh);bmesh.ops.recalc_face_normals(bm,faces=bm.faces);bm.to_mesh(mesh);bm.free();mesh.update();obj=bpy.data.objects.new(name,mesh);GEOMETRY.objects.link(obj);return obj
def cube_data(size,offset=(0,0,0)):
    x,y,z=(v/2 for v in size);ox,oy,oz=offset
    v=[(ox+a,oy+b,oz+c) for a,b,c in [(-x,-y,-z),(x,-y,-z),(x,y,-z),(-x,y,-z),(-x,-y,z),(x,-y,z),(x,y,z),(-x,y,z)]]
    return v,[(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(0,4,7,3)]
def bevel(obj,width,segments=3):
    mod=obj.modifiers.new("Hand-eased edges","BEVEL");mod.width=width;mod.segments=segments;mod.limit_method="ANGLE"
def uv_project(obj):
    bpy.ops.object.select_all(action="DESELECT");obj.select_set(True);bpy.context.view_layer.objects.active=obj
    bpy.ops.object.mode_set(mode="EDIT");bpy.ops.mesh.select_all(action="SELECT");bpy.ops.uv.smart_project(angle_limit=math.radians(66),island_margin=.02);bpy.ops.object.mode_set(mode="OBJECT")
def shaped(g,name):
    if g["edgeProfile"]!="eased": raise RuntimeError(f"unsupported shaped-board profile: {g['edgeProfile']}")
    v,f=cube_data(g["size"]);o=mesh_object(name,v,f);bevel(o,min(g["edgeRadiusM"],min(g["size"])*.22));return o
def tapered(g,name):
    axis=g["axis"];length=g["lengthM"];b=g["bottomSection"];t=g["topSection"]
    if g["chamferM"]>=min(*b,*t)/2: raise RuntimeError("member chamfer exceeds section")
    if axis!="y": raise RuntimeError("v1 settle only permits Y-axis tapered members")
    verts=[(-b[0]/2,-length/2,-b[1]/2),(b[0]/2,-length/2,-b[1]/2),(b[0]/2,-length/2,b[1]/2),(-b[0]/2,-length/2,b[1]/2),(-t[0]/2,length/2,-t[1]/2),(t[0]/2,length/2,-t[1]/2),(t[0]/2,length/2,t[1]/2),(-t[0]/2,length/2,t[1]/2)]
    o=mesh_object(name,verts,[(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(0,4,7,3)]);bevel(o,g["chamferM"],2);return o
def profile(g,name):
    horizontal=g["axis"];extrusion="x" if horizontal=="z" else "z";depth=g["depthM"]
    poly=[Vector((p[0],p[1])) for p in g["profile"]];tris=tessellate_polygon([poly]);verts=[]
    def point(p,d): return (d,p.y,p.x) if horizontal=="z" else (p.x,p.y,d)
    for d in (-depth/2,depth/2): verts.extend(point(p,d) for p in poly)
    n=len(poly);faces=[]
    index={tuple(p):i for i,p in enumerate(poly)}
    for tri in tris:
        ids=[p if isinstance(p,int) else index[tuple(p)] for p in tri];faces.append(tuple(reversed(ids)));faces.append(tuple(i+n for i in ids))
    for i in range(n):j=(i+1)%n;faces.append((i,j,j+n,i+n))
    o=mesh_object(name,verts,faces);bevel(o,g["bevelM"],3);o["limina.profileHorizontalAxis"]=horizontal;o["limina.extrusionAxis"]=extrusion;return o
def panel(g,name):
    # One semantic object containing a structural slab and a proud, inset field.
    base_v,base_f=cube_data(g["size"]);w,h,d=g["size"];field_size=(w-2*g["fieldMarginM"],h-2*g["fieldMarginM"],g["fieldDepthM"])
    field_v,field_f=cube_data(field_size,(0,0,d/2+g["fieldDepthM"]*.35));offset=len(base_v)
    o=mesh_object(name,base_v+field_v,base_f+[tuple(i+offset for i in face) for face in field_f]);bevel(o,g["edgeRadiusM"],3);o["limina.fieldedPanel"]=True;return o
def peg(g,name):
    axis=g["axis"]
    if axis not in {"x","y","z"}: raise RuntimeError(f"unsupported engine peg axis: {axis}")
    bpy.ops.mesh.primitive_cylinder_add(vertices=16,radius=g["diameterM"]/2,depth=g["lengthM"],location=(0,0,0));o=bpy.context.object;o.name=name;link_only(o,GEOMETRY)
    # Blender cylinders are local Z. Engine X/Y/Z map to Blender X/Z/-Y.
    if axis=="x": o.rotation_euler[1]=math.pi/2
    elif axis=="z": o.rotation_euler[0]=math.pi/2
    bpy.ops.object.transform_apply(location=False,rotation=True,scale=False);o["limina.engineAxis"]=axis;bevel(o,g["diameterM"]*.08,2);return o
BUILDERS={"shaped-board":shaped,"tapered-member":tapered,"profile-extrusion":profile,"panel":panel,"peg":peg}
root=bpy.data.objects.new(contract["id"],None);EXPORT.objects.link(root);root["limina.id"]=contract["id"];root["limina.role"]=contract["role"];root["limina.editPolicy"]="bounded-validate"
def engine_rotation(deg):
    rx,ry,rz=(math.radians(v) for v in deg);return Matrix.Rotation(rz,3,"Z")@Matrix.Rotation(ry,3,"Y")@Matrix.Rotation(rx,3,"X")
for part in contract["parts"]:
    obj=BUILDERS[part["kind"]](part["geometry"],part["id"]);obj.location=e2b(part["center"]);obj.rotation_mode="QUATERNION";obj.rotation_quaternion=(B@engine_rotation(part["rotationDeg"])@BI).to_quaternion();obj.parent=root;obj.data.materials.append(MATERIALS[part["materialRole"]])
    uv_project(obj)
    obj["limina.id"]=part["id"];obj["limina.role"]="furniture-part";obj["limina.kind"]=part["kind"];obj["limina.materialRole"]=part["materialRole"];obj["limina.editPolicy"]="bounded-validate";obj["limina.contractCenter"]=part["center"];obj["limina.contractRotationDeg"]=part["rotationDeg"];obj["limina.geometryJson"]=json.dumps(part["geometry"],sort_keys=True,separators=(",",":"))
for socket in contract["sockets"]:
    obj=bpy.data.objects.new(socket["id"],None);SOCKETS.objects.link(obj);obj.location=e2b(socket["position"]);obj.parent=root;obj.empty_display_type="ARROWS";obj.empty_display_size=.12;obj["limina.id"]=socket["id"];obj["limina.role"]="socket";obj["limina.kind"]=socket["kind"];obj["limina.editPolicy"]="bounded-validate";obj["limina.position"]=socket["position"];obj["limina.facing"]=socket["facing"];obj["limina.supportedBy"]=socket["supportedBy"];obj["limina.clearanceRadiusM"]=socket["clearanceRadiusM"]
for collider in contract["colliders"]:
    obj=bpy.data.objects.new(collider["id"],None);COLLISION.objects.link(obj);obj.location=e2b(collider["center"]);obj.scale=(collider["halfExtents"][0],collider["halfExtents"][2],collider["halfExtents"][1]);obj.parent=root;obj.empty_display_type="CUBE";obj.empty_display_size=1;obj.hide_render=True;obj["limina.id"]=collider["id"];obj["limina.role"]="collider";obj["limina.editPolicy"]="protected-generated";obj["limina.center"]=collider["center"];obj["limina.halfExtents"]=collider["halfExtents"];obj["limina.covers"]=collider["covers"]
scene=bpy.context.scene;scene["limina.handoffSchema"]="limina.blender-furniture-handoff/v1";scene["limina.furnitureContractHash"]=CONTRACT_HASH;scene["limina.visualDesignHash"]=VISUAL_HASH;scene["limina.coordinateContract"]="engine[x,y-up,z]=>blender[x,-z,y]";scene["limina.profileExtrusionSemantics"]="axis=profile-horizontal; y=profile-vertical; remaining-horizontal=extrusion";scene["limina.jointsJson"]=json.dumps(contract["joints"],sort_keys=True,separators=(",",":"));scene["limina.genericGltfExportAllowed"]=False
for obj in bpy.context.scene.objects: obj.select_set(obj.get("limina.role") in {"furniture-part","socket","collider"} or obj is root)
bpy.context.view_layer.objects.active=root
os.makedirs(os.path.dirname(BLEND_OUT),exist_ok=True);bpy.ops.wm.save_as_mainfile(filepath=BLEND_OUT,compress=True)
bpy.ops.export_scene.gltf(filepath=OUT,export_format="GLB",export_yup=True,export_extras=True,export_apply=False,export_animations=False,export_lights=False,export_cameras=False,use_selection=True)
def patch_glb(path):
    raw=open(path,"rb").read();magic,version,total=struct.unpack_from("<4sII",raw,0);offset=12;chunks=[]
    while offset<total:
        length,kind=struct.unpack_from("<II",raw,offset);offset+=8;chunks.append((kind,raw[offset:offset+length]));offset+=length
    doc=json.loads(next(data for kind,data in chunks if kind==0x4E4F534A).decode().rstrip(" \0"));extras=doc["asset"].setdefault("extras",{});extras["liminaFurnitureContract"]=contract;extras["liminaFurnitureContractHash"]=CONTRACT_HASH;extras["liminaVisualDesignHash"]=VISUAL_HASH;extras["liminaMaterialSources"]={"schema":"limina.material-sources/v1","packs":[{"id":"cottage-structural-oak","manifestSha256":MATERIALS["oak-frame"]["limina.sourceManifestSha256"],"provider":"Poly Haven","licenseSpdx":"CC0-1.0"}]}
    encoded=json.dumps(doc,separators=(",",":"),ensure_ascii=False).encode();encoded+=b" "*((4-len(encoded)%4)%4);rebuilt=[(0x4E4F534A,encoded)]+[(k,d) for k,d in chunks if k!=0x4E4F534A];body=b"".join(struct.pack("<II",len(d),k)+d for k,d in rebuilt);open(path,"wb").write(struct.pack("<4sII",b"glTF",2,12+len(body))+body)
patch_glb(OUT)
depsgraph=bpy.context.evaluated_depsgraph_get();points=[]
for obj in bpy.context.scene.objects:
    if obj.get("limina.role")!="furniture-part":continue
    evaluated=obj.evaluated_get(depsgraph);points.extend(BI@(evaluated.matrix_world@Vector(corner)) for corner in evaluated.bound_box)
bounds={"min":[min(p[i] for p in points) for i in range(3)],"max":[max(p[i] for p in points) for i in range(3)]}
print("LIMINA_FURNITURE_OUTPUT="+json.dumps({"schema":"limina.blender-furniture-output/v1","contractHash":CONTRACT_HASH,"visualHash":VISUAL_HASH,"parts":len(contract["parts"]),"sockets":len(contract["sockets"]),"colliders":len(contract["colliders"]),"bounds":bounds,"output":OUT,"blendOutput":BLEND_OUT},separators=(",",":")))
