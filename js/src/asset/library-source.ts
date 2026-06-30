// The LIBRARY source — Sketchfab's Creative-Commons catalog resolved as an AssetSource (types.ts:
// the "retrieval" backend). It searches Sketchfab for a model matching the request prompt, filters
// to redistributable licenses (CC0 first, CC-BY allowed), picks a DETERMINISTIC match (stable sort,
// indexed by req.seed), asks the Download API for a temporary archive URL, and fetches those bytes.
//
// WHO RUNS THIS, AND WHEN (mirrors model-source.ts):
//   - authoring  : this source hits Sketchfab ONCE, on the author's box, behind the asset.* skill.
//                  The resolved bytes are cached + snapshotted (the AssetCache replay contract).
//   - replay/play: end users NEVER hit Sketchfab. They replay the cached bytes carried in the export.
//                  This file is not on the playback path at all.
//
// DETERMINISM (the replay contract): a live catalog is not a pure function of the request (the index
// changes over time), so — exactly like a stochastic generator — the AssetCache makes the PIPELINE
// deterministic: generate once, then every later resolve (incl. replay) returns the same cached bytes.
// Within a single resolve we still pick deterministically: candidates are stable-sorted by uid and
// indexed by seed, so the SAME catalog snapshot + request always picks the SAME model.
//
// TRANSPORT IS INJECTABLE (mirrors TileTransport in model-source.ts). The Sketchfab calls need a GET
// with an `Authorization` header plus a binary archive fetch — shapes the limina sandbox host does NOT
// expose (its only HTTP op, op_http_post, is POST/JSON/text-only, and `fetch` is undefined in the
// sandbox; see js/test/p4_isolation.ts). So the DEFAULT transport uses the platform `fetch`, which is
// present in the real author-side host (Deno/Node/browser) where retrieval actually runs — and tests
// inject a MOCK transport that returns canned JSON + bytes, so search/filter/pick/download parsing is
// verified headlessly under ./target/release/limina with no token and no network.

import type { AssetRequest, AssetResult, AssetSource } from "./types.ts";

// ---- Sketchfab REST surface (Data API v3 + Download API) ---------------------
// Docs: https://sketchfab.com/developers/data-api/v3
//       https://sketchfab.com/developers/download-api/downloading-models
//       https://sketchfab.com/developers/download-api/guidelines

const SKETCHFAB_API = "https://api.sketchfab.com/v3";

/** License preference order. CC0 (public-domain, no attribution) is preferred; CC-BY (attribution
 *  required) is allowed. Sketchfab license *slugs* (the `license` search-filter values). We omit the
 *  NonCommercial / NoDerivatives / ShareAlike variants by default — they carry redistribution strings
 *  that complicate baking into an export. A host may widen this via opts.licenses. */
const DEFAULT_LICENSES = ["cc0", "by"] as const;

/** Sketchfab license slug → SPDX-ish id (AssetResult.meta.license) + whether a credit line is REQUIRED.
 *  CC0 is public domain (no attribution required); every CC-BY* variant requires attribution that must
 *  follow the asset everywhere (Download API guidelines). */
const LICENSE_INFO: Record<string, { spdx: string; attributionRequired: boolean; label: string }> = {
  cc0: { spdx: "CC0-1.0", attributionRequired: false, label: "CC0 1.0" },
  by: { spdx: "CC-BY-4.0", attributionRequired: true, label: "CC-BY 4.0" },
  "by-sa": { spdx: "CC-BY-SA-4.0", attributionRequired: true, label: "CC-BY-SA 4.0" },
  "by-nd": { spdx: "CC-BY-ND-4.0", attributionRequired: true, label: "CC-BY-ND 4.0" },
  "by-nc": { spdx: "CC-BY-NC-4.0", attributionRequired: true, label: "CC-BY-NC 4.0" },
  "by-nc-sa": { spdx: "CC-BY-NC-SA-4.0", attributionRequired: true, label: "CC-BY-NC-SA 4.0" },
  "by-nc-nd": { spdx: "CC-BY-NC-ND-4.0", attributionRequired: true, label: "CC-BY-NC-ND 4.0" },
};

/** The HTTP seam the Sketchfab calls go through. `getText` does an authenticated GET (the search +
 *  download-info JSON); `getBytes` fetches the temporary archive URL (no auth — the URL is pre-signed).
 *  The default impl is the platform `fetch`; tests inject a mock. */
export interface LibraryHttpTransport {
  /** GET `url` with `headers` (carries `Authorization: Token …`). Resolves the status + body text. */
  getText(url: string, headers: Record<string, string>): Promise<{ status: number; text: string }>;
  /** GET the (pre-signed, no-auth) archive `url`; resolve the raw bytes. */
  getBytes(url: string): Promise<Uint8Array>;
}

/** Default transport over the platform `fetch`. Present author-side (Deno/Node/browser); ABSENT in the
 *  limina sandbox (op_http_post is POST/JSON/text-only and cannot GET-with-headers or return binary),
 *  so under ./target/release/limina a caller MUST inject a transport (the tests do). */
export const fetchTransport: LibraryHttpTransport = {
  async getText(url, headers) {
    const f = (globalThis as { fetch?: typeof fetch }).fetch;
    if (!f) {
      throw new Error(
        "LibraryAssetSource: no `fetch` in this runtime. Retrieval runs author-side (Deno/Node/" +
          "browser); the limina sandbox has no GET op — pass opts.transport to inject one.",
      );
    }
    const res = await f(url, { headers });
    return { status: res.status, text: await res.text() };
  },
  async getBytes(url) {
    const f = (globalThis as { fetch?: typeof fetch }).fetch;
    if (!f) throw new Error("LibraryAssetSource: no `fetch` in this runtime; inject opts.transport.");
    const res = await f(url);
    if (!res.ok) throw new Error(`LibraryAssetSource: archive download HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  },
};

/** Read SKETCHFAB_API_TOKEN from the environment without assuming a specific host. The limina sandbox
 *  exposes no env API (Deno.env is undefined there — only Deno.core), so this safely returns undefined;
 *  a real author-side Deno/Node host returns the token. Never reads a hardcoded secret. */
function readEnvToken(name: string): string | undefined {
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

// ---- wire shapes ------------------------------------------------------------

interface SfUser {
  username?: string;
  displayName?: string;
  profileUrl?: string;
}
interface SfLicense {
  slug?: string;
  label?: string;
}
interface SfModel {
  uid: string;
  name?: string;
  viewerUrl?: string;
  isDownloadable?: boolean;
  license?: SfLicense;
  user?: SfUser;
  faceCount?: number;
  vertexCount?: number;
  animationCount?: number;
}
interface SfSearchResponse {
  results?: SfModel[];
}
interface SfArchive {
  url?: string;
  size?: number;
  expires?: number;
}
interface SfDownloadResponse {
  glb?: SfArchive;
  gltf?: SfArchive;
  usdz?: SfArchive;
  source?: SfArchive;
}

export interface LibraryAssetSourceOptions {
  /** Sketchfab API token. Defaults to env SKETCHFAB_API_TOKEN. NEVER hardcode a token. */
  token?: string;
  /** Env var name to read the token from (default "SKETCHFAB_API_TOKEN"). */
  tokenEnvVar?: string;
  /** Allowed license slugs in preference order (default {@link DEFAULT_LICENSES} = cc0, then by). */
  licenses?: readonly string[];
  /** Results requested per license query (Sketchfab caps at 24). */
  count?: number;
  /** Sort order for the search (default "-likeCount" — popular-first, a stable-ish ranking). */
  sortBy?: string;
  /** Injectable HTTP transport (defaults to {@link fetchTransport}). Tests inject a mock. */
  transport?: LibraryHttpTransport;
}

const DEFAULTS = { tokenEnvVar: "SKETCHFAB_API_TOKEN", count: 24, sortBy: "-likeCount" };

/** Build a query string from pairs (URLSearchParams may be absent in the sandbox; encodeURIComponent
 *  is a core ES global and always present). */
function qs(pairs: Array<[string, string]>): string {
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}

/** Stable, total order over models by uid (Sketchfab uids are unique strings), so the seed-indexed
 *  pick is independent of the API's result ordering → deterministic for a given catalog snapshot. */
function byUid(a: SfModel, b: SfModel): number {
  return a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
}

/** A Sketchfab-CC-catalog AssetSource. Searches → filters license → picks deterministically by seed →
 *  downloads the archive → returns the bytes with full provenance (source/license/attribution/url). */
export class LibraryAssetSource implements AssetSource {
  readonly name = "library:sketchfab";

  private readonly token: string | undefined;
  private readonly licenses: readonly string[];
  private readonly count: number;
  private readonly sortBy: string;
  private readonly transport: LibraryHttpTransport;

  constructor(opts: LibraryAssetSourceOptions = {}) {
    this.token = opts.token ?? readEnvToken(opts.tokenEnvVar ?? DEFAULTS.tokenEnvVar);
    this.licenses = opts.licenses ?? DEFAULT_LICENSES;
    this.count = opts.count ?? DEFAULTS.count;
    this.sortBy = opts.sortBy ?? DEFAULTS.sortBy;
    this.transport = opts.transport ?? fetchTransport;
  }

  async generateAsset(req: AssetRequest): Promise<AssetResult> {
    if (!this.token) {
      throw new Error(
        `LibraryAssetSource: ${DEFAULTS.tokenEnvVar} is not set. Export it (or pass opts.token) — ` +
          "the Sketchfab Data API requires an API token (never hardcode it).",
      );
    }
    const query = (req.prompt ?? "").trim();
    if (!query) {
      throw new Error("LibraryAssetSource: req.prompt is required as the Sketchfab search query.");
    }
    const authHeaders = { Authorization: `Token ${this.token}` };

    // Search each allowed license in PREFERENCE order; take the first license with hits. This both
    // enforces the license filter server-side AND realizes "prefer CC0, allow CC-BY".
    let pool: SfModel[] = [];
    let licenseSlug = "";
    for (const slug of this.licenses) {
      const url =
        `${SKETCHFAB_API}/search?` +
        qs([
          ["type", "models"],
          ["q", query],
          ["downloadable", "true"],
          ["license", slug],
          ["sort_by", this.sortBy],
          ["count", String(this.count)],
        ]);
      const res = await this.transport.getText(url, authHeaders);
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `LibraryAssetSource: Sketchfab auth failed (HTTP ${res.status}). Check ${DEFAULTS.tokenEnvVar}.`,
        );
      }
      if (res.status !== 200) {
        throw new Error(
          `LibraryAssetSource: search failed (HTTP ${res.status}) for license=${slug}: ` +
            `${res.text.slice(0, 160)}`,
        );
      }
      const parsed = this.parseSearch(res.text);
      // Belt-and-suspenders: keep only downloadable hits (the filter is also a query param).
      const hits = parsed.filter((m) => m.uid && m.isDownloadable !== false);
      if (hits.length > 0) {
        pool = hits;
        licenseSlug = slug;
        break;
      }
    }
    if (pool.length === 0) {
      throw new Error(
        `LibraryAssetSource: no downloadable ${this.licenses.join("/")} model for query "${query}".`,
      );
    }

    // Deterministic pick: stable order by uid, index by seed.
    pool.sort(byUid);
    const idx = ((req.seed % pool.length) + pool.length) % pool.length;
    const model = pool[idx];
    // The result object's own license slug wins if present (some catalogs return it); else the query slug.
    const effectiveSlug = model.license?.slug ?? licenseSlug;

    // Resolve the temporary archive URL, then fetch the bytes.
    const dl = await this.requestDownload(model.uid, authHeaders);
    const { format, archive } = pickArchive(dl);
    if (!archive?.url) {
      throw new Error(`LibraryAssetSource: no glb/gltf archive offered for model ${model.uid}.`);
    }
    const bytes = await this.transport.getBytes(archive.url);

    return {
      format,
      bytes,
      meta: {
        source: this.name,
        license: LICENSE_INFO[effectiveSlug]?.spdx ?? effectiveSlug,
        attribution: buildAttribution(model, effectiveSlug),
        sourceUrl: model.viewerUrl,
        polycount: model.faceCount,
        rigged: typeof model.animationCount === "number" ? model.animationCount > 0 : undefined,
      },
    };
  }

  /** Parse a /v3/search response into a model array (throws on non-JSON). */
  parseSearch(text: string): SfModel[] {
    let env: SfSearchResponse;
    try {
      env = JSON.parse(text) as SfSearchResponse;
    } catch (_e) {
      throw new Error(`LibraryAssetSource: search returned non-JSON (${text.slice(0, 120)}…)`);
    }
    return Array.isArray(env.results) ? env.results : [];
  }

  /** GET /v3/models/{uid}/download → the temporary-archive envelope (throws on auth/HTTP/JSON errors). */
  async requestDownload(uid: string, authHeaders: Record<string, string>): Promise<SfDownloadResponse> {
    const res = await this.transport.getText(`${SKETCHFAB_API}/models/${uid}/download`, authHeaders);
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `LibraryAssetSource: download auth failed (HTTP ${res.status}) for ${uid}. Check ${DEFAULTS.tokenEnvVar}.`,
      );
    }
    if (res.status !== 200) {
      throw new Error(
        `LibraryAssetSource: download request failed (HTTP ${res.status}) for ${uid}: ${res.text.slice(0, 160)}`,
      );
    }
    try {
      return JSON.parse(res.text) as SfDownloadResponse;
    } catch (_e) {
      throw new Error(`LibraryAssetSource: download returned non-JSON (${res.text.slice(0, 120)}…)`);
    }
  }
}

/** Prefer a single-file GLB; else the glTF archive. NOTE: Sketchfab's `gltf` download is a ZIP
 *  (scene.gltf + scene.bin + textures), so a "gltf"-format result here is that archive — the loader
 *  unzips it. A "glb" result is ready-to-load binary. */
function pickArchive(dl: SfDownloadResponse): { format: "glb" | "gltf"; archive: SfArchive | undefined } {
  if (dl.glb?.url) return { format: "glb", archive: dl.glb };
  return { format: "gltf", archive: dl.gltf };
}

/** Build the credit line for attribution licenses (CC-BY*): "Title by Author (model URL) — License".
 *  Returns undefined for CC0 (public domain, no attribution required by the contract). */
function buildAttribution(model: SfModel, slug: string): string | undefined {
  const info = LICENSE_INFO[slug];
  if (!info || !info.attributionRequired) return undefined;
  const title = model.name ?? "Untitled";
  const author = model.user?.displayName ?? model.user?.username ?? "Unknown";
  const url = model.viewerUrl ?? model.user?.profileUrl ?? "https://sketchfab.com";
  return `${title} by ${author} (${url}) — ${info.label}`;
}
