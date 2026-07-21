#!/usr/bin/env node

import { open, readFile, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";

const args = process.argv.slice(2);
const value = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const input = resolve(value("--input") ?? ""), output = resolve(value("--output") ?? ""), scale = Number(value("--scale"));
if (!input.endsWith(".glb") || !output.endsWith(".glb") || input === output || !Number.isFinite(scale) || !(scale > 0) || scale > 100) {
  throw new Error("usage: node scale-glb-cli.mjs --input source.glb --output scaled.glb --scale positive-number");
}
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const source = await readFile(input), document = await io.readBinary(source);
const scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0];
if (scene === undefined || scene.listChildren().length === 0) throw new Error("input GLB has no default scene roots");
for (const node of scene.listChildren()) {
  const current = node.getScale();
  node.setScale([current[0] * scale, current[1] * scale, current[2] * scale]);
}
const bytes = await io.writeBinary(document), temporary = `${output}.tmp-${process.pid}`;
let handle;
try {
  handle = await open(temporary, "wx", 0o644); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
  await rename(temporary, output);
} catch (error) { await handle?.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {}); throw error; }
console.log(JSON.stringify({ input, output, scale, bytesBefore: source.byteLength, bytesAfter: bytes.byteLength }));
