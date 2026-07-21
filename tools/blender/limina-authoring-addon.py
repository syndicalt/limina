"""Session-scoped, schema-aware controls for Limina Blender authoring sources."""
import bpy
import json
import os
from pathlib import Path
import subprocess
import sys

bl_info = {"name":"Limina Authoring","author":"Limina","version":(0,2,0),"blender":(4,0,2),"location":"3D View > Sidebar > Limina","category":"3D View"}
SHELL_SCHEMA = "limina.blender-authoring-handoff/v1"
COMPOSITION_SCHEMA = "limina.blender-building-composition-handoff/v2"
REQUIRED_SHELL = {"00_READ_ME","10_GENERATED_STRUCTURE","20_ARTIST_SURFACES","30_INTERIOR_DRESSING","40_ARTICULATION","COLLISION","SOCKETS","VFX_ANCHORS","90_EXPORT"}
REQUIRED_COMPOSITION = {"10_MATERIALIZED_SHELL","30_INTERIOR_DRESSING","COLLISION","SOCKETS","90_EXPORT"}

def scene_mode(scene):
    schema = scene.get("limina.handoffSchema")
    return "shell" if schema == SHELL_SCHEMA else "composition" if schema == COMPOSITION_SCHEMA else "unsupported"

def composition_handles(scene):
    return sorted((obj for obj in scene.objects if obj.get("limina.role") == "composition-instance"), key=lambda obj: str(obj.get("limina.instanceId", obj.name)))

def is_safe_composition_handle(obj):
    return obj.get("limina.role") == "composition-instance" and obj.get("limina.editPolicy") == "bounded-validate" and bool(obj.get("limina.instanceId")) and bool(obj.get("limina.catalogRole"))

def apply_session_locks(scene):
    if scene_mode(scene) != "composition": return
    for obj in scene.objects:
        safe = is_safe_composition_handle(obj)
        obj.hide_select = not safe
        if safe:
            obj.lock_location = (False, False, True)
            obj.lock_rotation = (True, True, False)
            obj.lock_scale = (True, True, True)
        else:
            obj.lock_location = (True, True, True)
            obj.lock_rotation = (True, True, True)
            obj.lock_scale = (True, True, True)

def validate_scene(scene):
    mode = scene_mode(scene); errors = []
    required = REQUIRED_SHELL if mode == "shell" else REQUIRED_COMPOSITION if mode == "composition" else set()
    if mode == "unsupported": errors.append("This is not a supported Limina authoring source")
    missing = sorted(required - set(bpy.data.collections.keys()))
    if missing: errors.append("Missing collections: " + ", ".join(missing))
    semantic = {}
    for obj in scene.objects:
        semantic_id = obj.get("limina.id")
        if semantic_id is None: continue
        if semantic_id in semantic: errors.append(f"Duplicate semantic ID: {semantic_id}")
        semantic[semantic_id] = obj
        if not obj.get("limina.role") or not obj.get("limina.editPolicy"): errors.append(f"Incomplete metadata: {obj.name}")
    if not semantic: errors.append("No semantic objects found")
    handles = composition_handles(scene) if mode == "composition" else []
    if mode == "composition":
        if len(handles) != 7: errors.append(f"Expected exactly seven bounded composition handles; found {len(handles)}")
        for obj in handles:
            if not is_safe_composition_handle(obj): errors.append(f"Unsafe composition handle metadata: {obj.name}")
            if obj.parent is None or obj.parent.get("limina.role") != "building-composition": errors.append(f"Composition handle parent drifted: {obj.name}")
            if any(abs(value - 1.0) > 1e-6 for value in obj.scale): errors.append(f"Composition handle scale drifted: {obj.name}")
    apply_session_locks(scene)
    return {"ok":not errors,"errors":errors,"mode":mode,"semanticCount":len(semantic),"safeHandleCount":len(handles),"protectedCount":len(scene.objects)-len(handles) if mode == "composition" else 0,"specHash":scene.get("limina_architecture_spec_hash","missing"),"irHash":scene.get("limina_architecture_ir_hash","missing")}

def host_command(action):
    labels = {"engine-preview":"Engine Preview", "submit-revision":"Submit Revision"}; label = labels[action]
    root_text = os.environ.get("LIMINA_AUTHORING_WORKSPACE_ROOT", "")
    orchestrator_text = os.environ.get("LIMINA_AUTHORING_HOST_ORCHESTRATOR", "")
    runtime_text = os.environ.get("LIMINA_AUTHORING_HOST_RUNTIME", "")
    session_text = os.environ.get("LIMINA_AUTHORING_SESSION_MANIFEST", "")
    if not all((root_text, orchestrator_text, runtime_text, session_text)):
        raise RuntimeError(f"Limina host orchestrator is unavailable; {label} is not configured for this session")
    root = Path(root_text).resolve(); orchestrator = Path(orchestrator_text).resolve(); runtime = Path(runtime_text).resolve(); session = Path(session_text).resolve()
    try: orchestrator.relative_to(root)
    except ValueError: raise RuntimeError("Limina host orchestrator is outside the workspace")
    if not orchestrator.is_file() or not runtime.is_file() or not session.is_file():
        raise RuntimeError(f"Limina host orchestrator is unavailable; {label} is not configured for this session")
    return [str(runtime), str(orchestrator), action, "--session", str(session)]

def save_verified_private_working_copy():
    root_text = os.environ.get("LIMINA_AUTHORING_WORKSPACE_ROOT", "")
    session_text = os.environ.get("LIMINA_AUTHORING_SESSION_MANIFEST", "")
    if not root_text or not session_text:
        raise RuntimeError("Limina private authoring session is unavailable; the Blend was not saved")
    root = Path(root_text).resolve(); session_path = Path(session_text).resolve(); session_root = (root / ".limina" / "authoring-sessions").resolve()
    if session_path.name != "session-manifest.json" or session_path.parent.parent != session_root or not session_path.is_file():
        raise RuntimeError("Limina session manifest is outside the private authoring root; the Blend was not saved")
    with session_path.open("r", encoding="utf8") as handle: session = json.load(handle)
    if session.get("schema") != "limina.blender-authoring-session/v1" or session.get("policy", {}).get("approvedSourceImmutable") is not True or session.get("policy", {}).get("genericGltfExportAllowed") is not False:
        raise RuntimeError("Limina private authoring policy drifted; the Blend was not saved")
    working = (root / session.get("workingCopy", {}).get("path", "__missing_working_copy__")).resolve()
    approved = (root / session.get("approvedSource", {}).get("path", "__missing_approved_source__")).resolve()
    current = Path(bpy.data.filepath).resolve() if bpy.data.filepath else None
    if working.parent != session_path.parent or working.name != "furnished-c1-r3.working.blend" or current != working or working == approved or not working.is_file():
        raise RuntimeError("Blender is not editing the verified private working copy; the Blend was not saved")
    bpy.ops.wm.save_as_mainfile(filepath=str(working), check_existing=False)
    if Path(bpy.data.filepath).resolve() != working:
        raise RuntimeError("Blender did not save the verified private working copy")
    return working

class LIMINA_OT_validate(bpy.types.Operator):
    bl_idname = "limina.validate_source"; bl_label = "Validate"; bl_description = "Check Limina identities, constraints, and protected boundaries without exporting"
    def execute(self, context):
        report = validate_scene(context.scene); context.scene["limina.lastValidation"] = json.dumps(report, separators=(",",":"))
        if report["ok"]: self.report({"INFO"}, f"Limina {report['mode']} valid: {report['semanticCount']} semantic objects")
        else: self.report({"ERROR"}, report["errors"][0]); return {"CANCELLED"}
        return {"FINISHED"}

class LIMINA_OT_select_collection(bpy.types.Operator):
    bl_idname = "limina.select_collection"; bl_label = "Select Authoring Group"; collection: bpy.props.StringProperty()
    def execute(self, context):
        if scene_mode(context.scene) != "shell": self.report({"ERROR"}, "Collection selection is available only for shell-v1 sources"); return {"CANCELLED"}
        bpy.ops.object.select_all(action="DESELECT"); collection = bpy.data.collections.get(self.collection)
        if collection is None: self.report({"ERROR"}, "Collection is missing"); return {"CANCELLED"}
        selectable = [obj for obj in collection.all_objects if not obj.hide_get()]
        for obj in selectable: obj.select_set(True)
        if selectable: context.view_layer.objects.active = selectable[0]
        self.report({"INFO"}, f"Selected {len(selectable)} objects in {self.collection}"); return {"FINISHED"}

class LIMINA_OT_select_composition_handle(bpy.types.Operator):
    bl_idname = "limina.select_composition_handle"; bl_label = "Select Safe Handle"; semantic_id: bpy.props.StringProperty()
    def execute(self, context):
        obj = next((item for item in context.scene.objects if item.get("limina.id") == self.semantic_id), None)
        if scene_mode(context.scene) != "composition" or obj is None or not is_safe_composition_handle(obj):
            self.report({"ERROR"}, "The requested object is not a bounded composition handle"); return {"CANCELLED"}
        bpy.ops.object.select_all(action="DESELECT"); obj.hide_select = False; obj.select_set(True); context.view_layer.objects.active = obj
        self.report({"INFO"}, f"Selected {obj.get('limina.catalogRole')} handle"); return {"FINISHED"}

class LIMINA_OT_engine_preview(bpy.types.Operator):
    bl_idname = "limina.engine_preview"; bl_label = "Engine Preview"; bl_description = "Request a guarded Limina engine preview through the named host orchestrator"
    def execute(self, context):
        report = validate_scene(context.scene)
        if not report["ok"]: self.report({"ERROR"}, report["errors"][0]); return {"CANCELLED"}
        try:
            command = host_command("engine-preview"); save_verified_private_working_copy(); subprocess.Popen(command, shell=False, close_fds=True)
        except Exception as error: self.report({"ERROR"}, str(error)); return {"CANCELLED"}
        self.report({"INFO"}, "Engine Preview request sent to the Limina host orchestrator"); return {"FINISHED"}

class LIMINA_OT_submit_revision(bpy.types.Operator):
    bl_idname = "limina.submit_revision"; bl_label = "Submit Revision"; bl_description = "Submit this working copy through the named Limina host orchestrator"
    def execute(self, context):
        report = validate_scene(context.scene)
        if not report["ok"]: self.report({"ERROR"}, report["errors"][0]); return {"CANCELLED"}
        try:
            command = host_command("submit-revision"); save_verified_private_working_copy(); subprocess.Popen(command, shell=False, close_fds=True)
        except Exception as error: self.report({"ERROR"}, str(error)); return {"CANCELLED"}
        self.report({"INFO"}, "Revision request sent to the Limina host orchestrator"); return {"FINISHED"}

class LIMINA_PT_authoring(bpy.types.Panel):
    bl_label = "Limina Authoring"; bl_idname = "LIMINA_PT_authoring"; bl_space_type = "VIEW_3D"; bl_region_type = "UI"; bl_category = "Limina"
    def draw(self, context):
        layout = self.layout; mode = scene_mode(context.scene)
        layout.label(text="Approved C1 Working Copy" if mode == "composition" else "Architectural Shell", icon="HOME")
        layout.operator("limina.validate_source", icon="CHECKMARK")
        last = context.scene.get("limina.lastValidation")
        if last:
            try:
                report = json.loads(last); layout.label(text="Valid" if report.get("ok") else "Needs attention", icon="CHECKMARK" if report.get("ok") else "ERROR")
            except Exception: pass
        layout.separator()
        if mode == "composition":
            layout.label(text="Safe handles (move / yaw only):", icon="UNLOCKED")
            for obj in composition_handles(context.scene):
                label = f"{str(obj.get('limina.catalogRole')).replace('-', ' ').title()} — {obj.get('limina.instanceId')}"
                button = layout.operator("limina.select_composition_handle", text=label); button.semantic_id = obj.get("limina.id")
        else:
            layout.label(text="Select a group:")
            for label, collection in (("Structure","10_GENERATED_STRUCTURE"),("Artist Surfaces","20_ARTIST_SURFACES"),("Interior Dressing","30_INTERIOR_DRESSING"),("Door / Articulation","40_ARTICULATION"),("Collision Helpers","COLLISION")):
                button = layout.operator("limina.select_collection", text=label); button.collection = collection
        box = layout.box(); box.label(text="Protected", icon="LOCKED"); box.label(text="Shell, parts, helpers, export data,"); box.label(text="scale and vertical placement are locked.")
        layout.separator(); layout.operator("limina.engine_preview", icon="RENDER_STILL"); layout.operator("limina.submit_revision", icon="EXPORT")
        layout.label(text="Approval requires an engine preview.", icon="INFO")

CLASSES = (LIMINA_OT_validate,LIMINA_OT_select_collection,LIMINA_OT_select_composition_handle,LIMINA_OT_engine_preview,LIMINA_OT_submit_revision,LIMINA_PT_authoring)
def register():
    for cls in CLASSES:
        try: bpy.utils.register_class(cls)
        except ValueError: pass
    apply_session_locks(bpy.context.scene)
def unregister():
    for cls in reversed(CLASSES):
        try: bpy.utils.unregister_class(cls)
        except RuntimeError: pass
register()

if "--limina-headless-check" in sys.argv:
    result = validate_scene(bpy.context.scene); print("LIMINA_AUTHORING_UI_CHECK=" + json.dumps(result, separators=(",",":")))
    if not result["ok"]: raise RuntimeError(result["errors"][0])
