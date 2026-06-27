// limina embedder bootstrap - expose the standard WebGPU JS API.
//
// deno_webgpu ships navigator.gpu + the GPU* interface objects as a lazily
// evaluated ext module (the full Deno runtime wires them in its own bootstrap).
// In a bare deno_core embedder we attach them ourselves: every GPU* export
// becomes a global (three.js and ordinary WebGPU code reference e.g.
// GPUBufferUsage / GPUTextureUsage as globals), and navigator.gpu is a getter
// that calls initGPU() (which runs op_create_gpu) on first access.

import { core } from "ext:core/mod.js";
import * as webgpu from "ext:deno_webgpu/01_webgpu.js";
import * as webImage from "ext:deno_image/01_image.js";

const NON_GLOBAL = new Set(["initGPU", "gpu", "denoNsWebGPU"]);

for (const key of Object.keys(webgpu)) {
  if (NON_GLOBAL.has(key)) continue;
  Object.defineProperty(globalThis, key, {
    value: webgpu[key],
    configurable: true,
    writable: true,
    enumerable: false,
  });
}

// TextEncoder/TextDecoder from deno_web (needed by three's GLTFLoader and general
// text handling). Wired as globals like a browser/Deno runtime.
const textEncoding = core.loadExtScript("ext:deno_web/08_text_encoding.js");
if (typeof globalThis.TextEncoder === "undefined") {
  globalThis.TextEncoder = textEncoding.TextEncoder;
  globalThis.TextDecoder = textEncoding.TextDecoder;
}
const webBase64 = core.loadExtScript("ext:deno_web/05_base64.js");
if (typeof globalThis.atob === "undefined") globalThis.atob = webBase64.atob;
if (typeof globalThis.btoa === "undefined") globalThis.btoa = webBase64.btoa;

// Minimal asset-only web loading surface for three.js loaders. This is not a
// network fetch implementation: it resolves `limina-asset://<id>` and relative
// asset ids through limina's sandboxed `op_read_asset`, and supports data URLs.
const webUrl = core.loadExtScript("ext:deno_web/00_url.js");
const webFile = core.loadExtScript("ext:deno_web/09_file.js");
if (typeof globalThis.URL === "undefined" && webUrl.URL !== undefined) {
  globalThis.URL = webUrl.URL;
  globalThis.URLSearchParams = webUrl.URLSearchParams;
}
if (typeof globalThis.Blob === "undefined" && webFile.Blob !== undefined) {
  globalThis.Blob = webFile.Blob;
}

// Blob object-URL registry. deno_web's native URL.createObjectURL relies on a
// host BlobStore that this bare embedder does not wire up, so it yields opaque
// `blob:null/...` URLs that limina's asset-only fetch cannot resolve. three's
// GLTFLoader uses createObjectURL to load bufferView-embedded images (the image
// bytes packed in a .glb's BIN chunk), so those textures fail to decode and
// render white. We back object URLs with a JS-side Map so the blob round-trips
// through liminaFetch (below): createObjectURL stores the Blob, fetch reads its
// bytes back, and createImageBitmap decodes it -- the exact path that data: URI
// embedded textures already take. ASCII only.
const __liminaObjectUrls = new Map();
let __liminaObjectUrlSeq = 0;
if (typeof globalThis.URL === "function") {
  globalThis.URL.createObjectURL = function createObjectURL(blob) {
    const id = (__liminaObjectUrlSeq = (__liminaObjectUrlSeq + 1) >>> 0);
    const url = `blob:limina/${id}-${Date.now()}`;
    __liminaObjectUrls.set(url, blob);
    return url;
  };
  globalThis.URL.revokeObjectURL = function revokeObjectURL(url) {
    __liminaObjectUrls.delete(String(url));
  };
}
if (typeof globalThis.createImageBitmap === "undefined" && webImage.createImageBitmap !== undefined) {
  globalThis.createImageBitmap = webImage.createImageBitmap;
  globalThis.ImageBitmap = webImage.ImageBitmap;
}

// Texture upload bridge for three.js. deno_webgpu (0.218) has no
// GPUQueue.copyExternalImageToTexture, so three's WebGPU backend silently
// (try/catch) fails to upload ImageBitmap-backed textures, leaving them black.
// This exposes the decoded RGBA8 pixels of an ImageBitmap so the three.loadGLTF
// skill can re-home glTF textures onto the DataTexture/queue.writeTexture path,
// which works in this embedder. Returns null for anything that is not a decoded
// ImageBitmap (e.g. an already-converted data image). ASCII only.
const __LIMINA_BITMAP_DATA = Symbol.for("Deno_bitmapData");
globalThis.__liminaImageBitmapToRGBA = function (image) {
  if (image === null || typeof image !== "object") return null;
  const getData = image[__LIMINA_BITMAP_DATA];
  if (typeof getData !== "function") return null;
  const width = image.width | 0;
  const height = image.height | 0;
  if (width <= 0 || height <= 0) return null;
  const raw = getData.call(image);
  const pixelCount = width * height;
  if (pixelCount === 0 || raw.length % pixelCount !== 0) return null;
  const channels = raw.length / pixelCount;
  const rgba = new Uint8Array(pixelCount * 4);
  if (channels === 4) {
    rgba.set(raw);
  } else if (channels === 3) {
    for (let i = 0; i < pixelCount; i++) {
      rgba[i * 4] = raw[i * 3];
      rgba[i * 4 + 1] = raw[i * 3 + 1];
      rgba[i * 4 + 2] = raw[i * 3 + 2];
      rgba[i * 4 + 3] = 255;
    }
  } else if (channels === 1) {
    for (let i = 0; i < pixelCount; i++) {
      const v = raw[i];
      rgba[i * 4] = v;
      rgba[i * 4 + 1] = v;
      rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = 255;
    }
  } else if (channels === 2) {
    for (let i = 0; i < pixelCount; i++) {
      const v = raw[i * 2];
      rgba[i * 4] = v;
      rgba[i * 4 + 1] = v;
      rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = raw[i * 2 + 1];
    }
  } else {
    return null;
  }
  return { width, height, data: rgba };
};

class LiminaHeaders {
  constructor(init = {}) {
    this.map = new Map();
    if (init instanceof LiminaHeaders) {
      for (const [key, value] of init.map) this.map.set(key, value);
    } else if (Array.isArray(init)) {
      for (const [key, value] of init) this.set(key, value);
    } else {
      for (const key of Object.keys(init)) this.set(key, init[key]);
    }
  }
  get(name) {
    return this.map.get(String(name).toLowerCase()) ?? null;
  }
  set(name, value) {
    this.map.set(String(name).toLowerCase(), String(value));
  }
}

class LiminaRequest {
  constructor(input, init = {}) {
    this.url = typeof input === "string" ? input : String(input.url ?? "");
    this.headers = new LiminaHeaders(init.headers ?? input.headers ?? {});
    this.credentials = init.credentials ?? input.credentials;
    this.signal = init.signal ?? input.signal;
  }
}

class LiminaResponse {
  constructor(bytes, init = {}) {
    this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
    this.status = init.status ?? 200;
    this.statusText = init.statusText ?? "OK";
    this.url = init.url ?? "";
    this.headers = new LiminaHeaders(init.headers ?? {});
    this.ok = this.status >= 200 && this.status < 300;
    this.body = undefined;
  }
  arrayBuffer() {
    return Promise.resolve(this.bytes.buffer.slice(this.bytes.byteOffset, this.bytes.byteOffset + this.bytes.byteLength));
  }
  blob() {
    return Promise.resolve(new Blob([this.bytes], { type: this.headers.get("content-type") ?? "" }));
  }
  text() {
    return this.arrayBuffer().then((buffer) => new TextDecoder().decode(buffer));
  }
  json() {
    return this.text().then((text) => JSON.parse(text));
  }
}

function decodeDataUrl(url) {
  const comma = url.indexOf(",");
  if (!url.startsWith("data:") || comma < 0) return undefined;
  const meta = url.slice(5, comma);
  const body = url.slice(comma + 1);
  const mime = meta.split(";")[0] || "application/octet-stream";
  const base64 = meta.split(";").includes("base64");
  const binary = base64 ? atob(body) : decodeURIComponent(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, mime };
}

function assetIdFromUrl(input) {
  if (input.startsWith("limina-asset://")) return input.slice("limina-asset://".length);
  if (input.startsWith("./")) return input.slice(2);
  if (!input.includes("://") && !input.startsWith("/") && !input.includes("..")) return input;
  throw new Error(`unsupported fetch URL: ${input}`);
}

if (typeof globalThis.Headers === "undefined") globalThis.Headers = LiminaHeaders;
if (typeof globalThis.Request === "undefined") globalThis.Request = LiminaRequest;
if (typeof globalThis.Response === "undefined") globalThis.Response = LiminaResponse;
if (typeof globalThis.fetch === "undefined") {
  globalThis.fetch = function liminaFetch(input) {
    const url = typeof input === "string" ? input : String(input.url ?? "");
    if (url.startsWith("blob:")) {
      const blob = __liminaObjectUrls.get(url);
      if (blob === undefined) {
        return Promise.reject(new Error(`unknown object URL: ${url}`));
      }
      return blob.arrayBuffer().then((buffer) => new LiminaResponse(new Uint8Array(buffer), {
        url,
        headers: {
          "content-type": typeof blob.type === "string" ? blob.type : "",
          "content-length": String(blob.size ?? 0),
        },
      }));
    }
    const data = decodeDataUrl(url);
    if (data !== undefined) {
      return Promise.resolve(new LiminaResponse(data.bytes, {
        url,
        headers: { "content-type": data.mime, "content-length": String(data.bytes.byteLength) },
      }));
    }
    const assetId = assetIdFromUrl(url);
    const bytes = core.ops.op_read_asset(assetId);
    return Promise.resolve(new LiminaResponse(bytes, {
      url,
      headers: { "content-length": String(bytes.byteLength) },
    }));
  };
}

// Event/EventTarget/AbortController/AbortSignal from deno_web - three's loaders
// (GLTFLoader) reference these browser globals.
const webEvents = core.loadExtScript("ext:deno_web/02_event.js");
const webAbort = core.loadExtScript("ext:deno_web/03_abort_signal.js");
const webGlobals = {
  Event: webEvents.Event,
  EventTarget: webEvents.EventTarget,
  AbortController: webAbort.AbortController,
  AbortSignal: webAbort.AbortSignal,
};
for (const name of Object.keys(webGlobals)) {
  if (typeof globalThis[name] === "undefined" && webGlobals[name] !== undefined) {
    Object.defineProperty(globalThis, name, { value: webGlobals[name], configurable: true, writable: true });
  }
}

const navigator = {
  get gpu() {
    webgpu.initGPU();
    return webgpu.gpu;
  },
};

Object.defineProperty(globalThis, "navigator", {
  value: navigator,
  configurable: true,
  enumerable: true,
});

// Non-browser shim for libraries (three.js) that probe for browser globals.
// The host owns the frame loop, so requestAnimationFrame is a no-op: three's
// internal animation loop never self-drives; frames come from the host calling
// renderAsync. `self` lets three's feature checks resolve, and `performance`
// backs its timing.
if (typeof globalThis.self === "undefined") {
  globalThis.self = globalThis;
}
if (typeof globalThis.requestAnimationFrame === "undefined") {
  globalThis.requestAnimationFrame = function requestAnimationFrame() {
    return 0;
  };
  globalThis.cancelAnimationFrame = function cancelAnimationFrame() {};
}
if (typeof globalThis.performance === "undefined") {
  globalThis.performance = { now: () => Date.now() };
}
