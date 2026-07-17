#!/usr/bin/env node
import { fetchAmbientCgMaterial } from "./fetch-ambientcg.mjs";

const args = process.argv.slice(2);
const value = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
if (args.includes("--help") || value("--asset") === undefined) {
  console.error("usage: node material/fetch-ambientcg-cli.mjs --asset <ambientCG-id> [--name <material-name>] [--resolution 1K|2K] [--format JPG|PNG] [--output-root assets/materials]");
  process.exit(args.includes("--help") ? 0 : 2);
}
const result = await fetchAmbientCgMaterial({
  assetId: value("--asset"),
  name: value("--name"),
  resolution: value("--resolution"),
  format: value("--format"),
  outputRoot: value("--output-root"),
});
console.log(JSON.stringify(result, null, 2));
