// LibraryAssetSource (Sketchfab CC catalog) unit gate — asset-pipeline "retrieval" backend.
//
// Proves the search → license-filter → DETERMINISTIC pick → download → bytes flow BY MEASUREMENT,
// headlessly and WITHOUT a token or network, by injecting a MOCK LibraryHttpTransport that returns
// canned Sketchfab JSON + bytes. The same seam the real `fetchTransport` fills author-side. We assert:
//   • the authenticated GET carries `Authorization: Token …` (API-token auth);
//   • CC0 is preferred and maps to license "CC0-1.0" with NO attribution;
//   • CC-BY is allowed when CC0 has no hits, maps to "CC-BY-4.0", and builds the credit string;
//   • the pick is deterministic: stable-sorted by uid, indexed by seed;
//   • GLB is preferred over the glTF zip;
//   • a missing token and an empty catalog both raise clear errors.
//
// Run: ./target/release/limina js/test/p17c_library_source.ts   (exit 0 = pass)

import { ops } from "../src/engine.ts";
import { LibraryAssetSource, type LibraryHttpTransport } from "../src/asset/library-source.ts";
import type { AssetRequest } from "../src/asset/types.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p17c_library_source FAIL: " + msg);
}

const enc = (s: string): Uint8Array => {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
};
const GLB_BYTES = enc("glTF-binary-bytes");
const GLTF_ZIP_BYTES = enc("PKgltf-zip");

const req = (over: Partial<AssetRequest> = {}): AssetRequest => ({ kind: "prop", seed: 0, prompt: "wooden barrel", ...over });

// A canned Sketchfab model record (search-result shape).
function model(uid: string, slug: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid,
    name: `Barrel ${uid}`,
    viewerUrl: `https://sketchfab.com/3d-models/${uid}`,
    isDownloadable: true,
    license: { slug, label: slug },
    user: { username: `u_${uid}`, displayName: `User ${uid}`, profileUrl: `https://sketchfab.com/u_${uid}` },
    faceCount: 1234,
    animationCount: 0,
    ...over,
  };
}

/** Build a mock transport. `searchByLicense` maps a license slug → the models that query returns.
 *  `download` maps a model uid → its download envelope. Records every Authorization header seen. */
function mockTransport(opts: {
  searchByLicense: Record<string, Record<string, unknown>[]>;
  download: (uid: string) => Record<string, unknown>;
  seenAuth: string[];
}): LibraryHttpTransport {
  return {
    async getText(url, headers) {
      opts.seenAuth.push(headers.Authorization ?? "");
      if (url.includes("/search")) {
        const m = url.match(/license=([a-z0-9-]+)/);
        const slug = m ? m[1] : "";
        return { status: 200, text: JSON.stringify({ results: opts.searchByLicense[slug] ?? [] }) };
      }
      if (url.includes("/download")) {
        const m = url.match(/\/models\/([^/]+)\/download/);
        const uid = m ? m[1] : "";
        return { status: 200, text: JSON.stringify(opts.download(uid)) };
      }
      return { status: 404, text: "{}" };
    },
    async getBytes(url) {
      return url.includes("gltf") ? GLTF_ZIP_BYTES : GLB_BYTES;
    },
  };
}

const glbArchive = (_uid: string) => ({ glb: { url: "https://cdn.sketchfab.test/x.glb", size: 10, expires: 300 } });

// ── 1. CC0 happy path: preferred license, GLB, auth header, provenance. ───────────────────────────
{
  const seenAuth: string[] = [];
  const src = new LibraryAssetSource({
    token: "TESTTOKEN",
    transport: mockTransport({ searchByLicense: { cc0: [model("a", "cc0")] }, download: glbArchive, seenAuth }),
  });
  const r = await src.generateAsset(req());
  assert(r.format === "glb", `format glb (got ${r.format})`);
  assert(r.bytes.length === GLB_BYTES.length && r.bytes[0] === GLB_BYTES[0], "GLB bytes round-trip");
  assert(r.meta.source === "library:sketchfab", `source (got ${r.meta.source})`);
  assert(r.meta.license === "CC0-1.0", `CC0 → SPDX CC0-1.0 (got ${r.meta.license})`);
  assert(r.meta.attribution === undefined, "CC0 requires NO attribution");
  assert(r.meta.sourceUrl === "https://sketchfab.com/3d-models/a", `sourceUrl (got ${r.meta.sourceUrl})`);
  assert(r.meta.polycount === 1234, `polycount from faceCount (got ${r.meta.polycount})`);
  assert(seenAuth.length >= 1 && seenAuth.every((h) => h === "Token TESTTOKEN"), "every GET carries `Token <token>` auth");
}

// ── 2. CC-BY allowed when CC0 is empty: maps to CC-BY-4.0 + builds the credit string. ─────────────
{
  const seenAuth: string[] = [];
  const src = new LibraryAssetSource({
    token: "T",
    transport: mockTransport({ searchByLicense: { cc0: [], by: [model("z", "by")] }, download: glbArchive, seenAuth }),
  });
  const r = await src.generateAsset(req());
  assert(r.meta.license === "CC-BY-4.0", `CC-BY → SPDX CC-BY-4.0 (got ${r.meta.license})`);
  assert(
    r.meta.attribution === "Barrel z by User z (https://sketchfab.com/3d-models/z) — CC-BY 4.0",
    `attribution credit string (got ${r.meta.attribution})`,
  );
}

// ── 3. Deterministic pick: stable-sort by uid, index by seed. ─────────────────────────────────────
{
  // Returned out of order ("c","a","b") → stable order a,b,c. seed 0 → "a", seed 1 → "b", seed 4 → "b".
  const pool = [model("c", "cc0"), model("a", "cc0"), model("b", "cc0")];
  const make = () =>
    new LibraryAssetSource({ token: "T", transport: mockTransport({ searchByLicense: { cc0: pool }, download: glbArchive, seenAuth: [] }) });
  const s0 = await make().generateAsset(req({ seed: 0 }));
  const s1 = await make().generateAsset(req({ seed: 1 }));
  const s4 = await make().generateAsset(req({ seed: 4 }));
  const s0b = await make().generateAsset(req({ seed: 0 }));
  assert(s0.meta.sourceUrl?.endsWith("/a") === true, `seed 0 → uid a (got ${s0.meta.sourceUrl})`);
  assert(s1.meta.sourceUrl?.endsWith("/b") === true, `seed 1 → uid b (got ${s1.meta.sourceUrl})`);
  assert(s4.meta.sourceUrl?.endsWith("/b") === true, `seed 4 (4%3=1) → uid b (got ${s4.meta.sourceUrl})`);
  assert(s0.meta.sourceUrl === s0b.meta.sourceUrl, "same seed → same pick (deterministic)");
}

// ── 4. GLB preferred over the glTF zip; falls back to gltf when no glb. ────────────────────────────
{
  const gltfOnly = (_uid: string) => ({ gltf: { url: "https://cdn.sketchfab.test/x-gltf.zip", size: 99, expires: 300 } });
  const src = new LibraryAssetSource({
    token: "T",
    transport: mockTransport({ searchByLicense: { cc0: [model("g", "cc0")] }, download: gltfOnly, seenAuth: [] }),
  });
  const r = await src.generateAsset(req());
  assert(r.format === "gltf", `falls back to gltf (got ${r.format})`);
  assert(r.bytes[0] === GLTF_ZIP_BYTES[0], "gltf-zip bytes round-trip");
}

// ── 5. Empty catalog across all licenses → clear error. ───────────────────────────────────────────
{
  const src = new LibraryAssetSource({
    token: "T",
    transport: mockTransport({ searchByLicense: {}, download: glbArchive, seenAuth: [] }),
  });
  let threw = "";
  try {
    await src.generateAsset(req({ prompt: "nonexistent-xyzzy" }));
  } catch (e) {
    threw = (e as Error).message;
  }
  assert(threw.includes("no downloadable"), `empty catalog raises a clear error (got "${threw}")`);
}

// ── 6. Missing token → clear auth-missing error, raised BEFORE any transport call. ────────────────
{
  let touched = false;
  const watch: LibraryHttpTransport = {
    async getText() { touched = true; return { status: 200, text: "{}" }; },
    async getBytes() { touched = true; return new Uint8Array(); },
  };
  // tokenEnvVar pointed at a name the runtime won't have set, so no env token leaks in.
  const src = new LibraryAssetSource({ tokenEnvVar: "SKETCHFAB_API_TOKEN__ABSENT_FOR_TEST", transport: watch });
  let threw = "";
  try {
    await src.generateAsset(req());
  } catch (e) {
    threw = (e as Error).message;
  }
  assert(threw.includes("is not set"), `missing token raises a clear error (got "${threw}")`);
  assert(touched === false, "auth check short-circuits before any HTTP call");
}

ops.op_log(
  "p17c_library_source OK: Sketchfab search→license-filter→seed-deterministic pick→download→bytes; " +
    "CC0 preferred (no attribution), CC-BY allowed (credit string built); `Token` auth header sent; " +
    "GLB preferred over glTF zip; empty-catalog + missing-token errors are clear.",
);
