#!/usr/bin/env node

import { open, readFile, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";

const args = process.argv.slice(2);
const value = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const input = resolve(value("--input") ?? ""), output = resolve(value("--output") ?? "");
if (!input.endsWith(".glb") || !output.endsWith(".glb") || input === output) {
  throw new Error("usage: node cross-cluster-glb-cli.mjs --input source.glb --output cluster.glb");
}
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS), source = await readFile(input), document = await io.readBinary(source);
const scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0];
const roots = scene?.listChildren() ?? [];
if (roots.length !== 1 || roots[0].getMesh() === null || roots[0].listChildren().length !== 0) {
  throw new Error("cross-cluster input must have exactly one root mesh node without children");
}
const original = roots[0], crossed = document.createNode(`${original.getName()}-crossed`).setMesh(original.getMesh().clone());
crossed.setTranslation(original.getTranslation()).setScale(original.getScale()).setRotation([0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)]);
scene.addChild(crossed);
const bytes = await io.writeBinary(document), temporary = `${output}.tmp-${process.pid}`;
let handle;
try {
  handle = await open(temporary, "wx", 0o644); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
  await rename(temporary, output);
} catch (error) { await handle?.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {}); throw error; }
console.log(JSON.stringify({ input, output, nodes: 2, bytesBefore: source.byteLength, bytesAfter: bytes.byteLength }));
