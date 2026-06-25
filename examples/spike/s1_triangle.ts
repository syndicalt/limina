// S1 spike — prove WebGPU presents to an OS window on THIS machine via the
// stock Deno binary (deno_webgpu + Deno.UnsafeWindowSurface + SDL2 FFI).
//
// Run: deno run -A --unstable-webgpu examples/spike/s1_triangle.ts
//
// This validates the hardware/driver/compositor path (Wayland/Vulkan) before
// the heavier custom-embedder surface work (S3/S4). It uses Path A's mechanism
// (Deno's UnsafeWindowSurface); limina itself will use Path B (native winit).

import { EventType, WindowBuilder } from "jsr:@divy/sdl2@0.15.0";

const WIDTH = 800;
const HEIGHT = 600;
const MAX_FRAMES = 180; // auto-exit so the harness is non-interactive

const adapter = await navigator.gpu?.requestAdapter();
if (!adapter) throw new Error("no WebGPU adapter");
const device = await adapter.requestDevice();
const format = navigator.gpu.getPreferredCanvasFormat();
console.log(`adapter ok; preferred format = ${format}`);

const win = new WindowBuilder("limina S1 — WebGPU triangle", WIDTH, HEIGHT)
  .resizable()
  .build();
const surface = win.windowSurface(WIDTH, HEIGHT);
const context = surface.getContext("webgpu");
context.configure({ device, format, alphaMode: "opaque" });

const shader = device.createShaderModule({
  code: `
@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(
    vec2<f32>(0.0, 0.5), vec2<f32>(-0.5, -0.5), vec2<f32>(0.5, -0.5)
  );
  return vec4<f32>(p[i], 0.0, 1.0);
}
@fragment
fn fs() -> @location(0) vec4<f32> { return vec4<f32>(1.0, 0.6, 0.1, 1.0); }
`,
});

const pipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: { module: shader, entryPoint: "vs" },
  fragment: { module: shader, entryPoint: "fs", targets: [{ format }] },
  primitive: { topology: "triangle-list" },
});

function drawFrame(): void {
  const view = context.getCurrentTexture().createView();
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view,
      clearValue: { r: 0.07, g: 0.08, b: 0.12, a: 1 },
      loadOp: "clear",
      storeOp: "store",
    }],
  });
  pass.setPipeline(pipeline);
  pass.draw(3);
  pass.end();
  device.queue.submit([encoder.finish()]);
  surface.present();
}

let frames = 0;
for await (const event of win.events()) {
  if (typeof event === "object" && event !== null && "type" in event) {
    const type = event.type; // unknown after `in` narrowing
    if (type === EventType.Quit) break;
    if (type === EventType.Draw) {
      drawFrame();
      frames += 1;
      if (frames >= MAX_FRAMES) break;
    }
  }
}

console.log(`S1 OK: presented ${frames} frames to the window`);
Deno.exit(0);
