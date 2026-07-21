"""Fresh-process, CPU-only validation for a Limina editable architecture .blend."""
import bpy, hashlib, json, sys

args=sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else []
def arg(flag):
    if flag not in args or args.index(flag)+1>=len(args): raise RuntimeError(f"missing {flag}")
    return args[args.index(flag)+1]

expected_spec,expected_ir=arg("--spec-hash"),arg("--ir-hash")
scene=bpy.context.scene
if scene.get("limina.handoffSchema")!="limina.blender-authoring-handoff/v1": raise RuntimeError("missing Limina authoring handoff schema")
if scene.get("limina_architecture_spec_hash")!=expected_spec or scene.get("limina_architecture_ir_hash")!=expected_ir: raise RuntimeError("source blend recipe identity drifted")
required={"00_READ_ME","10_GENERATED_STRUCTURE","20_ARTIST_SURFACES","30_INTERIOR_DRESSING","40_ARTICULATION","COLLISION","SOCKETS","VFX_ANCHORS","90_EXPORT"}
missing=sorted(required-set(bpy.data.collections.keys()))
if missing: raise RuntimeError("source blend missing authoring collections: "+",".join(missing))
semantic={}
for obj in scene.objects:
    semantic_id=obj.get("limina.id")
    if semantic_id is None: continue
    if not isinstance(semantic_id,str) or not semantic_id: raise RuntimeError("source blend has invalid semantic id")
    if semantic_id in semantic: raise RuntimeError(f"source blend duplicate semantic id {semantic_id}")
    if not obj.get("limina.role") or not obj.get("limina.editPolicy"): raise RuntimeError(f"source blend incomplete semantic metadata {semantic_id}")
    semantic[semantic_id]=obj.get("limina.role")
if not semantic: raise RuntimeError("source blend has no semantic inventory")
payload=json.dumps(sorted(semantic),separators=(",",":")).encode()
print("LIMINA_BLEND_VALIDATION="+json.dumps({"schema":"limina.blender-source-validation/v1","objects":len(scene.objects),"semanticCount":len(semantic),"semanticInventorySha256":"sha256:"+hashlib.sha256(payload).hexdigest(),"collections":sorted(required)},separators=(",",":")))
