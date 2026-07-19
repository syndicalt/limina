import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveChrome, resolvePwc } from "../_pw-resolve.mjs";

export const AUTHORITY_SCHEMA = "limina.static-behavioral-authorities/v1";
const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "..", "..");
export const defaultManifestPath = resolve(here, "static-behavioral-authorities.json");
const TEST_SUFFIX = /\.test\.(?:cjs|mjs|js)$/;
const SOURCE_TEXT_MARKER = /LIMITATION \(known, accepted\): this is a SOURCE-TEXT|This is a source-text check/i;
const AUTHORITY_KINDS = new Set(["limina", "node-test", "chromium-static", "chromium-live"]);

function fail(message) {
  throw new Error(`static behavioral authority: ${message}`);
}

function repoPath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0")) fail(`${label} is not a canonical repository path`);
  const absolute = resolve(repoRoot, value);
  const rel = relative(repoRoot, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || rel !== value) fail(`${label} escapes or is not normalized: ${JSON.stringify(value)}`);
  return absolute;
}

async function walk(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path));
    else if (entry.isFile() && TEST_SUFFIX.test(entry.name)) out.push(path);
  }
  return out;
}

export async function discoverSourceTextTests() {
  const candidates = [...await walk(resolve(repoRoot, "js", "test")), ...await walk(resolve(repoRoot, "editor", "test"))];
  const found = [];
  for (const path of candidates) {
    if (SOURCE_TEXT_MARKER.test(await readFile(path, "utf8"))) found.push(relative(repoRoot, path));
  }
  return found.sort();
}

export async function readAuthorityManifest(path = defaultManifestPath) {
  let value;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { throw new Error(`static behavioral authority: manifest is unreadable: ${error.message}`, { cause: error }); }
  return value;
}

export async function validateBehavioralAuthorityManifest(manifest) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest) || manifest.schema !== AUTHORITY_SCHEMA || !Array.isArray(manifest.entries)) {
    fail(`manifest must use ${AUTHORITY_SCHEMA} with an entries array`);
  }
  const discovered = await discoverSourceTextTests();
  const mapped = new Map();
  const chromium = new Set();
  for (const [index, entry] of manifest.entries.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) fail(`entry ${index} is not an object`);
    const fields = Object.keys(entry).sort().join(",");
    if (fields !== "authorities,staticTest") fail(`entry ${index} has unknown or missing fields`);
    const staticPath = entry.staticTest;
    const staticAbsolute = repoPath(staticPath, `entry ${index} staticTest`);
    if (mapped.has(staticPath)) fail(`duplicate static mapping ${staticPath}`);
    const staticSource = await readFile(staticAbsolute, "utf8").catch(() => fail(`static test does not exist: ${staticPath}`));
    if (!SOURCE_TEXT_MARKER.test(staticSource)) fail(`mapped test is not source-text based: ${staticPath}`);
    if (!Array.isArray(entry.authorities) || entry.authorities.length === 0) fail(`${staticPath} has no behavioral authority`);
    const authorities = [];
    const seen = new Set();
    for (const [authorityIndex, authority] of entry.authorities.entries()) {
      if (authority === null || typeof authority !== "object" || Array.isArray(authority) || Object.keys(authority).sort().join(",") !== "kind,path") {
        fail(`${staticPath} authority ${authorityIndex} has unknown or missing fields`);
      }
      if (!AUTHORITY_KINDS.has(authority.kind)) fail(`${staticPath} authority ${authorityIndex} has invalid kind ${JSON.stringify(authority.kind)}`);
      const absolute = repoPath(authority.path, `${staticPath} authority ${authorityIndex}`);
      const identity = `${authority.kind}:${authority.path}`;
      if (seen.has(identity)) fail(`${staticPath} repeats authority ${identity}`);
      seen.add(identity);
      const source = await readFile(absolute, "utf8").catch(() => fail(`${staticPath} authority does not exist: ${authority.path}`));
      if (SOURCE_TEXT_MARKER.test(source)) fail(`${staticPath} points at another source-text test instead of behavior: ${authority.path}`);
      if (authority.kind === "limina" && !authority.path.endsWith(".ts")) fail(`${authority.path} is not a Limina-host TypeScript test`);
      if (authority.kind === "node-test" && !TEST_SUFFIX.test(authority.path)) fail(`${authority.path} is not a Node test`);
      if (authority.kind.startsWith("chromium-")) {
        if (!authority.path.endsWith("_browser.test.cjs")) fail(`${authority.path} is not a browser behavioral test`);
        if (!source.includes("--disable-gpu")) fail(`${authority.path} does not pin CPU-only Chromium with --disable-gpu`);
        chromium.add(authority.path);
      }
      authorities.push(Object.freeze({ kind: authority.kind, path: authority.path }));
    }
    mapped.set(staticPath, Object.freeze(authorities));
  }
  const missing = discovered.filter((path) => !mapped.has(path));
  const stale = [...mapped.keys()].filter((path) => !discovered.includes(path));
  if (missing.length > 0 || stale.length > 0) {
    fail(`coverage mismatch; missing=[${missing.join(", ")}], stale=[${stale.join(", ")}]`);
  }
  return Object.freeze({
    staticTests: Object.freeze(discovered),
    entries: mapped,
    chromium: Object.freeze([...chromium].sort()),
  });
}

export async function validatedAuthorities() {
  return validateBehavioralAuthorityManifest(await readAuthorityManifest());
}

async function main() {
  const mode = process.argv[2] ?? "--check";
  if (mode === "--chrome-path" || mode === "--pwc-path") {
    const path = mode === "--chrome-path" ? resolveChrome() : resolvePwc();
    if (path === null) process.exit(2);
    process.stdout.write(`${path}\n`);
    return;
  }
  if (mode === "--chromium-available") {
    if (resolvePwc() === null || resolveChrome() === null) process.exit(2);
    return;
  }
  const result = await validatedAuthorities();
  if (mode === "--list-chromium" || mode === "--list-chromium-static" || mode === "--list-chromium-live") {
    const kind = mode === "--list-chromium-static" ? "chromium-static" : mode === "--list-chromium-live" ? "chromium-live" : undefined;
    const paths = new Set();
    for (const authorities of result.entries.values()) for (const authority of authorities) {
      if (authority.kind.startsWith("chromium-") && (kind === undefined || authority.kind === kind)) paths.add(authority.path);
    }
    process.stdout.write([...paths].sort().join("\n") + (paths.size > 0 ? "\n" : ""));
    return;
  }
  if (mode !== "--check") fail(`unknown mode ${JSON.stringify(mode)}`);
  console.log(`static-behavioral-authorities OK: ${result.staticTests.length} source-text tests have executable behavioral authority; ${result.chromium.length} real CPU-only Chromium twins are mandatory when Chromium is installed`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error?.stack ?? String(error)); process.exit(1); });
}
