import { createHash } from "node:crypto";
import { access, chmod, lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { portableAssetContentHash } from "../../js/src/world/asset-content-hash.mjs";

const raw = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const portable = (root, path) => relative(root, path).split(sep).join("/");
const IMPORT = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g;
const HASH = /^sha256:[0-9a-f]{64}$/;
export const CAPTURE_SOURCE_ARCHIVE_SCHEMA = "limina.capture-source-archive/v1";
const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};
async function resolveModule(from, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(from), specifier),
    candidates = extname(base)
      ? [base]
      : [
          base,
          `${base}.ts`,
          `${base}.mts`,
          `${base}.mjs`,
          `${base}.js`,
          resolve(base, "index.ts"),
          resolve(base, "index.mjs"),
          resolve(base, "index.js"),
        ];
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  throw new Error(`capture producer import cannot be resolved: ${portable(process.cwd(), from)} -> ${specifier}`);
}

export async function collectCaptureModuleClosure(repoRoot, entryPaths) {
  const pending = entryPaths.map((path) => resolve(repoRoot, path)),
    seen = new Set(),
    files = [];
  while (pending.length) {
    const path = pending.pop();
    if (seen.has(path)) continue;
    if (isAbsolute(path) && !path.startsWith(`${repoRoot}${sep}`))
      throw new Error(`capture producer source escaped workspace: ${path}`);
    seen.add(path);
    const bytes = await readFile(path),
      logical = portable(repoRoot, path);
    files.push(
      Object.freeze({
        path: logical,
        sha256: raw(bytes),
        contentHash: portableAssetContentHash(bytes),
        bytes: bytes.byteLength,
      }),
    );
    const text = bytes.toString("utf8");
    for (const match of text.matchAll(IMPORT)) {
      const dependency = await resolveModule(path, match[1]);
      if (dependency && !seen.has(dependency)) pending.push(dependency);
    }
  }
  return Object.freeze(files.sort((a, b) => a.path.localeCompare(b.path)));
}

export async function buildCaptureProducerClosure({
  repoRoot,
  entryPaths,
  runtimeBinary,
  argv,
  environmentKeys = Object.keys(process.env),
}) {
  const sources = await collectCaptureModuleClosure(repoRoot, entryPaths),
    binaryPath = resolve(repoRoot, runtimeBinary),
    binaryBytes = await readFile(binaryPath),
    orchestratorBytes = await readFile(process.execPath),
    bun = typeof Bun === "object" && Bun !== null ? Bun : undefined;
  const execution = Object.freeze({
    binary: Object.freeze({
      path: runtimeBinary,
      sha256: raw(binaryBytes),
      contentHash: portableAssetContentHash(binaryBytes),
      bytes: binaryBytes.byteLength,
    }),
    orchestrator: Object.freeze({
      kind: bun === undefined ? "node" : "bun",
      version: bun === undefined ? process.version : bun.version,
      sha256: raw(orchestratorBytes),
      bytes: orchestratorBytes.byteLength,
    }),
    entrySources: Object.freeze([...entryPaths]),
    sources,
    argv: Object.freeze([...argv]),
    platform: Object.freeze({ arch: process.arch, os: process.platform }),
    timestampEnvironmentKeys: Object.freeze(environmentKeys.filter((key) => /TIMESTAMP/i.test(key)).sort()),
  });
  if (execution.timestampEnvironmentKeys.length)
    throw new Error(
      `capture producer inherited timestamp-risk environment keys: ${execution.timestampEnvironmentKeys.join(",")}`,
    );
  return execution;
}

async function exactSourcePath(repoRoot, logical) {
  if (
    typeof logical !== "string" ||
    !logical ||
    isAbsolute(logical) ||
    logical.includes("\\") ||
    logical.split("/").some((segment) => !segment || segment === "." || segment === "..")
  )
    throw new Error(`capture source path is not workspace-relative: ${logical}`);
  const workspace = await realpath(resolve(repoRoot)),
    absolute = resolve(workspace, logical);
  if (!absolute.startsWith(`${workspace}${sep}`)) throw new Error(`capture source escaped workspace: ${logical}`);
  const sourceStat = await lstat(absolute);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink())
    throw new Error(`capture source is not a regular non-symlink file: ${logical}`);
  const canonical = await realpath(absolute);
  if (canonical !== absolute || !canonical.startsWith(`${workspace}${sep}`))
    throw new Error(`capture source traversed a symlink or escaped workspace: ${logical}`);
  return absolute;
}

async function exactSource(repoRoot, source) {
  const absolute = await exactSourcePath(repoRoot, source?.path),
    bytes = await readFile(absolute),
    sha256 = raw(bytes),
    contentHash = portableAssetContentHash(bytes);
  if (!HASH.test(source?.sha256) || source.sha256 !== sha256)
    throw new Error(`capture source SHA-256 drifted: ${source?.path}`);
  if (source.contentHash !== undefined && source.contentHash !== contentHash)
    throw new Error(`capture source content hash drifted: ${source.path}`);
  if (source.bytes !== undefined && source.bytes !== bytes.byteLength)
    throw new Error(`capture source byte length drifted: ${source.path}`);
  return {
    bytes,
    record: {
      path: source.path,
      sha256,
      contentHash,
      bytes: bytes.byteLength,
      archivePath: `source-archive/${sha256.slice("sha256:".length)}.blob`,
    },
  };
}

/**
 * Materialize the complete source closure beside a newly staged capture.
 * There is intentionally no hash-only representation in this schema: failure
 * to read and archive any declared source aborts the producer before evidence
 * can be emitted.
 */
export async function writeCaptureSourceArchive({ repoRoot, outputRoot, sources }) {
  if (!Array.isArray(sources) || sources.length < 1)
    throw new Error("new capture requires a non-empty producer source closure");
  if (new Set(sources.map((entry) => entry?.path)).size !== sources.length)
    throw new Error("capture producer source paths must be unique");
  const resolved = [];
  for (const source of [...sources].sort((a, b) => a.path.localeCompare(b.path))) {
    resolved.push(await exactSource(resolve(repoRoot), source));
  }
  const archiveRoot = resolve(outputRoot, "source-archive");
  await mkdir(archiveRoot, { recursive: false, mode: 0o700 });
  for (const entry of resolved) {
    const destination = resolve(outputRoot, entry.record.archivePath);
    await writeFile(destination, entry.bytes, { flag: "wx", mode: 0o444 }).catch(async (error) => {
      if (error?.code !== "EEXIST") throw error;
      if (raw(await readFile(destination)) !== entry.record.sha256)
        throw new Error(`capture source archive collision: ${entry.record.archivePath}`);
    });
    await chmod(destination, 0o444);
  }
  const manifest = {
      schema: CAPTURE_SOURCE_ARCHIVE_SCHEMA,
      completeness: "complete",
      sourceCount: resolved.length,
      sources: resolved.map(({ record }) => record),
    },
    manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    manifestPath = resolve(archiveRoot, "manifest.json");
  await writeFile(manifestPath, manifestBytes, { flag: "wx", mode: 0o400 });
  await chmod(manifestPath, 0o400);
  return Object.freeze({
    schema: CAPTURE_SOURCE_ARCHIVE_SCHEMA,
    completeness: "complete",
    sourceCount: resolved.length,
    manifest: Object.freeze({
      path: "source-archive/manifest.json",
      sha256: raw(manifestBytes),
      contentHash: portableAssetContentHash(manifestBytes),
      bytes: manifestBytes.byteLength,
    }),
  });
}

export async function verifyCaptureSourceArchive({ evidenceRoot, record, expectedSources }) {
  if (
    record?.schema !== CAPTURE_SOURCE_ARCHIVE_SCHEMA ||
    record.completeness !== "complete" ||
    record.manifest?.path !== "source-archive/manifest.json" ||
    !HASH.test(record.manifest?.sha256) ||
    !HASH.test(record.manifest?.contentHash) ||
    !Number.isSafeInteger(record.manifest?.bytes) ||
    record.manifest.bytes < 1
  )
    throw new Error("capture source archive record is incomplete");
  const manifestPath = resolve(evidenceRoot, record.manifest.path),
    manifestBytes = await readFile(manifestPath);
  if (
    raw(manifestBytes) !== record.manifest.sha256 ||
    portableAssetContentHash(manifestBytes) !== record.manifest.contentHash ||
    manifestBytes.byteLength !== record.manifest.bytes
  )
    throw new Error("capture source archive manifest drifted");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (
    manifest.schema !== CAPTURE_SOURCE_ARCHIVE_SCHEMA ||
    manifest.completeness !== "complete" ||
    !Number.isSafeInteger(manifest.sourceCount) ||
    manifest.sourceCount < 1 ||
    !Array.isArray(manifest.sources) ||
    manifest.sources.length !== manifest.sourceCount ||
    record.sourceCount !== manifest.sourceCount ||
    new Set(manifest.sources.map((entry) => entry.path)).size !== manifest.sources.length
  )
    throw new Error("capture source archive manifest is incomplete");
  for (const source of manifest.sources) {
    if (
      !HASH.test(source.sha256) ||
      !HASH.test(source.contentHash) ||
      !Number.isSafeInteger(source.bytes) ||
      source.bytes < 1 ||
      source.archivePath !== `source-archive/${source.sha256.slice("sha256:".length)}.blob`
    )
      throw new Error(`capture source archive entry is incomplete: ${source.path}`);
    const bytes = await readFile(resolve(evidenceRoot, source.archivePath));
    if (
      raw(bytes) !== source.sha256 ||
      portableAssetContentHash(bytes) !== source.contentHash ||
      bytes.byteLength !== source.bytes
    )
      throw new Error(`capture source archive bytes drifted: ${source.path}`);
    if ((await stat(resolve(evidenceRoot, source.archivePath))).mode & 0o111)
      throw new Error(`capture source archive is executable: ${source.archivePath}`);
  }
  if (expectedSources !== undefined) {
    if (!Array.isArray(expectedSources) || expectedSources.length !== manifest.sources.length)
      throw new Error("capture source archive does not cover the declared producer closure");
    const expected = [...expectedSources]
      .map(({ path, sha256, contentHash, bytes }) => ({ path, sha256, contentHash, bytes }))
      .sort((a, b) => a.path.localeCompare(b.path));
    const archived = manifest.sources.map(({ archivePath: _, ...entry }) => entry);
    if (JSON.stringify(expected) !== JSON.stringify(archived))
      throw new Error("capture source archive does not match the declared producer closure");
  }
  return manifest;
}
