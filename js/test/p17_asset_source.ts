// AssetSource + AssetCache unit gate (asset-pipeline step 1).
//
// Proves the determinism + replay contract BY MEASUREMENT: the cache key is stable + param-order
// independent + source/seed sensitive; resolve calls a backend only on a MISS; a persistent store is
// read-through (replay never re-hits the backend); the content hash is deterministic.
//
// Run: ./target/release/limina js/test/p17_asset_source.ts   (exit 0 = pass)

import { ops } from "../src/engine.ts";
import { AssetCache, type AssetStore, contentHash, requestKey } from "../src/asset/cache.ts";
import type { AssetRequest, AssetResult, AssetSource } from "../src/asset/types.ts";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error("p17_asset_source FAIL: " + msg);
}

class MockSource implements AssetSource {
  readonly name: string;
  calls = 0;
  constructor(name = "mock") { this.name = name; }
  async generateAsset(_req: AssetRequest): Promise<AssetResult> {
    this.calls++;
    return { format: "glb", bytes: new Uint8Array([1, 2, 3, this.calls]), meta: { source: this.name } };
  }
}
const req = (over: Partial<AssetRequest> = {}): AssetRequest => ({ kind: "building", seed: 7, ...over });

// ── 1. requestKey: stable, param-ORDER independent, source/seed/field sensitive. ─────────────────
{
  assert(requestKey("s", req()) === requestKey("s", req()), "same request → same key");
  // param order must not matter (keys sorted)
  const a = requestKey("s", req({ params: { a: 1, b: 2 } }));
  const b = requestKey("s", req({ params: { b: 2, a: 1 } }));
  assert(a === b, "param order must not change the key");
  assert(requestKey("s", req({ seed: 7 })) !== requestKey("s", req({ seed: 8 })), "seed changes the key");
  assert(requestKey("s1", req()) !== requestKey("s2", req()), "source name changes the key");
  assert(requestKey("s", req({ prompt: "a" })) !== requestKey("s", req({ prompt: "b" })), "prompt changes the key");
  assert(requestKey("s", req({ referenceImage: "x.jpg" })) !== requestKey("s", req()), "referenceImage changes the key");
}

// ── 2. resolve: backend called ONCE per distinct request; hits never call it. ────────────────────
{
  const src = new MockSource();
  const cache = new AssetCache();
  const r1 = await cache.resolve(req(), src);
  assert(src.calls === 1, `miss generates (calls ${src.calls})`);
  const r2 = await cache.resolve(req(), src);
  assert(src.calls === 1, `hit must NOT re-call the backend (calls ${src.calls})`);
  assert(r1 === r2, "hit returns the same cached result");
  await cache.resolve(req({ seed: 99 }), src);
  assert(src.calls === 2, `a distinct request generates again (calls ${src.calls})`);
  assert(cache.size === 2, `cache holds both distinct assets (size ${cache.size})`);
}

// ── 3. persistent store is read-through: a fresh cache resolves from disk WITHOUT the backend. ───
{
  const src = new MockSource();
  const preloaded: AssetResult = { format: "glb", bytes: new Uint8Array([9, 9, 9]), meta: { source: "disk" } };
  const store: AssetStore = {
    load: (key) => (key === requestKey(src.name, req()) ? preloaded : undefined),
    save: () => {},
  };
  const cache = new AssetCache(store);
  const got = await cache.resolve(req(), src);
  assert(src.calls === 0, "a store hit must NOT call the backend (replay safety)");
  assert(got === preloaded, "store-backed resolve returns the persisted asset");
}

// ── 4. content hash: deterministic + byte-sensitive. ─────────────────────────────────────────────
{
  const r: AssetResult = { format: "glb", bytes: new Uint8Array([1, 2, 3]), meta: { source: "m" } };
  const r2: AssetResult = { format: "glb", bytes: new Uint8Array([1, 2, 4]), meta: { source: "m" } };
  assert(contentHash(r) === contentHash(r), "content hash is deterministic");
  assert(contentHash(r) !== contentHash(r2), "content hash is byte-sensitive");
}

ops.op_log("p17_asset_source OK: cache key stable + order-independent + source/seed-sensitive; backend called once per distinct request; persistent store is read-through (replay-safe); content hash deterministic.");
