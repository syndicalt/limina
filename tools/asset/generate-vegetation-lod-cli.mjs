#!/usr/bin/env node
import { generateVegetationLod } from "./generate-vegetation-lod.mjs";

const USAGE = "Usage: node asset/generate-vegetation-lod-cli.mjs --input <source.glb> --output <lod.glb> --ratio <0..1> --error <0..1>";

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--input", "--output", "--ratio", "--error"].includes(flag) || value === undefined || value.startsWith("--")) {
      throw new Error(USAGE);
    }
    if (values.has(flag)) throw new Error(`duplicate option: ${flag}`);
    values.set(flag, value);
  }
  for (const flag of ["--input", "--output", "--ratio", "--error"]) {
    if (!values.has(flag)) throw new Error(`missing required option ${flag}\n${USAGE}`);
  }
  return {
    input: values.get("--input"),
    output: values.get("--output"),
    ratio: Number(values.get("--ratio")),
    error: Number(values.get("--error")),
  };
}

try {
  const summary = await generateVegetationLod(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} catch (error) {
  process.stderr.write(`vegetation LOD generation failed: ${error.message}\n`);
  process.exitCode = 1;
}
