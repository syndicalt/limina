import * as THREE from "../../build/three.bundle.mjs";

const DEFAULT_MAX_ENTRIES = 3;
const DEFAULT_MAX_SOURCE_BYTES = 24 * 1024 * 1024;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

interface PmremTarget {
  readonly texture: THREE.Texture;
  dispose(): void;
}

interface Entry {
  readonly assetId: string;
  readonly hash: string;
  readonly sourceBytes: number;
  readonly fingerprint: number;
  readonly source: THREE.DataTexture;
  readonly target: PmremTarget;
  leases: number;
  lastUsed: number;
}

export interface HdrEnvironmentCacheOptions {
  maxEntries?: number;
  maxSourceBytes?: number;
  /** Test seam. Production uses the bundled RGBELoader. */
  decode?: (bytes: Uint8Array) => THREE.DataTexture;
  /** Test seam. Production builds a PMREM target with the renderer owned by this cache. */
  buildPmrem?: (source: THREE.DataTexture) => PmremTarget;
}

export interface HdrEnvironmentCacheStats {
  entries: number;
  sourceBytes: number;
  activeLeases: number;
  decodes: number;
  evictions: number;
}

/**
 * One retained reference to a content-addressed HDR environment. `environment` is
 * the prefiltered PMREM texture used for PBR lighting; `background` is the decoded
 * equirectangular source used for the visible sky. A render-baseline session owns
 * exactly one lease and releases it during teardown.
 */
export interface HdrEnvironmentLease {
  readonly assetId: string;
  readonly hash: string;
  readonly environment: THREE.Texture;
  readonly background: THREE.DataTexture;
  retain(): HdrEnvironmentLease;
  release(): void;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new RangeError(`${label} must be a positive integer`);
  return resolved;
}

function byteFingerprint(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193);
  return hash >>> 0;
}

function decodeHdr(bytes: Uint8Array): THREE.DataTexture {
  interface HdrPixels { data: Float32Array | Uint16Array; width: number; height: number; type: number }
  const loaders = THREE as unknown as {
    HDRLoader?: new () => { parse(data: ArrayBuffer): HdrPixels };
    RGBELoader?: new () => { parse(data: ArrayBuffer): HdrPixels };
  };
  // Three r184 deprecates the RGBELoader name in favor of HDRLoader. Both are
  // bundled for compatibility; prefer the current name so native decoding emits
  // no deprecation warning.
  const Loader = loaders.HDRLoader ?? loaders.RGBELoader;
  if (Loader === undefined) throw new Error("HDRLoader/RGBELoader is not present in the native Three bundle");
  // HDRLoader.parse returns decoded HDR pixels (DataTextureLoader wraps these
  // during URL loading); our bytes are already content-addressed in memory, so
  // construct the DataTexture directly instead of creating a blob URL.
  const decoded = new Loader().parse(bytes.slice().buffer);
  const source = new THREE.DataTexture(
    decoded.data,
    decoded.width,
    decoded.height,
    THREE.RGBAFormat,
    decoded.type as THREE.TextureDataType,
  );
  source.mapping = THREE.EquirectangularReflectionMapping;
  source.colorSpace = THREE.LinearSRGBColorSpace;
  source.minFilter = THREE.LinearFilter;
  source.magFilter = THREE.LinearFilter;
  source.generateMipmaps = false;
  source.flipY = true;
  source.needsUpdate = true;
  return source;
}

/**
 * Bounded renderer-host cache for decoded HDR sources and their GPU-derived PMREM
 * targets. Entries are keyed by the already-verified AssetRegistry SHA-256, never
 * by a mutable path. Only idle entries may be evicted; an active world lease pins
 * its resources. This is intentionally renderer-scoped because PMREM textures are
 * backend resources and cannot be shared safely across renderers.
 */
export class HdrEnvironmentCache {
  readonly #maxEntries: number;
  readonly #maxSourceBytes: number;
  readonly #entries = new Map<string, Entry>();
  readonly #decode: (bytes: Uint8Array) => THREE.DataTexture;
  readonly #buildPmrem: (source: THREE.DataTexture) => PmremTarget;
  #sourceBytes = 0;
  #clock = 0;
  #decodes = 0;
  #evictions = 0;
  #disposed = false;

  constructor(renderer: unknown, options: HdrEnvironmentCacheOptions = {}) {
    this.#maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES, "HDR cache maxEntries");
    this.#maxSourceBytes = positiveInteger(options.maxSourceBytes, DEFAULT_MAX_SOURCE_BYTES, "HDR cache maxSourceBytes");
    this.#decode = options.decode ?? decodeHdr;
    this.#buildPmrem = options.buildPmrem ?? ((source) => {
      if (!renderer || typeof renderer !== "object") throw new Error("HDR PMREM requires a live renderer");
      const pmrem = new THREE.PMREMGenerator(renderer as never);
      try {
        pmrem.compileEquirectangularShader();
        return pmrem.fromEquirectangular(source) as PmremTarget;
      } finally {
        pmrem.dispose();
      }
    });
  }

  stats(): Readonly<HdrEnvironmentCacheStats> {
    let activeLeases = 0;
    for (const entry of this.#entries.values()) activeLeases += entry.leases;
    return Object.freeze({
      entries: this.#entries.size,
      sourceBytes: this.#sourceBytes,
      activeLeases,
      decodes: this.#decodes,
      evictions: this.#evictions,
    });
  }

  acquire(assetId: string, hash: string, bytes: Uint8Array): HdrEnvironmentLease {
    if (this.#disposed) throw new Error("HDR environment cache is disposed");
    if (typeof assetId !== "string" || assetId.length === 0) throw new TypeError("HDR assetId must be non-empty");
    if (!SHA256.test(hash)) throw new TypeError("HDR content hash must be a lower-case sha256: address");
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new TypeError("HDR bytes must be non-empty");
    if (bytes.byteLength > this.#maxSourceBytes) {
      throw new RangeError(`HDR source ${bytes.byteLength} bytes exceeds cache budget ${this.#maxSourceBytes}`);
    }

    const fingerprint = byteFingerprint(bytes);
    let entry = this.#entries.get(hash);
    if (entry === undefined) {
      this.#evictFor(bytes.byteLength);
      const source = this.#decode(bytes);
      let target: PmremTarget;
      try {
        source.mapping = THREE.EquirectangularReflectionMapping;
        source.needsUpdate = true;
        target = this.#buildPmrem(source);
      } catch (error) {
        source.dispose();
        throw error;
      }
      source.userData.liminaLifetime = "host";
      target.texture.userData.liminaLifetime = "host";
      entry = { assetId, hash, sourceBytes: bytes.byteLength, fingerprint, source, target, leases: 0, lastUsed: ++this.#clock };
      this.#entries.set(hash, entry);
      this.#sourceBytes += bytes.byteLength;
      this.#decodes++;
    } else {
      if (entry.sourceBytes !== bytes.byteLength || entry.fingerprint !== fingerprint) {
        throw new Error(`HDR content address ${hash} was reused for different bytes`);
      }
      entry.lastUsed = ++this.#clock;
    }
    entry.leases++;
    return this.#lease(entry);
  }

  #lease(entry: Entry): HdrEnvironmentLease {
    let released = false;
    return Object.freeze({
      assetId: entry.assetId,
      hash: entry.hash,
      environment: entry.target.texture,
      background: entry.source,
      retain: (): HdrEnvironmentLease => {
        if (released || this.#disposed || !this.#entries.has(entry.hash)) throw new Error("HDR environment lease is no longer active");
        entry.leases++;
        entry.lastUsed = ++this.#clock;
        return this.#lease(entry);
      },
      release: (): void => {
        if (released) return;
        released = true;
        if (entry.leases > 0) entry.leases--;
        entry.lastUsed = ++this.#clock;
      },
    });
  }

  #evictFor(incomingBytes: number): void {
    while (this.#entries.size >= this.#maxEntries || this.#sourceBytes + incomingBytes > this.#maxSourceBytes) {
      const idle = [...this.#entries.values()].filter((entry) => entry.leases === 0).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (idle === undefined) throw new Error("HDR environment cache budget is pinned by active world leases");
      this.#entries.delete(idle.hash);
      this.#sourceBytes -= idle.sourceBytes;
      idle.target.dispose();
      idle.source.dispose();
      this.#evictions++;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const entry of this.#entries.values()) {
      entry.target.dispose();
      entry.source.dispose();
    }
    this.#entries.clear();
    this.#sourceBytes = 0;
  }
}
