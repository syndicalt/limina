import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, extname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  args = process.argv.slice(2),
  at = (flag) => {
    const i = args.indexOf(flag);
    if (i < 0 || !args[i + 1])
      throw new Error("usage: node tools/reference/acquire-visual-reference-board.mjs --manifest <json> --out <json>");
    return resolve(args[i + 1]);
  },
  manifestPath = at("--manifest"),
  outputPath = at("--out"),
  manifest = JSON.parse(await readFile(manifestPath, "utf8")),
  cacheRoot = resolve(repo, "art-direction/reference-cache");
let previousSources = new Map();
try {
  const previous = JSON.parse(await readFile(outputPath, "utf8"));
  previousSources = new Map((previous.sources ?? []).map((source) => [source.id, source]));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
if (
  manifest.schema !== "limina.visual-reference-acquisition/v1" ||
  !Array.isArray(manifest.sources) ||
  manifest.sources.length === 0
)
  throw new Error("unsupported or empty visual reference acquisition manifest");
const acquired = [];
for (const source of manifest.sources) {
  if (!/^[a-z0-9][a-z0-9._/-]+$/.test(source.id) || !source.creator || !source.license || source.license === "unknown")
    throw new Error("reference source requires stable id, creator, and explicit license");
  for (const field of ["sourceUrl", "imageUrl"]) {
    const url = new URL(source[field]);
    if (url.protocol !== "https:") throw new Error("reference acquisition requires HTTPS source and image URLs");
  }
  const extension = extname(new URL(source.imageUrl).pathname).toLowerCase();
  if (![".jpg", ".jpeg", ".png", ".webp"].includes(extension))
    throw new Error(`unsupported reference image extension ${extension}`);
  const localPath = resolve(cacheRoot, `${source.id}${extension === ".jpeg" ? ".jpg" : extension}`);
  if (localPath !== cacheRoot && !localPath.startsWith(`${cacheRoot}/`))
    throw new Error("reference id escaped cache root");
  const response = await fetch(source.imageUrl, {
    redirect: "follow",
    headers: { "user-agent": "Limina reference acquisition/1.0", range: "bytes=0-" },
  });
  if (!response.ok) throw new Error(`reference download failed ${response.status}: ${source.imageUrl}`);
  if (new URL(response.url).protocol !== "https:") throw new Error("reference download redirected away from HTTPS");
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) throw new Error(`reference response is not an image: ${contentType}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 1024 || bytes.length > 20 * 1024 * 1024)
    throw new Error(`reference image byte length is outside policy: ${bytes.length}`);
  await mkdir(dirname(localPath), { recursive: true });
  await writeFile(localPath, bytes, { mode: 0o600 });
  const record = {
      id: source.id,
      sourceUrl: source.sourceUrl,
      imageUrl: source.imageUrl,
      creator: source.creator,
      license: source.license,
      retrievedAt: new Date().toISOString(),
      localPath: relative(repo, localPath).split(sep).join("/"),
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      bytes: bytes.length,
      roles: source.roles,
    },
    previous = previousSources.get(source.id),
    stable = ["id", "sourceUrl", "imageUrl", "creator", "license", "localPath", "sha256", "bytes", "roles"];
  if (
    previous &&
    stable.every((field) => JSON.stringify(previous[field]) === JSON.stringify(record[field])) &&
    Number.isFinite(Date.parse(previous.retrievedAt))
  )
    record.retrievedAt = previous.retrievedAt;
  acquired.push(record);
}
const board = {
  schema: "limina.visual-reference-board/v1",
  id: manifest.id,
  subjectKind: manifest.subjectKind,
  acquisitionManifest: relative(repo, manifestPath).split(sep).join("/"),
  sources: acquired,
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(board, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(board, null, 2));
