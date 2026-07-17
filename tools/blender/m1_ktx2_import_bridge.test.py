"""CPU-only determinism and fail-closed tests for the temporary M1 bridge."""
import json
import os
import shutil
import tempfile

from m1_ktx2_import_bridge import derive_import_bridge, read_glb, sha256_file


REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SOURCE = os.path.join(REPO, "assets", "buildings", "authoring", "functional-hall-house-v4", "material-r2", "runtime", "shell-m1-production.glb")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


source_before = sha256_file(SOURCE)
first_dir = tempfile.mkdtemp(prefix="limina-m1-bridge-test-a-")
second_dir = tempfile.mkdtemp(prefix="limina-m1-bridge-test-b-")
reject_dir = tempfile.mkdtemp(prefix="limina-m1-bridge-reject-")
try:
    first_path, first = derive_import_bridge(SOURCE, source_before, first_dir, REPO)
    second_path, second = derive_import_bridge(SOURCE, source_before, second_dir, REPO)
    assert first == second
    assert sha256_file(first_path) == sha256_file(second_path) == first["bridgeGlbSha256"]
    assert sha256_file(SOURCE) == source_before == first["sourceRuntimeGlbSha256"]
    _, source, _ = read_glb(SOURCE)
    _, bridge, _ = read_glb(first_path)
    assert "KHR_texture_basisu" in source["extensionsRequired"]
    assert "KHR_texture_basisu" not in bridge.get("extensionsRequired", [])
    assert "KHR_texture_basisu" not in bridge.get("extensionsUsed", [])
    assert len(source["images"]) == len(bridge["images"]) == first["imagesCount"] == len(first["images"])
    assert len(source["textures"]) == len(bridge["textures"]) == first["textures"]
    assert all(image["mimeType"] == "image/png" and "bufferView" in image and "uri" not in image for image in bridge["images"])
    assert all("source" in texture and "KHR_texture_basisu" not in texture.get("extensions", {}) for texture in bridge["textures"])
    for key in ("nodes", "meshes", "materials", "accessors", "animations", "scenes", "scene", "skins", "samplers"):
        assert canonical(source.get(key)) == canonical(bridge.get(key)), key
    assert bridge["asset"]["extras"]["liminaM1ImportBridge"]["sourceRuntimeGlbSha256"] == source_before
    try:
        derive_import_bridge(SOURCE, "sha256:" + "0" * 64, reject_dir, REPO)
    except RuntimeError as error:
        assert "raw byte authority drifted" in str(error)
    else:
        raise AssertionError("bridge accepted the wrong M1 authority hash")
finally:
    shutil.rmtree(first_dir, ignore_errors=True)
    shutil.rmtree(second_dir, ignore_errors=True)
    shutil.rmtree(reject_dir, ignore_errors=True)

print("deterministic pinned-KTX M1 PNG import bridge validated without Blender")
