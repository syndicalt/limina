#!/usr/bin/env node
// =============================================================================
// limina -> Zaxy/EventLoom durable-trace LOGGING bridge  (Phase 4, P4-A slice)
// =============================================================================
//
// WHAT THIS IS: an OPTIONAL, OUT-OF-ENGINE-CORE adapter. It is a standalone
// external tool that mirrors a limina durable trace (the EventLoom-shaped JSONL
// that LiminaTracer flushes into the sandboxed `traces/` dir) into a Zaxy 2.6.2
// session via `zaxy memory ingest`. It is NOT part of the limina engine runtime:
// the engine has no zaxy op and no `limina` subcommand that shells to zaxy. The
// engine merely provides the substrate (the durable trace); this bridge consumes
// it after the fact. Nothing here is ever imported by engine-core code.
//
// PRODUCER IDENTITY rides the `actor` field as "limina:<actorId>". There is NO
// separate producer field in the ingest manifest (locked architecture decision);
// the producer string is carried by `actor`, which Zaxy stores as the event's
// actorId.
//
// ZAXY OWNS THE CHAIN: Zaxy recomputes its own seq / prev_hash / hash from the
// locked session tail, but PRESERVES the caller-supplied id / parent_event_id /
// caused_by (they round-trip on replay and are hash-sealed). So limina needs NO
// hash-canonicalization alignment — we just hand over id + links + actor and let
// Zaxy reseal. `producer_ref` = the limina event id makes re-ingest idempotent
// (Zaxy dedups by producer_ref, both against the session log and within a batch).
// Ingest drops any timestamp, so the original limina timestamp + threadId are
// tucked into payload.__limina_origin to survive the trip.
//
// OPERATIONAL NOTE (graph lane): EventLoom graph projection is single-owner
// (Kuzu lock). If a `zaxy serve` MCP daemon is holding the repo's .eventloom,
// CLI ingest stays DURABLE (events are written and chain-sealed) but the GRAPH
// projection lane degrades to null for that ingest. The events are not lost —
// reproject later (or ingest against an uncontended eventloom-path).
//
// USAGE:
//   node js/tools/eventloom_bridge.mjs <traceJsonlPath> \
//        --eventloom-path <dir> --session-id <session> \
//        [--zaxy <zaxyBin>] [--items <itemsOutPath>] [--json]
//
// Env fallbacks: LIMINA_TRACE_PATH, ZAXY_EVENTLOOM_PATH, ZAXY_SESSION_ID, ZAXY_BIN.
//
// Mapping (one limina EventLoom event -> one ingest item):
//   event_type      = ev.type                       (dotted-lowercase => eventloom.v1 framing)
//   actor           = "limina:" + ev.actorId        (producer identity)
//   id              = ev.id                          (preserved & hash-sealed by Zaxy)
//   parent_event_id = ev.parentEventId               (omitted when null)
//   caused_by       = ev.causedBy
//   producer_ref    = ev.id                          (idempotent dedup key)
//   payload         = { ...ev.payload, __limina_origin: { t: ev.timestamp, threadId: ev.threadId } }
// =============================================================================

import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

function parseArgs(argv) {
  const opts = { trace: undefined, eventloomPath: undefined, sessionId: undefined, zaxy: undefined, items: undefined, json: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--eventloom-path") opts.eventloomPath = argv[++i];
    else if (a === "--session-id") opts.sessionId = argv[++i];
    else if (a === "--zaxy") opts.zaxy = argv[++i];
    else if (a === "--items") opts.items = argv[++i];
    else if (a === "--json") opts.json = true;
    else if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
    else rest.push(a);
  }
  if (opts.trace === undefined) opts.trace = rest[0];
  return opts;
}

/** Map one parsed limina EventLoom event into a Zaxy ingest item. */
export function toIngestItem(ev) {
  if (ev === null || typeof ev !== "object") throw new Error("trace line is not an object");
  if (typeof ev.id !== "string" || typeof ev.type !== "string" || typeof ev.actorId !== "string") {
    throw new Error("trace line missing EventLoom envelope fields (id/type/actorId)");
  }
  // payload must be an object for the ingest schema; wrap non-object payloads.
  const basePayload =
    ev.payload !== null && typeof ev.payload === "object" && !Array.isArray(ev.payload)
      ? { ...ev.payload }
      : { __limina_value: ev.payload ?? null };
  const item = {
    event_type: ev.type,
    actor: `limina:${ev.actorId}`,
    id: ev.id,
    caused_by: Array.isArray(ev.causedBy) ? ev.causedBy : [],
    producer_ref: ev.id,
    payload: {
      ...basePayload,
      __limina_origin: { t: ev.timestamp ?? null, threadId: ev.threadId ?? null },
    },
  };
  if (ev.parentEventId !== null && ev.parentEventId !== undefined) {
    item.parent_event_id = ev.parentEventId;
  }
  return item;
}

/**
 * Stream the trace JSONL line-by-line, transform each into an ingest item, and
 * write it to `itemsPath`. One-line lookahead lets us tolerate a torn/partial
 * FINAL line (a half-written last record): only the last line may fail to parse;
 * any earlier malformed line is a hard corruption error.
 */
async function transformTrace(tracePath, itemsPath) {
  const out = createWriteStream(itemsPath, { encoding: "utf8" });
  const rl = createInterface({ input: createReadStream(tracePath, { encoding: "utf8" }), crlfDelay: Infinity });

  let read = 0;
  let partialFinalLine = false;
  let pending; // one-line lookahead buffer
  let lineNo = 0;

  const writeItem = (raw, isFinal) => {
    if (raw.trim() === "") return; // skip blank lines
    let ev;
    try {
      ev = JSON.parse(raw);
    } catch (err) {
      if (isFinal) {
        partialFinalLine = true; // tolerate a torn final line
        return;
      }
      throw new Error(`invalid trace JSON at line ${lineNo}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const item = toIngestItem(ev);
    read++;
    if (!out.write(JSON.stringify(item) + "\n")) return out;
    return undefined;
  };

  for await (const line of rl) {
    lineNo++;
    if (pending !== undefined) writeItem(pending.raw, false);
    pending = { raw: line };
  }
  if (pending !== undefined) writeItem(pending.raw, true);

  out.end();
  await once(out, "finish");
  return { read, partialFinalLine };
}

/** Parse zaxy's `--json` ingest summary, tolerating any preamble log noise. */
function parseJsonSummary(text) {
  const isSummary = (o) => o !== null && typeof o === "object" && "imported" in o && "session_id" in o;
  try {
    const o = JSON.parse(text);
    if (isSummary(o)) return o;
  } catch {
    // fall through to a line-by-line scan
  }
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === "") continue;
    try {
      const o = JSON.parse(line);
      if (isSummary(o)) return o;
    } catch {
      // not JSON; keep scanning
    }
  }
  return undefined;
}

function runZaxyIngest(zaxyBin, itemsPath, eventloomPath, sessionId) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      zaxyBin,
      ["memory", "ingest", "--file", itemsPath, "--eventloom-path", eventloomPath, "--session-id", sessionId, "--json"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`zaxy memory ingest exited ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      // `--json` prints a single JSON summary object on stdout. Parse the whole
      // payload; if a daemon prepended log noise, fall back to the last line
      // that parses to a summary object (has `imported`/`session_id`).
      const text = stdout.trim();
      let summary = parseJsonSummary(text);
      if (summary === undefined) {
        reject(new Error(`could not parse zaxy --json output:\n${text}`));
        return;
      }
      resolve(summary);
    });
  });
}

export async function bridge(opts) {
  const tracePath = opts.trace ?? process.env.LIMINA_TRACE_PATH;
  const eventloomPath = opts.eventloomPath ?? process.env.ZAXY_EVENTLOOM_PATH;
  const sessionId = opts.sessionId ?? process.env.ZAXY_SESSION_ID;
  const zaxyBin = opts.zaxy ?? process.env.ZAXY_BIN ?? "zaxy";
  if (!tracePath) throw new Error("missing trace path (arg or LIMINA_TRACE_PATH)");
  if (!eventloomPath) throw new Error("missing --eventloom-path (or ZAXY_EVENTLOOM_PATH)");
  if (!sessionId) throw new Error("missing --session-id (or ZAXY_SESSION_ID)");

  // Guard rails for the locked decision: never touch the agent-memory session.
  if (sessionId === "limina-default" || sessionId === "default") {
    throw new Error(`refusing to ingest into agent-memory session '${sessionId}'; use a dedicated limina-world session`);
  }

  let scratchDir;
  let itemsPath = opts.items;
  if (!itemsPath) {
    scratchDir = await mkdtemp(join(tmpdir(), "limina-bridge-"));
    itemsPath = join(scratchDir, "items.jsonl");
  }

  try {
    const { read, partialFinalLine } = await transformTrace(tracePath, itemsPath);
    const summary = await runZaxyIngest(zaxyBin, itemsPath, eventloomPath, sessionId);
    return {
      tracePath,
      eventloomPath,
      sessionId,
      itemsPath,
      read,
      partialFinalLine,
      ingested: summary.imported ?? 0,
      deduped: summary.deduped ?? 0,
      sessionFile: join(eventloomPath, `${sessionId}.jsonl`),
    };
  } finally {
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
  }
}

// CLI entrypoint (only when run directly, not when imported by the test).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const r = await bridge(opts);
    process.stderr.write(
      `[eventloom-bridge] trace=${r.tracePath}\n` +
        `[eventloom-bridge] -> session=${r.sessionId} @ ${r.eventloomPath}\n` +
        `[eventloom-bridge] read=${r.read} ingested=${r.ingested} deduped=${r.deduped}` +
        (r.partialFinalLine ? " (tolerated partial final line)" : "") +
        "\n",
    );
    process.stdout.write(JSON.stringify(r) + "\n");
  } catch (err) {
    process.stderr.write(`[eventloom-bridge] ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
