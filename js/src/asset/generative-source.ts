// The GENERATIVE source — the 3D AI Studio (https://3daistudio.com) text-to-3D / image-to-3D backend
// resolved as an AssetSource (types.ts: the "authoring" backend). 3D AI Studio runs Tencent's Hunyuan3D
// model; generation is ASYNC: you POST a job, get a task id, poll until the result asset URL is ready,
// download the result ARCHIVE (a .zip of OBJ + MTL + separate PBR PNGs), then CONVERT it to a single glb.
//
// THE REAL CONTRACT (3D AI Studio v1):
//   START : POST /3d-models/tencent/generate/rapid/  body {"prompt": "...", "enable_pbr": true}
//           → {"task_id":"...","created_at":"..."}
//   POLL  : GET  /generation-request/{task_id}/status/
//           → {"status":"IN_PROGRESS"|"FINISHED"|"FAILED","progress":N,
//              "results":[{"asset":<url|null>,"asset_type":"ARCHIVE","metadata":null}],"failure_reason":null}
//           NUANCE: when status FIRST flips to FINISHED, results[0].asset is often STILL null — keep
//           polling until results[0].asset is a non-null URL.
//   DL    : results[0].asset is a presigned Cloudflare-R2 .zip URL (NO auth header; expires ~3600s).
//   ARCHIVE: a <hash>.obj + material.mtl + SEPARATE PBR PNGs (albedo, metallic, roughness, normal).
//
// WHO RUNS THIS, AND WHEN (mirrors terrain/model-source.ts):
//   - authoring  : this source hits the paid API ONCE per distinct request; the converted glb BAKES into
//                  the AssetCache (cache.ts) and rides the export. Out-of-process, baked, never a runtime.
//   - replay/play: end users NEVER call the API. They replay cached bytes. The durable log records only
//                  the REQUEST (+ content hash); the cache makes a STOCHASTIC, paid model replay-safe.
//
// TWO INJECTABLE SEAMS (so the embedded limina engine — no npm modules — can still type-check + unit-test
// this source headlessly):
//   1. config.http          — the HttpClient (Bearer auth POST, GET poll, binary R2 download). The default
//                             op_http_post client can't do these; a real host injects a fetch/reqwest one.
//   2. config.convertArchive — the OBJ-archive → glb converter. It depends on host-only npm tooling
//                             (sharp + gltf-transform + obj2gltf), which the engine sandbox CANNOT import,
//                             so it is INJECTED rather than imported at module top. tools/asset-fetch.ts
//                             wires in tools/obj-archive-to-glb.ts#objArchiveToGlb; tests inject a trivial
//                             stub. See js/test/p17d_generative_source.ts.

import { ops } from "../engine.ts";
import type { AssetRequest, AssetResult, AssetSource } from "./types.ts";

// ---- base64 (atob/btoa-backed; same approach as terrain/model-source.ts) ----

/** Decode standard base64 to bytes (host `atob`, present in the runtime). Tolerates a data: URI
 *  prefix and surrounding whitespace. Retained as a utility for hosts/tests that round-trip bytes. */
export function decodeBase64(b64: string): Uint8Array {
  const clean = b64.includes(",") && b64.startsWith("data:") ? b64.slice(b64.indexOf(",") + 1) : b64;
  const bin = atob(clean.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- the injectable HTTP seam ----------------------------------------------

export interface HttpResponse {
  /** HTTP status (the default op-backed client reports 200 on a resolved body; an injected client
   *  reports the real status so the source can surface auth/quota errors). */
  status: number;
  /** Response body as text (JSON for the start + poll steps). */
  body: string;
}

export interface HttpRequest {
  method: "GET" | "POST";
  url: string;
  /** e.g. { Authorization: "Bearer <key>" }. The default op-backed client cannot send these (see the
   *  file header); an injected real client must. */
  headers?: Record<string, string>;
  /** JSON body for POST. */
  body?: string;
}

/** A pluggable HTTP client — the seam tests mock and a real host injects. Mirrors model-source.ts's
 *  TileTransport, widened to the method/headers/binary the 3D AI Studio REST flow needs. */
export interface HttpClient {
  /** Text request (the start POST and the poll GET). */
  request(req: HttpRequest): Promise<HttpResponse>;
  /** Binary download from a URL (the presigned R2 archive .zip). The default op-backed client cannot do
   *  this (op_http_post returns text); a real host injects a binary-capable client. */
  fetchBinary(url: string, headers?: Record<string, string>): Promise<Uint8Array>;
}

/** Default client over the host `op_http_post`. POST + JSON only; headers/method/status/binary are NOT
 *  honored (the embedded runtime exposes no richer HTTP op). It exists so the source has a working
 *  default to override in tests; a real run injects a fuller client via config.http. */
export const opHttpClient: HttpClient = {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const body = await ops.op_http_post(req.url, req.body ?? "{}");
    return { status: 200, body };
  },
  fetchBinary(url: string): Promise<Uint8Array> {
    return Promise.reject(
      new Error(
        `GenerativeAssetSource: the default op_http_post client cannot download the binary archive from a URL ` +
          `(${url}); inject a binary-capable HttpClient via config.http (see tools/asset-fetch.ts).`,
      ),
    );
  },
};

// ---- the injectable archive→glb converter seam ------------------------------

/** The product of converting a downloaded result archive: a single binary glb. */
export interface ConvertedArchive {
  format: "glb";
  bytes: Uint8Array;
}

/** Converts a 3D AI Studio result archive (.zip bytes) into a single glb. Host-only (depends on sharp +
 *  gltf-transform + obj2gltf, which the engine sandbox can't import), so it is INJECTED. See
 *  tools/obj-archive-to-glb.ts#objArchiveToGlb. */
export type ArchiveConverter = (zipBytes: Uint8Array) => Promise<ConvertedArchive>;

// ---- config -----------------------------------------------------------------

export interface GenerativeAssetSourceConfig {
  /** API base URL (no trailing slash). Default 3D AI Studio v1. */
  endpoint?: string;
  /** Bearer token. If omitted, read from the THREEDAI_API_KEY env var at call time (NEVER hardcoded).
   *  Resolution is deferred to generateAsset so the source can be constructed (and unit-tested) with no
   *  key present. */
  apiKey?: string;
  /** Delay between poll attempts (ms). */
  pollIntervalMs?: number;
  /** Max poll attempts before a timeout error. pollIntervalMs * maxPollAttempts bounds total wait. */
  maxPollAttempts?: number;
  /** Path appended to endpoint for the start POST. */
  startPath?: string;
  /** Builds the status path for a task id (appended to endpoint). */
  statusPath?: (taskId: string) => string;
  /** Injectable HTTP client (defaults to {@link opHttpClient}). Tests mock it; a real host injects a
   *  header/GET/binary-capable client. */
  http?: HttpClient;
  /** Injectable archive→glb converter (required at generation time). Host wires in objArchiveToGlb; tests
   *  inject a trivial stub. */
  convertArchive?: ArchiveConverter;
  /** Provenance name override (defaults to "generative:3daistudio"). */
  name?: string;
}

const DEFAULTS = {
  endpoint: "https://api.3daistudio.com/v1",
  pollIntervalMs: 3000,
  maxPollAttempts: 80, // 80 * 3s = 240s cap (rapid Hunyuan3D finishes well inside this)
  startPath: "/3d-models/tencent/generate/rapid/",
  statusPath: (id: string) => `/generation-request/${id}/status/`,
  name: "generative:3daistudio",
};

const SUCCESS_STATES = new Set(["finished", "completed", "succeeded", "success", "done", "complete"]);
const FAILURE_STATES = new Set(["failed", "error", "errored", "canceled", "cancelled", "rejected"]);

// ---- env key read (guarded; the embedded runtime has no Deno.env) -----------

/** Best-effort THREEDAI_API_KEY read. The embedded deno_core runtime exposes no `Deno.env`, so this is
 *  fully guarded (a real host — node/bun/deno — may provide one). Returns undefined rather than throwing;
 *  the caller raises a clear error only when a key is actually required. */
function readApiKeyFromEnv(): string | undefined {
  try {
    const g = globalThis as unknown as {
      Deno?: { env?: { get?: (k: string) => string | undefined } };
      process?: { env?: Record<string, string | undefined> };
    };
    return g.Deno?.env?.get?.("THREEDAI_API_KEY") ?? g.process?.env?.THREEDAI_API_KEY ?? undefined;
  } catch {
    return undefined;
  }
}

// ---- small helpers ----------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

/** First defined string among a record's candidate keys (shallow). */
function pickString(obj: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function pickNumber(obj: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

// ---- the source -------------------------------------------------------------

export class GenerativeAssetSource implements AssetSource {
  readonly name: string;
  readonly endpoint: string;
  readonly pollIntervalMs: number;
  readonly maxPollAttempts: number;

  private readonly apiKeyOverride?: string;
  private readonly startPath: string;
  private readonly statusPath: (id: string) => string;
  private readonly http: HttpClient;
  private readonly convertArchive?: ArchiveConverter;

  constructor(cfg: GenerativeAssetSourceConfig = {}) {
    this.name = cfg.name ?? DEFAULTS.name;
    this.endpoint = (cfg.endpoint ?? DEFAULTS.endpoint).replace(/\/$/, "");
    this.pollIntervalMs = cfg.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
    this.maxPollAttempts = cfg.maxPollAttempts ?? DEFAULTS.maxPollAttempts;
    this.apiKeyOverride = cfg.apiKey;
    this.startPath = cfg.startPath ?? DEFAULTS.startPath;
    this.statusPath = cfg.statusPath ?? DEFAULTS.statusPath;
    this.http = cfg.http ?? opHttpClient;
    this.convertArchive = cfg.convertArchive;
    if (!(this.maxPollAttempts > 0)) {
      throw new Error(`GenerativeAssetSource: maxPollAttempts must be > 0 (got ${this.maxPollAttempts})`);
    }
  }

  /** The Bearer token: constructor override wins, else THREEDAI_API_KEY from the environment. Throws a
   *  clear error if neither is present (only when generation is actually attempted). */
  private resolveApiKey(): string {
    const key = this.apiKeyOverride ?? readApiKeyFromEnv();
    if (!key) {
      throw new Error(
        "GenerativeAssetSource: missing API key — set the THREEDAI_API_KEY environment variable " +
          "(or pass config.apiKey). Never hardcode the key.",
      );
    }
    return key;
  }

  private authHeaders(key: string): Record<string, string> {
    return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  }

  /** POST a generation job; poll until the result archive URL is ready; download the archive; convert it
   *  to a glb; return the asset. Stochastic — the AssetCache guarantees this runs only on a MISS. */
  async generateAsset(req: AssetRequest): Promise<AssetResult> {
    if (!this.convertArchive) {
      throw new Error(
        "GenerativeAssetSource: no archive converter — inject config.convertArchive (host wires in " +
          "tools/obj-archive-to-glb.ts#objArchiveToGlb). The 3D AI Studio result is an OBJ archive, not a glb.",
      );
    }
    const key = this.resolveApiKey();
    const headers = this.authHeaders(key);

    const taskId = await this.startJob(req, headers);
    const result = await this.pollUntilAsset(taskId, headers);
    // The asset is a presigned Cloudflare-R2 URL — download WITHOUT the Bearer header (R2 rejects it).
    let zipBytes: Uint8Array;
    try {
      zipBytes = await this.http.fetchBinary(result.assetUrl);
    } catch (e) {
      throw new Error(`GenerativeAssetSource: archive download failed (${result.assetUrl}): ${(e as Error).message}`);
    }
    let converted: ConvertedArchive;
    try {
      converted = await this.convertArchive(zipBytes);
    } catch (e) {
      throw new Error(`GenerativeAssetSource: archive→glb conversion failed: ${(e as Error).message}`);
    }

    return {
      format: converted.format,
      bytes: converted.bytes,
      meta: {
        source: this.name,
        sourceUrl: result.assetUrl,
      },
    };
  }

  /** Step 1 — start the async job. text-to-3D sends {prompt, enable_pbr:true}; a referenceImage adds an
   *  `image` field for image-to-3D (TODO: the exact image-to-3D field/encoding is UNVERIFIED). Returns the
   *  task_id the poll step tracks. */
  private async startJob(req: AssetRequest, headers: Record<string, string>): Promise<string> {
    if (!req.prompt && !req.referenceImage) {
      throw new Error("GenerativeAssetSource: a request needs a prompt and/or a referenceImage to generate.");
    }
    const body: Record<string, unknown> = { enable_pbr: true };
    if (req.prompt) body.prompt = req.prompt; // text-to-3D
    // TODO(image-to-3D): the rapid/tencent endpoint's image field is UNVERIFIED — `image` is a best guess.
    if (req.referenceImage) body.image = req.referenceImage;
    // Allow callers to pass through extra backend knobs (e.g. style/quality) via req.params.
    if (req.params) {
      for (const [k, v] of Object.entries(req.params)) {
        if (k !== "source") body[k] = v; // `source` is a router hint, not an API field.
      }
    }

    let resp: HttpResponse;
    try {
      resp = await this.http.request({
        method: "POST",
        url: `${this.endpoint}${this.startPath}`,
        headers,
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`GenerativeAssetSource: start request failed: ${(e as Error).message}`);
    }
    if (resp.status >= 400) {
      throw new Error(`GenerativeAssetSource: start failed (HTTP ${resp.status}): ${resp.body.slice(0, 200)}`);
    }

    const json = this.parseJson(resp.body, "start");
    const id = pickString(json, ["task_id", "taskId", "id", "uuid"]) ??
      pickString(asRecord(json.data), ["task_id", "taskId", "id"]);
    if (!id) {
      throw new Error(`GenerativeAssetSource: start response had no task_id: ${resp.body.slice(0, 200)}`);
    }
    return id;
  }

  /** Step 2 — poll GET /generation-request/{id}/status/ until results[0].asset is a non-null URL. Bounded
   *  retry (op_sleep_ms between attempts). CRITICAL: status flips to FINISHED BEFORE the asset URL
   *  populates, so a FINISHED-but-null-asset poll is treated as still-pending and we keep polling. Throws
   *  on a failure status (surfacing failure_reason) or after maxPollAttempts (timeout). */
  private async pollUntilAsset(
    taskId: string,
    headers: Record<string, string>,
  ): Promise<{ assetUrl: string; progress?: number }> {
    for (let attempt = 0; attempt < this.maxPollAttempts; attempt++) {
      if (attempt > 0) await ops.op_sleep_ms(this.pollIntervalMs);

      let resp: HttpResponse;
      try {
        resp = await this.http.request({
          method: "GET",
          url: `${this.endpoint}${this.statusPath(taskId)}`,
          headers,
        });
      } catch (e) {
        throw new Error(`GenerativeAssetSource: poll request failed for task ${taskId}: ${(e as Error).message}`);
      }
      if (resp.status >= 400) {
        throw new Error(
          `GenerativeAssetSource: poll failed for task ${taskId} (HTTP ${resp.status}): ${resp.body.slice(0, 200)}`,
        );
      }

      const json = this.parseJson(resp.body, "poll");
      const status = (pickString(json, ["status", "state"]) ?? "").toLowerCase();
      const progress = pickNumber(json, ["progress"]);

      if (FAILURE_STATES.has(status)) {
        const reason = pickString(json, ["failure_reason", "error", "message", "detail", "reason"]) ?? status;
        throw new Error(`GenerativeAssetSource: task ${taskId} failed (${status}): ${reason}`);
      }

      // Extract results[0].asset whenever it is present — independent of the status string, since the
      // asset URL can populate on the same poll the status reads FINISHED (or a poll or two later).
      const assetUrl = this.extractAssetUrl(json);
      if (assetUrl) return { assetUrl, progress };

      // FINISHED-but-null-asset, or IN_PROGRESS → keep polling (the documented late-populate nuance).
    }
    throw new Error(
      `GenerativeAssetSource: task ${taskId} timed out after ${this.maxPollAttempts} polls ` +
        `(~${(this.maxPollAttempts * this.pollIntervalMs) / 1000}s) waiting for results[0].asset.`,
    );
  }

  /** Pull results[0].asset (a non-null URL) out of a status payload. Tolerant of the documented shape
   *  (`results: [{asset}]`) plus a couple of common synonyms. */
  private extractAssetUrl(json: Record<string, unknown>): string | undefined {
    const arr = (json.results ?? json.outputs ?? json.assets) as unknown;
    if (Array.isArray(arr)) {
      for (const entry of arr) {
        const rec = asRecord(entry);
        const url = pickString(rec, ["asset", "url", "download_url", "file_url"]);
        if (url) return url;
      }
    }
    // Fallback: a top-level/nested single asset url.
    return pickString(json, ["asset", "model_url", "url", "download_url"]) ??
      pickString(asRecord(json.result), ["asset", "url"]);
  }

  private parseJson(text: string, step: string): Record<string, unknown> {
    try {
      const v = JSON.parse(text);
      const rec = asRecord(v);
      if (!rec) throw new Error("not a JSON object");
      return rec;
    } catch (e) {
      throw new Error(`GenerativeAssetSource: ${step} returned non-JSON (${(e as Error).message}): ${text.slice(0, 120)}…`);
    }
  }
}
