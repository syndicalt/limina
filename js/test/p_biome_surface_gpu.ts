// Native WebGPU compile/render smoke for the B3 three-map shared terrain graph.
// Run: ./target/release/limina --window --frames 6 js/test/p_biome_surface_gpu.ts
import * as THREE from "../build/three.bundle.mjs";
import { buildBiomeSurfaceMaterial } from "../src/terrain/biome-surface-material.ts";
import { SURFACE_COMPOSITE_POLICY_VERSION, SURFACE_COMPOSITE_TILE_SCHEMA } from "../src/world/surface-composite-tile.mjs";

interface SurfaceOps { op_create_window_context(): unknown; op_surface_present(context: unknown): void; op_set_frame_callback(callback: () => void): void; op_log(message: string): void }
interface Adapter { requestDevice(): Promise<unknown> }
declare const navigator: { gpu: { requestAdapter(): Promise<Adapter | null> } };
declare const Deno: { core: { ops: SurfaceOps } };

const ops = Deno.core.ops, adapter = await navigator.gpu.requestAdapter(); if (adapter === null) throw new Error("p_biome_surface_gpu FAIL: no WebGPU adapter");
const device = await adapter.requestDevice(), context = ops.op_create_window_context(), canvas = { width: 640, height: 480, style: {} };
const renderer = new THREE.WebGPURenderer({ device, context, canvas, antialias: false }); await renderer.init(); renderer.setSize(canvas.width, canvas.height, false);
function data(base: readonly [number, number, number], kind: "a" | "n" | "o"): Uint8Array { const size = 8, bytes = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const offset = (y * size + x) * 4, grain = ((x ^ y) & 1) * 28;
    if (kind === "a") { bytes[offset] = base[0] + grain; bytes[offset + 1] = base[1] + grain; bytes[offset + 2] = base[2] + grain; }
    else if (kind === "n") { bytes[offset] = 128; bytes[offset + 1] = 128; bytes[offset + 2] = 255; }
    else { bytes[offset] = 230; bytes[offset + 1] = 175 + grain; bytes[offset + 2] = 0; } bytes[offset + 3] = 255; } return bytes; }
function artifact(tx: number, base: readonly [number, number, number]): any { return { schema: SURFACE_COMPOSITE_TILE_SCHEMA,
  source: { biomeFieldHash: "field", biomePackHash: "pack", terrainChunkHash: "terrain", policyVersion: SURFACE_COMPOSITE_POLICY_VERSION }, coord: { tx, tz: 0, lod: 0 }, placement: { sizeM: 8 },
  resolution: { interior: 6, gutter: 1, total: 8 }, maps: { albedo: { data: data(base, "a") }, normal: { data: data(base, "n") },
    orm: { data: data(base, "o"), channels: "ao-roughness-metalness-grass-density" } }, diagnostics: { runtimeTextureSamples: 3 } }; }
const left = buildBiomeSurfaceMaterial(artifact(-1, [35, 85, 30])), right = buildBiomeSurfaceMaterial(artifact(0, [90, 55, 22]));
const geometry = new THREE.PlaneGeometry(8, 8, 16, 16).rotateX(-Math.PI / 2), a = new THREE.Mesh(geometry, left.material), b = new THREE.Mesh(geometry, right.material); a.position.x = -4; b.position.x = 4;
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x172027); scene.add(a, b, new THREE.HemisphereLight(0xc9e4ff, 0x26391d, 1.7));
const sun = new THREE.DirectionalLight(0xffe2b8, 4); sun.position.set(4, 8, 5); scene.add(sun);
const camera = new THREE.PerspectiveCamera(48, canvas.width / canvas.height, 0.1, 100); camera.position.set(11, 10, 14); camera.lookAt(0, 0, 0);
let frames = 0; ops.op_set_frame_callback(() => { renderer.render(scene, camera); ops.op_surface_present(context); frames++;
  if (frames === 1) ops.op_log("p_biome_surface_gpu OK: native WebGPU compiled the shared three-sample biome terrain graph and rendered two tile texture identities in two draws"); });
