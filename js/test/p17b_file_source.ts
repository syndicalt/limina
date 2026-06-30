// FileAssetSource + AssetResolver gate (asset-pipeline step 2 — the offline/test backend + routing).
//
// Proves BY MEASUREMENT: the file source returns the EXACT on-disk bytes for a request, derives the
// format from the extension, stamps meta.source "file", uses the conventional ${kind}/${prompt}.glb
// path when none is given, and throws a clear error for a missing file; the resolver routes by match(),
// honours an explicit params.source override, and falls back when nothing matches.
//
// Fixture: a committed asset under <cwd>/assets (the host's op_read_asset sandbox root) — the runtime
// exposes no write op, so an already-on-disk asset IS the on-disk file under test.
//
// Run: ./target/release/limina js/test/p17b_file_source.ts   (exit 0 = pass)

import { ops } from "../src/engine.ts";
import { FileAssetSource } from "../src/asset/file-source.ts";
import { AssetResolver } from "../src/asset/resolver.ts";
import type { AssetRequest, AssetResult, AssetSource } from "../src/asset/types.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p17b_file_source FAIL: " + msg);
}

const FIXTURE = "cactus.glb"; // a committed asset at the root of <cwd>/assets
const expected = ops.op_read_asset(FIXTURE);
assert(expected instanceof Uint8Array && expected.length > 0, "fixture asset must exist on disk");

// ── 1. FileAssetSource: exact bytes by params.path, format from extension, provenance. ───────────
{
  const src = new FileAssetSource(); // base = the asset root
  assert(src.name === "file", `source name is "file" (got ${src.name})`);
  const res: AssetResult = await src.generateAsset({ kind: "model", seed: 0, params: { path: FIXTURE } });
  assert(res.format === "glb", `format from .glb extension (got ${res.format})`);
  assert(res.meta.source === "file", `meta.source "file" (got ${res.meta.source})`);
  assert(res.bytes.length === expected.length, `byte length matches the file (${res.bytes.length} vs ${expected.length})`);
  let same = true;
  for (let i = 0; i < expected.length; i++) if (res.bytes[i] !== expected[i]) { same = false; break; }
  assert(same, "returned bytes are byte-identical to the on-disk file");
}

// ── 2. baseDir prefix + default ${kind}/${prompt ?? seed}.glb mapping (proven via the error path). ─
{
  const src = new FileAssetSource("library"); // base prefix within the asset root
  let threw = false, msg = "";
  try {
    await src.generateAsset({ kind: "prop", seed: 1, prompt: "does-not-exist" });
  } catch (e) {
    threw = true;
    msg = (e as Error).message;
  }
  assert(threw, "a missing file must throw");
  // The default mapping + base prefix produce library/prop/does-not-exist.glb — proven by the message.
  assert(msg.includes("library/prop/does-not-exist.glb"), `error names the mapped path (got: ${msg})`);
  assert(/file|asset|read|missing|not found/i.test(msg), `error is clear about the missing file (got: ${msg})`);
}

// ── 3. AssetResolver: match() routing, explicit params.source override, fallback. ────────────────
{
  const file = new FileAssetSource();
  const memory: AssetSource = {
    name: "memory",
    async generateAsset(): Promise<AssetResult> {
      return { format: "glb", bytes: new Uint8Array([7]), meta: { source: "memory" } };
    },
  };
  const resolver = new AssetResolver(
    [
      { name: "vegetation→file", match: (r: AssetRequest) => r.kind === "vegetation", source: file },
      { name: "model→memory", match: (r: AssetRequest) => r.kind === "model", source: memory },
    ],
    memory, // fallback
  );

  // match(): ordered predicates pick the source.
  assert(resolver.resolve({ kind: "vegetation", seed: 1 }) === file, "match() routes vegetation → file source");
  assert(resolver.resolve({ kind: "model", seed: 1 }) === memory, "match() routes model → memory source");
  // explicit params.source pins a backend, overriding match().
  assert(
    resolver.resolve({ kind: "vegetation", seed: 1, params: { source: "memory" } }) === memory,
    "params.source overrides match()",
  );
  assert(
    resolver.resolve({ kind: "model", seed: 1, params: { source: "file" } }) === file,
    "params.source 'file' pins the file source",
  );
  // an unknown explicit source fails loudly.
  let pinThrew = false;
  try { resolver.resolve({ kind: "model", seed: 1, params: { source: "nope" } }); } catch { pinThrew = true; }
  assert(pinThrew, "an unknown params.source throws");
  // nothing matches → fallback.
  assert(resolver.resolve({ kind: "character", seed: 1 }) === memory, "falls back when no route matches");
  // no-fallback resolver throws on a miss.
  let missThrew = false;
  try { new AssetResolver([]).resolve({ kind: "prop", seed: 1 }); } catch { missThrew = true; }
  assert(missThrew, "a no-fallback resolver throws on an unmatched request");
}

ops.op_log(
  "p17b_file_source OK: file source returns exact on-disk bytes + format-from-extension + meta.source \"file\" + " +
    "default ${kind}/${prompt}.glb mapping under baseDir + clear missing-file error; resolver routes by match(), " +
    "honours params.source override, and falls back.",
);
