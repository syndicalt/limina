"""Append-only architecture adapter v2: emit exact box geometry beside semantic ids."""
import json, os, runpy, struct, sys

runpy.run_path(os.path.join(os.path.dirname(__file__), "architecture-adapter.py"), run_name="__main__")

args=sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else []
def arg(flag): return os.path.abspath(args[args.index(flag)+1])
input_path,out=arg("--input"),arg("--out")
with open(input_path,"r",encoding="utf8") as handle: payload=json.load(handle)
raw=open(out,"rb").read();magic,version,total=struct.unpack_from("<III",raw,0);offset=12;chunks=[]
while offset<len(raw):
    length,kind=struct.unpack_from("<II",raw,offset);chunks.append((kind,raw[offset+8:offset+8+length]));offset+=8+length
document=json.loads(next(data for kind,data in chunks if kind==0x4E4F534A).decode().rstrip(" \0"));by_name={node.get("name"):node for node in document.get("nodes",[])}
for primitive in payload["primitives"]:
    if primitive["kind"]!="box": continue
    node=by_name.get(primitive["id"])
    if node is None: raise RuntimeError("missing box primitive node "+primitive["id"])
    limina=node.setdefault("extras",{}).get("limina")
    if limina is None or limina.get("id")!=primitive["id"] or limina.get("role")!="architecture-primitive": raise RuntimeError("box primitive semantic drift "+primitive["id"])
    limina["box"]={"center":primitive["center"],"halfExtents":primitive["halfExtents"],"yawRadians":primitive.get("yawRadians",0)}
def pad4(data): return data+bytes([0x20])*((4-len(data)%4)%4)
encoded=pad4(json.dumps(document,separators=(",",":")).encode());rebuilt=[(kind,encoded if kind==0x4E4F534A else data) for kind,data in chunks];body=b"".join(struct.pack("<II",len(data),kind)+data for kind,data in rebuilt)
open(out,"wb").write(struct.pack("<III",magic,version,12+len(body))+body)
