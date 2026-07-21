"""Fresh-process validation of a contract-authored furniture .blend."""
import bpy, hashlib, json, math, os, struct, sys
ARGS=sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else []
def arg(flag):
    if flag not in ARGS or ARGS.index(flag)+1>=len(ARGS):raise RuntimeError(f"missing {flag}")
    return ARGS[ARGS.index(flag)+1]
with open(arg("--contract"),"r",encoding="utf8") as handle:contract=json.load(handle)
expected=arg("--contract-hash");scene=bpy.context.scene
if scene.get("limina.handoffSchema")!="limina.blender-furniture-handoff/v1":raise RuntimeError("wrong furniture handoff schema")
if scene.get("limina.furnitureContractHash")!=expected or scene.get("limina.visualDesignHash")!=contract["visualDesign"]["hash"]:raise RuntimeError("furniture recipe identity drifted")
required={"00_READ_ME","10_FURNITURE_GEOMETRY","20_ARTIST_SURFACES","SOCKETS","COLLISION","90_EXPORT"}
if missing:=sorted(required-set(bpy.data.collections.keys())):raise RuntimeError("missing collections: "+",".join(missing))
parts={p["id"]:p for p in contract["parts"]};sockets={s["id"]:s for s in contract["sockets"]};colliders={c["id"]:c for c in contract["colliders"]};seen={}
for obj in scene.objects:
    sid=obj.get("limina.id")
    if not sid:continue
    if sid in seen:raise RuntimeError(f"duplicate semantic id: {sid}")
    seen[sid]=obj
for sid,part in parts.items():
    obj=seen.get(sid)
    if obj is None or obj.type!="MESH" or obj.get("limina.role")!="furniture-part":raise RuntimeError(f"missing semantic mesh: {sid}")
    if len(obj.data.vertices)<8 or len(obj.data.polygons)<6:raise RuntimeError(f"empty/degenerate semantic mesh: {sid}")
    if obj.get("limina.kind")!=part["kind"] or obj.get("limina.materialRole")!=part["materialRole"]:raise RuntimeError(f"part metadata drift: {sid}")
    if not obj.data.materials or obj.data.materials[0].get("limina.sourcePack")!="cottage-structural-oak":raise RuntimeError(f"unpinned material: {sid}")
for sid,socket in sockets.items():
    obj=seen.get(sid)
    if obj is None or obj.get("limina.role")!="socket" or obj.name not in bpy.data.collections["SOCKETS"].objects:raise RuntimeError(f"missing socket: {sid}")
    facing=socket["facing"];length=math.sqrt(sum(v*v for v in facing))
    if not math.isfinite(length) or abs(length-1)>.001:raise RuntimeError(f"socket facing not normalized: {sid}")
if len([s for s in sockets.values() if s["kind"]=="occupancy"])!=contract["dimensions"]["occupancy"]:raise RuntimeError("occupancy mismatch")
for sid,collider in colliders.items():
    obj=seen.get(sid)
    if obj is None or obj.get("limina.role")!="collider" or obj.name not in bpy.data.collections["COLLISION"].objects:raise RuntimeError(f"missing collider: {sid}")
if len(colliders)<2:raise RuntimeError("whole-AABB collision is forbidden")
if set(seen)!=(set(parts)|set(sockets)|set(colliders)|{contract["id"]}):raise RuntimeError("semantic inventory contains unknown or missing ids")
if any(obj.type in {"CAMERA","LIGHT"} for obj in scene.objects):raise RuntimeError("furniture source contains camera/light")
payload=json.dumps(sorted(seen),separators=(",",":")).encode();print("LIMINA_FURNITURE_BLEND_VALIDATION="+json.dumps({"schema":"limina.blender-furniture-source-validation/v1","contractHash":expected,"parts":len(parts),"sockets":len(sockets),"colliders":len(colliders),"semanticInventorySha256":"sha256:"+hashlib.sha256(payload).hexdigest()},separators=(",",":")))
