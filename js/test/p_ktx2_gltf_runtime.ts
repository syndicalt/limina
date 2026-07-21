import { GltfSceneCache } from "../src/skills/three.ts";
const encoded = new TextEncoder().encode(JSON.stringify({ asset: { version: "2.0" }, extensionsUsed: ["KHR_texture_basisu"], textures: [{ extensions: { KHR_texture_basisu: { source: 0 } } }], images: [{ uri: "x.ktx2" }], scenes: [{ nodes: [] }], scene: 0 }));
const cache = new GltfSceneCache();
let failed = "";
try { await cache.prewarm("compressed.gltf", encoded); } catch (error) { failed = error instanceof Error ? error.message : String(error); }
if (!failed.includes("renderer-configured project Basis transcoder")) throw new Error(`KTX2 missing-runtime failure was not explicit: ${failed}`);
await cache.dispose();
let pathRejected = false;
try { new GltfSceneCache({ ktx2TranscoderPath: "runtime/basis" }); } catch { pathRejected = true; }
if (!pathRejected) throw new Error("relative KTX2 transcoder path was accepted");
console.log("p_ktx2_gltf_runtime OK");
