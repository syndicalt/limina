#!/usr/bin/env node
import { flattenVegetationGlb } from "./flatten-vegetation-glb.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const input = option("--input");
if (input === undefined || args.includes("--help")) {
  console.error("usage: node asset/flatten-vegetation-glb-cli.mjs --input <asset.glb> [--output <asset.glb>] [--max-meshes 1|2]");
  process.exit(input === undefined && !args.includes("--help") ? 2 : 0);
}
const summary = await flattenVegetationGlb({
  input,
  output: option("--output") ?? input,
  maxMeshes: Number(option("--max-meshes") ?? 2),
});
console.log(JSON.stringify(summary, null, 2));

