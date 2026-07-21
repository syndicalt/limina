#!/usr/bin/env node
import { retopoStatic } from "./retopo-static.mjs";

const USAGE = "Usage: bun retopo/retopo-static-cli.mjs --input source.glb --output clean.glb --lod-output clean-lod1.glb --evidence clean.retopo.json --seed N --target-faces N --resolution N [--cage-extrusion M] [--lod-ratio R] [--lod-error E]";
const allowed = new Set(["--input", "--output", "--lod-output", "--evidence", "--seed", "--target-faces", "--resolution", "--bake-samples", "--cage-extrusion", "--lod-ratio", "--lod-error"]);
function parse(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]; const value = argv[index + 1];
    if (!allowed.has(flag) || value === undefined || value.startsWith("--")) throw new Error(USAGE);
    if (values.has(flag)) throw new Error(`duplicate option ${flag}`);
    values.set(flag, value);
  }
  for (const required of ["--input", "--output", "--lod-output", "--evidence", "--seed", "--target-faces", "--resolution"]) {
    if (!values.has(required)) throw new Error(`missing required option ${required}\n${USAGE}`);
  }
  return {
    input: values.get("--input"), output: values.get("--output"), lodOutput: values.get("--lod-output"), evidence: values.get("--evidence"),
    seed: Number(values.get("--seed")), targetFaces: Number(values.get("--target-faces")), resolution: Number(values.get("--resolution")),
    bakeSamples: values.has("--bake-samples") ? Number(values.get("--bake-samples")) : undefined,
    cageExtrusion: values.has("--cage-extrusion") ? Number(values.get("--cage-extrusion")) : undefined,
    lodRatio: values.has("--lod-ratio") ? Number(values.get("--lod-ratio")) : undefined,
    lodError: values.has("--lod-error") ? Number(values.get("--lod-error")) : undefined,
  };
}

try {
  const options = Object.fromEntries(Object.entries(parse(process.argv.slice(2))).filter(([, value]) => value !== undefined));
  process.stdout.write(`${JSON.stringify(await retopoStatic(options))}\n`);
} catch (error) {
  process.stderr.write(`static retopo failed: ${error.message}\n`);
  process.exitCode = 1;
}
