// Phase 5-A / A1 — Text raster substrate.
//
// Proves the js/src/ui compositor + DataTexture quad for real, two ways:
//
//  PART A (CPU readback): composite a styled box (text 'Hi', border B, bg G at
//  opacity, padding P) and read the RGBA buffer back, asserting
//    (i)   a glyph stroke texel is the text color where the glyph is, AND a
//          known-empty cell is the background (not the glyph) — plus a fully
//          transparent composite whose empty cell is ZERO alpha;
//    (ii)  a border texel == B;
//    (iii) an interior/background texel == G alpha-blended at the opacity;
//    (iv)  the padding region is background, not glyph.
//  Falsifiable: setting the string to '' removes the glyph texels; removing the
//  border removes the B texels (both asserted).
//
//  PART B (GPU offscreen): build the Panel's THREE.DataTexture, upload ITS OWN
//  bytes through the exact op the embedder's WebGPU backend uses for a
//  DataTexture (queue.writeTexture — it has no copyExternalImageToTexture), render
//  a textured quad to an offscreen target (the s3_offscreen pattern), read the
//  pixels back, and assert the surface samples NON-BLACK where bg/text is (and
//  the exact bg color + a text-colored texel survive the round-trip). A zero
//  texture rendered through the SAME pipeline samples black — so the non-black
//  result comes from the composited data, not the pipeline.
//
// Run (headless): ./target/debug/limina js/test/p5_text_substrate.ts

import { composite, type Composited, type RGBA, type TextStyle } from "../src/ui/compositor.ts";
import { GLYPH_W, glyphFor } from "../src/ui/font.ts";
import { Panel } from "../src/ui/surface.ts";
import * as THREE from "../build/three.bundle.mjs";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error("P5 A1 FAIL: " + message);
}

function px(c: Composited, x: number, y: number): RGBA {
  const i = (y * c.width + x) * 4;
  return { r: c.data[i], g: c.data[i + 1], b: c.data[i + 2], a: c.data[i + 3] };
}
function eq(a: RGBA, b: RGBA): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
}
function show(p: RGBA): string {
  return `${p.r},${p.g},${p.b},${p.a}`;
}

// ---- PART A: CPU composite + pixel readback --------------------------------

const G: RGBA = { r: 32, g: 96, b: 200, a: 255 }; // background
const B: RGBA = { r: 220, g: 40, b: 40, a: 255 }; // border
const TEXT: RGBA = { r: 255, g: 255, b: 255, a: 255 }; // text
const OPACITY = 0.5;
const BW = 3;
const PAD = 8;
const SCALE = 3;

const style: TextStyle = {
  background: { color: G, opacity: OPACITY },
  border: { width: BW, color: B },
  padding: PAD,
  text: { color: TEXT, scale: SCALE, align: "left" },
};
const box = composite(style, "Hi");
console.log(`A1 composite: ${box.width}x${box.height} RGBA (${box.data.length} bytes)`);

// (ii) border texel == B (top edge + left edge).
const borderTop = px(box, box.width >> 1, 0);
const borderLeft = px(box, 0, box.height >> 1);
assert(eq(borderTop, B), `(ii) top border texel ${show(borderTop)} != B ${show(B)}`);
assert(eq(borderLeft, B), `(ii) left border texel ${show(borderLeft)} != B ${show(B)}`);

// (iii) interior bg texel == G alpha-blended at OPACITY (straight-alpha).
const bgExpected: RGBA = { r: G.r, g: G.g, b: G.b, a: Math.round(G.a * OPACITY) };
const bgPx = px(box, BW + 1, BW + 1); // inside the border ring, in the padding
assert(eq(bgPx, bgExpected), `(iii) interior bg texel ${show(bgPx)} != expected ${show(bgExpected)}`);

// (iv) padding region is background, not glyph (a padding pixel far from text).
const padPx = px(box, BW + 1, box.height - BW - 1);
assert(eq(padPx, bgExpected), `(iv) padding texel ${show(padPx)} is not background ${show(bgExpected)}`);

// (i) glyph coverage: a fully-covered 'H' source pixel maps to the text color,
// while a zero-coverage interior cell stays background (the glyph did not bleed).
const originX = BW + PAD;
const originY = BW + PAD;
const hGlyph = glyphFor("H".charCodeAt(0));
let inkSX = -1;
let inkSY = -1;
for (let sy = 0; sy < hGlyph.height && inkSX < 0; sy++) {
  for (let sx = 0; sx < hGlyph.width; sx++) {
    if (hGlyph.alpha[sy * GLYPH_W + sx] === 255) {
      inkSX = sx;
      inkSY = sy;
      break;
    }
  }
}
assert(inkSX >= 0, "(i) 'H' has no fully-covered source pixel");
const inkPx = px(box, originX + inkSX * SCALE + 1, originY + inkSY * SCALE + 1);
assert(eq(inkPx, TEXT), `(i) glyph stroke texel ${show(inkPx)} != text color ${show(TEXT)}`);

let holeSX = -1;
let holeSY = -1;
for (let sy = 4; sy < hGlyph.height - 4 && holeSX < 0; sy++) {
  for (let sx = 2; sx < hGlyph.width - 2; sx++) {
    if (hGlyph.alpha[sy * GLYPH_W + sx] === 0) {
      holeSX = sx;
      holeSY = sy;
      break;
    }
  }
}
assert(holeSX >= 0, "(i) 'H' has no empty interior source pixel");
const holePx = px(box, originX + holeSX * SCALE + 1, originY + holeSY * SCALE + 1);
assert(eq(holePx, bgExpected), `(i) empty-cell texel ${show(holePx)} != background (glyph bled?)`);

// (i, literal "zero in a known-empty cell"): a fully transparent composite (no
// bg/border) has zero alpha where there is no glyph, and non-zero coverage total.
const glyphOnly = composite({ text: { color: TEXT, scale: SCALE } }, "Hi");
assert(px(glyphOnly, 0, 0).a === 0, "(i) transparent composite: known-empty cell (0,0) is not zero alpha");
let coverage = 0;
for (let i = 3; i < glyphOnly.data.length; i += 4) coverage += glyphOnly.data[i];
assert(coverage > 0, "(i) transparent composite has no glyph coverage at all");

// Falsifiable — glyph: set the string to '' (same dimensions) -> the glyph texel
// reverts to background.
const boxEmpty = composite({ ...style, width: box.width, height: box.height }, "");
const inkGone = px(boxEmpty, originX + inkSX * SCALE + 1, originY + inkSY * SCALE + 1);
assert(!eq(inkGone, TEXT), `falsifiable(glyph): '' still has a glyph texel ${show(inkGone)}`);
assert(eq(inkGone, bgExpected), `falsifiable(glyph): cleared glyph cell ${show(inkGone)} != background`);

// Falsifiable — border: remove the border -> the B texel is gone (now bg).
const boxNoBorder = composite({ ...style, border: { width: 0, color: B } }, "Hi");
const borderGone = px(boxNoBorder, boxNoBorder.width >> 1, 0);
assert(!eq(borderGone, B), `falsifiable(border): border-less box still has a B texel ${show(borderGone)}`);

// Title/header bar: its own background is distinct from the body background.
const titled = composite(
  {
    background: { color: { r: 20, g: 20, b: 20, a: 255 } },
    title: { background: { r: 80, g: 10, b: 10, a: 255 }, color: TEXT, scale: 2 },
    padding: 6,
    text: { color: TEXT, scale: 2 },
  },
  "Body",
  "Title",
);
const titleBarPx = px(titled, 2, 2);
const bodyBgPx = px(titled, 2, titled.height - 2);
assert(!eq(titleBarPx, bodyBgPx), `title bar bg ${show(titleBarPx)} should differ from body bg ${show(bodyBgPx)}`);

console.log("A1 PART A OK: border / bg+opacity / padding / glyph coverage + falsifiability + title bar");

// ---- PART B: GPU offscreen render of the DataTexture quad ------------------

// Local typings for the raw-WebGPU surfaces (the host types them as unknown).
interface GpuMappedBuffer {
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
}
interface GpuTexture {
  createView(): unknown;
}
interface GpuRenderPipeline {
  getBindGroupLayout(index: number): unknown;
}
interface GpuRenderPass {
  setPipeline(pipeline: GpuRenderPipeline): void;
  setBindGroup(index: number, group: unknown): void;
  draw(count: number): void;
  end(): void;
}
interface GpuCommandEncoder {
  beginRenderPass(desc: object): GpuRenderPass;
  copyTextureToBuffer(src: object, dst: object, size: object): void;
  finish(): unknown;
}
interface GpuQueue {
  writeTexture(dst: object, data: BufferSource, layout: object, size: object): void;
  submit(buffers: unknown[]): void;
}
interface GpuDevice {
  createTexture(desc: object): GpuTexture;
  createBuffer(desc: { size: number; usage: number }): GpuMappedBuffer;
  createShaderModule(desc: { code: string }): unknown;
  createRenderPipeline(desc: object): GpuRenderPipeline;
  createSampler(desc: object): unknown;
  createBindGroup(desc: object): unknown;
  createCommandEncoder(): GpuCommandEncoder;
  queue: GpuQueue;
}
interface GpuAdapter {
  requestDevice(): Promise<GpuDevice>;
}
declare const navigator: { gpu: { requestAdapter(): Promise<GpuAdapter | null> } };
declare const GPUTextureUsage: { RENDER_ATTACHMENT: number; COPY_SRC: number; COPY_DST: number; TEXTURE_BINDING: number };
declare const GPUBufferUsage: { COPY_DST: number; MAP_READ: number };
declare const GPUMapMode: { READ: number };

// Build the Panel (same styled box) and assert the DataTexture config that makes
// it SAMPLE rather than upload black.
const panel = new Panel({ style, text: "Hi" });
const tex = panel.texture;
assert(tex.isDataTexture === true, "panel texture is not flagged isDataTexture (would upload black)");
assert(tex.image.data === panel.composited.data, "DataTexture does not carry the composited RGBA bytes");
assert(tex.image.width === box.width && tex.image.height === box.height, "DataTexture dimensions mismatch the composite");
assert(tex.format === THREE.RGBAFormat, "DataTexture format is not RGBAFormat");
assert(tex.type === THREE.UnsignedByteType, "DataTexture type is not UnsignedByteType");
assert(tex.flipY === true, "DataTexture flipY must be true to render upright");
// needsUpdate is write-only in three (bumps version); a bumped version is the
// real signal the backend will (re-)upload via queue.writeTexture.
assert(tex.version >= 1, "DataTexture version not bumped (needsUpdate never set -> no upload)");

const W = panel.width;
const H = panel.height;

const adapter = await navigator.gpu.requestAdapter();
assert(adapter !== null, "no WebGPU adapter");
const device = await adapter.requestDevice();

function makeSampledTexture(data: Uint8Array): GpuTexture {
  const t = device.createTexture({
    size: { width: W, height: H },
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  // queue.writeTexture: the SAME upload the three WebGPU backend uses for a
  // DataTexture. We feed the DataTexture's own bytes so this proves THAT buffer.
  device.queue.writeTexture(
    { texture: t },
    data,
    { offset: 0, bytesPerRow: W * 4, rowsPerImage: H },
    { width: W, height: H, depthOrArrayLayers: 1 },
  );
  return t;
}

const composedTex = makeSampledTexture(tex.image.data);
const blackTex = makeSampledTexture(new Uint8Array(W * H * 4)); // control: all zero

const shader = device.createShaderModule({
  code: `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  var p = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
    vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0)
  );
  var u = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 0.0),
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(1.0, 0.0)
  );
  var o: VSOut;
  o.pos = vec4<f32>(p[vi], 0.0, 1.0);
  o.uv = u[vi];
  return o;
}
@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  return textureSample(tex, samp, in.uv);
}
`,
});
const pipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: { module: shader, entryPoint: "vs" },
  fragment: { module: shader, entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
  primitive: { topology: "triangle-list" },
});
// Nearest sampling so a sampled texel reproduces the source texel exactly.
const sampler = device.createSampler({ magFilter: "nearest", minFilter: "nearest" });

const bytesPerRow = Math.ceil((W * 4) / 256) * 256;

async function renderAndRead(srcTex: GpuTexture): Promise<Uint8Array> {
  const outTex = device.createTexture({
    size: { width: W, height: H },
    format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: sampler },
      { binding: 1, resource: srcTex.createView() },
    ],
  });
  const readBuffer = device.createBuffer({
    size: bytesPerRow * H,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: outTex.createView(),
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
      loadOp: "clear",
      storeOp: "store",
    }],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(6);
  pass.end();
  encoder.copyTextureToBuffer(
    { texture: outTex },
    { buffer: readBuffer, bytesPerRow },
    { width: W, height: H, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await readBuffer.mapAsync(GPUMapMode.READ);
  const pixels = new Uint8Array(readBuffer.getMappedRange().slice(0));
  readBuffer.unmap();
  return pixels;
}

function sampleAt(pixels: Uint8Array, x: number, y: number): RGBA {
  const i = y * bytesPerRow + x * 4;
  return { r: pixels[i], g: pixels[i + 1], b: pixels[i + 2], a: pixels[i + 3] };
}

const composedPixels = await renderAndRead(composedTex);
const blackPixels = await renderAndRead(blackTex);

// Primary proof: the surface samples NON-BLACK at the center (bg/text region).
const center = sampleAt(composedPixels, W >> 1, H >> 1);
const centerLum = center.r + center.g + center.b;
console.log(`A1 offscreen: center sample ${show(center)} (lum ${centerLum})`);
assert(centerLum > 30, `offscreen sample is black at center ${show(center)} (DataTexture did NOT sample)`);

// The exact bg color survives the GPU round-trip (nearest sampling, real texels).
const bgSample = sampleAt(composedPixels, BW + 2, BW + 2);
assert(
  bgSample.r === G.r && bgSample.g === G.g && bgSample.b === G.b,
  `offscreen bg sample ${show(bgSample)} != composited bg ${show(G)}`,
);

// A text-colored (white) texel survives too -> the glyph rendered on the GPU.
let whiteFound = false;
for (let y = 0; y < H && !whiteFound; y++) {
  for (let x = 0; x < W; x++) {
    const p = sampleAt(composedPixels, x, y);
    if (p.r > 240 && p.g > 240 && p.b > 240) {
      whiteFound = true;
      break;
    }
  }
}
assert(whiteFound, "no text-colored texel sampled on the GPU (glyph did not survive upload)");

// Control: the SAME pipeline over a zero texture samples black -> the non-black
// above came from the composited data, not from the pipeline.
const blackCenter = sampleAt(blackPixels, W >> 1, H >> 1);
assert(
  blackCenter.r + blackCenter.g + blackCenter.b === 0,
  `control (zero texture) did not sample black: ${show(blackCenter)}`,
);

console.log("A1 PART B OK: DataTexture quad sampled NON-BLACK on GPU (bg + glyph), zero-texture control black");
console.log("P5 A1 OK: text raster substrate composites + samples for real (CPU readback + GPU offscreen)");
