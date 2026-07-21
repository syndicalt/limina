"""Deterministically derive a Blender-4.0-readable GLB from an approved M1 GLB.

The source GLB remains the authority.  This helper only replaces embedded KTX2
images with PNG images derived by the package-local, hash-pinned KTX 4.4.2
binary.  Geometry, nodes, meshes, materials, samplers, and material bindings are
left intact.  Callers must retain and attest the returned bridge identity.
"""
import argparse
import copy
import hashlib
import json
import os
import struct
import subprocess


SCHEMA = "limina.m1-ktx2-png-import-bridge/v1"
KTX_RELATIVE_PATH = "js/.tools/ktx/4.4.2/linux-arm64/root/usr/bin/ktx"
KTX_SHA256 = "sha256:1699bb4bfc7bee62cf27496d1c02f85e560e3f78b1e7a7651243fc7fde271029"
KTX_VERSION = "ktx version: v4.4.2"
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942


def sha256_bytes(payload):
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def sha256_file(path):
    with open(path, "rb") as handle:
        return sha256_bytes(handle.read())


def canonical_hash(value):
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf8")
    return sha256_bytes(payload)


def read_glb(path):
    with open(path, "rb") as handle:
        raw = handle.read()
    if len(raw) < 20:
        raise RuntimeError("approved M1 runtime is not a GLB")
    magic, version, total = struct.unpack_from("<4sII", raw, 0)
    if magic != b"glTF" or version != 2 or total != len(raw):
        raise RuntimeError("approved M1 runtime has an invalid GLB envelope")
    offset, chunks = 12, []
    while offset < total:
        if offset + 8 > total:
            raise RuntimeError("approved M1 runtime has a truncated chunk header")
        length, kind = struct.unpack_from("<II", raw, offset)
        offset += 8
        if length % 4 or offset + length > total:
            raise RuntimeError("approved M1 runtime has an invalid chunk")
        chunks.append((kind, raw[offset:offset + length]))
        offset += length
    json_chunks = [data for kind, data in chunks if kind == JSON_CHUNK]
    bin_chunks = [data for kind, data in chunks if kind == BIN_CHUNK]
    if len(json_chunks) != 1 or len(bin_chunks) != 1 or len(chunks) != 2:
        raise RuntimeError("approved M1 runtime must contain exactly one JSON and one BIN chunk")
    try:
        document = json.loads(json_chunks[0].decode("utf8").rstrip(" \0"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("approved M1 runtime JSON is invalid") from error
    if not isinstance(document, dict):
        raise RuntimeError("approved M1 runtime JSON must be an object")
    return raw, document, bin_chunks[0]


def build_glb(document, binary):
    encoded = json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf8")
    encoded += b" " * ((4 - len(encoded) % 4) % 4)
    padded_binary = binary + b"\0" * ((4 - len(binary) % 4) % 4)
    body = struct.pack("<II", len(encoded), JSON_CHUNK) + encoded
    body += struct.pack("<II", len(padded_binary), BIN_CHUNK) + padded_binary
    return struct.pack("<4sII", b"glTF", 2, 12 + len(body)) + body


def png_identity(payload):
    if len(payload) < 33 or payload[:8] != b"\x89PNG\r\n\x1a\n" or payload[12:16] != b"IHDR":
        raise RuntimeError("pinned KTX tool did not emit a PNG")
    width, height, bit_depth, color_type = struct.unpack_from(">IIBB", payload, 16)
    # KTX 4.4.2 deterministically emits indexed PNG for single-channel maps and
    # RGB PNG for the color/normal maps even though the requested transcode
    # target is rgba8.  All five legal 8-bit PNG color types are import-safe.
    if width < 1 or height < 1 or bit_depth != 8 or color_type not in (0, 2, 3, 4, 6):
        raise RuntimeError("pinned KTX tool emitted an unsupported PNG")
    return {
        "sha256": sha256_bytes(payload),
        "byteLength": len(payload),
        "width": width,
        "height": height,
        "bitDepth": bit_depth,
        "colorType": color_type,
    }


def verify_pinned_tool(repo):
    tool = os.path.abspath(os.path.join(repo, *KTX_RELATIVE_PATH.split("/")))
    if os.path.commonpath((os.path.abspath(repo), tool)) != os.path.abspath(repo) or not os.path.isfile(tool) or not os.access(tool, os.X_OK):
        raise RuntimeError("pinned package-local KTX 4.4.2 binary is unavailable")
    if sha256_file(tool) != KTX_SHA256:
        raise RuntimeError("pinned package-local KTX binary hash drifted")
    environment = {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C", "TZ": "UTC"}
    result = subprocess.run([tool, "--version"], check=False, capture_output=True, text=True, env=environment)
    version = (result.stdout + result.stderr).strip()
    if result.returncode != 0 or version != KTX_VERSION:
        raise RuntimeError("pinned package-local KTX binary version drifted")
    return tool, environment


def derive_import_bridge(source_path, expected_source_sha256, output_dir, repo):
    """Write and attest a deterministic PNG-backed GLB for temporary import."""
    source_path = os.path.abspath(source_path)
    output_dir = os.path.abspath(output_dir)
    repo = os.path.abspath(repo)
    if sha256_file(source_path) != expected_source_sha256:
        raise RuntimeError("approved M1 raw byte authority drifted before bridge derivation")
    raw, source_document, source_binary_padded = read_glb(source_path)
    if sha256_bytes(raw) != expected_source_sha256:
        raise RuntimeError("approved M1 raw byte authority is inconsistent")
    if source_document.get("extensionsRequired") is None or "KHR_texture_basisu" not in source_document.get("extensionsRequired", []) or "KHR_texture_basisu" not in source_document.get("extensionsUsed", []):
        raise RuntimeError("approved M1 runtime does not require its KTX2 closure")
    images = source_document.get("images")
    textures = source_document.get("textures")
    views = source_document.get("bufferViews")
    buffers = source_document.get("buffers")
    if not isinstance(images, list) or not images or not isinstance(textures, list) or not textures or not isinstance(views, list) or len(buffers or []) != 1:
        raise RuntimeError("approved M1 KTX2 material inventory is incomplete")
    declared_length = buffers[0].get("byteLength")
    if not isinstance(declared_length, int) or declared_length < 1 or declared_length > len(source_binary_padded):
        raise RuntimeError("approved M1 BIN length is invalid")
    for texture in textures:
        basis = texture.get("extensions", {}).get("KHR_texture_basisu")
        if not isinstance(basis, dict) or set(basis) != {"source"} or not isinstance(basis["source"], int) or not 0 <= basis["source"] < len(images) or "source" in texture:
            raise RuntimeError("approved M1 texture is not an exact BasisU source binding")
    os.makedirs(output_dir, exist_ok=True)
    tool, environment = verify_pinned_tool(repo)
    document = copy.deepcopy(source_document)
    binary = bytearray(source_binary_padded[:declared_length])
    image_records = []
    for index, image in enumerate(source_document["images"]):
        if not isinstance(image, dict) or image.get("mimeType") != "image/ktx2" or not isinstance(image.get("bufferView"), int) or "uri" in image:
            raise RuntimeError("approved M1 image is not an embedded KTX2 buffer view")
        view_index = image["bufferView"]
        if not 0 <= view_index < len(views):
            raise RuntimeError("approved M1 KTX2 image buffer view is out of range")
        view = views[view_index]
        start, length = view.get("byteOffset", 0), view.get("byteLength")
        if view.get("buffer", 0) != 0 or not isinstance(start, int) or not isinstance(length, int) or start < 0 or length < 1 or start + length > declared_length:
            raise RuntimeError("approved M1 KTX2 image buffer view is invalid")
        ktx_payload = bytes(source_binary_padded[start:start + length])
        ktx_path = os.path.join(output_dir, f"image-{index:03d}.ktx2")
        png_path = os.path.join(output_dir, f"image-{index:03d}.png")
        with open(ktx_path, "wb") as handle:
            handle.write(ktx_payload)
        result = subprocess.run(
            [tool, "extract", "--testrun", "--transcode", "rgba8", ktx_path, png_path],
            check=False, capture_output=True, env=environment,
        )
        if result.returncode != 0 or result.stdout or result.stderr or not os.path.isfile(png_path):
            raise RuntimeError(f"pinned KTX transcode failed closed for M1 image {index}")
        with open(png_path, "rb") as handle:
            png_payload = handle.read()
        record = {
            "index": index,
            "name": image.get("name"),
            "sourceKtx2Sha256": sha256_bytes(ktx_payload),
            **png_identity(png_payload),
        }
        image_records.append(record)
        binary.extend(b"\0" * ((4 - len(binary) % 4) % 4))
        png_offset = len(binary)
        binary.extend(png_payload)
        document["bufferViews"].append({"buffer": 0, "byteOffset": png_offset, "byteLength": len(png_payload)})
        document["images"][index] = {key: value for key, value in image.items() if key not in ("bufferView", "mimeType")}
        document["images"][index].update({"bufferView": len(document["bufferViews"]) - 1, "mimeType": "image/png"})
    for texture in document["textures"]:
        basis = texture["extensions"].pop("KHR_texture_basisu")
        texture["source"] = basis["source"]
        if not texture["extensions"]:
            del texture["extensions"]
    for key in ("extensionsUsed", "extensionsRequired"):
        document[key] = [name for name in document.get(key, []) if name != "KHR_texture_basisu"]
        if not document[key]:
            del document[key]
    document["buffers"][0]["byteLength"] = len(binary)
    bridge_provenance = {
        "schema": SCHEMA,
        "sourceRuntimeGlbSha256": expected_source_sha256,
        "ktxTool": KTX_RELATIVE_PATH,
        "ktxToolSha256": KTX_SHA256,
        "ktxToolVersion": KTX_VERSION,
        "transcode": "extract --testrun --transcode rgba8",
        "images": image_records,
    }
    document.setdefault("asset", {}).setdefault("extras", {})["liminaM1ImportBridge"] = bridge_provenance
    bridge_bytes = build_glb(document, bytes(binary))
    bridge_path = os.path.join(output_dir, "m1-png-import-bridge.glb")
    with open(bridge_path, "wb") as handle:
        handle.write(bridge_bytes)
    identity = {
        **bridge_provenance,
        "bridgeGlbSha256": sha256_bytes(bridge_bytes),
        "bridgeDocumentSha256": canonical_hash(document),
        "materials": len(document.get("materials", [])),
        "textures": len(document["textures"]),
        "imagesCount": len(document["images"]),
    }
    return bridge_path, identity


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--repo", required=True)
    args = parser.parse_args()
    path, identity = derive_import_bridge(args.source, args.expected_sha256, args.out_dir, args.repo)
    print(json.dumps({"path": path, "identity": identity}, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
