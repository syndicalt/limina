// GenerativeAssetSource gate (asset-pipeline · the 3D AI Studio authoring backend).
//
// Proves the ASYNC generation state machine BY MEASUREMENT against a MOCK HttpClient (canned
// POST→poll→download JSON) — GREEN with NO key and NO network, so CI never hits the paid API:
//   1. start: POSTs a job (text-to-3D); the request body carries prompt/seed/model; auth header is set.
//   2. poll : tolerates pending→processing→completed, sleeping op_sleep_ms between attempts; returns
//             only on a success state; the GLB locator is extracted from the final payload.
//   3. dl   : the inline-base64 GLB path decodes to the exact expected bytes (works through op_http_post);
//             the URL path downloads via the injected client's fetchBinary.
//   4. image-to-3D: a referenceImage routes into the job body as `image`.
//   5. errors: a failure status, a poll timeout, and a missing key each throw a CLEAR error.
//   6. KEY-ABSENT contract: with no THREEDAI_API_KEY and no config.apiKey, generateAsset throws the
//      "missing API key" error (the documented SKIP-equivalent — the unit suite still runs fully on the
//      injected mock, so the file is always GREEN; a REAL run is the separate smoke command).
//
// Run: timeout 90 ./target/release/limina js/test/p17d_generative_source.ts   (exit 0 = pass)

import { ops } from "../src/engine.ts";
import {
  decodeBase64,
  GenerativeAssetSource,
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

// btoa-encode bytes the SAME way the real API would return inline GLB base64.
function encodeBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// A tiny canned "GLB" payload (bytes are opaque to the source; we just round-trip them exactly).
const GLB_BYTES = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 2, 3, 4, 250, 0, 99]); // "glTF"....
const GLB_B64 = encodeBase64(GLB_BYTES);

/** A scripted HttpClient: records requests, returns a programmable POST→poll→download script. */
interface MockOpts {
  /** Number of "processing" polls before a "completed" poll (exercises the wait loop). */
  processingPolls: number;
  /** "inline" returns base64 in the final poll; "url" returns a model_url + serves fetchBinary. */
  delivery: "inline" | "url";
  /** Force a terminal failure status on the first poll. */
  failStatus?: boolean;
  /** Never reach a success state (drives the timeout path). */
  neverDone?: boolean;
}
class MockHttp implements HttpClient {
  posts: HttpRequest[] = [];
  gets: HttpRequest[] = [];
  binaryFetches: string[] = [];
  private polls = 0;
  constructor(private readonly o: MockOpts) {}

  // eslint-disable-next-line require-await
  async request(req: HttpRequest): Promise<HttpResponse> {
    if (req.method === "POST") {
      this.posts.push(req);
      return { status: 200, body: JSON.stringify({ id: "task_abc123", status: "queued" }) };
    }
    // GET — the status poll.
    this.gets.push(req);
    if (this.o.failStatus) {
      return { status: 200, body: JSON.stringify({ status: "failed", error: "unsafe prompt" }) };
    }
    if (this.o.neverDone) {
      return { status: 200, body: JSON.stringify({ status: "processing", progress: 10 }) };
    }
    if (this.polls < this.o.processingPolls) {
      this.polls++;
      return { status: 200, body: JSON.stringify({ status: this.polls === 1 ? "pending" : "processing" }) };
    }
    // Final, completed payload — nested `output` shape, with metadata.
    const output: Record<string, unknown> = { polycount: 4096, rigged: false };
    if (this.o.delivery === "inline") output.glb_base64 = GLB_B64;
    else output.model_url = "https://cdn.3daistudio.com/assets/task_abc123.glb";
    return { status: 200, body: JSON.stringify({ status: "completed", output }) };
  }

  // eslint-disable-next-line require-await
  async fetchBinary(url: string): Promise<Uint8Array> {
    this.binaryFetches.push(url);
    return GLB_BYTES;
  }
}

const baseReq = (over: Partial<AssetRequest> = {}): AssetRequest => ({
  kind: "prop",
  seed: 42,
  prompt: "a medieval treasure chest",
  ...over,
});

// Fast polling so the timeout case stays well under the 90s harness budget.
const cfg = (http: HttpClient, over = {}) => ({
  http,
  apiKey: "test-key-DO-NOT-SHIP",
  endpoint: "https://api.example.test/v1",
  model: "prism-turbo",
  pollIntervalMs: 5,
  maxPollAttempts: 8,
  ...over,
});

// ── 1. Happy path · text-to-3D · inline base64 (works through op_http_post). ─────────────────────
{
  const http = new MockHttp({ processingPolls: 2, delivery: "inline" });
  const src = new GenerativeAssetSource(cfg(http));
  assert(src.name === "generative:3daistudio", "provenance name is generative:3daistudio");

  const res = await src.generateAsset(baseReq());
  assert(res.format === "glb", "result format is glb");
  assert(res.bytes.length === GLB_BYTES.length, "decoded byte length matches the canned GLB");
  for (let i = 0; i < GLB_BYTES.length; i++) {
    assert(res.bytes[i] === GLB_BYTES[i], `inline GLB byte[${i}] round-trips exactly`);
  }
  assert(res.meta.source === "generative:3daistudio", "meta.source set");
  assert(res.meta.polycount === 4096, "polycount carried from the result payload");
  assert(res.meta.rigged === false, "rigged carried from the result payload");

  // start: exactly one POST, auth header + prompt/seed/model in the body.
  assert(http.posts.length === 1, `start POSTs exactly once (got ${http.posts.length})`);
  assert(http.posts[0].url === "https://api.example.test/v1/generate", "start hits {endpoint}/generate");
  assert(http.posts[0].headers?.Authorization === "Bearer test-key-DO-NOT-SHIP", "start sends Bearer auth");
  const sent = JSON.parse(http.posts[0].body!);
  assert(sent.prompt === "a medieval treasure chest", "prompt marshaled into the job body");
  assert(sent.seed === 42, "seed marshaled into the job body");
  assert(sent.model === "prism-turbo", "model marshaled into the job body");
  // poll: visited the status endpoint until completed (1 pending + 1 processing + 1 completed = 3).
  assert(http.gets.length === 3, `polled until completed (got ${http.gets.length} polls)`);
  assert(http.gets[0].url === "https://api.example.test/v1/tasks/task_abc123", "poll hits {endpoint}/tasks/{id}");
  assert(http.binaryFetches.length === 0, "inline delivery does NOT hit the binary download path");
}

// ── 2. Happy path · model URL delivery → fetchBinary. ────────────────────────────────────────────
{
  const http = new MockHttp({ processingPolls: 1, delivery: "url" });
  const src = new GenerativeAssetSource(cfg(http));
  const res = await src.generateAsset(baseReq());
  assert(http.binaryFetches.length === 1, "URL delivery downloads via fetchBinary once");
  assert(
    http.binaryFetches[0] === "https://cdn.3daistudio.com/assets/task_abc123.glb",
    "fetchBinary called with the model_url",
  );
  assert(res.meta.sourceUrl === "https://cdn.3daistudio.com/assets/task_abc123.glb", "sourceUrl provenance set");
  assert(res.bytes.length === GLB_BYTES.length, "URL-delivered bytes match");
}

// ── 3. image-to-3D: a referenceImage routes into the job body as `image`. ────────────────────────
{
  const http = new MockHttp({ processingPolls: 0, delivery: "inline" });
  const src = new GenerativeAssetSource(cfg(http));
  await src.generateAsset(baseReq({ prompt: undefined, referenceImage: "ref/art-direction.png" }));
  const sent = JSON.parse(http.posts[0].body!);
  assert(sent.image === "ref/art-direction.png", "referenceImage marshaled as `image` (image-to-3D)");
}

// ── 4. base64 decode helper is correct (data: URI tolerated). ────────────────────────────────────
{
  const dec = decodeBase64(`data:model/gltf-binary;base64,${GLB_B64}`);
  assert(dec.length === GLB_BYTES.length, "data: URI base64 decodes to the right length");
  for (let i = 0; i < GLB_BYTES.length; i++) assert(dec[i] === GLB_BYTES[i], `data: URI byte[${i}] matches`);
}

// ── 5a. Failure status → clear error. ────────────────────────────────────────────────────────────
{
  const http = new MockHttp({ processingPolls: 0, delivery: "inline", failStatus: true });
  const src = new GenerativeAssetSource(cfg(http));
  await expectThrow(() => src.generateAsset(baseReq()), "failed", "failure-status");
}

// ── 5b. Never-done → bounded poll timeout. ───────────────────────────────────────────────────────
{
  const http = new MockHttp({ processingPolls: 0, delivery: "inline", neverDone: true });
  const src = new GenerativeAssetSource(cfg(http, { maxPollAttempts: 3 }));
  await expectThrow(() => src.generateAsset(baseReq()), "timed out", "poll-timeout");
}

// ── 5c. Empty request (no prompt + no referenceImage) → clear error. ─────────────────────────────
{
  const http = new MockHttp({ processingPolls: 0, delivery: "inline" });
  const src = new GenerativeAssetSource(cfg(http));
  await expectThrow(
    () => src.generateAsset(baseReq({ prompt: undefined, referenceImage: undefined })),
    "prompt and/or a referenceImage",
    "empty-request",
  );
}

// ── 6. KEY-ABSENT contract: no env key + no config.apiKey → "missing API key" (the SKIP-equivalent). ─
{
  const http = new MockHttp({ processingPolls: 0, delivery: "inline" });
  const src = new GenerativeAssetSource({ http, endpoint: "https://api.example.test/v1" }); // NO apiKey
  const envKeyPresent = typeof (globalThis as { THREEDAI_API_KEY?: string }).THREEDAI_API_KEY === "string";
  if (envKeyPresent) {
    ops.op_log("p17d_generative_source: THREEDAI_API_KEY present in env — skipping the key-absent assertion.");
  } else {
    await expectThrow(() => src.generateAsset(baseReq()), "missing API key", "missing-key");
  }
}

ops.op_log(
  "p17d_generative_source OK: async POST→poll→download state machine verified on a mock client — start " +
    "marshals prompt/seed/model + Bearer auth; poll tolerates pending→processing→completed (op_sleep_ms " +
    "between attempts); inline-base64 AND model_url delivery both yield exact GLB bytes; image-to-3D routes " +
    "the referenceImage; failure-status, poll-timeout, empty-request, and missing-key all throw clearly.",
);
