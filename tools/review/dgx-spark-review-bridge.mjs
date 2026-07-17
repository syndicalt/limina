#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  unlink,
} from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_PORT = 4178;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const APPROVED_CHECKPOINT_SHA256 = "232e84925ff4fd951159feb6d35a602d04b50ac753bf78e09692582d3304d173";
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

export const WORKSPACE_ROOT = resolve(moduleDirectory, "../..");
export const DEFAULT_ARTIFACT_DIRECTORY = join(WORKSPACE_ROOT, ".limina", "review-artifacts");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function inspectPng(bytes) {
  if (bytes.byteLength < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
      || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("artifact is not a PNG with an IHDR header");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0) throw new Error("artifact PNG dimensions are invalid");
  return { width, height };
}

function isSafeArtifactName(name) {
  return typeof name === "string"
    && name.length > 0
    && Buffer.byteLength(name, "utf8") <= 240
    && name === basename(name)
    && !name.startsWith(".")
    && !name.includes("/")
    && !name.includes("\\")
    && !/[\0-\x1f\x7f]/.test(name)
    && extname(name).toLowerCase() === ".png";
}

function assertArtifactName(name) {
  if (!isSafeArtifactName(name)) {
    throw new Error("artifact name must be a direct, non-hidden PNG filename");
  }
}

async function ensurePrivateArtifactDirectory(artifactDirectory) {
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  await chmod(artifactDirectory, 0o700);
}

async function readArtifact(path, name) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("artifact is not a regular file");
    const bytes = await handle.readFile();
    const dimensions = inspectPng(bytes);
    return {
      name,
      bytes,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
      width: dimensions.width,
      height: dimensions.height,
      modifiedAt: stat.mtime.toISOString(),
      modifiedAtMs: stat.mtimeMs,
    };
  } finally {
    await handle.close();
  }
}

export async function stageReviewArtifact({
  source,
  name = basename(source ?? ""),
  artifactDirectory = DEFAULT_ARTIFACT_DIRECTORY,
  expectedSha256,
  expectedWidth,
  expectedHeight,
}) {
  if (typeof source !== "string" || source.length === 0) throw new Error("a source PNG is required");
  assertArtifactName(name);

  const sourcePath = resolve(source);
  const sourceStat = await lstat(sourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error("source artifact must be a regular, non-symlink file");
  }
  const sourceArtifact = await readArtifact(sourcePath, name);
  if (expectedSha256 !== undefined && sourceArtifact.sha256 !== expectedSha256) {
    throw new Error(`source SHA-256 mismatch: ${sourceArtifact.sha256}`);
  }
  if (expectedWidth !== undefined && sourceArtifact.width !== expectedWidth) {
    throw new Error(`source width mismatch: ${sourceArtifact.width}`);
  }
  if (expectedHeight !== undefined && sourceArtifact.height !== expectedHeight) {
    throw new Error(`source height mismatch: ${sourceArtifact.height}`);
  }

  await ensurePrivateArtifactDirectory(artifactDirectory);
  const destination = join(artifactDirectory, name);
  try {
    const existing = await readArtifact(destination, name);
    if (existing.sha256 !== sourceArtifact.sha256) {
      throw new Error(`artifact '${name}' already exists with different bytes`);
    }
    return { ...existing, path: destination, staged: false };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const temporary = join(artifactDirectory, `.${process.pid}-${Date.now()}-${name}.partial`);
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      await handle.writeFile(sourceArtifact.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await copyFile(temporary, destination, constants.COPYFILE_EXCL);
    await chmod(destination, 0o600);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }

  return { ...(await readArtifact(destination, name)), path: destination, staged: true };
}

export async function listReviewArtifacts(artifactDirectory = DEFAULT_ARTIFACT_DIRECTORY) {
  await ensurePrivateArtifactDirectory(artifactDirectory);
  const entries = await readdir(artifactDirectory, { withFileTypes: true });
  const artifacts = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !isSafeArtifactName(entry.name)) continue;
    try {
      const artifact = await readArtifact(join(artifactDirectory, entry.name), entry.name);
      artifacts.push(artifact);
    } catch (error) {
      if (!["ENOENT", "ELOOP"].includes(error?.code)) throw error;
    }
  }
  artifacts.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs
    || left.name.localeCompare(right.name, "en"));
  return artifacts;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]);
}

function publicMetadata(artifact) {
  return {
    filename: artifact.name,
    modifiedAt: artifact.modifiedAt,
    width: artifact.width,
    height: artifact.height,
    byteLength: artifact.byteLength,
    sha256: artifact.sha256,
    reviewStatus: artifact.sha256 === APPROVED_CHECKPOINT_SHA256
      ? "approved laptop checkpoint"
      : "review required",
  };
}

function renderGallery(artifacts) {
  const cards = artifacts.map((artifact) => {
    const metadata = publicMetadata(artifact);
    return `<article class="card">
      <a href="/artifacts/${encodeURIComponent(artifact.name)}"><img src="/artifacts/${encodeURIComponent(artifact.name)}" alt="${escapeHtml(artifact.name)}"></a>
      <div class="details">
        <h2>${escapeHtml(artifact.name)}</h2>
        <p class="status ${metadata.reviewStatus.startsWith("approved") ? "approved" : "pending"}">${escapeHtml(metadata.reviewStatus)}</p>
        <dl>
          <dt>Timestamp</dt><dd><time datetime="${metadata.modifiedAt}">${escapeHtml(metadata.modifiedAt)}</time></dd>
          <dt>Dimensions</dt><dd>${metadata.width} × ${metadata.height}</dd>
          <dt>Bytes</dt><dd>${metadata.byteLength.toLocaleString("en-US")}</dd>
          <dt>SHA-256</dt><dd><code>${metadata.sha256}</code></dd>
        </dl>
      </div>
    </article>`;
  }).join("\n");
  const empty = "<p class=\"empty\">No staged review artifacts.</p>";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Limina private visual review</title>
<style>
:root{color-scheme:dark;background:#101512;color:#edf4ee;font:16px/1.45 system-ui,sans-serif}body{margin:0 auto;max-width:1500px;padding:28px}header{margin-bottom:24px}h1{margin:0 0 6px;font-size:clamp(1.5rem,4vw,2.5rem)}header p{color:#aebbb1;margin:.3rem 0}.grid{display:grid;gap:24px}.card{background:#18201a;border:1px solid #334338;border-radius:12px;overflow:hidden;box-shadow:0 10px 30px #0006}.card img{display:block;width:100%;height:auto;background:#090c0a}.details{padding:18px}h2{font-size:1.05rem;margin:0 0 10px;overflow-wrap:anywhere}.status{display:inline-block;margin:0 0 12px;padding:4px 9px;border-radius:999px;font-size:.8rem;text-transform:uppercase;letter-spacing:.04em}.approved{background:#1f5937;color:#d8ffe5}.pending{background:#664c1d;color:#fff0c5}dl{display:grid;grid-template-columns:max-content 1fr;gap:5px 14px;margin:0}dt{color:#9eafa2}dd{margin:0;min-width:0;overflow-wrap:anywhere}code{font-size:.82rem}.empty{padding:40px;background:#18201a;border-radius:12px}@media(min-width:1100px){.card{display:grid;grid-template-columns:minmax(0,2fr) minmax(360px,1fr);align-items:start}}
</style></head><body><header><h1>Limina private visual review</h1><p>Newest artifact first. Spark captures remain unapproved until reviewed on this target.</p></header><main class="grid">${cards || empty}</main></body></html>`;
}

function securityHeaders(contentType) {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Type": contentType,
  };
}

function send(response, status, contentType, body, method = "GET", extraHeaders = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  response.writeHead(status, {
    ...securityHeaders(contentType),
    ...extraHeaders,
    "Content-Length": bytes.byteLength,
  });
  response.end(method === "HEAD" ? undefined : bytes);
}

function validHost(request) {
  const port = request.socket.localPort;
  return request.headers.host === `${LOOPBACK_HOST}:${port}`
    || request.headers.host === `localhost:${port}`;
}

export function createReviewServer({ artifactDirectory = DEFAULT_ARTIFACT_DIRECTORY } = {}) {
  const root = resolve(artifactDirectory);
  const server = createServer({ requestTimeout: 10_000, headersTimeout: 5_000 }, async (request, response) => {
    const method = request.method ?? "GET";
    try {
      if (!validHost(request)) {
        send(response, 421, "text/plain; charset=utf-8", "misdirected request\n", method);
        return;
      }
      if (method !== "GET" && method !== "HEAD") {
        send(response, 405, "text/plain; charset=utf-8", "method not allowed\n", method, { Allow: "GET, HEAD" });
        return;
      }
      const url = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`);
      if (url.pathname === "/" && url.search === "") {
        send(response, 200, "text/html; charset=utf-8", renderGallery(await listReviewArtifacts(root)), method);
        return;
      }
      if (url.pathname === "/manifest.json" && url.search === "") {
        const metadata = (await listReviewArtifacts(root)).map(publicMetadata);
        send(response, 200, "application/json; charset=utf-8", `${JSON.stringify(metadata, null, 2)}\n`, method);
        return;
      }
      if (url.pathname === "/healthz" && url.search === "") {
        send(response, 200, "text/plain; charset=utf-8", "ok\n", method);
        return;
      }
      if (url.pathname.startsWith("/artifacts/") && url.search === "") {
        let name;
        try { name = decodeURIComponent(url.pathname.slice("/artifacts/".length)); } catch { name = ""; }
        if (!isSafeArtifactName(name)) {
          send(response, 404, "text/plain; charset=utf-8", "not found\n", method);
          return;
        }
        try {
          const artifact = await readArtifact(join(root, name), name);
          send(response, 200, "image/png", artifact.bytes, method);
        } catch (error) {
          if (!["ENOENT", "ELOOP"].includes(error?.code)) throw error;
          send(response, 404, "text/plain; charset=utf-8", "not found\n", method);
        }
        return;
      }
      send(response, 404, "text/plain; charset=utf-8", "not found\n", method);
    } catch {
      send(response, 500, "text/plain; charset=utf-8", "internal error\n", method);
    }
  });
  server.maxHeadersCount = 32;
  server.keepAliveTimeout = 5_000;
  server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"));
  return server;
}

export async function listenReviewServer(server, port = DEFAULT_PORT) {
  await ensurePrivateArtifactDirectory(DEFAULT_ARTIFACT_DIRECTORY);
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(port, LOOPBACK_HOST, accept);
  });
  return server.address();
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function parseOptions(arguments_) {
  const options = {};
  const positional = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument.startsWith("--")) { positional.push(argument); continue; }
    const key = argument.slice(2);
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  return { options, positional };
}

async function main() {
  const [command, ...arguments_] = process.argv.slice(2);
  const { options, positional } = parseOptions(arguments_);
  if (command === "stage") {
    const source = positional[0];
    if (!source || positional.length > 1) throw new Error("usage: stage <source.png> [--name <artifact.png>] [--expect-sha256 <hex>] [--expect-width <px>] [--expect-height <px>]");
    const artifact = await stageReviewArtifact({
      source,
      name: options.name ?? basename(source),
      expectedSha256: options["expect-sha256"],
      expectedWidth: options["expect-width"] === undefined ? undefined : parsePositiveInteger(options["expect-width"], "expected width"),
      expectedHeight: options["expect-height"] === undefined ? undefined : parsePositiveInteger(options["expect-height"], "expected height"),
    });
    console.log(JSON.stringify(publicMetadata(artifact), null, 2));
    return;
  }
  if (command === "serve") {
    if (positional.length > 0) throw new Error("usage: serve [--port <port>]");
    const port = options.port === undefined ? DEFAULT_PORT : parsePositiveInteger(options.port, "port");
    if (port > 65_535) throw new Error("port must be at most 65535");
    const server = createReviewServer();
    const address = await listenReviewServer(server, port);
    console.log(`Limina review bridge serving ${DEFAULT_ARTIFACT_DIRECTORY}`);
    console.log(`Listening only on http://${address.address}:${address.port}/`);
    return;
  }
  throw new Error("usage: dgx-spark-review-bridge.mjs <stage|serve> ...");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`review bridge: ${error.message}`);
    process.exitCode = 1;
  });
}
