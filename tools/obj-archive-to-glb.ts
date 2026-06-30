// HOST-SIDE converter — turns a 3D AI Studio (Hunyuan/tencent) result ARCHIVE into a single binary .glb
// with a proper glTF metallic-roughness PBR material. Runs under `bun` (has fs + npm); it is NEVER
// imported by the sandboxed limina engine — it is injected into GenerativeAssetSource as the
// `convertArchive` seam (see tools/asset-fetch.ts + js/src/asset/generative-source.ts).
//
// THE ARCHIVE (confirmed shape): a `<hash>.obj` (geometry, often with NO vertex normals), a
// `material.mtl`, and SEPARATE PBR PNGs — albedo (map_Kd), metallic (map_Pm), roughness (map_Pr) and
// normal (map_Bump). glTF wants a SINGLE packed metallic-roughness texture (G = roughness, B = metalness
// per the glTF 2.0 spec), so the separate roughness/metallic PNGs are channel-packed with `sharp`.
//
// PIPELINE: fflate unzips in-memory → obj2gltf parses the OBJ geometry + baseColor + normal map from the
// MTL → @gltf-transform/core attaches the sharp-packed metallicRoughnessTexture, sets metallicFactor =
// roughnessFactor = 1, and (re)generates smooth vertex normals when the OBJ shipped none → a valid .glb.
//
// SELFTEST:  bun run tools/obj-archive-to-glb.ts --selftest <archive.zip> [<out.glb>]

import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { Document, NodeIO, type Primitive } from "@gltf-transform/core";
import sharp from "sharp";
// obj2gltf is CommonJS; bun resolves the default export.
import obj2gltf from "obj2gltf";

/** A parsed archive: the extracted files keyed by their in-zip name, plus the resolved roles. */
interface ParsedArchive {
  files: Record<string, Uint8Array>;
  objName: string;
  mtlName?: string;
  albedo?: string;
  metallic?: string;
  roughness?: string;
  normal?: string;
}

/** Find a file in the archive by exact (basename) name, case-insensitive. */
function findFile(files: Record<string, Uint8Array>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const k of Object.keys(files)) {
    const base = k.split("/").pop()!.toLowerCase();
    if (base === target) return k;
  }
  return undefined;
}

/** Parse the MTL to resolve the PBR PNG roles by their map_* directives (the robust path), then fall back
 *  to filename heuristics (_metallic/_roughness/_normal) for any role the MTL left implicit. */
function resolveRoles(arc: ParsedArchive): void {
  const { files } = arc;
  if (arc.mtlName && files[arc.mtlName]) {
    const mtl = new TextDecoder().decode(files[arc.mtlName]);
    for (const raw of mtl.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const sp = line.split(/\s+/);
      const key = sp[0].toLowerCase();
      // The texture path is the LAST token (map_Bump may carry `-bm <n>` options before the filename).
      const file = sp[sp.length - 1];
      const resolved = findFile(files, file.split(/[\\/]/).pop() ?? file);
      if (!resolved) continue;
      if (key === "map_kd") arc.albedo = resolved;
      else if (key === "map_pm") arc.metallic = resolved;
      else if (key === "map_pr") arc.roughness = resolved;
      else if (key === "map_bump" || key === "bump" || key === "norm" || key === "map_normal") arc.normal = resolved;
    }
  }
  // Heuristic fallback by filename suffix for any unresolved role.
  for (const k of Object.keys(files)) {
    if (!/\.png$/i.test(k)) continue;
    const base = k.toLowerCase();
    if (!arc.metallic && base.includes("metallic")) arc.metallic = k;
    else if (!arc.roughness && base.includes("roughness")) arc.roughness = k;
    else if (!arc.normal && base.includes("normal")) arc.normal = k;
    else if (!arc.albedo && (base.includes("albedo") || base.includes("basecolor") || base.includes("_pbr_v"))) {
      // the bare `texture_pbr_v128.png` (no role suffix) is the albedo/baseColor.
      if (!/_(metallic|roughness|normal)\b/.test(base)) arc.albedo = k;
    }
  }
}

/** Unzip the archive in-memory and resolve the OBJ + MTL + PBR-PNG roles. */
function parseArchive(zipBytes: Uint8Array): ParsedArchive {
  const files = unzipSync(zipBytes) as Record<string, Uint8Array>;
  let objName: string | undefined;
  let mtlName: string | undefined;
  for (const k of Object.keys(files)) {
    if (/\.obj$/i.test(k)) objName = k;
    else if (/\.mtl$/i.test(k)) mtlName = k;
  }
  if (!objName) throw new Error("objArchiveToGlb: no .obj geometry found in the archive.");
  const arc: ParsedArchive = { files, objName, mtlName };
  resolveRoles(arc);
  return arc;
}

/** Channel-pack the separate roughness + metallic grayscale PNGs into ONE glTF metallic-roughness
 *  texture: R = 255 (unused/occlusion-white), G = roughness, B = metalness. Both inputs are resized to a
 *  common size (the roughness map's, else the metallic map's). Returns PNG bytes. */
async function packMetallicRoughness(roughPng?: Uint8Array, metalPng?: Uint8Array): Promise<Uint8Array | undefined> {
  if (!roughPng && !metalPng) return undefined;
  // Pick the reference size from whichever map exists (prefer roughness).
  const refBuf = roughPng ?? metalPng!;
  const meta = await sharp(refBuf).metadata();
  const w = meta.width ?? 1024;
  const h = meta.height ?? 1024;

  const grayChannel = async (png: Uint8Array | undefined, fill: number): Promise<Buffer> => {
    if (!png) return Buffer.alloc(w * h, fill);
    return await sharp(png).resize(w, h, { fit: "fill" }).grayscale().raw().toBuffer(); // 1 byte/pixel
  };
  const rough = await grayChannel(roughPng, 255); // default rough if absent
  const metal = await grayChannel(metalPng, 0); // default non-metal if absent

  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    rgb[i * 3 + 0] = 255; // R — occlusion-white / unused
    rgb[i * 3 + 1] = rough[i]; // G — roughness (glTF spec)
    rgb[i * 3 + 2] = metal[i]; // B — metalness (glTF spec)
  }
  const out = await sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  return new Uint8Array(out);
}

/** Generate smooth (area-weighted) per-vertex normals for any primitive missing a NORMAL attribute.
 *  3D AI Studio's OBJ often ships zero `vn` lines; without this the GLB renders flat-shaded. */
function generateNormalsIfMissing(doc: Document): void {
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getAttribute("NORMAL")) continue;
      const pos = prim.getAttribute("POSITION");
      if (!pos) continue;
      const idxAcc = prim.getIndices();
      const vCount = pos.getCount();
      const normals = new Float32Array(vCount * 3);
      const indices: number[] = [];
      if (idxAcc) {
        for (let i = 0; i < idxAcc.getCount(); i++) indices.push(idxAcc.getScalar(i));
      } else {
        for (let i = 0; i < vCount; i++) indices.push(i);
      }
      const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0];
      for (let t = 0; t < indices.length; t += 3) {
        const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2];
        pos.getElement(i0, a); pos.getElement(i1, b); pos.getElement(i2, c);
        const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
        const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];
        // cross(e1,e2) — magnitude is proportional to triangle area (area weighting).
        const nx = e1y * e2z - e1z * e2y;
        const ny = e1z * e2x - e1x * e2z;
        const nz = e1x * e2y - e1y * e2x;
        for (const i of [i0, i1, i2]) {
          normals[i * 3 + 0] += nx; normals[i * 3 + 1] += ny; normals[i * 3 + 2] += nz;
        }
      }
      for (let i = 0; i < vCount; i++) {
        const x = normals[i * 3], y = normals[i * 3 + 1], z = normals[i * 3 + 2];
        const len = Math.hypot(x, y, z) || 1;
        normals[i * 3] = x / len; normals[i * 3 + 1] = y / len; normals[i * 3 + 2] = z / len;
      }
      const nAcc = doc.createAccessor()
        .setType("VEC3")
        .setArray(normals)
        .setBuffer(doc.getRoot().listBuffers()[0] ?? doc.createBuffer());
      prim.setAttribute("NORMAL", nAcc);
    }
  }
}

/**
 * Convert a 3D AI Studio result archive (zip bytes) into a single binary .glb with a glTF
 * metallic-roughness PBR material:
 *   - baseColorTexture        = albedo PNG (map_Kd)
 *   - metallicRoughnessTexture = sharp-packed (G = roughness, B = metalness)
 *   - normalTexture           = normal PNG (map_Bump)
 *   - metallicFactor = roughnessFactor = 1
 */
export async function objArchiveToGlb(zipBytes: Uint8Array): Promise<Uint8Array> {
  const arc = parseArchive(zipBytes);

  // obj2gltf reads texture files referenced by the MTL off disk, so stage the archive in a temp dir.
  const dir = mkdtempSync(join(tmpdir(), "limina-objglb-"));
  try {
    for (const [name, bytes] of Object.entries(arc.files)) {
      // Flatten any in-zip subdirs to basenames so the MTL's relative refs resolve in one dir.
      const base = name.split("/").pop()!;
      if (base) writeFileSync(join(dir, base), bytes);
    }
    const objPath = join(dir, arc.objName.split("/").pop()!);

    // Step 1 — geometry + baseColor + normal map via obj2gltf (binary glb, textures embedded).
    const glbBuf: Buffer = await obj2gltf(objPath, { separate: false, binary: true });

    // Step 2 — load into gltf-transform and attach the packed metallic-roughness + finalize the material.
    const io = new NodeIO();
    const doc = await io.readBinary(new Uint8Array(glbBuf));
    const root = doc.getRoot();

    const mat = root.listMaterials()[0] ?? doc.createMaterial("Material");

    // baseColorTexture — ensure it's set (obj2gltf maps map_Kd); fall back to the resolved albedo PNG.
    if (!mat.getBaseColorTexture() && arc.albedo) {
      const tex = doc.createTexture("baseColor").setMimeType("image/png").setImage(arc.files[arc.albedo]);
      mat.setBaseColorTexture(tex);
    }
    mat.setBaseColorFactor([1, 1, 1, 1]);

    // normalTexture — ensure it's set (obj2gltf maps map_Bump); fall back to the resolved normal PNG.
    if (!mat.getNormalTexture() && arc.normal) {
      const tex = doc.createTexture("normal").setMimeType("image/png").setImage(arc.files[arc.normal]);
      mat.setNormalTexture(tex);
    }

    // metallicRoughnessTexture — the packed (G=roughness, B=metalness) map. This is the piece obj2gltf
    // can't produce from separate map_Pm/map_Pr PNGs.
    const packed = await packMetallicRoughness(
      arc.roughness ? arc.files[arc.roughness] : undefined,
      arc.metallic ? arc.files[arc.metallic] : undefined,
    );
    if (packed) {
      const tex = doc.createTexture("metallicRoughness").setMimeType("image/png").setImage(packed);
      mat.setMetallicRoughnessTexture(tex);
    }
    // glTF spec: factors multiply the texture channels — keep them at 1 so the packed map is authoritative.
    mat.setMetallicFactor(1);
    mat.setRoughnessFactor(1);

    // Make sure every primitive references the finalized material.
    for (const mesh of root.listMeshes()) {
      for (const prim of mesh.listPrimitives() as Primitive[]) prim.setMaterial(mat);
    }

    // 3D AI Studio OBJs frequently ship no vertex normals — generate smooth normals so the GLB isn't flat.
    generateNormalsIfMissing(doc);

    const out = await io.writeBinary(doc);
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── selftest CLI ──────────────────────────────────────────────────────────────
if (import.meta.main) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--selftest");
  if (i !== -1) {
    const zipPath = argv[i + 1];
    const outPath = argv[i + 2] ?? zipPath.replace(/\.zip$/i, "") + "_converted.glb";
    if (!zipPath || !existsSync(zipPath)) {
      console.error(`obj-archive-to-glb --selftest: missing/invalid zip path: ${zipPath}`);
      process.exit(2);
    }
    const zip = new Uint8Array(readFileSync(zipPath));
    const glb = await objArchiveToGlb(zip);
    writeFileSync(outPath, glb);

    // Validate: glTF magic header + parses back with a PBR material carrying all three textures.
    const magic = new TextDecoder().decode(glb.slice(0, 4));
    const io = new NodeIO();
    const doc = await io.readBinary(glb);
    const root = doc.getRoot();
    const meshes = root.listMeshes();
    const mat = root.listMaterials()[0];
    const report = {
      out: outPath,
      bytes: glb.length,
      magic,
      meshes: meshes.length,
      primitives: meshes.reduce((n, m) => n + m.listPrimitives().length, 0),
      materials: root.listMaterials().length,
      textures: root.listTextures().length,
      hasBaseColor: !!mat?.getBaseColorTexture(),
      hasMetallicRoughness: !!mat?.getMetallicRoughnessTexture(),
      hasNormal: !!mat?.getNormalTexture(),
      metallicFactor: mat?.getMetallicFactor(),
      roughnessFactor: mat?.getRoughnessFactor(),
      hasNormals: meshes.some((m) => m.listPrimitives().some((p) => !!p.getAttribute("NORMAL"))),
    };
    console.log(JSON.stringify(report, null, 2));
    if (magic !== "glTF") { console.error("FAIL: bad glb magic"); process.exit(1); }
    if (!report.meshes || !report.hasBaseColor || !report.hasMetallicRoughness || !report.hasNormal) {
      console.error("FAIL: glb missing a required mesh/PBR texture"); process.exit(1);
    }
    console.error("SELFTEST OK");
  } else {
    console.error("usage: bun run tools/obj-archive-to-glb.ts --selftest <archive.zip> [<out.glb>]");
    process.exit(2);
  }
}
