// The GENERATIVE source — a 3D AI Studio (https://3daistudio.com) text-to-3D / image-to-3D backend
// resolved as an AssetSource (types.ts: the "authoring" backend). 3D AI Studio runs its own models
// (Prism Turbo/Swift/Forge, Prism 3, …) and exports GLB + PBR. Generation is ASYNC: you POST a job,
// get a task id, poll until the task finishes, then fetch the GLB.
//
// WHO RUNS THIS, AND WHEN (mirrors terrain/model-source.ts):
//   - authoring  : this source hits the paid API ONCE per distinct request; the bytes BAKE into the
//                  AssetCache (cache.ts) and ride the export. It is an out-of-process, baked authoring
//                  source — never a runtime/export/replay dependency.
//   - replay/play: end users NEVER call the API. They replay cached bytes. The durable log records only
//                  the REQUEST (+ content hash); the cache makes a STOCHASTIC, paid model replay-safe.
//
// TRANSPORT IS INJECTABLE (the same shape as model-source.ts's TileTransport): the default client is
// built on the host `op_http_post` op (the ONLY HTTP primitive the embedded deno_core runtime exposes —
// there is no `fetch`, no `Deno.env`, no GET/binary op here). Tests inject a mock HttpClient that returns
// canned JSON so the POST→poll→download state machine is verifiable headlessly, with no key and no
// network. See js/test/p17d_generative_source.ts.
//
// EMBEDDED-RUNTIME LIMITATION (be honest): `op_http_post` does POST + `content-type: application/json`
// only — it cannot set an `Authorization` header, cannot do GET, and returns text (not binary). So the
// DEFAULT op-backed client cannot, by itself, send a Bearer token, poll a GET status endpoint, or
// stream a binary GLB. For a REAL run, supply a header/GET/binary-capable HttpClient via config.http
// (e.g. a fetch- or reqwest-backed client on the author's host), or have the host extend op_http_post.
// The download step ALSO supports an INLINE base64 GLB in the result JSON, which works end-to-end
// through op_http_post when the API/proxy returns the bytes inline.

import { ops } from "../engine.ts";
import type { AssetRequest, AssetResult, AssetSource } from "./types.ts";

// ---- base64 (atob/btoa-backed; same approach as terrain/model-source.ts) ----

/** Decode standard base64 to bytes (host `atob`, present in the runtime). Tolerates a data: URI
 *  prefix and surrounding whitespace so an inline `data:model/gltf-binary;base64,…` payload decodes. */
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
  /** Text request (the start POST and the poll GET/POST). */
  request(req: HttpRequest): Promise<HttpResponse>;
  /** Binary GLB download from a URL (used when the result JSON carries a model URL rather than inline
   *  base64). The default op-backed client cannot do this (op_http_post returns text); inject a client
   *  for the URL-download path, or rely on the inline-base64 path. */
  fetchBinary(url: string, headers?: Record<string, string>): Promise<Uint8Array>;
}

/** Default client over the host `op_http_post`. POST + JSON only; headers/method/status/binary are NOT
 *  honored (the embedded runtime exposes no richer HTTP op). It exists so the source has a working
 *  default for the inline-base64 flow and so tests have something to override; a real run injects a
 *  fuller client via config.http. */
export const opHttpClient: HttpClient = {
  async request(req: HttpRequest): Promise<HttpResponse> {
    // op_http_post is POST-only and drops headers; we still pass the URL/body through so an
    // inline-base64-returning endpoint works. A GET status endpoint or a Bearer-gated endpoint will
    // not work here — inject a real client (see the file header).
    const body = await ops.op_http_post(req.url, req.body ?? "{}");
    return { status: 200, body };
  },
  fetchBinary(url: string): Promise<Uint8Array> {
    return Promise.reject(
      new Error(
        `GenerativeAssetSource: the default op_http_post client cannot download a binary GLB from a URL ` +
          `(${url}); have the API return an inline base64 GLB, or inject a binary-capable HttpClient via config.http.`,
      ),
    );
  },
};

// ---- config -----------------------------------------------------------------

export interface GenerativeAssetSourceConfig {
  /** API base URL (no trailing slash). Default 3D AI Studio v1. */
  endpoint?: string;
  /** Bearer token. If omitted, read from the THREEDAI_API_KEY env var at call time (NEVER hardcoded).
   *  Resolution is deferred to generateAsset so the source can be constructed (and unit-tested) with no
   *  key present. */
  apiKey?: string;
  /** 3D AI Studio model id, e.g. "prism-turbo" | "prism-swift" | "prism-forge" | "prism-3.1". */
  model?: string;
  /** Delay between poll attempts (ms). */
  pollIntervalMs?: number;
  /** Max poll attempts before a timeout error. pollIntervalMs * maxPollAttempts bounds total wait. */
  maxPollAttempts?: number;
  /** Path appended to endpoint for the start POST. */
  startPath?: string;
  /** Builds the status path for a task id (appended to endpoint). Default `/tasks/{id}`. */
  statusPath?: (taskId: string) => string;
  /** Injectable HTTP client (defaults to {@link opHttpClient}). Tests mock it; a real host injects a
   *  header/GET/binary-capable client. */
  http?: HttpClient;
  /** Provenance name override (defaults to "generative:3daistudio"). */
  name?: string;
}

const DEFAULTS = {
  endpoint: "https://api.3daistudio.com/v1",
  model: "prism-turbo",
  pollIntervalMs: 3000,
  maxPollAttempts: 60, // 60 * 3s = 180s cap (Prism Turbo finishes well inside this)
  startPath: "/generate",
  statusPath: (id: string) => `/tasks/${id}`,
  name: "generative:3daistudio",
};

/** Status strings 3D AI Studio (and similar task APIs) report. Matched case-insensitively; we accept a
 *  generous synonym set since the exact enum is not pinned in the public docs. */
const SUCCESS_STATES = new Set(["completed", "succeeded", "success", "done", "finished", "complete"]);
const FAILURE_STATES = new Set(["failed", "error", "errored", "canceled", "cancelled", "rejected"]);

// ---- env key read (guarded; the embedded runtime has no Deno.env) -----------

/** Best-effort THREEDAI_API_KEY read. The embedded deno_core runtime exposes no `Deno.env`, so this is
 *  fully guarded (a real host — node/deno/a host-injected global — may provide one). Returns undefined
 *  rather than throwing; the caller raises a clear error only when a key is actually required. */
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

function pickBool(obj: Record<string, unknown> | undefined, keys: string[]): boolean | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "boolean") return v;
  }
  return undefined;
}

// ---- the source -------------------------------------------------------------

export class GenerativeAssetSource implements AssetSource {
  readonly name: string;
  readonly endpoint: string;
  readonly model: string;
  readonly pollIntervalMs: number;
  readonly maxPollAttempts: number;

  private readonly apiKeyOverride?: string;
  private readonly startPath: string;
  private readonly statusPath: (id: string) => string;
  private readonly http: HttpClient;

  constructor(cfg: GenerativeAssetSourceConfig = {}) {
    this.name = cfg.name ?? DEFAULTS.name;
    this.endpoint = (cfg.endpoint ?? DEFAULTS.endpoint).replace(/\/$/, "");
    this.model = cfg.model ?? DEFAULTS.model;
    this.pollIntervalMs = cfg.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
    this.maxPollAttempts = cfg.maxPollAttempts ?? DEFAULTS.maxPollAttempts;
    this.apiKeyOverride = cfg.apiKey;
    this.startPath = cfg.startPath ?? DEFAULTS.startPath;
    this.statusPath = cfg.statusPath ?? DEFAULTS.statusPath;
    this.http = cfg.http ?? opHttpClient;
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

  /** POST a generation job from the request; poll until done; download the GLB; return the asset. Pure
   *  per request only via the cache (the model is stochastic) — this method calls the API on every
   *  invocation (the AssetCache guarantees it runs only on a MISS). */
  async generateAsset(req: AssetRequest): Promise<AssetResult> {
    const key = this.resolveApiKey();
    const headers = this.authHeaders(key);

    const taskId = await this.startJob(req, headers);
    const result = await this.pollUntilDone(taskId, headers);
    const bytes = await this.downloadGlb(result, headers);

    return {
      format: "glb",
      bytes,
      meta: {
        source: this.name,
        sourceUrl: result.modelUrl,
        polycount: result.polycount,
        rigged: result.rigged,
      },
    };
  }

  /** Step 1 — start the async job. Picks image-to-3D when a referenceImage is given, else text-to-3D.
   *  Returns the task id the poll step tracks. */
  private async startJob(req: AssetRequest, headers: Record<string, string>): Promise<string> {
    // The durable-log inputs (prompt/referenceImage/seed/params) marshal straight into the job body.
    const body: Record<string, unknown> = {
      model: (req.params?.model as string | undefined) ?? this.model,
      seed: req.seed,
      kind: req.kind,
      format: "glb",
      ...(req.params ?? {}),
    };
    if (req.referenceImage) body.image = req.referenceImage; // image-to-3D
    if (req.prompt) body.prompt = req.prompt; // text-to-3D (or image+prompt)
    if (!req.prompt && !req.referenceImage) {
      throw new Error("GenerativeAssetSource: a request needs a prompt and/or a referenceImage to generate.");
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
    const id = pickString(json, ["id", "task_id", "taskId", "jobId", "job_id", "uuid"]) ??
      pickString(asRecord(json.task), ["id", "task_id"]) ??
      pickString(asRecord(json.data), ["id", "task_id", "taskId"]);
    if (!id) {
      throw new Error(`GenerativeAssetSource: start response had no task id: ${resp.body.slice(0, 200)}`);
    }
    return id;
  }

  /** Step 2 — poll the task status with a bounded retry loop (op_sleep_ms between attempts, the host's
   *  only timer — same primitive model-source.ts uses). Resolves on a success state, throws on a failure
   *  state or after maxPollAttempts (timeout). */
  private async pollUntilDone(
    taskId: string,
    headers: Record<string, string>,
  ): Promise<{ modelUrl?: string; glbBase64?: string; polycount?: number; rigged?: boolean }> {
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
      const status = (pickString(json, ["status", "state", "stage"]) ?? "").toLowerCase();

      if (FAILURE_STATES.has(status)) {
        const reason = pickString(json, ["error", "message", "detail", "reason"]) ?? status;
        throw new Error(`GenerativeAssetSource: task ${taskId} failed (${status}): ${reason}`);
      }
      if (SUCCESS_STATES.has(status) || this.extractOutput(json).modelUrl || this.extractOutput(json).glbBase64) {
        const out = this.extractOutput(json);
        if (!out.modelUrl && !out.glbBase64) {
          throw new Error(
            `GenerativeAssetSource: task ${taskId} reported done but carried no GLB url or inline bytes: ` +
              `${resp.body.slice(0, 200)}`,
          );
        }
        return out;
      }
      // else: pending/processing/queued/running → keep polling.
    }
    throw new Error(
      `GenerativeAssetSource: task ${taskId} timed out after ${this.maxPollAttempts} polls ` +
        `(~${(this.maxPollAttempts * this.pollIntervalMs) / 1000}s).`,
    );
  }

  /** Pull the GLB locator + metadata out of a (possibly nested) status payload. Tolerant of several
   *  common shapes since the exact schema is not pinned in the public docs: a top-level url, an
   *  `output`/`result`/`model` object, or an `outputs`/`assets` array; inline base64 under several keys. */
  private extractOutput(
    json: Record<string, unknown>,
  ): { modelUrl?: string; glbBase64?: string; polycount?: number; rigged?: boolean } {
    const output = asRecord(json.output) ?? asRecord(json.result) ?? asRecord(json.model) ?? asRecord(json.data);
    const arr = (json.outputs ?? json.assets ?? json.models) as unknown;
    const first = Array.isArray(arr) ? asRecord(arr[0]) : undefined;

    const urlKeys = ["model_url", "glb_url", "modelUrl", "glbUrl", "url", "download_url", "downloadUrl", "file_url"];
    const b64Keys = ["model_base64", "glb_base64", "glb_b64", "modelBase64", "data_base64", "base64", "data"];
    const polyKeys = ["polycount", "poly_count", "triangles", "tris", "faceCount", "face_count"];
    const rigKeys = ["rigged", "is_rigged", "has_rig", "rig"];

    const modelUrl = pickString(json, urlKeys) ?? pickString(output, urlKeys) ?? pickString(first, urlKeys);
    const glbBase64 = pickString(json, b64Keys) ?? pickString(output, b64Keys) ?? pickString(first, b64Keys);
    const polycount = pickNumber(json, polyKeys) ?? pickNumber(output, polyKeys) ?? pickNumber(first, polyKeys);
    const rigged = pickBool(json, rigKeys) ?? pickBool(output, rigKeys) ?? pickBool(first, rigKeys);
    return { modelUrl, glbBase64, polycount, rigged };
  }

  /** Step 3 — materialize the GLB bytes: prefer the inline base64 (works through op_http_post), else
   *  download from the model URL via the injected client's binary path. */
  private async downloadGlb(
    out: { modelUrl?: string; glbBase64?: string },
    headers: Record<string, string>,
  ): Promise<Uint8Array> {
    if (out.glbBase64) {
      try {
        return decodeBase64(out.glbBase64);
      } catch (e) {
        throw new Error(`GenerativeAssetSource: failed to decode inline base64 GLB: ${(e as Error).message}`);
      }
    }
    if (out.modelUrl) {
      try {
        return await this.http.fetchBinary(out.modelUrl, headers);
      } catch (e) {
        throw new Error(`GenerativeAssetSource: GLB download failed (${out.modelUrl}): ${(e as Error).message}`);
      }
    }
    throw new Error("GenerativeAssetSource: no GLB url or inline base64 to download.");
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
