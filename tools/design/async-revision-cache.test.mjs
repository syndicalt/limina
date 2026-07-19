import assert from "node:assert/strict";
import test from "node:test";
import { AsyncRevisionCache } from "./async-revision-cache.mjs";

test("same-revision requests coalesce and cached reads do no new work", async () => {
  const cache = new AsyncRevisionCache();
  let loads = 0;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const load = async () => { loads += 1; await held; return { generation: loads }; };
  const a = cache.get("r1", load);
  const b = cache.get("r1", load);
  await Promise.resolve();
  assert.equal(loads, 1);
  release();
  assert.equal(await a, await b);
  assert.deepEqual(await cache.get("r1", () => { throw new Error("cache miss"); }), { generation: 1 });
  assert.equal(loads, 1);
});

test("a newer revision behind an in-flight load is compiled after it settles", async () => {
  const cache = new AsyncRevisionCache();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const old = cache.get("r1", async () => { await held; return "old"; });
  let newLoads = 0;
  const loadNew = async () => { newLoads += 1; return "new"; };
  const newer = cache.get("r2", loadNew);
  const newerToo = cache.get("r2", loadNew);
  release();
  assert.equal(await old, "old");
  assert.equal(await newer, "new");
  assert.equal(await newerToo, "new");
  assert.equal(newLoads, 1);
  assert.equal(await cache.get("r2", async () => "wrong"), "new");
});

test("failed loads are not cached and invalidate forces recomputation", async () => {
  const cache = new AsyncRevisionCache();
  await assert.rejects(cache.get("r1", async () => { throw new Error("broken"); }), /broken/);
  assert.equal(await cache.get("r1", async () => "recovered"), "recovered");
  cache.invalidate();
  assert.equal(await cache.get("r1", async () => "fresh"), "fresh");
});
