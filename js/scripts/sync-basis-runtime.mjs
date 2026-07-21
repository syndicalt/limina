import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const jsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(jsRoot, "node_modules/three/examples/jsm/libs/basis");
const files = ["basis_transcoder.js", "basis_transcoder.wasm"];
const targets = [resolve(jsRoot, "../runtime/basis"), resolve(jsRoot, "../web/public/runtime/basis"), resolve(jsRoot, "../editor/vendor/runtime/basis"), resolve(jsRoot, "../tools/scaffold/public/runtime/basis")];
const three = JSON.parse(await readFile(resolve(jsRoot, "node_modules/three/package.json"), "utf8"));
const pinned = JSON.parse(await readFile(resolve(jsRoot, "package.json"), "utf8")).dependencies.three;
if (three.version !== pinned) throw new Error(`Basis runtime source Three ${three.version} does not match package pin ${pinned}`);
for (const target of targets) {
  await mkdir(target, { recursive: true });
  for (const file of files) await copyFile(resolve(source, file), resolve(target, file));
}
console.log(`synced Three ${pinned} Basis runtime (${files.join(", ")}) to ${targets.length} project targets`);
