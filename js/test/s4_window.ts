// S4 - native window + injected surface (Path B).
//
// Run: limina --window --frames 180 js/test/s4_window.ts
//
// Sets up a WebGPU device, acquires the host window's GPUCanvasContext via the
// surface op, and registers a frame callback that clears to an animated color
// and presents. Resize reconfigures the swapchain.

type Dict = Record<string, unknown>;

interface RenderPass {
  end(): void;
}
interface Encoder {
  beginRenderPass(desc: Dict): RenderPass;
  finish(): unknown;
}
interface TextureView {
  createView(): unknown;
}
interface Device {
  createCommandEncoder(): Encoder;
  queue: { submit(buffers: unknown[]): void };
}
interface CanvasContext {
  configure(config: Dict): void;
  getCurrentTexture(): TextureView;
}
interface Adapter {
  requestDevice(): Promise<Device>;
}
interface Gpu {
  requestAdapter(): Promise<Adapter | null>;
  getPreferredCanvasFormat(): string;
}

interface SurfaceOps {
  op_create_window_context(): CanvasContext;
  op_surface_present(context: CanvasContext): void;
  op_surface_resize(w: number, h: number): void;
  op_set_frame_callback(cb: () => void): void;
  op_set_resize_callback(cb: (w: number, h: number) => void): void;
  op_log(msg: string): void;
}

declare const navigator: { gpu: Gpu };
declare const Deno: { core: { ops: SurfaceOps } };

const ops = Deno.core.ops;

const adapter = await navigator.gpu.requestAdapter();
if (!adapter) throw new Error("S4 FAIL: no adapter");
const device = await adapter.requestDevice();
const format = navigator.gpu.getPreferredCanvasFormat();

const context = ops.op_create_window_context();
function configure(): void {
  context.configure({ device, format, alphaMode: "opaque" });
}
configure();

let tick = 0;
function frame(): void {
  tick += 1;
  const phase = (tick % 240) / 240;
  const view = context.getCurrentTexture().createView();
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view,
      clearValue: { r: phase, g: 0.15, b: 1 - phase, a: 1 },
      loadOp: "clear",
      storeOp: "store",
    }],
  });
  pass.end();
  device.queue.submit([encoder.finish()]);
  ops.op_surface_present(context);
}

function onResize(w: number, h: number): void {
  ops.op_surface_resize(w, h);
  configure();
  ops.op_log(`S4 resized to ${w}x${h}`);
}

ops.op_set_frame_callback(frame);
ops.op_set_resize_callback(onResize);
ops.op_log("S4 OK: window context created, frame loop registered");
