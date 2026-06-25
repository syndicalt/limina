// Generates a minimal valid .glb (one triangle) for the loadGLTF demo/test.
import { writeFileSync } from "node:fs";

const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const bin = Buffer.from(positions.buffer);

const gltf = {
  asset: { version: "2.0" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  buffers: [{ byteLength: bin.length }],
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length, target: 34962 }],
  accessors: [{ bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }],
};

let json = Buffer.from(JSON.stringify(gltf), "utf8");
while (json.length % 4 !== 0) json = Buffer.concat([json, Buffer.from(" ")]);
let binChunk = bin;
while (binChunk.length % 4 !== 0) binChunk = Buffer.concat([binChunk, Buffer.from([0])]);

const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0); // "glTF"
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + json.length + 8 + binChunk.length, 8);
const jsonHeader = Buffer.alloc(8);
jsonHeader.writeUInt32LE(json.length, 0);
jsonHeader.writeUInt32LE(0x4e4f534a, 4); // "JSON"
const binHeader = Buffer.alloc(8);
binHeader.writeUInt32LE(binChunk.length, 0);
binHeader.writeUInt32LE(0x004e4942, 4); // "BIN\0"

const glb = Buffer.concat([header, jsonHeader, json, binHeader, binChunk]);
writeFileSync("assets/triangle.glb", glb);
console.log("wrote assets/triangle.glb", glb.length, "bytes");
