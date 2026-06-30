// PolyPizzaAssetSource (Poly Pizza CC catalog) unit gate — asset-pipeline "retrieval" backend (FOSS,
// key-header auth, no OAuth2).
//
// Proves the search → DETERMINISTIC pick → download → bytes flow BY MEASUREMENT, headlessly and WITHOUT
// a key or network, by injecting a MOCK PolyHttpTransport that returns canned Poly Pizza JSON + bytes.
// The same seam the real `polyFetchTransport` fills author-side. We assert:
//   • the authenticated search GET carries the `x-auth-token: <key>` header (key auth, NOT OAuth);
//   • CC0 maps to license "CC0-1.0" with NO attribution;
//   • CC-BY maps to "CC-BY-3.0" and surfaces Poly Pizza's ready-made `Attribution` credit string;
//   • the pick is deterministic: stable-sorted by ID, indexed by seed;
//   • the GLB bytes the chosen result's `Download` URL points at are returned with provenance;
//   • a missing key and an empty catalog both raise clear errors (the key check short-circuits the HTTP).
//
// Run: ./target/release/limina js/test/p17e_library_poly.ts   (exit 0 = pass)

import { ops } from "../src/engine.ts";
import { PolyPizzaAssetSource, type PolyHttpTransport } from "../src/asset/library-poly.ts";
import type { AssetRequest } from "../src/asset/types.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p17e_library_poly FAIL: " + msg);
}

const enc = (s: string): Uint8Array => {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
};
const GLB_BYTES = enc("glTF-binary-bytes");

const req = (over: Partial<AssetRequest> = {}): AssetRequest => ({ kind: "prop", seed: 0, prompt: "barrel", ...over });

// A canned Poly Pizza search-result record.
function model(id: string, licence: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ID: id,
    Title: `Barrel ${id}`,
    Thumbnail: `https://poly.pizza/thumb/${id}.webp`,
    Download: `https://cdn.poly.pizza/${id}.glb`,
    Attribution: `Barrel ${id} by Creator ${id} (https://poly.pizza/m/${id})`,
    Creator: { Username: `Creator ${id}`, DPURL: `https://poly.pizza/u/${id}` },
    Licence: licence,
    ...over,
  };
}

/** Build a mock transport. `results` is the canned search hit list. Records every x-auth-token seen. */
function mockTransport(opts: { results: Record<string, unknown>[]; seenKey: string[] }): PolyHttpTransport {
  return {
    async getText(url, headers) {
      opts.seenKey.push(headers["x-auth-token"] ?? "");
      if (url.includes("/search/")) {
        return { status: 200, text: JSON.stringify({ results: opts.results, total: opts.results.length }) };
      }
      return { status: 404, text: "{}" };
    },
    async getBytes(_url) {
      return GLB_BYTES;
    },
  };
}

// ── 1. CC0 happy path: license maps to CC0-1.0, NO attribution, GLB bytes, key header, provenance. ──
{
  const seenKey: string[] = [];
  const src = new PolyPizzaAssetSource({
    apiKey: "TESTKEY",
    transport: mockTransport({ results: [model("aaa", "CC0")], seenKey }),
  });
  const r = await src.generateAsset(req());
  assert(r.format === "glb", `format glb (got ${r.format})`);
  assert(r.bytes.length === GLB_BYTES.length && r.bytes[0] === GLB_BYTES[0], "GLB bytes round-trip");
  assert(r.meta.source === "library:polypizza", `source (got ${r.meta.source})`);
  assert(r.meta.license === "CC0-1.0", `CC0 → SPDX CC0-1.0 (got ${r.meta.license})`);
  assert(r.meta.attribution === undefined, "CC0 requires NO attribution");
  assert(r.meta.sourceUrl === "https://poly.pizza/m/aaa", `sourceUrl (got ${r.meta.sourceUrl})`);
  assert(seenKey.length >= 1 && seenKey.every((h) => h === "TESTKEY"), "search GET carries `x-auth-token: <key>`");
}

// ── 2. CC-BY: maps to CC-BY-3.0 and surfaces Poly Pizza's ready-made `Attribution` credit string. ──
{
  const src = new PolyPizzaAssetSource({
    apiKey: "K",
    transport: mockTransport({ results: [model("zzz", "CC-BY")], seenKey: [] }),
  });
  const r = await src.generateAsset(req());
  assert(r.meta.license === "CC-BY-3.0", `CC-BY → SPDX CC-BY-3.0 (got ${r.meta.license})`);
  assert(
    r.meta.attribution === "Barrel zzz by Creator zzz (https://poly.pizza/m/zzz)",
    `attribution uses Poly Pizza's credit string (got ${r.meta.attribution})`,
  );
}

// ── 2b. CC-BY with NO Attribution field → a credit string is BUILT (never silently dropped). ───────
{
  const src = new PolyPizzaAssetSource({
    apiKey: "K",
    transport: mockTransport({ results: [model("q", "CC-BY", { Attribution: "" })], seenKey: [] }),
  });
  const r = await src.generateAsset(req());
  assert(
    r.meta.attribution === "Barrel q by Creator q (https://poly.pizza/m/q) — CC-BY 3.0",
    `attribution assembled when the field is empty (got ${r.meta.attribution})`,
  );
}

// ── 3. Deterministic pick: stable-sort by ID, index by seed. ───────────────────────────────────────
{
  // Returned out of order ("ccc","aaa","bbb") → stable order aaa,bbb,ccc. seed 0→aaa, 1→bbb, 4→bbb.
  const results = [model("ccc", "CC0"), model("aaa", "CC0"), model("bbb", "CC0")];
  const make = () => new PolyPizzaAssetSource({ apiKey: "K", transport: mockTransport({ results, seenKey: [] }) });
  const s0 = await make().generateAsset(req({ seed: 0 }));
  const s1 = await make().generateAsset(req({ seed: 1 }));
  const s4 = await make().generateAsset(req({ seed: 4 }));
  const s0b = await make().generateAsset(req({ seed: 0 }));
  assert(s0.meta.sourceUrl?.endsWith("/aaa") === true, `seed 0 → id aaa (got ${s0.meta.sourceUrl})`);
  assert(s1.meta.sourceUrl?.endsWith("/bbb") === true, `seed 1 → id bbb (got ${s1.meta.sourceUrl})`);
  assert(s4.meta.sourceUrl?.endsWith("/bbb") === true, `seed 4 (4%3=1) → id bbb (got ${s4.meta.sourceUrl})`);
  assert(s0.meta.sourceUrl === s0b.meta.sourceUrl, "same seed → same pick (deterministic)");
}

// ── 4. Empty catalog → clear error. ────────────────────────────────────────────────────────────────
{
  const src = new PolyPizzaAssetSource({ apiKey: "K", transport: mockTransport({ results: [], seenKey: [] }) });
  let threw = "";
  try {
    await src.generateAsset(req({ prompt: "nonexistent-xyzzy" }));
  } catch (e) {
    threw = (e as Error).message;
  }
  assert(threw.includes("no downloadable"), `empty catalog raises a clear error (got "${threw}")`);
}

// ── 5. Missing key → clear key-missing error, raised BEFORE any transport call. ───────────────────
{
  let touched = false;
  const watch: PolyHttpTransport = {
    async getText() { touched = true; return { status: 200, text: "{}" }; },
    async getBytes() { touched = true; return new Uint8Array(); },
  };
  // apiKeyEnvVar pointed at a name the runtime won't have set, so no env key leaks in.
  const src = new PolyPizzaAssetSource({ apiKeyEnvVar: "POLY_PIZZA_API_KEY__ABSENT_FOR_TEST", transport: watch });
  let threw = "";
  try {
    await src.generateAsset(req());
  } catch (e) {
    threw = (e as Error).message;
  }
  assert(threw.includes("is not set"), `missing key raises a clear error (got "${threw}")`);
  assert(touched === false, "key check short-circuits before any HTTP call");
}

ops.op_log(
  "p17e_library_poly OK: Poly Pizza search→seed-deterministic pick→download→bytes; `x-auth-token` key " +
    "auth (no OAuth); CC0 preferred mapping (no attribution), CC-BY surfaces the ready-made credit " +
    "string (and is built when absent); empty-catalog + missing-key errors are clear.",
);
