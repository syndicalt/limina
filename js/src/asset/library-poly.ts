// The LIBRARY source (Poly Pizza variant) — Poly Pizza's free Creative-Commons catalog resolved as an
// AssetSource (types.ts: the "retrieval" backend), the FOSS sibling of library-source.ts. It searches
// Poly Pizza for a model matching the request prompt, picks a DETERMINISTIC match (stable sort by id,
// indexed by req.seed), and fetches the GLB the search result points at directly. Unlike Sketchfab there
// is NO OAuth2 + temporary-archive dance: Poly Pizza is key-header auth (`x-auth-token`) and every search
// hit already carries a direct, public `Download` GLB URL — so it's search → pick → fetch-bytes, one hop.
//
// WHO RUNS THIS, AND WHEN (mirrors library-source.ts):
//   - authoring  : this source hits Poly Pizza ONCE, on the author's box, behind the asset.* skill /
//                  the host-side orchestrator (tools/asset-fetch.ts). The bytes are cached + snapshotted
//                  (the AssetCache replay contract).
//   - replay/play: end users NEVER hit Poly Pizza. They replay the cached bytes carried in the export.
//
// DETERMINISM (the replay contract): a live catalog is not a pure function of the request (the index
// changes over time), so — exactly like a stochastic generator — the AssetCache makes the PIPELINE
// deterministic: generate once, then every later resolve (incl. replay) returns the same cached bytes.
// Within a single resolve we still pick deterministically: candidates are stable-sorted by id and
// indexed by seed, so the SAME catalog snapshot + request always picks the SAME model.
//
// TRANSPORT IS INJECTABLE (mirrors LibraryHttpTransport in library-source.ts). The Poly Pizza search is a
// GET with an `x-auth-token` header plus a binary GLB fetch — shapes the limina sandbox host does NOT
// expose (op_http_post is POST/JSON/text-only; `fetch` is undefined in the sandbox; see js/test/
// p4_isolation.ts). So the DEFAULT transport uses the platform `fetch`, present in the real author-side
// host (bun/Node/Deno/browser) where retrieval runs — and tests inject a MOCK transport that returns
// canned JSON + bytes, so search/pick/download parsing is verified headlessly under ./target/release/
// limina with no key and no network.
//
// API REFERENCE (Poly Pizza v1.1, https://poly.pizza/docs/api/v1.1):
//   GET https://api.poly.pizza/v1.1/search/{query}?Limit={n}   header: x-auth-token: <key>
//   → { results: [ { ID, Title, Thumbnail, Download (direct .glb URL), Attribution (credit string),
//        Creator: { Username, DPURL } | string, Licence (e.g. "CC-BY" | "CC0") } ] }
//   Model page: https://poly.pizza/m/{ID}. (Field names verified against live API-consuming code.)

import type { AssetRequest, AssetResult, AssetSource } from "./types.ts";

const POLY_PIZZA_API = "https://api.poly.pizza/v1.1";

/** Poly Pizza `Licence` string → SPDX-ish id (AssetResult.meta.license) + whether a credit line is
 *  REQUIRED. Poly Pizza hosts mostly CC-BY (the Google Poly archive is CC-BY 3.0) plus some CC0. CC0 is
 *  public domain (no attribution); every CC-BY* variant requires attribution that must follow the asset
 *  everywhere. Unknown slugs fall back to the raw string + attribution-required (the safe default). */
const LICENSE_INFO: Record<string, { spdx: string; attributionRequired: boolean; label: string }> = {
  cc0: { spdx: "CC0-1.0", attributionRequired: false, label: "CC0 1.0" },
  "cc-by": { spdx: "CC-BY-3.0", attributionRequired: true, label: "CC-BY 3.0" },
  by: { spdx: "CC-BY-3.0", attributionRequired: true, label: "CC-BY 3.0" },
  "cc-by-4.0": { spdx: "CC-BY-4.0", attributionRequired: true, label: "CC-BY 4.0" },
};

/** Normalize a raw Poly Pizza `Licence` string into {spdx, attributionRequired, label}. Lower-cases +
 *  strips spaces so "CC-BY", "CC BY", "cc0" all map; unknowns keep the raw string and assume attribution
 *  is required (never silently drop a required credit). */
function normalizeLicense(raw: string | undefined): { spdx: string; attributionRequired: boolean; label: string } {
  const key = (raw ?? "").trim().toLowerCase().replace(/\s+/g, "-");
  const hit = LICENSE_INFO[key];
  if (hit) return hit;
  if (/cc-?0|public.?domain/.test(key)) return LICENSE_INFO.cc0;
  // Unknown/empty → keep the raw label, require attribution (safe).
  return { spdx: raw && raw.length > 0 ? raw : "unknown", attributionRequired: true, label: raw ?? "unknown" };
}

/** The HTTP seam the Poly Pizza calls go through. `getText` does the key-authenticated search GET (the
 *  JSON list); `getBytes` fetches the public, no-auth `Download` GLB URL. The default impl is the
 *  platform `fetch`; tests inject a mock. Mirrors library-source.ts's LibraryHttpTransport. */
export interface PolyHttpTransport {
  /** GET `url` with `headers` (carries `x-auth-token: <key>`). Resolves the status + body text. */
  getText(url: string, headers: Record<string, string>): Promise<{ status: number; text: string }>;
  /** GET the (public, no-auth) `Download` GLB `url`; resolve the raw bytes. */
  getBytes(url: string): Promise<Uint8Array>;
}

/** Default transport over the platform `fetch`. Present author-side (bun/Node/Deno/browser); ABSENT in
 *  the limina sandbox (op_http_post is POST/JSON/text-only and cannot GET-with-headers or return binary),
 *  so under ./target/release/limina a caller MUST inject a transport (the tests do). */
export const polyFetchTransport: PolyHttpTransport = {
  async getText(url, headers) {
    const f = (globalThis as { fetch?: typeof fetch }).fetch;
    if (!f) {
      throw new Error(
        "PolyPizzaAssetSource: no `fetch` in this runtime. Retrieval runs author-side (bun/Node/Deno/" +
          "browser); the limina sandbox has no GET op — pass opts.transport to inject one.",
      );
    }
    const res = await f(url, { headers });
    return { status: res.status, text: await res.text() };
  },
  async getBytes(url) {
    const f = (globalThis as { fetch?: typeof fetch }).fetch;
    if (!f) throw new Error("PolyPizzaAssetSource: no `fetch` in this runtime; inject opts.transport.");
    const res = await f(url);
    if (!res.ok) throw new Error(`PolyPizzaAssetSource: GLB download HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  },
};

/** Read POLY_PIZZA_API_KEY from the environment without assuming a specific host. The limina sandbox
 *  exposes no env API (Deno.env is undefined there — only Deno.core), so this safely returns undefined; a
 *  real author-side bun/Node/Deno host returns the key. Never reads a hardcoded secret. */
function readEnvKey(name: string): string | undefined {
  const g = globalThis as {
    Deno?: { env?: { get(k: string): string | undefined } };
    process?: { env?: Record<string, string | undefined> };
  };
  try {
    const v = g.Deno?.env?.get?.(name);
    if (v) return v;
  } catch {
    // Deno env permission denied — fall through.
  }
  return g.process?.env?.[name] ?? undefined;
}

// ---- wire shapes (Poly Pizza v1.1 search result) ----------------------------

interface PpCreator {
  Username?: string;
  DPURL?: string;
}
interface PpModel {
  ID?: string;
  Title?: string;
  Thumbnail?: string;
  /** Direct, public GLB download URL (no auth). */
  Download?: string;
  /** Ready-made credit string for CC-BY models. */
  Attribution?: string;
  Creator?: PpCreator | string;
  /** License string, e.g. "CC-BY" | "CC0". */
  Licence?: string;
}
interface PpSearchResponse {
  results?: PpModel[];
  total?: number;
}

export interface PolyPizzaAssetSourceOptions {
  /** Poly Pizza API key. Defaults to env POLY_PIZZA_API_KEY. NEVER hardcode a key. */
  apiKey?: string;
  /** Env var name to read the key from (default "POLY_PIZZA_API_KEY"). */
  apiKeyEnvVar?: string;
  /** Results requested per query (Poly Pizza caps Limit at 24). */
  count?: number;
  /** Injectable HTTP transport (defaults to {@link polyFetchTransport}). Tests inject a mock. */
  transport?: PolyHttpTransport;
}

const DEFAULTS = { apiKeyEnvVar: "POLY_PIZZA_API_KEY", count: 24 };

/** Stable, total order over models by ID (Poly Pizza ids are unique strings), so the seed-indexed pick
 *  is independent of the API's result ordering → deterministic for a given catalog snapshot. */
function byId(a: PpModel, b: PpModel): number {
  const ai = a.ID ?? "";
  const bi = b.ID ?? "";
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

/** Derive the asset format from the download URL extension (Poly Pizza serves single-file GLB; default
 *  glb when the extension is absent or unrecognized). */
function formatOf(url: string): "glb" | "gltf" {
  return /\.gltf(\?|#|$)/i.test(url) ? "gltf" : "glb";
}

/** Build the credit line for attribution licenses (CC-BY*). Prefers Poly Pizza's ready-made
 *  `Attribution` string; else assembles "Title by Creator (model page) — License". Returns undefined for
 *  CC0 (public domain, no attribution required by the contract). */
function buildAttribution(model: PpModel, license: { attributionRequired: boolean; label: string }): string | undefined {
  if (!license.attributionRequired) return undefined;
  if (model.Attribution && model.Attribution.trim().length > 0) return model.Attribution.trim();
  const title = model.Title ?? "Untitled";
  const author = typeof model.Creator === "string" ? model.Creator : model.Creator?.Username ?? "Unknown";
  const url = model.ID ? `https://poly.pizza/m/${model.ID}` : "https://poly.pizza";
  return `${title} by ${author} (${url}) — ${license.label}`;
}

/** A Poly Pizza CC-catalog AssetSource. Searches → picks deterministically by seed → fetches the GLB the
 *  result points at → returns the bytes with full provenance (source/license/attribution/url). */
export class PolyPizzaAssetSource implements AssetSource {
  readonly name = "library:polypizza";

  private readonly apiKey: string | undefined;
  private readonly count: number;
  private readonly transport: PolyHttpTransport;

  constructor(opts: PolyPizzaAssetSourceOptions = {}) {
    this.apiKey = opts.apiKey ?? readEnvKey(opts.apiKeyEnvVar ?? DEFAULTS.apiKeyEnvVar);
    this.count = Math.min(opts.count ?? DEFAULTS.count, 24);
    this.transport = opts.transport ?? polyFetchTransport;
  }

  async generateAsset(req: AssetRequest): Promise<AssetResult> {
    if (!this.apiKey) {
      throw new Error(
        `PolyPizzaAssetSource: ${DEFAULTS.apiKeyEnvVar} is not set. Export it (or pass opts.apiKey) — ` +
          "the Poly Pizza API requires an API key (free, account → API key; never hardcode it).",
      );
    }
    const query = (req.prompt ?? "").trim();
    if (!query) {
      throw new Error("PolyPizzaAssetSource: req.prompt is required as the Poly Pizza search query.");
    }

    const url = `${POLY_PIZZA_API}/search/${encodeURIComponent(query)}?Limit=${this.count}`;
    const res = await this.transport.getText(url, { "x-auth-token": this.apiKey, Accept: "application/json" });
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `PolyPizzaAssetSource: Poly Pizza auth failed (HTTP ${res.status}). Check ${DEFAULTS.apiKeyEnvVar}.`,
      );
    }
    if (res.status !== 200) {
      throw new Error(`PolyPizzaAssetSource: search failed (HTTP ${res.status}) for "${query}": ${res.text.slice(0, 160)}`);
    }

    // Keep only hits with a usable id + a direct download URL.
    const pool = this.parseSearch(res.text).filter((m) => (m.ID ?? "").length > 0 && (m.Download ?? "").length > 0);
    if (pool.length === 0) {
      throw new Error(`PolyPizzaAssetSource: no downloadable model for query "${query}".`);
    }

    // Deterministic pick: stable order by id, index by seed.
    pool.sort(byId);
    const idx = ((req.seed % pool.length) + pool.length) % pool.length;
    const model = pool[idx];
    const downloadUrl = model.Download as string;

    const license = normalizeLicense(model.Licence);
    const bytes = await this.transport.getBytes(downloadUrl);

    return {
      format: formatOf(downloadUrl),
      bytes,
      meta: {
        source: this.name,
        license: license.spdx,
        attribution: buildAttribution(model, license),
        sourceUrl: model.ID ? `https://poly.pizza/m/${model.ID}` : undefined,
      },
    };
  }

  /** Parse a /v1.1/search response into a model array (throws on non-JSON). */
  parseSearch(text: string): PpModel[] {
    let env: PpSearchResponse;
    try {
      env = JSON.parse(text) as PpSearchResponse;
    } catch (_e) {
      throw new Error(`PolyPizzaAssetSource: search returned non-JSON (${text.slice(0, 120)}…)`);
    }
    return Array.isArray(env.results) ? env.results : [];
  }
}
