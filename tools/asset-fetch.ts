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
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`GLB download HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
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
  return { kind, prompt, seed, source: m.get("source"), reference: m.get("reference") };
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
  const generative = new GenerativeAssetSource({ apiKey: threeKey, http: fetchHttpClient });

  // The resolver ladder: library matches by default, generative is the fallback; an explicit --source
  // pins one backend by name (resolver throws if it names neither).
  const resolver = new AssetResolver([{ name: "library", match: () => true, source: library }], generative);

  const req: AssetRequest = {
    kind: args.kind,
    seed: args.seed,
    prompt: args.prompt,
    referenceImage: args.reference,
    ...(args.source ? { params: { source: args.source } } : {}),
  };

  const store = new FsAssetStore(join(process.cwd(), ".asset-cache"));
  const cache = new AssetCache(store);

  // Resolve a source through the cache, reporting whether the disk tier already held it.
  const resolveWith = async (source: AssetSource): Promise<{ result: AssetResult; source: AssetSource; cached: boolean }> => {
    const cached = store.load(requestKey(source.name, req)) !== undefined;
    const result = await cache.resolve(req, source);
    return { result, source, cached };
  };

  let resolved: { result: AssetResult; source: AssetSource; cached: boolean };
  if (args.source) {
    // Explicit pin: one backend, no fallback.
    resolved = await resolveWith(resolver.resolve(req));
  } else {
    // Ladder: library first; on failure (no hits / down) fall back to the generative backend.
    const primary = resolver.resolve(req); // = library
    try {
      resolved = await resolveWith(primary);
    } catch (e) {
      console.error(`asset-fetch: ${primary.name} failed (${(e as Error).message}); falling back to ${generative.name}`);
      if (!threeKey) keyError(`fallback to ${generative.name} needs THREEDAI_API_KEY`);
      resolved = await resolveWith(generative);
    }
  }

  const { result, cached } = resolved;

  // Write the glb into assets/ under a deterministic id so asset.place can resolve it by that id (the
  // engine reads <cwd>/assets/<assetId> via op_read_asset; assets/ is the sandbox asset root).
  const assetsDir = join(process.cwd(), "assets");
  mkdirSync(assetsDir, { recursive: true });
  const assetId = `${args.kind}-${slug(args.prompt)}-${args.seed}.${result.format}`;
  writeFileSync(join(assetsDir, assetId), result.bytes);

  // One machine-readable JSON line (bytes = the glb byte length; the raw bytes live on disk).
  console.log(
    JSON.stringify({
      assetId,
      format: result.format,
      bytes: result.bytes.length,
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
