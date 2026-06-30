// GenerativeAssetSource gate (asset-pipeline · the 3D AI Studio authoring backend).
//
// Proves the ASYNC generation state machine BY MEASUREMENT against a MOCK HttpClient + a trivial injected
// archive→glb converter (canned POST→poll→download flow) — GREEN with NO key and NO network, so CI never
// hits the paid API. It models the REAL 3D AI Studio v1 contract:
//   1. start: POST /3d-models/tencent/generate/rapid/ with {prompt, enable_pbr:true}; Bearer auth set;
//             the response carries {task_id}.
//   2. poll : GET /generation-request/{id}/status/ tolerates IN_PROGRESS, sleeping op_sleep_ms between
//             attempts. CRITICAL NUANCE: status flips to FINISHED with results[0].asset STILL null — the
//             source must keep polling until results[0].asset is a non-null URL.
//   3. dl   : the asset URL is a presigned R2 archive (.zip) — downloaded via fetchBinary WITHOUT the
//             Bearer header; the injected convertArchive turns the archive bytes into glb bytes.
//   4. image-to-3D: a referenceImage routes into the job body as `image`.
//   5. errors: a FAILED status (with failure_reason), a poll timeout, a missing converter, and a missing
//              key each throw a CLEAR error.
//   6. KEY-ABSENT contract: with no THREEDAI_API_KEY and no config.apiKey, generateAsset throws the
//      "missing API key" error (the documented SKIP-equivalent — the unit suite still runs fully on the
//      injected mocks, so the file is always GREEN; a REAL run is the separate smoke command).
//
// Run: timeout 90 ./target/release/limina js/test/p17d_generative_source.ts   (exit 0 = pass)

import { ops } from "../src/engine.ts";
import {
  GenerativeAssetSource,
  type ArchiveConverter,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from "../src/asset/generative-source.ts";
import type { AssetRequest } from "../src/asset/types.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p17d_generative_source FAIL: " + msg);
}
async function expectThrow(fn: () => Promise<unknown>, needle: string, label: string): Promise<void> {
  let threw: Error | undefined;
  try {
    await fn();
  } catch (e) {
    threw = e as Error;
  }
  assert(!!threw, `${label}: expected a throw, got none`);
  assert(
    threw!.message.includes(needle),
    `${label}: error should mention "${needle}", got: ${threw!.message}`,
  );
}

// A tiny canned ARCHIVE payload (opaque .zip bytes) and the glb the converter "produces" from them.
const ARCHIVE_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 7, 7, 7, 7]); // "PK\x03\x04"… (zip magic)
const GLB_BYTES = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 2, 3, 4, 250, 0, 99]); // "glTF"….

// A trivial injected converter: asserts it received the downloaded archive bytes, returns the canned glb.
let lastConvertedInput: Uint8Array | undefined;
const mockConvert: ArchiveConverter = async (zipBytes) => {
  lastConvertedInput = zipBytes;
  return { format: "glb", bytes: GLB_BYTES };
};

/** A scripted HttpClient modeling the REAL status shape, incl. the FINISHED-but-null-asset nuance. */
interface MockOpts {
  /** Number of IN_PROGRESS polls before the status flips to FINISHED (exercises the wait loop). */
  inProgressPolls: number;
  /** Number of FINISHED-but-null-asset polls AFTER the flip, before results[0].asset populates (the
   *  documented late-populate nuance). */
  finishedNullPolls: number;
  /** Force a terminal FAILED status on the first poll. */
  failStatus?: boolean;
  /** Never populate results[0].asset (drives the timeout path). */
  neverDone?: boolean;
}
class MockHttp implements HttpClient {
  posts: HttpRequest[] = [];
  gets: HttpRequest[] = [];
  binaryFetches: { url: string; headers?: Record<string, string> }[] = [];
  private polls = 0;
  constructor(private readonly o: MockOpts) {}

  // eslint-disable-next-line require-await
  async request(req: HttpRequest): Promise<HttpResponse> {
    if (req.method === "POST") {
      this.posts.push(req);
      return { status: 200, body: JSON.stringify({ task_id: "abc-123-task", created_at: "2026-06-29T00:00:00Z" }) };
    }
    // GET — the status poll.
    this.gets.push(req);
    if (this.o.failStatus) {
      return {
        status: 200,
        body: JSON.stringify({ status: "FAILED", progress: 0, results: [], failure_reason: "unsafe prompt" }),
      };
    }
    if (this.o.neverDone) {
      // Always FINISHED but with a null asset → the source must NOT accept this and must time out.
      return {
        status: 200,
        body: JSON.stringify({
          status: "FINISHED",
          progress: 100,
          results: [{ asset: null, asset_type: "ARCHIVE", metadata: null }],
          failure_reason: null,
        }),
      };
    }
    const i = this.polls++;
    if (i < this.o.inProgressPolls) {
      return {
        status: 200,
        body: JSON.stringify({ status: "IN_PROGRESS", progress: 10 * (i + 1), results: [], failure_reason: null }),
      };
    }
    if (i < this.o.inProgressPolls + this.o.finishedNullPolls) {
      // FINISHED but the asset URL has NOT populated yet — the critical nuance.
      return {
        status: 200,
        body: JSON.stringify({
          status: "FINISHED",
          progress: 100,
          results: [{ asset: null, asset_type: "ARCHIVE", metadata: null }],
          failure_reason: null,
        }),
      };
    }
    // FINISHED with the presigned R2 archive URL finally populated.
    return {
      status: 200,
      body: JSON.stringify({
        status: "FINISHED",
        progress: 100,
        results: [{ asset: "https://r2.cloudflarestorage.com/3dai/abc-123-task.zip?sig=xyz", asset_type: "ARCHIVE", metadata: null }],
        failure_reason: null,
      }),
    };
  }

  // eslint-disable-next-line require-await
  async fetchBinary(url: string, headers?: Record<string, string>): Promise<Uint8Array> {
    this.binaryFetches.push({ url, headers });
    return ARCHIVE_BYTES;
  }
}

const baseReq = (over: Partial<AssetRequest> = {}): AssetRequest => ({
  kind: "prop",
  seed: 42,
  prompt: "a medieval treasure chest",
  ...over,
});

// Fast polling so the timeout case stays well under the 90s harness budget.
const cfg = (http: HttpClient, over: Record<string, unknown> = {}) => ({
  http,
  convertArchive: mockConvert,
  apiKey: "test-key-DO-NOT-SHIP",
  endpoint: "https://api.example.test/v1",
  pollIntervalMs: 5,
  maxPollAttempts: 12,
  ...over,
});

// ── 1. Happy path · text-to-3D · IN_PROGRESS → FINISHED(null asset) → FINISHED(asset) → convert. ──────
{
  lastConvertedInput = undefined;
  const http = new MockHttp({ inProgressPolls: 2, finishedNullPolls: 2 });
  const src = new GenerativeAssetSource(cfg(http));
  assert(src.name === "generative:3daistudio", "provenance name is generative:3daistudio");

  const res = await src.generateAsset(baseReq());
  assert(res.format === "glb", "result format is glb");
  assert(res.bytes.length === GLB_BYTES.length, "converted glb byte length matches the canned glb");
  for (let i = 0; i < GLB_BYTES.length; i++) {
    assert(res.bytes[i] === GLB_BYTES[i], `converted glb byte[${i}] matches`);
  }
  assert(res.meta.source === "generative:3daistudio", "meta.source set");
  assert(
    res.meta.sourceUrl === "https://r2.cloudflarestorage.com/3dai/abc-123-task.zip?sig=xyz",
    "meta.sourceUrl is the presigned R2 archive URL",
  );

  // start: exactly one POST, real endpoint + body + Bearer auth.
  assert(http.posts.length === 1, `start POSTs exactly once (got ${http.posts.length})`);
  assert(
    http.posts[0].url === "https://api.example.test/v1/3d-models/tencent/generate/rapid/",
    `start hits the rapid/tencent endpoint (got ${http.posts[0].url})`,
  );
  assert(http.posts[0].headers?.Authorization === "Bearer test-key-DO-NOT-SHIP", "start sends Bearer auth");
  const sent = JSON.parse(http.posts[0].body!);
  assert(sent.prompt === "a medieval treasure chest", "prompt marshaled into the job body");
  assert(sent.enable_pbr === true, "enable_pbr:true marshaled into the job body");

  // poll: 2 IN_PROGRESS + 2 FINISHED-null + 1 FINISHED-with-asset = 5 polls (the late-populate nuance).
  assert(http.gets.length === 5, `polled until results[0].asset populated (got ${http.gets.length} polls)`);
  assert(
    http.gets[0].url === "https://api.example.test/v1/generation-request/abc-123-task/status/",
    `poll hits /generation-request/{id}/status/ (got ${http.gets[0].url})`,
  );

  // download: fetchBinary once, on the R2 url, with NO auth header (presigned).
  assert(http.binaryFetches.length === 1, `archive downloaded once (got ${http.binaryFetches.length})`);
  assert(
    http.binaryFetches[0].url === "https://r2.cloudflarestorage.com/3dai/abc-123-task.zip?sig=xyz",
    "archive download hits the presigned R2 url",
  );
  assert(http.binaryFetches[0].headers === undefined, "R2 archive download sends NO auth header (presigned)");

  // convert: the converter received exactly the downloaded archive bytes.
  assert(!!lastConvertedInput, "convertArchive was invoked");
  assert(lastConvertedInput!.length === ARCHIVE_BYTES.length, "convertArchive received the downloaded archive bytes");
  for (let i = 0; i < ARCHIVE_BYTES.length; i++) {
    assert(lastConvertedInput![i] === ARCHIVE_BYTES[i], `archive byte[${i}] handed to the converter exactly`);
  }
}

// ── 2. FINISHED-with-asset on the FIRST poll (no IN_PROGRESS, no null window). ────────────────────────
{
  const http = new MockHttp({ inProgressPolls: 0, finishedNullPolls: 0 });
  const src = new GenerativeAssetSource(cfg(http));
  const res = await src.generateAsset(baseReq());
  assert(http.gets.length === 1, `single poll when the asset is immediately ready (got ${http.gets.length})`);
  assert(res.bytes.length === GLB_BYTES.length, "glb bytes returned");
}

// ── 3. image-to-3D: a referenceImage routes into the job body as `image`. ────────────────────────────
{
  const http = new MockHttp({ inProgressPolls: 0, finishedNullPolls: 0 });
  const src = new GenerativeAssetSource(cfg(http));
  await src.generateAsset(baseReq({ prompt: undefined, referenceImage: "ref/art-direction.png" }));
  const sent = JSON.parse(http.posts[0].body!);
  assert(sent.image === "ref/art-direction.png", "referenceImage marshaled as `image` (image-to-3D)");
  assert(sent.enable_pbr === true, "enable_pbr still set for image-to-3D");
}

// ── 4. FAILED status → clear error surfacing failure_reason. ─────────────────────────────────────────
{
  const http = new MockHttp({ inProgressPolls: 0, finishedNullPolls: 0, failStatus: true });
  const src = new GenerativeAssetSource(cfg(http));
  await expectThrow(() => src.generateAsset(baseReq()), "unsafe prompt", "failure-status");
}

// ── 5. FINISHED-but-forever-null asset → bounded poll timeout. ───────────────────────────────────────
{
  const http = new MockHttp({ inProgressPolls: 0, finishedNullPolls: 0, neverDone: true });
  const src = new GenerativeAssetSource(cfg(http, { maxPollAttempts: 3 }));
  await expectThrow(() => src.generateAsset(baseReq()), "timed out", "poll-timeout");
}

// ── 6. Empty request (no prompt + no referenceImage) → clear error. ──────────────────────────────────
{
  const http = new MockHttp({ inProgressPolls: 0, finishedNullPolls: 0 });
  const src = new GenerativeAssetSource(cfg(http));
  await expectThrow(
    () => src.generateAsset(baseReq({ prompt: undefined, referenceImage: undefined })),
    "prompt and/or a referenceImage",
    "empty-request",
  );
}

// ── 7. Missing converter → clear error (the engine sandbox can't supply one; a host must inject it). ──
{
  const http = new MockHttp({ inProgressPolls: 0, finishedNullPolls: 0 });
  const src = new GenerativeAssetSource(cfg(http, { convertArchive: undefined }));
  await expectThrow(() => src.generateAsset(baseReq()), "no archive converter", "missing-converter");
}

// ── 8. KEY-ABSENT contract: no env key + no config.apiKey → "missing API key" (the SKIP-equivalent). ──
{
  const http = new MockHttp({ inProgressPolls: 0, finishedNullPolls: 0 });
  const src = new GenerativeAssetSource({ http, convertArchive: mockConvert, endpoint: "https://api.example.test/v1" });
  const envKeyPresent = typeof (globalThis as { THREEDAI_API_KEY?: string }).THREEDAI_API_KEY === "string";
  if (envKeyPresent) {
    ops.op_log("p17d_generative_source: THREEDAI_API_KEY present in env — skipping the key-absent assertion.");
  } else {
    await expectThrow(() => src.generateAsset(baseReq()), "missing API key", "missing-key");
  }
}

ops.op_log(
  "p17d_generative_source OK: async POST→poll→download→convert state machine verified on mock HTTP + a " +
    "trivial injected converter — start POSTs the rapid/tencent endpoint with {prompt, enable_pbr:true} + " +
    "Bearer auth; poll tolerates IN_PROGRESS and the FINISHED-but-null-asset late-populate nuance, returning " +
    "only once results[0].asset is a non-null R2 url; the archive downloads via fetchBinary with NO auth " +
    "header and the converter receives the exact archive bytes; image-to-3D routes the referenceImage; " +
    "FAILED-status, poll-timeout, empty-request, missing-converter, and missing-key all throw clearly.",
);
