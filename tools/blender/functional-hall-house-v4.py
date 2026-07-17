"""Clean-sheet Limina functional hall-house v4, stages A+B (author/export; no Blender render).

  blender --background --factory-startup --python tools/blender/functional-hall-house-v4.py -- \
    --out assets/buildings/functional-hall-house-v4.glb
"""
import bpy, hashlib, json, math, os, struct, sys
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[argv.index("--out") + 1] if "--out" in argv else "assets/buildings/functional-hall-house-v4.glb"
bpy.ops.object.select_all(action="SELECT"); bpy.ops.object.delete(use_global=False)
for c in (bpy.data.meshes, bpy.data.materials):
    for item in list(c): c.remove(item)

REPO=os.path.abspath(os.path.join(os.path.dirname(__file__),"..",".."))
MATERIAL_ROOT=os.path.join(REPO,"assets","materials")
MATERIAL_MANIFESTS=[]
def pbr_mat(name, pack, tint=(1,1,1,1), normal_strength=.62):
    directory=os.path.join(MATERIAL_ROOT,pack); manifest_path=os.path.join(directory,"material-pack.json")
    with open(manifest_path,"rb") as f: manifest_bytes=f.read()
    manifest=json.loads(manifest_bytes); MATERIAL_MANIFESTS.append((pack,hashlib.sha256(manifest_bytes).hexdigest()))
    m=bpy.data.materials.new(name); m.use_nodes=True; m.diffuse_color=tint
    b=m.node_tree.nodes["Principled BSDF"]; b.inputs["Base Color"].default_value=tint; b.inputs["Metallic"].default_value=0
    for slot,node_name,color_space in (("albedo","albedo","sRGB"),("roughness","roughness","Non-Color"),("normal","normal","Non-Color")):
        record=manifest["maps"][slot]; path=os.path.join(REPO,"assets",record["assetId"])
        with open(path,"rb") as f: payload=f.read()
        if "sha256:"+hashlib.sha256(payload).hexdigest()!=record["sha256"]: raise RuntimeError(f"material source hash drift: {pack}/{slot}")
        image=bpy.data.images.load(path,check_existing=False); image.name=f"{name} {slot}"; image.colorspace_settings.name=color_space; image.pack()
        tex=m.node_tree.nodes.new("ShaderNodeTexImage"); tex.name=f"{name} {node_name}"; tex.image=image
        if slot=="albedo": m.node_tree.links.new(tex.outputs["Color"],b.inputs["Base Color"])
        elif slot=="roughness": m.node_tree.links.new(tex.outputs["Color"],b.inputs["Roughness"])
        else:
            normal=m.node_tree.nodes.new("ShaderNodeNormalMap"); normal.inputs["Strength"].default_value=normal_strength
            m.node_tree.links.new(tex.outputs["Color"],normal.inputs["Color"]); m.node_tree.links.new(normal.outputs["Normal"],b.inputs["Normal"])
    m["limina_material_pack"]=pack; m["limina_material_manifest_sha256"]=MATERIAL_MANIFESTS[-1][1]
    return m
def simple_mat(name,rgb,rough=.82,metal=0,alpha=1):
    m=bpy.data.materials.new(name); m.use_nodes=True; m.diffuse_color=(*rgb,alpha)
    b=m.node_tree.nodes["Principled BSDF"]; b.inputs["Base Color"].default_value=(*rgb,alpha); b.inputs["Roughness"].default_value=rough; b.inputs["Metallic"].default_value=metal
    if alpha<1:
        b.inputs["Alpha"].default_value=alpha
        for attribute,value in (("surface_render_method","BLENDED"),("blend_method","BLEND")):
            if hasattr(m,attribute):
                try: setattr(m,attribute,value)
                except Exception: pass
        if hasattr(m,"use_transparency_overlap"): m.use_transparency_overlap=False
        if hasattr(m,"show_transparent_back"): m.show_transparent_back=True
    return m
def emissive_mat(name,rgb,strength,alpha=1):
    m=simple_mat(name,rgb,.48,0,alpha); b=m.node_tree.nodes["Principled BSDF"]
    emission=b.inputs.get("Emission Color") or b.inputs.get("Emission")
    if emission is not None: emission.default_value=(*rgb,1)
    emission_strength=b.inputs.get("Emission Strength")
    if emission_strength is not None: emission_strength.default_value=strength
    return m
STONE=pbr_mat("V4 fieldstone","cottage-fieldstone"); MORTAR=pbr_mat("V4 lime mortar","cottage-white-plaster")
PLASTER=pbr_mat("V4 warm lime plaster","cottage-white-plaster"); INNER=pbr_mat("V4 interior lime","cottage-white-plaster")
OAK=pbr_mat("V4 structural oak","cottage-structural-oak"); DOOR_OAK=pbr_mat("V4 door oak","cottage-structural-oak"); OAK_WORN=pbr_mat("V4 worn oak","cottage-worn-planks")
SLATE=pbr_mat("V4 blue slate","cottage-grey-roof"); GLASS=simple_mat("V4 leadlight glass",(.12,.20,.22),.22,0,.24)
IRON=simple_mat("V4 black iron",(.035,.032,.028),.46,.85); BRICK=pbr_mat("V4 chimney brick","cottage-medieval-brick")
SOOT=simple_mat("V4 hearth soot",(.012,.009,.007),.96,0); EMBER=emissive_mat("V4 hearth embers",(.95,.12,.015),3.2)
FLAME_OUTER=emissive_mat("V4 flame outer",(1.0,.20,.025),4.5,.72); FLAME_INNER=emissive_mat("V4 flame inner",(1.0,.72,.08),6.0,.78)

def box(name,c,d,m,parent=None,bev=.0):
    bpy.ops.mesh.primitive_cube_add(size=1,location=(c[0],-c[2],c[1])); o=bpy.context.object; o.name=name
    o.dimensions=(d[0],d[2],d[1]); bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    if bev:
        q=o.modifiers.new("crafted edge","BEVEL"); q.width=bev; q.segments=1
        bpy.context.view_layer.objects.active=o; bpy.ops.object.modifier_apply(modifier=q.name)
    o.data.materials.append(m)
    if parent: w=o.matrix_world.copy(); o.parent=parent; o.matrix_world=w
    return o

def cylinder(name,c,r,depth,m,parent=None,vertices=12,rotation=(0,0,0)):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices,radius=r,depth=depth,location=(c[0],-c[2],c[1]),rotation=rotation)
    o=bpy.context.object; o.name=name; o.data.materials.append(m)
    if parent: w=o.matrix_world.copy(); o.parent=parent; o.matrix_world=w
    return o

def cone(name,c,radius,depth,m,parent=None,vertices=16):
    bpy.ops.mesh.primitive_cone_add(vertices=vertices,radius1=radius,radius2=radius*.10,depth=depth,location=(c[0],-c[2],c[1]))
    o=bpy.context.object; o.name=name; o.data.materials.append(m)
    if parent: w=o.matrix_world.copy(); o.parent=parent; o.matrix_world=w
    return o

def diagonal_bar(name,center,length,angle,axis,material,parent,thickness=.032,depth=.045):
    """Slender rectangular lead/joinery bar in a facade plane."""
    if axis=="x":
        o=box(name,center,(length,thickness,depth),material,parent,.004); o.rotation_euler[1]=-angle
    else:
        o=box(name,center,(depth,thickness,length),material,parent,.004); o.rotation_euler[0]=angle
    return o

def beam_between(name,start,end,width,depth,material,parent,bev=.0):
    """Rectangular construction member between two Limina-space 3D points."""
    a=Vector((start[0],-start[2],start[1])); b=Vector((end[0],-end[2],end[1])); delta=b-a; length=delta.length
    bpy.ops.mesh.primitive_cube_add(size=1,location=(a+b)/2); o=bpy.context.object; o.name=name; o.dimensions=(length,width,depth)
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True); o.rotation_mode="QUATERNION"; o.rotation_quaternion=Vector((1,0,0)).rotation_difference(delta.normalized())
    if bev:
        q=o.modifiers.new("crafted edge","BEVEL"); q.width=bev; q.segments=1; bpy.context.view_layer.objects.active=o; bpy.ops.object.modifier_apply(modifier=q.name)
    o.data.materials.append(material)
    if parent: bpy.context.view_layer.update(); world=o.matrix_world.copy(); o.parent=parent; o.matrix_world=world
    return o

def triangle_prism(name, axis, fixed, base0, base1, y0, apex, thick, material, parent):
    # axis='x': span X at fixed Z; axis='z': span Z at fixed X.
    verts=[]
    for side in (-thick/2,thick/2):
        pts=((base0,y0),(base1,y0),((base0+base1)/2,apex))
        for u,y in pts:
            e=(u,y,fixed+side) if axis=='x' else (fixed+side,y,u)
            verts.append((e[0],-e[2],e[1]))
    faces=[(0,2,1),(3,4,5),(0,1,4,3),(1,2,5,4),(2,0,3,5)]
    me=bpy.data.meshes.new(name+" mesh"); me.from_pydata(verts,[],faces); me.update()
    o=bpy.data.objects.new(name,me); bpy.context.collection.objects.link(o); o.data.materials.append(material); o.parent=parent; return o

root=bpy.data.objects.new("building/root",None); bpy.context.collection.objects.link(root)

# 9.6 x 7.2m hall, 3.55m eaves. Layered floor and genuinely thick wall construction.
box("shell/subfloor",(0,-.80,0),(9.6,1.60,7.2),STONE,root)
box("shell/interior-floor",(0,.045,0),(8.86,.09,6.46),OAK_WORN,root)
box("shell/ceiling",(0,3.47,0),(8.9,.12,6.5),OAK,root)

# North and side leaves are decomposed around apertures; no decorative glass laid over solid walls.
for i,(a,b) in enumerate(((-4.8,-3.37),(-1.93,4.8))):
    box(f"shell/north-pier-{i}",((a+b)/2,1.78,3.42),(b-a,3.55,.36),PLASTER,root)
    box(f"shell/north-inner-pier-{i}",((a+b)/2,1.78,3.19),(b-a,3.25,.10),INNER,root)
for i,x in enumerate((-2.65,)):
    box(f"shell/north-sill-{i}",(x,.48,3.42),(1.44,.96,.36),PLASTER,root)
    box(f"shell/north-head-{i}",(x,3.06,3.42),(1.44,.98,.36),PLASTER,root)
    box(f"shell/north-inner-sill-{i}",(x,.48,3.19),(1.44,.96,.10),INNER,root)
    box(f"shell/north-inner-head-{i}",(x,3.06,3.19),(1.44,.98,.10),INNER,root)
for side,x in (("west",-4.62),("east",4.62)):
    wz=-.55 if side=="west" else .65
    for i,(a,b) in enumerate(((-3.42,wz-.72),(wz+.72,3.42))):
        box(f"shell/{side}-pier-{i}",(x,1.78,(a+b)/2),(.36,3.55,b-a),PLASTER,root)
        box(f"shell/{side}-inner-pier-{i}",(x+(.23 if x<0 else -.23),1.78,(a+b)/2),(.10,3.25,b-a),INNER,root)
    box(f"shell/{side}-sill",(x,.48,wz),(.36,.96,1.44),PLASTER,root)
    box(f"shell/{side}-head",(x,3.06,wz),(.36,.98,1.44),PLASTER,root)
    ix=x+(.23 if x<0 else -.23)
    box(f"shell/{side}-inner-sill",(ix,.48,wz),(.10,.96,1.44),INNER,root)
    box(f"shell/{side}-inner-head",(ix,3.06,wz),(.10,.98,1.44),INNER,root)

# South facade: clean 1.42 x 2.48 portal at x=-.7 and two true recessed window voids.
segments=[(-4.8,-3.62),(-2.18,-1.46),(0.02,1.10),(2.70,4.8)]
for i,(a,b) in enumerate(segments): box(f"shell/south-pier-{i}",((a+b)/2,1.78,-3.42),(b-a,3.55,.36),PLASTER,root)
for i,(a,b) in enumerate(segments): box(f"shell/south-inner-pier-{i}",((a+b)/2,1.78,-3.19),(b-a,3.25,.10),INNER,root)
# The western gap is a window. The 1.10..2.70 eastern gap remains full-height:
# it is the intentional interior connection into the projecting service bay.
for i,(a,b) in enumerate(((-3.62,-2.18),)):
    box(f"shell/south-window-sill-{i}",((a+b)/2,.48,-3.42),(b-a,.96,.36),PLASTER,root)
    box(f"shell/south-window-head-{i}",((a+b)/2,3.06,-3.42),(b-a,.98,.36),PLASTER,root)
    box(f"shell/south-inner-window-sill-{i}",((a+b)/2,.48,-3.19),(b-a,.96,.10),INNER,root)
    box(f"shell/south-inner-window-head-{i}",((a+b)/2,3.06,-3.19),(b-a,.98,.10),INNER,root)
box("shell/south-door-head",(-.72,3.02,-3.42),(1.44,1.06,.36),PLASTER,root)
box("shell/south-inner-door-head",(-.72,3.02,-3.19),(1.44,1.06,.10),INNER,root)

# Deep window assembly: reveal, sill, inset frame, mullions, glazing. The returned
# record is the sole authority for the stable IDs and aperture authored here.
WINDOW_OPENINGS=[]
def window_front(name,x,z,facade,facade_plane,axis="x",width=1.36,height=1.48,center_y=1.72):
    reveal_ids=[name+suffix for suffix in ("/reveal-left","/reveal-right","/reveal-top","/reveal-bottom")]
    glazing_id=name+"/glass"; mullion_ids=[name+"/mullion"]
    came_ys=(center_y-.25,center_y+.25)
    came_ids=[name+f"/came-{y}" for y in came_ys]
    rail_ys=(center_y-height/2,center_y+height/2)
    sill_y=center_y-height/2-.06
    if axis=="x":
        inward=-1 if z>0 else 1
        rz=z+inward*.17; exterior=z-inward*.04
        box(name+"/reveal-left",(x-width/2-.065,center_y,rz),(.13,height+.26,.36),MORTAR,root,.018)
        box(name+"/reveal-right",(x+width/2+.065,center_y,rz),(.13,height+.26,.36),MORTAR,root,.018)
        box(name+"/reveal-top",(x,center_y+height/2+.065,rz),(width,.13,.36),MORTAR,root,.018)
        box(name+"/reveal-bottom",(x,center_y-height/2-.065,rz),(width,.13,.36),MORTAR,root,.018)
        box(name+"/glass",(x,center_y,z+inward*.31),(width,height,.045),GLASS,root)
        box(name+"/sill",(x,sill_y,z-inward*.02),(width+.30,.14,.62),STONE,root,.035)
        jamb_ids=[name+f"/jamb-{dx}" for dx in (-width/2,width/2)]
        rail_ids=[name+f"/rail-{y}" for y in rail_ys]
        for dx,node_id in zip((-width/2,width/2),jamb_ids): box(node_id,(x+dx,center_y,exterior),(.13,height+.22,.30),OAK,root,.018)
        for y,node_id in zip(rail_ys,rail_ids): box(node_id,(x,y,exterior),(width+.13,.13,.30),OAK,root,.018)
        box(name+"/mullion",(x,center_y,z-inward*.07),(.085,height,.22),OAK,root,.012)
        for y in came_ys: box(name+f"/came-{y}",(x,y,z-inward*.09),(width,.045,.16),IRON,root,.006)
        diagonal_length=math.hypot(width/2,height); diagonal_angle=math.atan2(height,width/2)
        for half,dx in (("left",-width/4),("right",width/4)):
            for slope,sign in (("rise",1),("fall",-1)):
                node_id=f"{name}/came-diagonal-{half}-{slope}"; came_ids.append(node_id)
                diagonal_bar(node_id,(x+dx,center_y,z-inward*.095),diagonal_length,sign*diagonal_angle,"x",IRON,root,.015,.065)
        aperture={"center":[x,center_y,facade_plane],"halfExtents":[width/2,height/2,.18]}
    else:
        inward=-1 if x>0 else 1
        rx=x+inward*.17; exterior=x-inward*.04
        box(name+"/reveal-left",(rx,center_y,z-width/2-.065),(.36,height+.26,.13),MORTAR,root,.018)
        box(name+"/reveal-right",(rx,center_y,z+width/2+.065),(.36,height+.26,.13),MORTAR,root,.018)
        box(name+"/reveal-top",(rx,center_y+height/2+.065,z),(.36,.13,width),MORTAR,root,.018)
        box(name+"/reveal-bottom",(rx,center_y-height/2-.065,z),(.36,.13,width),MORTAR,root,.018)
        box(name+"/glass",(x+inward*.31,center_y,z),(.045,height,width),GLASS,root)
        box(name+"/sill",(x-inward*.02,sill_y,z),(.62,.14,width+.30),STONE,root,.035)
        jamb_ids=[name+f"/jamb-{dz}" for dz in (-width/2,width/2)]
        rail_ids=[name+f"/rail-{y}" for y in rail_ys]
        for dz,node_id in zip((-width/2,width/2),jamb_ids): box(node_id,(exterior,center_y,z+dz),(.30,height+.22,.13),OAK,root,.018)
        for y,node_id in zip(rail_ys,rail_ids): box(node_id,(exterior,y,z),(.30,.13,width+.13),OAK,root,.018)
        box(name+"/mullion",(x-inward*.07,center_y,z),(.22,height,.085),OAK,root,.012)
        for y in came_ys: box(name+f"/came-{y}",(x-inward*.09,y,z),(.16,.045,width),IRON,root,.006)
        diagonal_length=math.hypot(width/2,height); diagonal_angle=math.atan2(height,width/2)
        for half,dz in (("left",-width/4),("right",width/4)):
            for slope,sign in (("rise",1),("fall",-1)):
                node_id=f"{name}/came-diagonal-{half}-{slope}"; came_ids.append(node_id)
                diagonal_bar(node_id,(x-inward*.095,center_y,z+dz),diagonal_length,sign*diagonal_angle,"z",IRON,root,.015,.065)
        aperture={"center":[facade_plane,center_y,z],"halfExtents":[.18,height/2,width/2]}
    record={"id":name,"kind":"window","facade":facade,"aperture":aperture,"glazingNodeId":glazing_id,
        "revealNodeIds":reveal_ids,"frameNodeIds":jamb_ids+rail_ids,"mullionNodeIds":mullion_ids,"cameNodeIds":came_ids}
    WINDOW_OPENINGS.append(record)
    return record
# The projecting cross-bay hides the former south-east wall assembly; do not
# certify a window that has no exposed exterior aperture.
window_front("window/south-west",-2.90,-3.43,"south",-3.42)
window_front("window/north-west",-2.65,3.43,"north",3.42)
window_front("window/west",-4.63,-.55,"west",-4.62,"z"); window_front("window/east",4.63,.65,"east",4.62,"z")

# Continuous irregular stone foundation, two staggered courses.
for course in range(2):
    y=.22+course*.30
    for side,z in (("south",-3.66),("north",3.66)):
        # The south course returns at both portal jambs; it never crosses the
        # opening or buries the authored threshold beneath decorative blocks.
        # The projecting service bay owns the south-east support line.  Do not
        # continue the main facade course through its interior connection.
        ranges=((-4.78,-1.58),(.14,1.02),(4.22,4.70)) if side=="south" else ((-4.78,4.70),)
        i=0
        for start,end in ranges:
            cursor=start-(.16 if course and side=="north" else 0)
            while cursor<end:
                w=min(.48+.09*((i*7+course*3)%4),end-cursor); x=cursor+w/2; cursor+=w+.035
                if w>.12: box(f"foundation/{side}-{course}-{i}",(x,y+.018*(i%2),z),(w,.32+.035*(i%3),.48),STONE if i%4 else MORTAR,root,.035)
                i+=1
    for side,x in (("west",-4.84),("east",4.84)):
        for i in range(11):
            z=-3.28+i*.64+(.16 if course else 0)
            box(f"foundation/{side}-{course}-{i}",(x,y+.016*(i%2),z),(.48,.31+.04*(i%3),.52+.06*((i*5)%3)),STONE if i%4 else MORTAR,root,.035)

# Timber sill, posts, and rails follow facade-specific load paths. Framing may
# border an opening, but must never pass through its glass or portal corridor.
for side,z,posts,rail_segments in (
    ("south",-3.65,(-4.55,-3.65,-2.15,-1.45,.05,1.08,2.72,4.55),segments),
    ("north",3.65,(-4.55,-3.37,-1.93,0,2.25,4.55),((-4.8,-3.37),(-1.93,4.8))),
):
    box(f"frame/sill-{side}",(0,.68,z),(9.7,.22,.24),OAK,root,.025)
    box(f"frame/eave-{side}",(0,3.46,z),(9.75,.24,.24),OAK,root,.025)
    for x in posts: box(f"frame/post-{side}-{x}",(x,2.05,z),(.20,2.75,.22),OAK,root,.025)
    for i,(a,b) in enumerate(rail_segments):
        box(f"frame/midrail-{side}-{i}",((a+b)/2,2.18,z),(b-a,.18,.23),OAK,root,.022)
for x in (-4.84,4.84):
    box(f"frame/side-sill-{x}",(x,.68,0),(.24,.22,7.25),OAK,root,.025); box(f"frame/side-eave-{x}",(x,3.46,0),(.24,.24,7.25),OAK,root,.025)

# Main layered 48-degree roof: sheathing, visible fascia/eaves, slate skin and segmented ridge.
pitch=math.radians(48); span=4.62; rise=span*math.sin(pitch)
def south_roof_panel(name,x0,x1,local_z0,local_z1,base_y,thick,material):
    # Split in roof-local coordinates so the bounded dormer penetration does
    # not leave opaque sheathing/slate immediately behind its glazing.
    local_z=(local_z0+local_z1)/2
    o=box(name,((x0+x1)/2,base_y+local_z*math.sin(pitch),-1.75+local_z*math.cos(pitch)),
        (x1-x0,thick,local_z1-local_z0),material,root,.018)
    o.rotation_euler[0]=-pitch
    if material==SLATE:
        o["limina_roof_ridge_axis"]=0; o["limina_roof_slope_axis"]=1; o["limina_roof_slope_sign"]=-1; o["limina_roof_anchor"]=(0,0,6.87)
    return o
for side,sign in (("south",1),("north",-1)):
    for layer,(yoff,thick,material) in enumerate(((0,.18,OAK),(.11,.13,SLATE))):
        if side=="south":
            # Dormer footprint: X -1.23..0.83, roof-local Z -1.05..0.45.
            # Side panels retain the complete eave-to-ridge span; center panels
            # close the roof above and below the framed penetration.
            south_roof_panel(f"roof/main-south-layer-{layer}-left",-5.075,-1.23,-2.575,2.575,5.15+yoff,thick,material)
            south_roof_panel(f"roof/main-south-layer-{layer}-right",.83,5.075,-2.575,2.575,5.15+yoff,thick,material)
            south_roof_panel(f"roof/main-south-layer-{layer}-below",-1.23,.83,-2.575,-1.05,5.15+yoff,thick,material)
            south_roof_panel(f"roof/main-south-layer-{layer}-above",-1.23,.83,.45,2.575,5.15+yoff,thick,material)
        else:
            o=box(f"roof/main-{side}-layer-{layer}",(0,5.15+yoff,-sign*1.75),(10.15,thick,5.15),material,root,.018)
            o.rotation_euler[0]=-sign*pitch
            if material==SLATE:
                o["limina_roof_ridge_axis"]=0; o["limina_roof_slope_axis"]=1; o["limina_roof_slope_sign"]=1; o["limina_roof_anchor"]=(0,0,6.87)
    for i in range(22):
        box(f"roof/eave-{side}-{i}",(-4.82+i*.46,3.46,-sign*4.03),(.50,.13,.36),SLATE,root,.012)
for i in range(15): box(f"roof/ridge-{i}",(-4.72+i*.67,6.87,0),(.74,.22,.38),SLATE,root,.022)
# Exposed rafter tails retain the eave construction.  The slate weather skin
# already carries authored shingle courses; the former nine full-width raised
# `roof/course-*` bars duplicated those courses and read as perpendicular
# planks across the lower slope, so there is deliberately no second course
# geometry system here.
for side,sign in (("south",-1),("north",1)):
    for i in range(19):
        x=-4.55+i*.51
        tail=box(f"roof/rafter-tail-{side}-{i}",(x,3.35,sign*3.72),(.13,.20,.82),OAK,root,.016); tail.rotation_euler[0]=(-sign)*pitch
# End-gable plaster is inset beneath the actual 48-degree roof underside.
# The former independently pitched 43.3-degree triangle broke through the
# weather skin by ~48 mm at both eaves.
triangle_prism("shell/gable-west","z",-4.62,-3.42,3.42,3.43,6.66,.36,PLASTER,root)
triangle_prism("shell/gable-east","z",4.62,-3.42,3.42,3.43,6.66,.36,PLASTER,root)

# Asymmetric south-east cross-gable/service bay.  A deep stone core overlaps
# the main subfloor and supports the complete projection; exposed masonry
# courses wrap its front and side returns instead of leaving a floating floor.
box("crossbay/subfloor",(2.62,-.80,-4.18),(3.20,1.60,2.00),STONE,root)
box("crossbay/floor",(2.62,.08,-4.05),(3.20,.16,2.00),OAK_WORN,root)
for course in range(2):
    y=.22+course*.30
    for side,x in (("west",1.06),("east",4.18)):
        cursor=-5.02
        for i in range(3):
            depth=.43 if i<2 else .42
            z=cursor+depth/2; cursor+=depth+.035
            box(f"crossbay/foundation-{side}-{course}-{i}",(x,y+.014*((i+course)%2),z),(.48,.32+.025*((i+1)%3),depth),STONE if i%3 else MORTAR,root,.03)
    cursor=1.10
    for i in range(6):
        width=min(.47+.05*((i+course)%3),4.14-cursor)
        if width>.08: box(f"crossbay/foundation-front-{course}-{i}",(cursor+width/2,y+.012*(i%2),-5.19),(width,.32+.025*((i+course)%3),.48),STONE if i%4 else MORTAR,root,.03)
        cursor+=width+.035
for x in (1.10,4.14): box(f"crossbay/side-{x}",(x,1.85,-4.18),(.28,3.70,1.72),PLASTER,root)
box("crossbay/front-left",(1.48,1.85,-5.02),(.78,3.70,.30),PLASTER,root)
box("crossbay/front-right",(3.76,1.85,-5.02),(.78,3.70,.30),PLASTER,root)
box("crossbay/front-sill",(2.62,.58,-5.02),(1.50,1.10,.30),PLASTER,root); box("crossbay/front-head",(2.62,3.05,-5.02),(1.50,1.30,.30),PLASTER,root)
window_front("window/cross-gable",2.62,-5.04,"south",-5.02,width=1.28,height=1.34)
cross_pitch=math.radians(54); cross_wall_half=1.52; cross_gable_base=3.64; cross_apex=cross_gable_base+cross_wall_half*math.tan(cross_pitch)-.01
triangle_prism("crossbay/gable","x",-5.02,1.10,4.14,cross_gable_base,cross_apex,.30,PLASTER,root)
cross_roof_front=-5.53; cross_roof_rear=-.85; cross_roof_depth=cross_roof_rear-cross_roof_front; cross_roof_center=(cross_roof_front+cross_roof_rear)/2
for side,sign in (("west",1),("east",-1)):
    o=box(f"roof/cross-{side}",(2.62+sign*.85,4.745,cross_roof_center),(2.895,.15,cross_roof_depth),SLATE,root,.018); o.rotation_euler[1]=sign*cross_pitch
    o["limina_roof_ridge_axis"]=1; o["limina_roof_slope_axis"]=0; o["limina_roof_slope_sign"]=-sign; o["limina_roof_anchor"]=(2.62,4.18,5.91)
cross_ridge=box("roof/cross-ridge",(2.62,5.91,cross_roof_center),(.28,.22,cross_roof_depth+.08),SLATE,root,.022)
cross_ridge["limina_roof_ridge_axis"]=1; cross_ridge["limina_roof_slope_axis"]=0; cross_ridge["limina_roof_slope_sign"]=1; cross_ridge["limina_roof_anchor"]=(2.62,4.18,5.91)
# Raised woven-slate valley strips close the two analytic intersections with
# the main south weather skin; the underlying planes meet at this line rather
# than presenting an unflashed raw interpenetration.
main_south_slope=math.tan(pitch)
main_south_top_intercept=5.26+main_south_slope*1.75+.13/(2*math.cos(pitch))
cross_top_ridge_y=4.745+math.tan(cross_pitch)*.85+.15/(2*math.cos(cross_pitch))
for side,sign in (("west",-1),("east",1)):
    top_x=2.62+sign*.08; top_surface_y=cross_top_ridge_y-math.tan(cross_pitch)*.08; top_z=(top_surface_y-main_south_top_intercept)/main_south_slope; top_y=top_surface_y+.035
    bottom_x=2.62+sign*1.52; bottom_surface_y=cross_top_ridge_y-math.tan(cross_pitch)*1.52; bottom_z=(bottom_surface_y-main_south_top_intercept)/main_south_slope; bottom_y=bottom_surface_y+.035
    beam_between(f"roof/cross-valley-{side}",(top_x,top_y,top_z),(bottom_x,bottom_y,bottom_z),.22,.035,SLATE,root,.008)

# Offset chimney and dormer provide long-range silhouette hierarchy.
# The stack rises directly from the north-east hearth rather than reading as an
# unrelated roof prop on the opposite side of the building.
box("chimney/stack",(2.95,5.22,2.65),(1.05,4.15,.92),STONE,root,.045)
# Staggered projecting face stones break the former monolithic stack read while
# retaining one continuous weatherproof core and the authoritative silhouette.
for course in range(8):
    y=3.62+course*.47; offset=.12 if course%2 else 0
    for face,axis,plane in (("south","x",2.17),("north","x",3.13),("west","z",2.39),("east","z",3.51)):
        for index in range(2):
            along=(-.27 if index==0 else .27)+offset*(1 if index==0 else -1)
            if axis=="x": center=(2.95+along,y,plane); dimensions=(.54,.42,.12)
            else: center=(plane,y,2.65+along); dimensions=(.12,.42,.54)
            box(f"chimney/face-{face}-{course}-{index}",center,dimensions,STONE if (course+index)%3 else MORTAR,root,.028)
box("chimney/cap",(2.95,7.30,2.65),(1.28,.22,1.12),STONE,root,.035)
box("dormer/front-left",(-.95,5.03,-2.26),(.55,1.45,.24),PLASTER,root)
box("dormer/front-right",(.55,5.03,-2.26),(.55,1.45,.24),PLASTER,root)
box("dormer/front-sill",(-.20,4.47,-2.26),(1.05,.33,.24),PLASTER,root)
box("dormer/front-head",(-.20,5.63,-2.26),(1.05,.25,.24),PLASTER,root)
window_front("window/dormer",-.20,-2.41,"south",-2.26,width=1.05,height=.94,center_y=5.07)
triangle_prism("dormer/gable","x",-2.39,-1.23,.83,5.75,6.72,.24,PLASTER,root)
# Cheeks and paired slate roof planes cover the bounded main-roof cut while
# preserving a clear inward reveal behind the dormer glazing.
for x in (-1.14,.74): box(f"dormer/cheek-{x}",(x,5.18,-1.91),(.18,1.48,.94),PLASTER,root,.018)
for side,sign in (("west",-1),("east",1)):
    o=box(f"dormer/roof-{side}",(-.20+sign*.48,6.30,-1.91),(1.28,.14,1.38),SLATE,root,.018)
    o.rotation_euler[1]=sign*math.radians(44)
    o["limina_roof_ridge_axis"]=1; o["limina_roof_slope_axis"]=0; o["limina_roof_slope_sign"]=-sign; o["limina_roof_anchor"]=(-.20,1.91,6.65)
box("dormer/roof-ridge",(-.20,6.85,-1.91),(.22,.18,1.48),SLATE,root,.018)

# Covered stoop, clean portal frame and a separately articulated modeled leaf.
for x in (-1.72,.30): box(f"stoop/post-{x}",(x,1.45,-4.22),(.18,2.90,.18),OAK,root,.025)
box("stoop/beam",(-.71,2.84,-4.22),(2.35,.22,.22),OAK,root,.025)
stoop=box("stoop/roof",(-.71,3.03,-3.98),(2.65,.16,1.55),SLATE,root,.018); stoop.rotation_euler[0]=-math.radians(16)
stoop["limina_roof_ridge_axis"]=0; stoop["limina_roof_slope_axis"]=1; stoop["limina_roof_slope_sign"]=-1; stoop["limina_roof_anchor"]=(-.71,3.98,3.25)
box("entry/threshold",(-.72,.105,-3.63),(1.46,.20,.64),STONE,root,.035)
for level,(y,z,width,depth,pieces) in enumerate(((.08,-4.02,1.68,.52,3),(.045,-4.38,1.96,.42,4))):
    cursor=-.72-width/2
    for piece in range(pieces):
        gap=.025; remaining=-.72+width/2-cursor; w=remaining/(pieces-piece)-gap
        box(f"entry/step-{'upper' if level==0 else 'lower'}-{piece}",(cursor+w/2,y+.008*((piece+level)%2),z+.025*((piece*3+level)%2)),(w,.16 if level==0 else .09,depth-.025*((piece+1)%2)),STONE if piece%3 else MORTAR,root,.035)
        cursor+=w+gap
for x in (-1.50,.06): box(f"entry/jamb-{x}",(x,1.34,-3.66),(.20,2.68,.32),OAK,root,.025)
box("entry/head",(-.72,2.61,-3.66),(1.76,.22,.32),OAK,root,.025)
box("entry/reveal-left",(-1.47,1.24,-3.42),(.12,2.48,.42),MORTAR,root,.012)
box("entry/reveal-right",(.03,1.24,-3.42),(.12,2.48,.42),MORTAR,root,.012)
box("entry/reveal-top",(-.72,2.54,-3.42),(1.38,.12,.42),MORTAR,root,.012)
box("entry/reveal-bottom",(-.72,.06,-3.42),(1.38,.12,.42),STONE,root,.012)
door=box("door/front",(0,0,0),(1.38,2.42,.11),DOOR_OAK,root,.018)
door.data.transform(Matrix.Translation((.69,0,1.21))); door.location=(-1.41,3.72,0)
# Five nearly full-width boards form one continuous leaf.  The former 55 mm
# strips left most of the slab exposed and, combined with floated trim, read as
# a portcullis in the engine threshold view rather than a boarded oak door.
for i in range(5):
    p=box(f"door/front/plank-{i}",(-1.32+i*.28,1.21,-3.782),(.262,2.34,.018),DOOR_OAK,None,.006); w=p.matrix_world.copy(); p.parent=door; p.matrix_world=w
for y in (.34,2.08):
    s=box(f"door/front/strap-{y}",(-.86,y,-3.810),(.96,.060,.016),IRON,None,.006); w=s.matrix_world.copy(); s.parent=door; s.matrix_world=w
# Modeled frame-and-brace joinery, hinge knuckles, latch plate and pull remain door descendants.
for x in (-1.34,-.10):
    q=box(f"door/front/stile-{x}",(x,1.21,-3.798),(.105,2.32,.024),DOOR_OAK,None,.009); w=q.matrix_world.copy(); q.parent=door; q.matrix_world=w
for y in (.34,2.08):
    q=box(f"door/front/rail-{y}",(-.72,y,-3.798),(1.31,.105,.024),DOOR_OAK,None,.009); w=q.matrix_world.copy(); q.parent=door; q.matrix_world=w
# A housed diagonal brace makes the leaf read as an assembled load-bearing
# door instead of stacked decorative rectangles; it articulates with the leaf.
q=diagonal_bar("door/front/brace",(-.72,1.20,-3.814),2.20,math.radians(57),"x",DOOR_OAK,door,.105,.025)
for y in (.42,1.20,1.98):
    q=cylinder(f"door/front/hinge-knuckle-{y}",(-1.425,y,-3.812),.045,.16,IRON,None,12,(math.pi/2,0,0)); w=q.matrix_world.copy(); q.parent=door; q.matrix_world=w
q=box("door/front/latch-plate",(-.14,1.20,-3.813),(.16,.26,.016),IRON,None,.010); w=q.matrix_world.copy(); q.parent=door; q.matrix_world=w
q=cylinder("door/front/pull",(-.12,1.20,-3.875),.075,.055,IRON,None,16,(math.pi/2,0,0)); w=q.matrix_world.copy(); q.parent=door; q.matrix_world=w
door.rotation_euler[2]=0; door.keyframe_insert(data_path="rotation_euler",index=2,frame=1)
door.rotation_euler[2]=-math.radians(95); door.keyframe_insert(data_path="rotation_euler",index=2,frame=25)
door.animation_data.action.name="door/front/open"; door.rotation_euler[2]=0

# Stage-B interior construction/readability: exposed ceiling structure and a furnished perimeter keep
# the central one-metre traversal aisle clear from the exterior portal to the back of the hall.
for x in (-4.1,-2.7,-1.3,.1,1.5,2.9,4.1): box(f"interior/tie-beam-{x}",(x,3.30,0),(.18,.22,6.30),OAK,root,.022)
box("interior/hearth-base",(2.95,.18,2.65),(2.20,.36,1.10),STONE,root,.04)
box("interior/firebox-cavity",(2.95,1.08,3.00),(1.42,1.58,.22),SOOT,root,.025)
box("interior/firebox-jamb-west",(2.08,1.08,2.86),(.34,1.78,.52),STONE,root,.035)
box("interior/firebox-jamb-east",(3.82,1.08,2.86),(.34,1.78,.52),STONE,root,.035)
box("interior/firebox-lintel",(2.95,1.91,2.86),(2.08,.34,.52),STONE,root,.04)
box("interior/firebox-hood",(2.95,2.12,2.91),(1.74,.28,.42),BRICK,root,.025)
box("interior/mantel",(2.95,2.31,2.78),(2.40,.22,.58),OAK,root,.03)
box("interior/hearth-ember-bed",(2.95,.44,2.55),(1.22,.08,.54),EMBER,root,.03)
for i,(x,z,rotation) in enumerate(((2.95,2.48,(0,math.pi/2,0)),(2.95,2.62,(0,math.pi/2,0)),(2.95,2.55,(math.pi/2,0,0)))):
    log=cylinder(f"interior/hearth-log-{i}",(x,.50,z),.105,1.05,OAK,root,12,rotation)
for i,(x,y,z,radius,height,material) in enumerate(((2.70,.82,2.48,.18,.78,FLAME_OUTER),(3.13,.78,2.54,.16,.68,FLAME_OUTER),(2.92,.92,2.43,.14,.94,FLAME_INNER))):
    flame=cone(f"interior/hearth-flame-{i}",(x,y,z),radius,height,material,root,16); flame["limina_fire_phase"]=i/3
box("interior/table-top",(-2.70,.91,.45),(2.70,.16,1.18),OAK_WORN,root,.035)
for x in (-3.75,-1.65):
    for z in (.02,.88): box(f"interior/table-leg-{x}-{z}",(x,.47,z),(.18,.88,.18),OAK,root,.018)
for z in (-.55,1.45):
    box(f"interior/bench-seat-{z}",(-2.70,.53,z),(2.85,.16,.42),OAK_WORN,root,.025)
    for x in (-3.75,-1.65): box(f"interior/bench-leg-{z}-{x}",(x,.27,z),(.16,.54,.28),OAK,root,.018)
box("interior/cupboard",(-4.13,1.10,2.25),(.55,2.20,1.55),OAK_WORN,root,.025)
for y in (.55,1.12,1.70): box(f"interior/shelf-{y}",(-4.05,y,-2.00),(.52,.12,1.50),OAK,root,.018)
box("interior/runner",(-.72,.075,-.65),(1.05,.045,5.20),BRICK,root,.012)
# Service/loft zone, bed, textiles, storage and tools complete the readable room perimeter.
box("interior/loft-floor",(-3.30,2.62,2.12),(2.35,.18,2.25),OAK,root,.025)
for x in (-4.18,-2.42): box(f"interior/loft-post-{x}",(x,1.35,1.22),(.18,2.70,.18),OAK,root,.022)
for i in range(7): box(f"interior/loft-rail-{i}",(-4.10+i*.31,3.02,1.02),(.10,.72,.10),OAK,root,.012)
box("interior/bed-frame",(2.65,.43,-2.18),(2.15,.38,1.42),OAK_WORN,root,.035)
box("interior/bed-mattress",(2.65,.70,-2.18),(1.94,.24,1.22),INNER,root,.06)
box("interior/bed-blanket",(2.94,.84,-2.18),(1.28,.08,1.24),BRICK,root,.025)
for i in range(5):
    box(f"interior/crate-{i}",(3.72-.34*(i%2),.25+.32*(i//2),-.35+i*.22),(.55,.48,.55),OAK_WORN,root,.025)
for i in range(8):
    cylinder(f"interior/tool-{i}",(-3.96,1.15+i*.16,-1.55+(i%3)*.22),.025,.55,IRON,root,8,(0,math.pi/2,0))

# Warm practicals are authored scene lights and travel through the GLB/engine
# loader; they are not Blender-only acceptance lighting.
for name,location,energy,size,distance in (("interior/light-hearth",(2.95,1.00,2.55),.55,.75,4.2),("interior/light-table",(-2.55,2.25,.30),.275,.65,3.6),("interior/light-entry",(-.72,2.05,-2.75),.138,.45,2.8)):
    data=bpy.data.lights.new(name+" data",type="POINT"); data.color=(1.0,.46,.18); data.energy=energy; data.shadow_soft_size=size
    data.use_custom_distance=True; data.cutoff_distance=distance
    light=bpy.data.objects.new(name,data); bpy.context.collection.objects.link(light); light.location=(location[0],-location[2],location[1]); light.parent=root

# Exported UV0 is authored from final geometry, never from Blender procedural
# coordinates. Masonry/plaster share one building-space origin across split
# piers, sills and heads; timber follows each member's longest local axis.
WORLD_UV={
    "V4 fieldstone":2.35,"V4 lime mortar":2.80,"V4 warm lime plaster":3.20,
    "V4 interior lime":3.20,"V4 blue slate":2.20,"V4 chimney brick":1.85,
}
TIMBER_UV={"V4 structural oak":2.40,"V4 door oak":2.40,"V4 worn oak":2.40}
def author_uv0(obj):
    if obj.type!="MESH" or not obj.data.materials: return
    material=obj.data.materials[0]; name=material.name
    if name not in WORLD_UV and name not in TIMBER_UV: return
    uv=obj.data.uv_layers.get("UVMap") or obj.data.uv_layers.new(name="UVMap")
    if name=="V4 blue slate" and "limina_roof_ridge_axis" not in obj:
        extents=[max(vertex.co[axis] for vertex in obj.data.vertices)-min(vertex.co[axis] for vertex in obj.data.vertices) for axis in range(3)]
        ordered=sorted(range(3),key=lambda axis:extents[axis],reverse=True)
        obj["limina_roof_ridge_axis"]=ordered[0]; obj["limina_roof_slope_axis"]=ordered[1]; obj["limina_roof_slope_sign"]=1; obj["limina_roof_anchor"]=(0,0,0)
    if "limina_roof_ridge_axis" in obj:
        scale=WORLD_UV[name]; basis=obj.matrix_world.to_3x3(); ridge_axis=int(obj["limina_roof_ridge_axis"]); slope_axis=int(obj["limina_roof_slope_axis"]); slope_sign=float(obj["limina_roof_slope_sign"]); anchor=Vector(obj["limina_roof_anchor"])
        ridge=(basis @ Vector((1 if ridge_axis==0 else 0,1 if ridge_axis==1 else 0,1 if ridge_axis==2 else 0))).normalized()
        slope=(basis @ Vector((1 if slope_axis==0 else 0,1 if slope_axis==1 else 0,1 if slope_axis==2 else 0))).normalized()*slope_sign
        obj["limina_roof_anchor_engine"]=(anchor.x,anchor.z,-anchor.y); obj["limina_roof_ridge_world"]=(ridge.x,ridge.z,-ridge.y); obj["limina_roof_slope_world"]=(slope.x,slope.z,-slope.y); obj["limina_roof_metres_per_repeat"]=scale
        for polygon in obj.data.polygons:
            for loop_index in polygon.loop_indices:
                p=obj.matrix_world @ obj.data.vertices[obj.data.loops[loop_index].vertex_index].co
                relative=p-anchor; uv.data[loop_index].uv=(relative.dot(ridge)/scale,relative.dot(slope)/scale)
        material["limina_surface_mapping"]="roof-plane-ridge-slope"
        material["limina_metres_per_repeat"]=scale
    elif name in WORLD_UV:
        scale=WORLD_UV[name]; normal_matrix=obj.matrix_world.to_3x3().inverted().transposed()
        for polygon in obj.data.polygons:
            n=normal_matrix @ polygon.normal; dominant=max(range(3),key=lambda axis:abs(n[axis]))
            for loop_index in polygon.loop_indices:
                p=obj.matrix_world @ obj.data.vertices[obj.data.loops[loop_index].vertex_index].co
                # Blender (X,Y,Z) corresponds to Limina (X,-Z,Y).
                if dominant==0: coords=(-p.y,p.z)
                elif dominant==1: coords=(p.x,p.z)
                else: coords=(p.x,-p.y)
                uv.data[loop_index].uv=(coords[0]/scale,coords[1]/scale)
        material["limina_surface_mapping"]="building-space-dominant-axis"
        material["limina_metres_per_repeat"]=scale
    else:
        scale=TIMBER_UV[name]; bounds=[max(v.co[a] for v in obj.data.vertices)-min(v.co[a] for v in obj.data.vertices) for a in range(3)]
        grain=max(range(3),key=lambda axis:bounds[axis]); cross=max((a for a in range(3) if a!=grain),key=lambda axis:bounds[axis])
        for loop_index,loop in enumerate(obj.data.loops):
            p=obj.data.vertices[loop.vertex_index].co; uv.data[loop_index].uv=(p[cross]/scale,p[grain]/scale)
        material["limina_surface_mapping"]="member-local-long-axis"
        material["limina_metres_per_repeat"]=scale
for candidate in bpy.context.scene.objects: author_uv0(candidate)

os.makedirs(os.path.dirname(os.path.abspath(OUT)),exist_ok=True)
bpy.ops.export_scene.gltf(filepath=os.path.abspath(OUT),export_format="GLB",export_yup=True,export_animations=True,export_extras=True,export_apply=False,export_lights=True)

def pad4(d,b): return d+bytes([b])*((4-len(d)%4)%4)
raw=open(OUT,"rb").read(); magic,version,total=struct.unpack_from("<III",raw,0); off=12; chunks=[]
while off<len(raw):
    n,k=struct.unpack_from("<II",raw,off); chunks.append((k,raw[off+8:off+8+n])); off+=8+n
doc=json.loads(next(d for k,d in chunks if k==0x4E4F534A).decode().rstrip(" \0"))
doc["asset"].setdefault("extras",{})["liminaMaterialSources"]={"schema":"limina.material-sources/v1","packs":[{"id":pack,"manifestSha256":digest} for pack,digest in sorted(set(MATERIAL_MANIFESTS))]}
doc["asset"].setdefault("extras",{})["liminaFunctionalBuilding"]={"schema":"limina.functional-building/v1","units":"meter","up":"Y","buildingId":"hall-house/temperate/v4","rootNodeId":"building/root","roomIds":["room/main"],"portalIds":["portal/exterior"],"entryAnchor":[-.72,0,-4.18],
    "site":{"footprintCenter":[0,-.70],"footprintHalfExtents":[5.10,4.60],"finishedFloorY":.09,"terrainClearance":.12,"vegetationClearance":.80,"maximumTerrainRelief":1.40}}
doc["asset"]["extras"]["liminaFunctionalBuildingVisual"]={
    "schema":"limina.functional-building-visual/v1",
    "openings":[*WINDOW_OPENINGS,
        {"id":"portal/exterior","kind":"door","facade":"south","aperture":{"center":[-.72,1.24,-3.42],"halfExtents":[.72,1.24,.18]},
            "leafNodeId":"door/front","revealNodeIds":["entry/reveal-left","entry/reveal-right","entry/reveal-top","entry/reveal-bottom"],
            "plankNodeIds":["door/front/plank-0","door/front/plank-1","door/front/plank-2","door/front/plank-3","door/front/plank-4","door/front/stile--1.34","door/front/stile--0.1","door/front/rail-0.34","door/front/rail-2.08","door/front/brace"],
            "ironworkNodeIds":["door/front/strap-0.34","door/front/strap-2.08","door/front/hinge-knuckle-0.42","door/front/hinge-knuckle-1.2","door/front/hinge-knuckle-1.98","door/front/latch-plate","door/front/pull"]}],
    "materialRoles":[
        {"role":"foundation","materialName":"V4 fieldstone"},{"role":"mortar-reveal","materialName":"V4 lime mortar"},
        {"role":"wall-exterior","materialName":"V4 warm lime plaster"},{"role":"wall-interior","materialName":"V4 interior lime"},
        {"role":"structure-trim","materialName":"V4 structural oak"},{"role":"door-surface","materialName":"V4 door oak"},{"role":"floor-furnishing","materialName":"V4 worn oak"},
        {"role":"roof","materialName":"V4 blue slate"},{"role":"hearth-masonry","materialName":"V4 chimney brick"},
        {"role":"hearth-soot","materialName":"V4 hearth soot"},{"role":"hearth-embers","materialName":"V4 hearth embers"},
        {"role":"flame-outer","materialName":"V4 flame outer"},{"role":"flame-inner","materialName":"V4 flame inner"},
        {"role":"glazing","materialName":"V4 leadlight glass"},{"role":"door-hardware","materialName":"V4 black iron"}],
    "interior":{"walkableNodeIds":["shell/interior-floor"],"ceilingNodeIds":["shell/ceiling"],
        "shellNodeIds":[n.get("name") for n in doc.get("nodes",[]) if n.get("name","").startswith("shell/")],
        "furnishingNodeIds":[n.get("name") for n in doc.get("nodes",[]) if n.get("name","").startswith("interior/") and n.get("name") not in ("interior/runner",) and not n.get("name","").startswith("interior/light-")],
        "hearth":{"apertureCenter":[2.95,1.08,2.70],"apertureHalfExtents":[.70,.72,.70],
            "surroundNodeIds":["interior/firebox-jamb-west","interior/firebox-jamb-east","interior/firebox-lintel","interior/firebox-hood"],
            "fuelNodeIds":["interior/hearth-log-0","interior/hearth-log-1","interior/hearth-log-2"],"emberNodeId":"interior/hearth-ember-bed",
            "flameNodeIds":["interior/hearth-flame-0","interior/hearth-flame-1","interior/hearth-flame-2"],"lightNodeId":"interior/light-hearth"},
        "clearAisle":{"from":[-.72,.10,-4.10],"to":[-.72,.10,2.55],"halfWidth":.50,"minClearHeight":2.20}},
    "lod":{"identity":"hall-house/temperate/v4","lod0RootNodeId":"building/root","triangleBudget":90000,"drawBudget":640,"productionDrawTarget":24,"lod1TriangleBudget":32000,"lod2TriangleBudget":8000}}
sem={"building/root":{"id":"building/root","role":"root"},"room/main":{"id":"room/main","role":"room"},"portal/exterior":{"id":"portal/exterior","role":"portal"},"door/front":{"id":"door/front","role":"door","roomId":"room/main","portalId":"portal/exterior","hinge":[-1.41,0,-3.72],"center":[.69,1.21,0],"halfExtents":[.69,1.21,.055],"closedYaw":0,"openYaw":-math.radians(95)}}
cols={
"floor":([0,-.16,0],[4.8,.16,3.6]),"ceiling":([0,3.47,0],[4.45,.06,3.25]),"north":([0,1.78,3.42],[4.8,1.78,.18]),"west":([-4.62,1.78,0],[.18,1.78,3.42]),"east":([4.62,1.78,0],[.18,1.78,3.42]),
"south-far-left":([-4.21,1.78,-3.42],[.59,1.78,.18]),"south-window-left":([-2.90,.58,-3.42],[.72,.58,.18]),"south-mid":([-1.82,1.78,-3.42],[.36,1.78,.18]),"south-door-head":([-.72,3.02,-3.42],[.72,.53,.18]),"south-far-right":([3.75,1.78,-3.42],[1.05,1.78,.18])}
for n,(c,h) in cols.items(): sem["collider/"+n]={"id":"collider/"+n,"role":"collider","shape":"box","center":c,"halfExtents":h}
names={n.get("name"):n for n in doc.get("nodes",[])}
for name,data in sem.items():
    target=names.get(name)
    if target is None: target={"name":name}; doc.setdefault("nodes",[]).append(target)
    target.setdefault("extras",{})["limina"]=data
# Every visual-contract reference carries an explicit stable ID; runtime never depends on sanitized names.
visual_ids=[]
visual_ids.extend(n.get("name") for n in doc.get("nodes",[]) if n.get("name","").startswith("entry/step-"))
visual_ids.extend(n.get("name") for n in doc.get("nodes",[]) if n.get("name","").startswith("crossbay/") or n.get("name","").startswith("roof/cross-"))
visual_ids.extend(n.get("name") for n in doc.get("nodes",[]) if n.get("name","").startswith("dormer/") or n.get("name","") in ("shell/gable-west","shell/gable-east"))
visual_ids.append("interior/light-hearth")
for item in doc["asset"]["extras"]["liminaFunctionalBuildingVisual"]["openings"]:
    visual_ids.extend(item["revealNodeIds"])
    visual_ids.append(item.get("glazingNodeId",item.get("leafNodeId")))
    for key in ("frameNodeIds","mullionNodeIds","cameNodeIds","plankNodeIds","ironworkNodeIds"):
        visual_ids.extend(item.get(key,[]))
interior_contract=doc["asset"]["extras"]["liminaFunctionalBuildingVisual"]["interior"]
visual_ids.extend(interior_contract["walkableNodeIds"]+interior_contract["ceilingNodeIds"]+interior_contract["shellNodeIds"]+interior_contract["furnishingNodeIds"])
for name in visual_ids:
    target=names.get(name)
    if target is None: raise RuntimeError("missing visual contract node "+name)
    target.setdefault("extras",{}).setdefault("limina",{"id":name,"role":"visual-opening-part"})
j=pad4(json.dumps(doc,separators=(",",":")).encode(),0x20); rebuilt=[(k,j if k==0x4E4F534A else d) for k,d in chunks]
body=b"".join(struct.pack("<II",len(d),k)+d for k,d in rebuilt); open(OUT,"wb").write(struct.pack("<III",magic,version,12+len(body))+body)
print("functional-hall-house-v4: wrote",OUT)
