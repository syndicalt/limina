/** Canonical native-window pixel readback.
 *
 * Three's native render-target readback is not the authority here: Limina's native
 * surface is a deno_webgpu canvas context, and `p3_fidelity_readback` proved that
 * copying its live swapchain texture before present is reliable. This module makes
 * that path reusable while keeping row-padding removal and BGRA conversion pure and
 * independently falsifiable.
 */

interface NativeMappedBuffer {
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
  destroy?(): void;
}

interface NativeCommandEncoder {
  copyTextureToBuffer(
    source: { texture: NativeSurfaceTexture },
    destination: { buffer: NativeMappedBuffer; bytesPerRow: number },
    size: { width: number; height: number; depthOrArrayLayers: number },
  ): void;
  finish(): unknown;
}

export interface NativeReadbackDevice {
  createBuffer(descriptor: { size: number; usage: number }): NativeMappedBuffer;
  createCommandEncoder(): NativeCommandEncoder;
  queue: { submit(commands: unknown[]): void };
}

export interface NativeSurfaceTexture {
  readonly width: number;
  readonly height: number;
  readonly format: string;
}

export interface NativeReadbackContext {
  getCurrentTexture(): NativeSurfaceTexture;
}

export interface NativeSurfaceReadback {
  readonly width: number;
  readonly height: number;
  readonly format: string;
  readonly bytesPerRow: number;
  /** Tightly packed, top-left-origin canonical RGBA8 bytes. */
  readonly rgba: Uint8Array;
}

function errorSummary(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Keep the host's acquire/present contract balanced even when rendering, shader
 * compilation, or readback rejects. An unpresented acquired swapchain texture can
 * otherwise survive into runtime teardown and trigger a wgpu-hal lifetime panic
 * that masks the original JavaScript error.
 */
export async function withPresentedNativeSurfaceFrame<T>(
  present: () => void,
  operation: () => T | Promise<T>,
): Promise<T> {
  let result: T | undefined;
  let primary: unknown;
  try {
    result = await operation();
  } catch (error) {
    primary = error;
  }
  try {
    present();
  } catch (error) {
    if (primary !== undefined) {
      throw new AggregateError(
        [primary, error],
        `native surface frame operation failed (${errorSummary(primary)}); present also failed (${errorSummary(error)})`,
      );
    }
    throw error;
  }
  if (primary !== undefined) throw primary;
  return result as T;
}

declare const GPUBufferUsage: { readonly COPY_DST: number; readonly MAP_READ: number };
declare const GPUMapMode: { readonly READ: number };

function positiveDimension(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 16_384) {
    throw new RangeError(`${name} must be an integer in [1,16384]`);
  }
  return value;
}

export function nativeSurfaceReadbackLayout(width: number, height: number): Readonly<{
  width: number;
  height: number;
  bytesPerRow: number;
  byteLength: number;
}> {
  const w = positiveDimension(width, "native readback width");
  const h = positiveDimension(height, "native readback height");
  const bytesPerRow = Math.ceil((w * 4) / 256) * 256;
  return Object.freeze({ width: w, height: h, bytesPerRow, byteLength: bytesPerRow * h });
}

function channelOrder(format: string): "rgba" | "bgra" {
  if (format === "rgba8unorm" || format === "rgba8unorm-srgb") return "rgba";
  if (format === "bgra8unorm" || format === "bgra8unorm-srgb") return "bgra";
  throw new Error(`native surface readback requires an RGBA8/BGRA8 surface, received '${format}'`);
}

/** Remove WebGPU row padding and normalize the native surface's channel order. */
export function canonicalizeNativeSurfacePixels(
  source: Uint8Array,
  width: number,
  height: number,
  bytesPerRow: number,
  format: string,
): Uint8Array {
  const layout = nativeSurfaceReadbackLayout(width, height);
  if (!Number.isSafeInteger(bytesPerRow) || bytesPerRow < width * 4 || bytesPerRow % 256 !== 0) {
    throw new RangeError("native surface bytesPerRow must be 256-byte aligned and cover one RGBA8 row");
  }
  if (source.byteLength !== bytesPerRow * layout.height) {
    throw new RangeError(`native surface byte length ${source.byteLength} does not match ${bytesPerRow * layout.height}`);
  }
  const order = channelOrder(format);
  const rgba = new Uint8Array(layout.width * layout.height * 4);
  for (let y = 0; y < layout.height; y++) {
    const sourceRow = y * bytesPerRow;
    const targetRow = y * layout.width * 4;
    for (let x = 0; x < layout.width; x++) {
      const from = sourceRow + x * 4;
      const to = targetRow + x * 4;
      if (order === "rgba") {
        rgba[to] = source[from];
        rgba[to + 1] = source[from + 1];
        rgba[to + 2] = source[from + 2];
      } else {
        rgba[to] = source[from + 2];
        rgba[to + 1] = source[from + 1];
        rgba[to + 2] = source[from];
      }
      rgba[to + 3] = source[from + 3];
    }
  }
  return rgba;
}

/** Copy the current native swapchain texture before it is presented. */
export async function readNativeSurfaceRgba(input: {
  readonly device: NativeReadbackDevice;
  readonly context: NativeReadbackContext;
  readonly expectedWidth?: number;
  readonly expectedHeight?: number;
  readonly minimumWidth?: number;
  readonly minimumHeight?: number;
}): Promise<NativeSurfaceReadback> {
  const texture = input.context.getCurrentTexture();
  const layout = nativeSurfaceReadbackLayout(texture.width, texture.height);
  if (input.expectedWidth !== undefined && layout.width !== input.expectedWidth) {
    throw new Error(`native capture surface width ${layout.width} does not match required ${input.expectedWidth}`);
  }
  if (input.expectedHeight !== undefined && layout.height !== input.expectedHeight) {
    throw new Error(`native capture surface height ${layout.height} does not match required ${input.expectedHeight}`);
  }
  if (input.minimumWidth !== undefined && layout.width < input.minimumWidth) {
    throw new Error(`native capture surface width ${layout.width} is below required ${input.minimumWidth}`);
  }
  if (input.minimumHeight !== undefined && layout.height < input.minimumHeight) {
    throw new Error(`native capture surface height ${layout.height} is below required ${input.minimumHeight}`);
  }
  channelOrder(texture.format);
  const buffer = input.device.createBuffer({
    size: layout.byteLength,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  let mapped = false;
  try {
    const encoder = input.device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture },
      { buffer, bytesPerRow: layout.bytesPerRow },
      { width: layout.width, height: layout.height, depthOrArrayLayers: 1 },
    );
    input.device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    mapped = true;
    const padded = new Uint8Array(buffer.getMappedRange().slice(0));
    return Object.freeze({
      width: layout.width,
      height: layout.height,
      format: texture.format,
      bytesPerRow: layout.bytesPerRow,
      rgba: canonicalizeNativeSurfacePixels(padded, layout.width, layout.height, layout.bytesPerRow, texture.format),
    });
  } finally {
    if (mapped) buffer.unmap();
    buffer.destroy?.();
  }
}
