// HOST-SIDE asset-fetch orchestrator — the bun-run front door to the asset pipeline's RETRIEVAL +
// GENERATION backends. The limina ENGINE is sandboxed (no fetch / no env / no fs-write); it only
// CONSUMES glb via the content-addressed asset.place (op_read_asset, rooted at <cwd>/assets). This tool
// is the other half: it runs author-side under `bun` (which HAS fetch + env + fs), hits the real Poly
// Pizza / 3D AI Studio APIs, persists the bytes to the disk cache the sandbox can't, and writes the
// resolved glb into assets/ so the engine can later place it BY ID.
//
//   RUN:  bun run tools/asset-fetch.ts --kind prop --prompt "barrel" --seed 1 [--source <name>] [--reference <img>]
//
// LADDER: library (Poly Pizza) → generative (3D AI Studio) fallback. An explicit --source pins ONE
// backend (no fallback). The AssetCache (in-memory hot tier over a gitignored .asset-cache/ disk tier)
// makes a paid/stochastic generate a ONE-TIME cost and the whole pipeline replay-safe: a second run for
// the same request returns the cached bytes (cached:true) without re-hitting any API.
//
// OUTPUT: one JSON line {assetId, format, bytes, license, attribution, sourceUrl, cached}. The `assetId`
// is the relative filename under assets/ — exactly what asset.place's op_read_asset resolves (the engine
// reads <cwd>/assets/<assetId>; see crates/limina-ops op_read_asset + js/src/asset-registry.ts toRef
// which addresses assets as `assets/${assetId}`).
//
// KEYS (never hardcoded): POLY_PIZZA_API_KEY (Poly Pizza, free account → API key), THREEDAI_API_KEY
// (3D AI Studio). With no usable key the tool prints a clear "set …" message and exits non-zero WITHOUT
// touching the network.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { installOps, type EngineOps } from "../js/src/engine.ts";
import { PolyPizzaAssetSource, polyFetchTransport } from "../js/src/asset/library-poly.ts";
import {
  GenerativeAssetSource,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from "../js/src/asset/generative-source.ts";
import { AssetCache, requestKey, type AssetStore } from "../js/src/asset/cache.ts";
import { AssetResolver } from "../js/src/asset/resolver.ts";
import type { AssetRequest, AssetResult, AssetSource } from "../js/src/asset/types.ts";
import { objArchiveToGlb } from "./obj-archive-to-glb.ts";
import { curateResolve, DEFAULT_MAX_ATTEMPTS } from "./curate.ts";

const LIBRARY_NAME = "library:polypizza";
const GENERATIVE_NAME = "generative:3daistudio";

// ── 0. A minimal bun/Node host op surface so generative-source's `ops.op_sleep_ms` (poll backoff) and
//       `ops.op_log` resolve off the native host. Real HTTP is injected via a fetch client, so the
//       op_http_post default is never used here. (generative-source reads the live `ops` binding.) ────
installOps({
  op_sleep_ms: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  op_log: (msg: string) => console.error(`[asset-fetch] ${msg}`),
  op_http_post: () => Promise.reject(new Error("op_http_post unused: a real fetch HttpClient is injected")),
} as unknown as EngineOps);

// Hard cap on a single downloaded GLB. A generative model result is a few MB; anything past this is a
// misconfigured/hostile endpoint, so we abort rather than buffer it into memory.
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

// Best-effort SSRF guard for the binary download URL. This is DEFENCE-IN-DEPTH, not a full mitigation:
// it does a plain hostname check and does NOT follow DNS rebinding or redirect targets. It keeps the
// tool from being pointed at https://localhost/… style internal endpoints via a crafted API response.
function isInternalHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "::") return true;
  // ULA (fc00::/7) + link-local (fe80::/10) — only meaningful on an actual IPv6
  // literal, so gate on a colon. Otherwise dotted-domain hosts like fcdn.example.com
  // or fd-assets.net would be false-positived by the raw prefix match.
  if (h.includes(":") && (h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd"))) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const o = m.slice(1).map(Number);
    if (o.some((n) => n > 255)) return true; // malformed dotted-quad -> reject
    const [a, b] = o;
    if (a === 0 || a === 127 || a === 10) return true; // this-host / loopback / private
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
  }
  return false;
}

function assertPublicHttpsUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`refusing to fetch non-URL asset target: ${raw}`);
  }
  if (u.protocol !== "https:") throw new Error(`refusing non-https asset URL: ${raw}`);
  const host = u.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (isInternalHost(host)) throw new Error(`refusing to fetch internal/loopback host: ${host}`);
}

// ── 1. A real fetch-backed HttpClient for the generative backend (bun `fetch`; sends Bearer auth, does
//       GET polls, and streams the binary GLB — all things the sandbox op_http_post can't). ───────────
const fetchHttpClient: HttpClient = {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.method === "POST" ? req.body : undefined,
    });
    return { status: res.status, body: await res.text() };
  },
  async fetchBinary(url: string, headers?: Record<string, string>): Promise<Uint8Array> {
    assertPublicHttpsUrl(url);
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`GLB download HTTP ${res.status}`);
    // Fast pre-check on the advertised size, then enforce the cap on the ACTUAL streamed bytes so a
    // missing/lying Content-Length can't slip past it.
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
      throw new Error(`GLB download too large: Content-Length ${declared} > cap ${MAX_DOWNLOAD_BYTES}`);
    }
    const body = res.body;
    if (!body) {
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error(`GLB download exceeded cap ${MAX_DOWNLOAD_BYTES} bytes`);
      return buf;
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > MAX_DOWNLOAD_BYTES) {
        await reader.cancel();
        throw new Error(`GLB download exceeded cap ${MAX_DOWNLOAD_BYTES} bytes`);
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  },
};

// ── 2. A Node-fs AssetStore: the gitignored .asset-cache/ disk tier the engine sandbox can't write but
//       bun can. Each request key → a sha256-named pair: <hash>.json (format + provenance meta) and
//       <hash>.bin (the raw glb bytes). This makes generation survive across process runs. ────────────
class FsAssetStore implements AssetStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  private base(key: string): string {
    return join(this.dir, createHash("sha256").update(key).digest("hex"));
  }
  load(key: string): AssetResult | undefined {
    const b = this.base(key);
    if (!existsSync(`${b}.json`) || !existsSync(`${b}.bin`)) return undefined;
    const meta = JSON.parse(readFileSync(`${b}.json`, "utf8")) as { format: AssetResult["format"]; meta: AssetResult["meta"] };
    return { format: meta.format, bytes: new Uint8Array(readFileSync(`${b}.bin`)), meta: meta.meta };
  }
  save(key: string, result: AssetResult): void {
    const b = this.base(key);
    writeFileSync(`${b}.bin`, result.bytes);
    writeFileSync(`${b}.json`, JSON.stringify({ format: result.format, meta: result.meta }, null, 2));
  }
}

// ── 3. CLI parsing ───────────────────────────────────────────────────────────
interface Args {
  kind: AssetRequest["kind"];
  prompt: string;
  seed: number;
  source?: string;
  reference?: string;
  /** CURATION: re-roll the seed past asset-selection mistakes (wrong-shape picks). On by default. */
  curate: boolean;
  /** Max seed re-rolls the curator tries before falling back to the best candidate. */
  maxAttempts: number;
}
const KINDS = new Set(["prop", "building", "character", "vegetation", "model"]);

function parseArgs(argv: string[]): Args {
  const m = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      m.set(k, v);
    }
  }
  const kind = (m.get("kind") ?? "prop") as AssetRequest["kind"];
  if (!KINDS.has(kind)) fail(`--kind must be one of ${[...KINDS].join(", ")} (got "${kind}")`);
  const prompt = m.get("prompt") ?? "";
  if (!prompt) fail("--prompt is required (the library search query / text-to-3D prompt)");
  const seed = Number(m.get("seed") ?? "0");
  if (!Number.isFinite(seed)) fail(`--seed must be a number (got "${m.get("seed")}")`);
  // Curation is ON by default; --no-curate skips the footprint gate + re-roll. --max-attempts tunes the
  // re-roll budget (default DEFAULT_MAX_ATTEMPTS).
  const curate = !m.has("no-curate");
  const maxAttempts = Number(m.get("max-attempts") ?? String(DEFAULT_MAX_ATTEMPTS));
  if (!Number.isFinite(maxAttempts) || maxAttempts < 1) fail(`--max-attempts must be a number >= 1 (got "${m.get("max-attempts")}")`);
  return { kind, prompt, seed, source: m.get("source"), reference: m.get("reference"), curate, maxAttempts };
}

function fail(msg: string): never {
  console.error(`asset-fetch: ${msg}`);
  process.exit(2);
}

/** Filesystem-safe slug for the deterministic assetId. */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "asset";
}

// ── 4. Main ────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const polyKey = process.env.POLY_PIZZA_API_KEY;
  const threeKey = process.env.THREEDAI_API_KEY;

  // Pre-flight key gate — surface a clear message and exit non-zero BEFORE any network call. The exact
  // key(s) required depend on the routing: an explicit --source needs that backend's key; the default
  // ladder needs at least one (library is tried first, generative is the fallback).
  if (args.source === LIBRARY_NAME && !polyKey) {
    keyError(`--source ${LIBRARY_NAME} needs POLY_PIZZA_API_KEY`);
  } else if (args.source === GENERATIVE_NAME && !threeKey) {
    keyError(`--source ${GENERATIVE_NAME} needs THREEDAI_API_KEY`);
  } else if (!args.source && !polyKey && !threeKey) {
    keyError("the library→generative ladder needs at least one key");
  }

  // Build the backends with REAL fetch-backed transports/clients + env keys.
  const library = new PolyPizzaAssetSource({ apiKey: polyKey, transport: polyFetchTransport });
  // The generative backend returns an OBJ ARCHIVE; inject the host-only converter (sharp + gltf-transform
  // + obj2gltf) that packs it into a single glb. This dep lives in tools/ — NEVER imported by the engine.
  const generative = new GenerativeAssetSource({
    apiKey: threeKey,
    http: fetchHttpClient,
    convertArchive: async (zipBytes) => ({ format: "glb", bytes: await objArchiveToGlb(zipBytes) }),
  });

  // The resolver ladder: library matches by default, generative is the fallback; an explicit --source
  // pins one backend by name (resolver throws if it names neither).
  const resolver = new AssetResolver([{ name: "library", match: () => true, source: library }], generative);

  // Build the request for a given seed (curation re-rolls the seed; everything else is fixed). The seed is
  // folded into the cache key, so each re-rolled seed is its own cache entry — and the curated seed that
  // wins is what gets cached, keeping re-rolls deterministic on replay.
  const reqFor = (seed: number): AssetRequest => ({
    kind: args.kind,
    seed,
    prompt: args.prompt,
    referenceImage: args.reference,
    ...(args.source ? { params: { source: args.source } } : {}),
  });

  const store = new FsAssetStore(join(process.cwd(), ".asset-cache"));
  const cache = new AssetCache(store);

  // Resolve a source through the cache, reporting whether the disk tier already held it.
  const resolveWith = async (
    req: AssetRequest,
    source: AssetSource,
  ): Promise<{ result: AssetResult; source: AssetSource; cached: boolean }> => {
    const cached = store.load(requestKey(source.name, req)) !== undefined;
    const result = await cache.resolve(req, source);
    return { result, source, cached };
  };

  // One full resolve for a given seed: explicit pin (one backend, no fallback) OR the library→generative
  // ladder. This is the unit the curator re-rolls.
  const resolveOnce = async (seed: number): Promise<{ result: AssetResult; source: AssetSource; cached: boolean }> => {
    const req = reqFor(seed);
    if (args.source) {
      return resolveWith(req, resolver.resolve(req));
    }
    const primary = resolver.resolve(req); // = library
    try {
      return await resolveWith(req, primary);
    } catch (e) {
      console.error(`asset-fetch: ${primary.name} failed (${(e as Error).message}); falling back to ${generative.name}`);
      if (!threeKey) keyError(`fallback to ${generative.name} needs THREEDAI_API_KEY`);
      return resolveWith(req, generative);
    }
  };

  // CURATION: re-roll the seed past asset-selection mistakes (a wide castle for "tower", a cluster for
  // "house") until a candidate passes the per-kind footprint check, or fall back to the best one seen. The
  // chosen seed is reported so the (deterministic) pick is visible.
  let resolved: { result: AssetResult; source: AssetSource; cached: boolean };
  let usedSeed = args.seed;
  let bounds: [number, number, number] | undefined;
  let aspect: number | undefined;
  if (args.curate) {
    const { chosen, seed, verdict } = await curateResolve({
      kind: args.kind,
      prompt: args.prompt,
      baseSeed: args.seed,
      maxAttempts: args.maxAttempts,
      resolve: resolveOnce,
    });
    resolved = chosen;
    usedSeed = seed;
    bounds = verdict.dims;
    aspect = verdict.aspect;
  } else {
    resolved = await resolveOnce(args.seed);
  }

  const { result, cached } = resolved;

  // Write the glb into assets/ under a deterministic id so asset.place can resolve it by that id (the
  // engine reads <cwd>/assets/<assetId> via op_read_asset; assets/ is the sandbox asset root).
  const assetsDir = join(process.cwd(), "assets");
  mkdirSync(assetsDir, { recursive: true });
  const assetId = `${args.kind}-${slug(args.prompt)}-${args.seed}.${result.format}`;
  writeFileSync(join(assetsDir, assetId), result.bytes);

  // One machine-readable JSON line (bytes = the glb byte length; the raw bytes live on disk). `seed` is the
  // CURATED seed actually used (== requested seed unless curation re-rolled); bounds/aspect are the
  // footprint the curator measured (null when --no-curate).
  console.log(
    JSON.stringify({
      assetId,
      format: result.format,
      bytes: result.bytes.length,
      seed: usedSeed,
      bounds: bounds ?? null,
      aspect: aspect ?? null,
      license: result.meta.license ?? null,
      attribution: result.meta.attribution ?? null,
      sourceUrl: result.meta.sourceUrl ?? null,
      cached,
    }),
  );
}

function keyError(why: string): never {
  console.error(
    `asset-fetch: missing API key — ${why}.\n` +
      "  Set POLY_PIZZA_API_KEY (Poly Pizza — free account → API key) for the library backend, and/or\n" +
      "  THREEDAI_API_KEY (3D AI Studio) for the generative backend. Never hardcode a key. Example:\n" +
      '    POLY_PIZZA_API_KEY=… bun run tools/asset-fetch.ts --kind prop --prompt "barrel" --seed 1',
  );
  process.exit(1);
}

main().catch((e) => {
  console.error(`asset-fetch: ${(e as Error).message}`);
  process.exit(1);
});
