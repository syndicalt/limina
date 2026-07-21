import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, mkdir, opendir, readFile, readlink, writeFile } from "node:fs/promises";
import { hostname, arch, platform } from "node:os";
import { dirname, isAbsolute, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const policyPath = resolve(root, "tools/handoff/dgx-spark-transfer-policy.json");
const defaultManifest = resolve(root, ".limina/handoff/dgx-spark-workspace.manifest.json");
const MANIFEST_SCHEMA = "limina.workspace-transfer-manifest/v1";

function fail(message) {
  throw new Error(`workspace transfer: ${message}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function toolVersion(command, args = ["--version"]) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 10_000 });
  if (result.error || result.status !== 0) return null;
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n")[0] || null;
}

function toolchain() {
  return {
    node: process.version,
    npm: toolVersion("npm"),
    bun: toolVersion("bun"),
    pnpm: toolVersion("pnpm"),
    rustc: toolVersion("rustc"),
    cargo: toolVersion("cargo"),
    python: toolVersion("python3"),
    zaxy: toolVersion("zaxy"),
    rsync: toolVersion("rsync"),
  };
}

function git(args, encoding = "utf8") {
  return execFileSync("git", args, { cwd: root, encoding, maxBuffer: 256 * 1024 * 1024 });
}

function gitFsckIdentity() {
  const result = spawnSync("git", ["fsck", "--full", "--no-progress", "--no-reflogs"], {
    cwd: root, encoding: null, maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`git fsck failed: ${Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)]).toString("utf8")}`);
  return sha256(Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)]));
}

function normalizedRelative(target) {
  const value = relative(root, resolve(target)).split("\\").join("/");
  if (value === "" || value === "." || value === ".." || value.startsWith("../") || isAbsolute(value)) {
    fail(`path is not a contained workspace file: ${target}`);
  }
  return posix.normalize(value);
}

function validatePolicy(policy) {
  if (policy?.schema !== "limina.workspace-transfer-policy/v1"
      || !Array.isArray(policy.manifestExcludedRootPrefixes)
      || !Array.isArray(policy.manifestExcludedDirectoryNames)
      || typeof policy.manifestOutputPrefix !== "string"
      || !Array.isArray(policy.rsyncExcludes)) {
    fail("transfer policy is malformed");
  }
  return policy;
}

async function loadPolicy() {
  return validatePolicy(JSON.parse(await readFile(policyPath, "utf8")));
}

function excluded(path, isDirectory, policy) {
  const clean = path.replace(/^\.\//, "").replace(/\/$/, "");
  if (clean.startsWith(policy.manifestOutputPrefix) && clean.endsWith(".manifest.json")) return true;
  for (const prefix of policy.manifestExcludedRootPrefixes) {
    if (clean === prefix || clean.startsWith(`${prefix}/`)) return true;
  }
  if (isDirectory) {
    const leaf = clean.slice(clean.lastIndexOf("/") + 1);
    if (policy.manifestExcludedDirectoryNames.includes(leaf)) return true;
  }
  return false;
}

async function collectPortablePaths(policy) {
  const files = [];
  async function visit(directory, relativeDirectory = "") {
    const entries = [];
    for await (const entry of await opendir(directory)) entries.push(entry);
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      const path = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (excluded(path, entry.isDirectory(), policy)) continue;
      const absolute = resolve(root, path);
      if (entry.isDirectory()) await visit(absolute, path);
      else files.push({ path, absolute });
    }
  }
  await visit(root);
  return files;
}

async function hashFile(path) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.byteLength;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function mapLimit(items, limit, operation) {
  const result = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      result[index] = await operation(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, worker));
  return result;
}

async function describeFiles(policy) {
  const paths = await collectPortablePaths(policy);
  return mapLimit(paths, 8, async ({ path, absolute }) => {
    const stat = await lstat(absolute);
    const mode = stat.mode & 0o777;
    if (stat.isSymbolicLink()) {
      const target = await readlink(absolute);
      return { path, kind: "symlink", target, mode };
    }
    if (!stat.isFile()) fail(`portable set contains unsupported filesystem object '${path}'`);
    const identity = await hashFile(absolute);
    return { path, kind: "file", ...identity, mode };
  });
}

function gitState() {
  const status = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], null);
  const diff = git(["diff", "--binary", "--no-ext-diff"], null);
  const cached = git(["diff", "--cached", "--binary", "--no-ext-diff"], null);
  let branch = null;
  try { branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"]).trim(); } catch { /* detached */ }
  const refs = git(["for-each-ref", "--sort=refname", "--format=%(refname)%00%(objectname)%00%(symref)", "refs/"], null);
  const worktreeList = git(["worktree", "list", "--porcelain", "-z"], null);
  const linkedWorktrees = worktreeList.toString("utf8").split("\0\0").map((record) => {
    const path = record.split("\0").find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    if (path === undefined) return null;
    const worktreeStatus = execFileSync("git", ["-C", path, "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      encoding: null, maxBuffer: 256 * 1024 * 1024,
    });
    return { path, statusPorcelainV1ZSha256: sha256(worktreeStatus),
      statusEntryCount: worktreeStatus.length === 0 ? 0 : worktreeStatus.toString("utf8").split("\0").filter(Boolean).length };
  }).filter(Boolean);
  return {
    head: git(["rev-parse", "HEAD"]).trim(),
    branch,
    statusPorcelainV1ZSha256: sha256(status),
    statusEntryCount: status.length === 0 ? 0 : status.toString("utf8").split("\0").filter(Boolean).length,
    worktreeBinaryDiffSha256: sha256(diff),
    cachedBinaryDiffSha256: sha256(cached),
    refsSha256: sha256(refs),
    worktreeListPorcelainSha256: sha256(worktreeList),
    linkedWorktrees,
    fsckOutputSha256: gitFsckIdentity(),
  };
}

function totalBytes(files) {
  return files.reduce((sum, entry) => sum + (entry.kind === "file" ? entry.bytes : 0), 0);
}

async function eventLoomState() {
  const path = resolve(root, ".eventloom/limina-default.jsonl");
  const bytes = await readFile(path);
  const lines = bytes.toString("utf8").trimEnd().split("\n");
  const latest = JSON.parse(lines.at(-1));
  const sequence = Number(latest.id?.match(/_([0-9]{12})_/)?.[1]);
  if (!Number.isSafeInteger(sequence) || typeof latest.integrity?.hash !== "string") {
    fail("limina-default EventLoom ledger does not end in a sequenced integrity event");
  }
  return { path: ".eventloom/limina-default.jsonl", bytes: bytes.byteLength, sha256: sha256(bytes),
    eventCount: lines.length, latestSequence: sequence, latestEventId: latest.id,
    latestIntegrityHash: latest.integrity.hash };
}

function manifestPath(argument) {
  const target = resolve(root, argument ?? defaultManifest);
  normalizedRelative(target);
  return target;
}

async function createManifest(target) {
  const policy = await loadPolicy();
  const files = await describeFiles(policy);
  const manifest = {
    schema: MANIFEST_SCHEMA,
    createdAt: new Date().toISOString(),
    purpose: "lossless-laptop-to-dgx-spark-resume",
    source: { hostname: hostname(), platform: platform(), arch: arch(), workspaceBasename: "limina",
      toolchain: toolchain() },
    policy,
    git: gitState(),
    eventLoom: await eventLoomState(),
    inventory: { fileCount: files.filter((entry) => entry.kind === "file").length,
      symlinkCount: files.filter((entry) => entry.kind === "symlink").length,
      totalBytes: totalBytes(files) },
    files,
  };
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  console.log(JSON.stringify({ manifest: normalizedRelative(target), ...manifest.inventory, git: manifest.git }, null, 2));
}

function safeManifest(value) {
  if (value?.schema !== MANIFEST_SCHEMA || !Array.isArray(value.files)) fail("manifest schema or file list is invalid");
  validatePolicy(value.policy);
  const seen = new Set();
  for (const entry of value.files) {
    if (typeof entry?.path !== "string" || entry.path === "" || entry.path.startsWith("/")
        || entry.path.includes("../") || posix.normalize(entry.path) !== entry.path || seen.has(entry.path)) {
      fail("manifest contains an unsafe or duplicate path");
    }
    seen.add(entry.path);
  }
  return value;
}

async function verifyManifest(target) {
  const manifest = safeManifest(JSON.parse(await readFile(target, "utf8")));
  const actualPaths = await collectPortablePaths(manifest.policy);
  const expected = new Map(manifest.files.map((entry) => [entry.path, entry]));
  const actualSet = new Set(actualPaths.map((entry) => entry.path));
  const errors = [];
  for (const path of expected.keys()) if (!actualSet.has(path)) errors.push(`missing ${path}`);
  for (const path of actualSet) if (!expected.has(path)) errors.push(`unexpected ${path}`);
  await mapLimit(actualPaths.filter(({ path }) => expected.has(path)), 8, async ({ path, absolute }) => {
    const wanted = expected.get(path);
    const stat = await lstat(absolute);
    const mode = stat.mode & 0o777;
    if (mode !== wanted.mode) errors.push(`mode ${path}: ${mode.toString(8)} != ${wanted.mode.toString(8)}`);
    if (wanted.kind === "symlink") {
      if (!stat.isSymbolicLink()) errors.push(`kind ${path}: expected symlink`);
      else if (await readlink(absolute) !== wanted.target) errors.push(`target ${path}: symlink changed`);
      return;
    }
    if (!stat.isFile()) { errors.push(`kind ${path}: expected file`); return; }
    if (stat.size !== wanted.bytes) { errors.push(`size ${path}: ${stat.size} != ${wanted.bytes}`); return; }
    const identity = await hashFile(absolute);
    if (identity.sha256 !== wanted.sha256) errors.push(`sha256 ${path}: ${identity.sha256} != ${wanted.sha256}`);
  });
  const currentGit = gitState();
  for (const key of ["head", "branch", "statusPorcelainV1ZSha256", "statusEntryCount",
    "worktreeBinaryDiffSha256", "cachedBinaryDiffSha256", "refsSha256",
    "worktreeListPorcelainSha256", "fsckOutputSha256"]) {
    if (currentGit[key] !== manifest.git[key]) errors.push(`git ${key}: ${currentGit[key]} != ${manifest.git[key]}`);
  }
  if (JSON.stringify(currentGit.linkedWorktrees) !== JSON.stringify(manifest.git.linkedWorktrees)) {
    errors.push("git linkedWorktrees: registered or dirty linked-worktree state changed");
  }
  const currentEventLoom = await eventLoomState();
  if (JSON.stringify(currentEventLoom) !== JSON.stringify(manifest.eventLoom)) {
    errors.push("EventLoom limina-default ledger identity changed");
  }
  if (errors.length > 0) {
    console.error(errors.slice(0, 100).join("\n"));
    if (errors.length > 100) console.error(`... ${errors.length - 100} more mismatch(es)`);
    fail(`verification failed with ${errors.length} mismatch(es)`);
  }
  console.log(JSON.stringify({ verified: normalizedRelative(target), ...manifest.inventory,
    sourceMachine: manifest.source, destinationMachine: { hostname: hostname(), platform: platform(), arch: arch() },
    destinationToolchain: toolchain(), git: currentGit, eventLoom: currentEventLoom }, null, 2));
}

async function transfer(target, destination) {
  if (typeof destination !== "string" || destination.trim() === "" || destination === "/" || !destination.endsWith("/")) {
    fail("destination must be a non-root directory ending in '/', for example user@spark:/home/user/Projects/limina/");
  }
  await verifyManifest(target);
  const policy = await loadPolicy();
  const args = ["-aHS", "--no-owner", "--no-group", "--partial", "--delay-updates", "--safe-links", "--human-readable",
    "--info=progress2", "--protect-args"];
  for (const pattern of policy.rsyncExcludes) args.push(`--exclude=${pattern}`);
  args.push(`${root}/`, destination);
  console.log(`Transferring the verified portable workspace to ${destination}`);
  const result = spawnSync("rsync", args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`rsync exited ${result.status}`);
  console.log(`Transfer complete. On the Spark run:\n  node tools/handoff/workspace-transfer-manifest.mjs verify ${normalizedRelative(target)}`);
}

const [command = "", argument, destination] = process.argv.slice(2);
try {
  const target = manifestPath(argument);
  if (command === "create") await createManifest(target);
  else if (command === "verify") await verifyManifest(target);
  else if (command === "transfer") await transfer(target, destination);
  else fail("usage: workspace-transfer-manifest.mjs create|verify [manifest] OR transfer [manifest] <destination/>");
} catch (error) {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
}
