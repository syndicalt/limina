import { DurableTraceStore, type AsyncKvStore } from "../src/browser/host.ts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`p8_browser_trace_segments FAIL: ${message}`);
}

async function rejects(work: () => Promise<unknown>, pattern: RegExp, message: string): Promise<void> {
  let error: unknown;
  try { await work(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${error instanceof Error ? error.message : "did not reject"}`);
}

function throws(work: () => unknown, pattern: RegExp, message: string): void {
  let error: unknown;
  try { work(); } catch (caught) { error = caught; }
  assert(error instanceof Error && pattern.test(error.message), `${message}: ${error instanceof Error ? error.message : "did not throw"}`);
}

interface CommitRecord {
  expectedKey: string;
  expectedValue: string | null;
  writes: Array<[string, string]>;
}

class AtomicFakeKv implements AsyncKvStore {
  readonly data = new Map<string, string>();
  readonly commits: CommitRecord[] = [];
  readonly removals: string[][] = [];
  failNext: Error | null = null;
  active = 0;
  maxActive = 0;
  loads = 0;

  async loadAll(): Promise<Array<[string, string]>> {
    this.loads++;
    await Promise.resolve();
    return [...this.data];
  }

  async put(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async commit(
    expectedKey: string,
    expectedValue: string | null,
    writes: readonly (readonly [string, string])[],
  ): Promise<boolean> {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      // Force callers through an async boundary so same-instance serialization
      // and competing-instance compare-and-set behavior are both observable.
      await Promise.resolve();
      if (this.failNext !== null) { const error = this.failNext; this.failNext = null; throw error; }
      const actual = this.data.get(expectedKey) ?? null;
      if (actual !== expectedValue) return false;
      const copied = writes.map(([key, value]) => [key, value] as [string, string]);
      this.commits.push({ expectedKey, expectedValue, writes: copied });
      for (const [key, value] of copied) this.data.set(key, value);
      return true;
    } finally {
      this.active--;
    }
  }

  async remove(keys: readonly string[]): Promise<void> {
    assert(keys.length <= 256, `cleanup batch was unbounded (${keys.length})`);
    this.removals.push([...keys]);
    for (const key of keys) this.data.delete(key);
  }
}

function segmentWrites(records: readonly CommitRecord[]): Array<[string, string]> {
  return records.flatMap((record) => record.writes.filter(([key]) => key.includes(":segment:")));
}

function metadataWrites(records: readonly CommitRecord[]): Array<[string, string]> {
  return records.flatMap((record) => record.writes.filter(([key]) => key.includes(":meta:")));
}

function segmentContent(raw: string): string {
  const value = JSON.parse(raw) as { content?: unknown };
  assert(typeof value.content === "string", "segment envelope omitted string content");
  return value.content;
}

function metaKey(kv: AtomicFakeKv, name: string): string {
  const key = [...kv.data.keys()].find((candidate) => candidate.includes(":meta:") && candidate.endsWith(encodeURIComponent(name)));
  assert(key !== undefined, `metadata key for ${name} was not found`);
  return key;
}

// New traces write immutable append-sized, hash-bound segments plus bounded
// metadata. Immediate synchronous reads retain the native op contract.
{
  const kv = new AtomicFakeKv();
  const store = new DurableTraceStore(kv);
  await Promise.all([store.hydrate(), store.hydrate()]);
  assert(kv.loads === 1, "concurrent hydrate calls did not share one backing-store read");
  await store.hydrate();
  assert(kv.loads === 1, "completed hydrate was not idempotent");

  const initial = "x".repeat(256 * 1024);
  store.op_write_trace("large.jsonl", initial);
  await store.whenIdle();
  kv.commits.length = 0;
  const chunks = ["a".repeat(17), "b".repeat(31), "c".repeat(47)];
  for (const chunk of chunks) store.op_append_trace("large.jsonl", chunk);
  assert(store.op_read_trace("large.jsonl") === initial + chunks.join(""), "synchronous append/read semantics changed");
  await store.hydrate();
  assert(kv.loads === 1, "repeated hydrate after mutation unexpectedly replaced the mirror");
  await store.whenIdle();

  assert(kv.maxActive === 1, "same-trace append commits overlapped instead of serializing");
  assert(kv.commits.length === chunks.length, "one atomic commit was not issued per append");
  const segments = segmentWrites(kv.commits);
  const metadata = metadataWrites(kv.commits);
  assert(segments.length === chunks.length && metadata.length === chunks.length, "append commit did not contain one segment and one metadata write");
  assert(segments.map(([, raw]) => segmentContent(raw)).join("") === chunks.join(""), "persisted segment bodies differ from append inputs");
  assert(new Set(segments.map(([key]) => key)).size === chunks.length, "append segment keys were not monotonically unique");
  assert(kv.commits.every((record) => record.writes.every(([key]) => key !== "large.jsonl")), "append rewrote the public monolithic key");
  assert(Math.max(...segments.map(([, raw]) => segmentContent(raw).length)) === 47, "append segment content grew with trace history");
  assert(metadata.every(([, value]) => value.length < 4_096), "metadata grew with trace history instead of remaining bounded");

  const reopened = new DurableTraceStore(kv);
  await reopened.hydrate();
  assert(reopened.op_read_trace("large.jsonl") === initial + chunks.join(""), "segmented trace did not reopen byte-exactly");

  // Overwrite publishes a new generation, then boundedly deletes all stale
  // generation segments. The following append continues only the new generation.
  reopened.op_write_trace("large.jsonl", "reset\n");
  reopened.op_append_trace("large.jsonl", "tail\n");
  await reopened.whenIdle();
  assert(kv.removals.every((batch) => batch.length <= 256), "overwrite cleanup exceeded its batch cap");
  const activeMetadata = JSON.parse(kv.data.get(metaKey(kv, "large.jsonl")) ?? "null") as { generation: number; segmentCount: number };
  const liveSegments = [...kv.data.keys()].filter((key) => key.includes(":segment:large.jsonl:"));
  assert(liveSegments.length === activeMetadata.segmentCount, "stale generation segments leaked after overwrite");
  const afterOverwrite = new DurableTraceStore(kv);
  await afterOverwrite.hydrate();
  assert(afterOverwrite.op_read_trace("large.jsonl") === "reset\ntail\n", "overwrite generation retained stale content");
}

// Cleanup remains bounded even when an old generation spans more than one batch.
{
  const kv = new AtomicFakeKv();
  const store = new DurableTraceStore(kv);
  await store.hydrate();
  store.op_write_trace("many.jsonl", "head\n");
  for (let i = 0; i < 300; i++) store.op_append_trace("many.jsonl", `${i}\n`);
  await store.whenIdle();
  store.op_write_trace("many.jsonl", "replacement\n");
  await store.whenIdle();
  const cleanup = kv.removals.slice(-2);
  assert(cleanup.length === 2 && cleanup[0].length === 256 && cleanup[1].length === 45, "301 stale segments were not reclaimed in 256-key batches");
}

// A legacy monolithic value is hash-bound as an immutable migration base. A
// same-UTF16-length rewrite is detected, and an overwrite reclaims that base.
{
  const kv = new AtomicFakeKv();
  kv.data.set("legacy.jsonl", "legacy-a\n");
  const store = new DurableTraceStore(kv);
  await store.hydrate();
  store.op_append_trace("legacy.jsonl", "legacy-b\n");
  await store.whenIdle();
  assert(kv.data.get("legacy.jsonl") === "legacy-a\n", "legacy migration rewrote its monolithic base");
  assert(segmentContent(segmentWrites(kv.commits).at(-1)?.[1] ?? "") === "legacy-b\n", "legacy migration segment is not append-sized");
  kv.data.set("legacy.jsonl", "LEGACY-A\n");
  await rejects(async () => new DurableTraceStore(kv).hydrate(), /legacy base content integrity failed/, "same-length legacy rewrite was accepted");
  kv.data.set("legacy.jsonl", "legacy-a\n");
  const reopened = new DurableTraceStore(kv);
  await reopened.hydrate();
  reopened.op_write_trace("legacy.jsonl", "replacement\n");
  await reopened.whenIdle();
  assert(!kv.data.has("legacy.jsonl"), "detached legacy base was not reclaimed after overwrite");
}

// Segment content is independently hashed and chained. Same-length tampering is
// detected before any reconstructed value is installed in the mirror.
{
  const kv = new AtomicFakeKv();
  const writer = new DurableTraceStore(kv);
  await writer.hydrate();
  writer.op_write_trace("tampered.jsonl", "first\n");
  writer.op_append_trace("tampered.jsonl", "second\n");
  await writer.whenIdle();
  const key = [...kv.data.keys()].find((candidate) => candidate.includes(":segment:tampered.jsonl:") && candidate.endsWith(":0000001"));
  assert(key !== undefined, "tamper fixture could not find segment 1");
  const record = JSON.parse(kv.data.get(key) ?? "null") as { content: string };
  record.content = "SECOND\n";
  kv.data.set(key, JSON.stringify(record));
  await rejects(async () => new DurableTraceStore(kv).hydrate(), /segment 1 content integrity failed/, "same-length segment rewrite was accepted");
}

// Metadata limits reject corrupt counts before a hostile loop or key-width
// overflow can occur; trace-name limits also fail synchronously.
{
  const kv = new AtomicFakeKv();
  const writer = new DurableTraceStore(kv);
  await writer.hydrate();
  writer.op_write_trace("caps.jsonl", "ok\n");
  await writer.whenIdle();
  const key = metaKey(kv, "caps.jsonl");
  const original = kv.data.get(key) ?? "";
  const metadata = JSON.parse(original) as Record<string, unknown>;
  metadata.segmentCount = 1_000_001;
  kv.data.set(key, JSON.stringify(metadata));
  await rejects(async () => new DurableTraceStore(kv).hydrate(), /segmentCount exceeds 1000000/, "oversized segmentCount was accepted");
  metadata.segmentCount = 1;
  metadata.generation = 100_000_000;
  kv.data.set(key, JSON.stringify(metadata));
  await rejects(async () => new DurableTraceStore(kv).hydrate(), /generation exceeds 99999999/, "generation key overflow was accepted");
  kv.data.set(key, original);
  throws(() => writer.op_append_trace("x".repeat(513), "a"), /name exceeds 512/, "oversized trace name was accepted");
}

// A failed atomic commit preserves the prior metadata pointer and the exact root
// cause. The poisoned trace remains named and no later commit is attempted.
{
  const kv = new AtomicFakeKv();
  const store = new DurableTraceStore(kv);
  await store.hydrate();
  store.op_write_trace("crash.jsonl", "good\n");
  await store.whenIdle();
  const root = new Error("injected atomic commit failure");
  kv.failNext = root;
  store.op_append_trace("crash.jsonl", "lost\n");
  await store.whenIdle();
  assert(store.op_read_trace("crash.jsonl") === "good\nlost\n", "write-behind failure changed the synchronous mirror contract");
  assert(store.persistStatus.failures === 1 && store.persistStatus.lastError === root, "atomic failure root cause was replaced");
  assert(store.persistStatus.poisonedTraces.length === 1 && store.persistStatus.poisonedTraces[0].name === "crash.jsonl" && store.persistStatus.poisonedTraces[0].cause === root, "poison status lost trace name or root cause");
  const commitsAfterFailure = kv.commits.length;
  store.op_append_trace("crash.jsonl", "also-lost\n");
  await store.whenIdle();
  assert(kv.commits.length === commitsAfterFailure && store.persistStatus.failures === 1, "poisoned trace retried or replaced its root failure");
  const reopened = new DurableTraceStore(kv);
  await reopened.hydrate();
  assert(reopened.op_read_trace("crash.jsonl") === "good\n", "failed append escaped the last complete durable prefix");
}

// Two independently hydrated writers race from one metadata revision. One CAS
// wins; the other fails closed, never combining the two contents.
{
  const kv = new AtomicFakeKv();
  const left = new DurableTraceStore(kv);
  const right = new DurableTraceStore(kv);
  await Promise.all([left.hydrate(), right.hydrate()]);
  left.op_append_trace("race.jsonl", "left\n");
  right.op_append_trace("race.jsonl", "right\n");
  await Promise.all([left.whenIdle(), right.whenIdle()]);
  assert(left.persistStatus.failures + right.persistStatus.failures === 1, "competing append did not produce exactly one CAS loser");
  const reopened = new DurableTraceStore(kv);
  await reopened.hydrate();
  const durable = reopened.op_read_trace("race.jsonl");
  assert(durable === "left\n" || durable === "right\n", `concurrent writers fabricated content: ${JSON.stringify(durable)}`);
}

// Orphans are ignored, while published metadata with a missing segment rejects
// hydration rather than silently truncating replay.
{
  const kv = new AtomicFakeKv();
  kv.data.set("\u0000limina:browser-trace:v2:segment:orphan:00000001:0000000", "ignored");
  const empty = new DurableTraceStore(kv);
  await empty.hydrate();
  assert(empty.op_read_trace("orphan") === "", "orphan segment became a visible trace");
  assert(!kv.data.has("\u0000limina:browser-trace:v2:segment:orphan:00000001:0000000"), "crash-orphan segment was not reclaimed during hydration");
  const writer = new DurableTraceStore(kv);
  await writer.hydrate();
  writer.op_write_trace("broken.jsonl", "complete\n");
  await writer.whenIdle();
  const segment = [...kv.data.keys()].find((key) => key.includes(":segment:broken.jsonl:"));
  assert(segment !== undefined, "missing-segment fixture could not find its published segment");
  kv.data.delete(segment);
  await rejects(async () => new DurableTraceStore(kv).hydrate(), /segment 0 is missing/, "metadata with a missing segment was accepted");
}

// Existing AsyncKvStore implementations with only loadAll+put remain source- and
// behavior-compatible. They use the old monolithic write-behind path explicitly.
{
  class LegacyKv implements AsyncKvStore {
    readonly data = new Map<string, string>();
    puts = 0;
    async loadAll(): Promise<Array<[string, string]>> { return [...this.data]; }
    async put(key: string, value: string): Promise<void> { this.puts++; this.data.set(key, value); }
  }
  const kv = new LegacyKv();
  const store = new DurableTraceStore(kv);
  await store.hydrate();
  store.op_write_trace("compat.jsonl", "a");
  store.op_append_trace("compat.jsonl", "b");
  await store.whenIdle();
  assert(kv.puts === 2 && kv.data.get("compat.jsonl") === "ab", "legacy AsyncKvStore compatibility path changed");
  const reopened = new DurableTraceStore(kv);
  await reopened.hydrate();
  assert(reopened.op_read_trace("compat.jsonl") === "ab", "legacy AsyncKvStore did not reopen its monolithic value");
}

console.log("p8_browser_trace_segments OK: append-sized sha256-chained segments, idempotent hydration, bounded caps/cleanup, byte-exact reopen, hash-bound legacy migration, atomic crash/CAS behavior, and stable legacy AsyncKv compatibility");
