import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const VERSION = "4.4.2";
const PACKAGES = Object.freeze({
  "linux-arm64": Object.freeze({
    filename: `KTX-Software-${VERSION}-Linux-arm64.deb`,
    sha256: "654e9fb9323e1fe89255939952c4f4867692ab1f4e8f71df2b4e04de1802b113",
  }),
  "linux-x64": Object.freeze({
    filename: `KTX-Software-${VERSION}-Linux-x86_64.deb`,
    sha256: "ca635ed489d8bf54fac8d7687056c651193de0740830a7738cc034adc63e3027",
  }),
});

const scriptDir = dirname(fileURLToPath(import.meta.url));
const jsRoot = dirname(scriptDir);
const key = `${process.platform}-${process.arch}`;
const authority = PACKAGES[key];
if (authority === undefined) {
  const message = `KTX authoring tools are not pinned for ${key}; refusing an unverified fallback`;
  if (process.argv.includes("--required")) throw new Error(message);
  console.warn(`${message}; runtime dependencies remain available, but KTX authoring is disabled`);
  process.exit(0);
}

const installRoot = join(jsRoot, ".tools", "ktx", VERSION, key);
const packagePath = join(installRoot, authority.filename);
const extractedRoot = join(installRoot, "root");
const markerPath = join(installRoot, "installed.json");
const toolPath = join(extractedRoot, "usr", "bin", "toktx");
const sourceUrl = `https://github.com/KhronosGroup/KTX-Software/releases/download/v${VERSION}/${authority.filename}`;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const toolWorks = () => spawnSync(toolPath, ["--version"], { encoding: "utf8" }).status === 0;

try {
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  const packageBytes = await readFile(packagePath);
  if (marker.version === VERSION && marker.platform === key && marker.sha256 === authority.sha256
      && sha256(packageBytes) === authority.sha256 && toolWorks()) {
    console.log(`KTX tools ${VERSION} already verified at ${toolPath}`);
    process.exit(0);
  }
} catch {
  // A missing or stale installation is replaced only inside the package-local tool directory.
}

await mkdir(installRoot, { recursive: true });
const temporaryPackage = `${packagePath}.partial-${process.pid}`;
const response = await fetch(sourceUrl, { redirect: "follow" });
if (!response.ok) throw new Error(`KTX tools download failed: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
const actualSha256 = sha256(bytes);
if (actualSha256 !== authority.sha256) {
  throw new Error(`KTX tools checksum mismatch: expected ${authority.sha256}, got ${actualSha256}`);
}
await writeFile(temporaryPackage, bytes, { mode: 0o644 });
await rename(temporaryPackage, packagePath);
await rm(extractedRoot, { recursive: true, force: true });
await mkdir(extractedRoot, { recursive: true });
const unpack = spawnSync("dpkg-deb", ["-x", packagePath, extractedRoot], { encoding: "utf8" });
if (unpack.status !== 0) throw new Error(`dpkg-deb failed: ${unpack.stderr || unpack.stdout}`);
await chmod(toolPath, 0o755);
if (!toolWorks()) throw new Error(`verified KTX package did not provide a working toktx at ${toolPath}`);
await writeFile(markerPath, `${JSON.stringify({
  schema: "limina.engine-tool-dependency/v1",
  name: "Khronos KTX-Software",
  version: VERSION,
  platform: key,
  sourceUrl,
  sha256: authority.sha256,
  toolPath,
}, null, 2)}\n`, { mode: 0o644 });
console.log(`Installed and verified KTX tools ${VERSION} at ${toolPath}`);
