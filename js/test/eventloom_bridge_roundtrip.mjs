#!/usr/bin/env node
// =============================================================================
// REAL round-trip test for the limina -> Zaxy/EventLoom logging bridge.
// =============================================================================
//
// This is a genuine end-to-end test against the LIVE `zaxy` 2.6.2 CLI — no
// mocks, no stubs. It will FAIL if ingest is a no-op, if ids / parent / causedBy
// links are lost, if the producer is misattributed, or if a second ingest
// duplicates events instead of deduping.
//
// Reproducible wrapper — run from the repo root:
//   node js/test/eventloom_bridge_roundtrip.mjs
// Optional env overrides: ZAXY_BIN (default /home/cheapseatsecon/miniconda3/bin/zaxy),
// LIMINA_BIN (default ./target/debug/limina).
//
// Flow:
//   (a) produce a REAL limina durable trace (>=2 causally-linked events) by
//       running the limina engine binary on js/test/eventloom_bridge_producer.ts;
//   (b) bridge it into a TEMP eventloom-path + dedicated session via the CLI;
//   (c) VERIFY the written session JSONL: events present; original id /
//       parentEventId / causedBy preserved; actor == "limina:<actorId>";
//       payload.__limina_origin carries the original timestamp + thread; and the
//       recomputed integrity chain links cleanly (genesis null, each -> prior);
//   (d) run the bridge AGAIN and assert idempotence (0 new, all deduped, no
//       duplicate lines — producer_ref dedup);
//   (e) clean up the temp dir and the produced trace.
// =============================================================================

import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const ZAXY_BIN = process.env.ZAXY_BIN ?? "/home/cheapseatsecon/miniconda3/bin/zaxy";
const LIMINA_BIN = process.env.LIMINA_BIN ?? join(REPO, "target", "debug", "limina");
const PRODUCER = join(REPO, "js", "test", "eventloom_bridge_producer.ts");
const BRIDGE = join(REPO, "js", "tools", "eventloom_bridge.mjs");
const TRACE_NAME = "eventloom_bridge_src.jsonl";
const TRACE_PATH = join(REPO, "traces", TRACE_NAME);
const SESSION = "limina-world-roundtrip";

let failures = 0;
function check(cond, msg) {
  if (cond) {
    console.log(`  ok: ${msg}`);
  } else {
    failures++;
    console.error(`  FAIL: ${msg}`);
  }
}
function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function run(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const c = spawn(cmd, args, { cwd: REPO, ...opts });
    let out = "";
    let err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("error", rej);
    c.on("close", (code) => res({ code, out, err }));
  });
}

function parseJsonl(text) {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function bridgeOnce(eventloomPath) {
  const r = await run(
    "node",
    [BRIDGE, TRACE_PATH, "--eventloom-path", eventloomPath, "--session-id", SESSION],
    { env: { ...process.env, ZAXY_BIN } },
  );
  if (r.code !== 0) throw new Error(`bridge exited ${r.code}: ${r.err}`);
  // stdout is a single JSON summary line.
  const line = r.out.trim().split(/\r?\n/).filter(Boolean).pop();
  return JSON.parse(line);
}

async function main() {
  // Pre-flight: confirm the live CLI is exactly 2.6.2 and supports `memory ingest`.
  const ver = await run(ZAXY_BIN, ["--version"]);
  check(ver.out.trim() === "zaxy 2.6.2", `zaxy version is 2.6.2 (got "${ver.out.trim()}")`);
  const ing = await run(ZAXY_BIN, ["memory", "ingest", "--help"]);
  if (ing.code !== 0 || !/--eventloom-path/.test(ing.out)) {
    throw new Error("zaxy CLI lacks `memory ingest`; STOP — cannot run round-trip");
  }

  if (!(await exists(LIMINA_BIN))) throw new Error(`limina binary not found at ${LIMINA_BIN}`);

  // (a) Produce a REAL limina trace via the engine binary.
  await rm(TRACE_PATH, { force: true });
  const prod = await run(LIMINA_BIN, [PRODUCER]);
  if (prod.code !== 0) throw new Error(`producer exited ${prod.code}: ${prod.err || prod.out}`);
  check(await exists(TRACE_PATH), `producer flushed real trace at traces/${TRACE_NAME}`);

  const expected = parseJsonl(await readFile(TRACE_PATH, "utf8"));
  check(expected.length >= 2, `trace has >=2 events (got ${expected.length})`);
  const hasCausalLink = expected.some(
    (e) => e.parentEventId !== null && Array.isArray(e.causedBy) && e.causedBy.length > 0,
  );
  check(hasCausalLink, "trace contains at least one causally-linked event (parent + causedBy)");

  const tmp = await mkdtemp(join(tmpdir(), "limina-roundtrip-"));
  const eventloomPath = join(tmp, "el");
  const sessionFile = join(eventloomPath, `${SESSION}.jsonl`);

  try {
    // (b) First ingest via the bridge CLI.
    const first = await bridgeOnce(eventloomPath);
    console.log(`\n[bridge CLI] node js/tools/eventloom_bridge.mjs traces/${TRACE_NAME} --eventloom-path <tmp>/el --session-id ${SESSION}`);
    console.log(`[run 1] read=${first.read} ingested=${first.ingested} deduped=${first.deduped}`);
    check(first.read === expected.length, `bridge read all ${expected.length} trace events`);
    check(first.ingested === expected.length, `first ingest imported all ${expected.length} events`);
    check(first.deduped === 0, "first ingest deduped 0");

    // (c) Verify the written session.
    check(await exists(sessionFile), `session file written at <tmp>/el/${SESSION}.jsonl`);
    const stored = parseJsonl(await readFile(sessionFile, "utf8"));
    check(stored.length === expected.length, `session has ${expected.length} events (got ${stored.length})`);

    const storedById = new Map(stored.map((e) => [e.id, e]));
    for (const ex of expected) {
      const got = storedById.get(ex.id);
      check(got !== undefined, `event id preserved: ${ex.id}`);
      if (!got) continue;
      check(got.type === ex.type, `  type preserved (${ex.type})`);
      check(got.actorId === `limina:${ex.actorId}`, `  producer attributed via actor -> actorId="limina:${ex.actorId}"`);
      check(eq(got.parentEventId ?? null, ex.parentEventId ?? null), `  parentEventId preserved (${ex.parentEventId})`);
      check(eq(got.causedBy ?? [], ex.causedBy ?? []), `  causedBy preserved (${JSON.stringify(ex.causedBy)})`);
      check(got.payload?.__limina_origin?.t === ex.timestamp, `  payload.__limina_origin.t == original timestamp (${ex.timestamp})`);
      check(got.payload?.__limina_origin?.threadId === ex.threadId, `  payload.__limina_origin.threadId == original thread (${ex.threadId})`);
      check(got.payload?.__zaxy_producer_ref === ex.id, "  producer_ref (dedup key) == limina event id");
      // original payload fields survive alongside the injected metadata
      const origKeysOk = Object.keys(ex.payload ?? {}).every((k) => eq(got.payload?.[k], ex.payload[k]));
      check(origKeysOk, "  original payload fields preserved");
    }

    // Chain integrity: Zaxy recomputed a sealed sha256 chain. Verify it links.
    let prevHash = null;
    let chainOk = true;
    for (const e of stored) {
      const i = e.integrity;
      if (!i || typeof i.hash !== "string" || !i.hash.startsWith("sha256:")) chainOk = false;
      if ((i?.previousHash ?? null) !== prevHash) chainOk = false;
      prevHash = i?.hash ?? null;
    }
    check(chainOk, "recomputed integrity chain links cleanly (genesis null -> each previousHash == prior hash)");

    // (d) Idempotence: re-ingest, expect 0 new + full dedup, no new lines.
    const second = await bridgeOnce(eventloomPath);
    console.log(`[run 2] read=${second.read} ingested=${second.ingested} deduped=${second.deduped}`);
    check(second.ingested === 0, "second ingest imported 0 (idempotent)");
    check(second.deduped === expected.length, `second ingest deduped all ${expected.length} (producer_ref)`);
    const storedAfter = parseJsonl(await readFile(sessionFile, "utf8"));
    check(storedAfter.length === expected.length, `no duplicate lines after re-ingest (still ${expected.length})`);

    // Concrete read-back of the dedicated session (the actual verification proof).
    console.log(`\n=== read-back of <tmp>/el/${SESSION}.jsonl (preserved id/links + integrity) ===`);
    for (const e of stored) {
      console.log(
        JSON.stringify({
          id: e.id,
          type: e.type,
          actorId: e.actorId,
          parentEventId: e.parentEventId,
          causedBy: e.causedBy,
          __limina_origin: e.payload?.__limina_origin,
          producer_ref: e.payload?.__zaxy_producer_ref,
          integrity: e.integrity,
        }),
      );
    }
  } finally {
    // (e) Clean up temp eventloom-path and the produced trace.
    await rm(tmp, { recursive: true, force: true });
    await rm(TRACE_PATH, { force: true });
  }

  console.log(`\n[cleanup] removed temp eventloom-path + traces/${TRACE_NAME}`);

  if (failures > 0) {
    console.error(`\nEVENTLOOM BRIDGE ROUND-TRIP: ${failures} FAILED CHECK(S)`);
    process.exit(1);
  }
  console.log("\nEVENTLOOM BRIDGE ROUND-TRIP: ALL CHECKS PASSED");
}

main().catch((err) => {
  console.error(`\nEVENTLOOM BRIDGE ROUND-TRIP: ERROR: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
