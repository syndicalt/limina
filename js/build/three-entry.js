// Bundle entry for limina: the full three.js WebGPU surface, TSL, and the
// GLTFLoader addon — one ESM loaded through the embedder's module loader.
export * from "three/webgpu";
export * as TSL from "three/tsl";
export { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
