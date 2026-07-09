// Bundle entry for limina: the full three.js WebGPU surface, TSL, and the
// GLTFLoader addon — one ESM loaded through the embedder's module loader.
export * from "three/webgpu";
export * as TSL from "three/tsl";
export { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
export { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
export { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
// Post-processing TSL display nodes (Phase 3 terrain overhaul render stack):
// real GTAO ambient occlusion + bloom, composited via THREE.RenderPipeline.
// These are addon nodes (not part of the three/webgpu or three/tsl surface),
// so they are pulled in explicitly here and exposed as THREE.ao / THREE.bloom.
export { ao } from "three/examples/jsm/tsl/display/GTAONode.js";
export { bloom } from "three/examples/jsm/tsl/display/BloomNode.js";
// Phase-4 post additions (the "steal from Threenity" render stack): volumetric
// god-rays (crepuscular scatter from the sun), depth-of-field bokeh, and a
// full-scene Sobel edge outline. Wired into render/post.ts as opt-in stages.
export { godrays } from "three/examples/jsm/tsl/display/GodraysNode.js";
export { dof } from "three/examples/jsm/tsl/display/DepthOfFieldNode.js";
export { sobel } from "three/examples/jsm/tsl/display/SobelOperatorNode.js";
