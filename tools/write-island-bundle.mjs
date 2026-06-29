// Companion writer for tools/export-island.ts. The limina native runtime has no
// file-write op (restricted Deno: only Deno.core.ops), so the generator emits the
// export bundle JSON to stdout between markers and this node step persists the files.
//
//   ./target/release/limina tools/export-island.ts | node tools/write-island-bundle.mjs
//
// Writes manifest.json / log.jsonl / keyframes.jsonl / tiles.jsonl / assets.jsonl
// (skipping empty artifacts) + view.json (camera framing) to site/public/examples/island/.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "site", "public", "examples", "island");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const begin = input.indexOf("===LIMINA_BUNDLE_BEGIN===");
  const end = input.indexOf("===LIMINA_BUNDLE_END===");
  if (begin === -1 || end === -1 || end < begin) {
    console.error("write-island-bundle: bundle markers not found in stdin (did the generator run?)");
    process.exit(1);
  }
  const json = input.slice(begin + "===LIMINA_BUNDLE_BEGIN===".length, end).trim();
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    console.error("write-island-bundle: failed to parse bundle JSON:", err.message);
    process.exit(1);
  }
  const { files, view } = parsed;
  mkdirSync(OUT_DIR, { recursive: true });
  const written = [];
  for (const [name, content] of Object.entries(files)) {
    // Skip empty optional artifacts (keyframes for a static world); always keep the
    // three required files even if empty so loadExport's fetch finds them.
    const required = name === "manifest.json" || name === "log.jsonl" || name === "keyframes.jsonl";
    if (!required && (content === undefined || content.length === 0)) continue;
    writeFileSync(join(OUT_DIR, name), content);
    written.push(`${name} (${content.length}B)`);
  }
  if (view !== undefined) {
    writeFileSync(join(OUT_DIR, "view.json"), JSON.stringify(view, null, 2) + "\n");
    written.push("view.json");
  }
  console.log(`wrote ${written.length} files to ${OUT_DIR}:\n  ${written.join("\n  ")}`);
});
