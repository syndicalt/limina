// Behavioral audit gate for the browser durable trace seam. This runs the real
// IndexedDbKvStore in Chromium with GPU disabled: transaction publication, reopen,
// structural world-log verification/replay, overwrite cleanup, and competing writers.

import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../js/node_modules/esbuild/lib/main.js";
import { resolveChrome, resolvePwc } from "./_pw-resolve.mjs";

const require = createRequire(import.meta.url);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pwc = resolvePwc();
const chrome = resolveChrome();
if (!pwc || !chrome) {
  console.log("__LIMINA_SKIP__ Playwright or Chromium unavailable for real IndexedDB trace test");
  process.exit(2);
}
let chromium;
try { ({ chromium } = require(pwc)); }
catch (error) {
  console.log(`__LIMINA_SKIP__ Playwright is not loadable: ${error.message}`);
  process.exit(2);
}

const directory = await mkdtemp(join(tmpdir(), "limina-trace-idb-"));
const dbName = `limina-trace-test-${process.pid}-${Date.now()}`;
const validLog = [
  JSON.stringify({ kind: "meta", logVersion: 2, sessionId: "browser-idb", createdAt: "tick:0", commands: 1, ticks: 0 }),
  JSON.stringify({ kind: "seed", seq: 0, seed: 123456789 }),
].join("\n") + "\n";
const entry = `
import { DurableTraceStore, IndexedDbKvStore } from ${JSON.stringify(join(repo, "js/src/browser/host.ts"))};
import { verifyWorldLog } from ${JSON.stringify(join(repo, "js/src/worldlog/verify.ts"))};
import { replayWorldLog } from ${JSON.stringify(join(repo, "js/src/worldlog/replay.ts"))};

const dbName = ${JSON.stringify(dbName)};
const validLog = ${JSON.stringify(validLog)};
const kv = () => new IndexedDbKvStore(dbName, "traces");
const first = new DurableTraceStore(kv());
await Promise.all([first.hydrate(), first.hydrate()]);
first.op_write_trace("world.log.jsonl", validLog.slice(0, 61));
first.op_append_trace("world.log.jsonl", validLog.slice(61));
await first.whenIdle();
if (first.persistStatus.failures !== 0) throw new Error("initial IndexedDB publication failed");

const reopened = new DurableTraceStore(kv());
await reopened.hydrate();
await reopened.hydrate();
const durable = reopened.op_read_trace("world.log.jsonl");
const verified = verifyWorldLog(durable);
if (!verified.ok) throw new Error("reopened world log did not verify: " + verified.reason);
const replayed = await replayWorldLog(durable, {
  makeWorld: () => ({ entities: { ids: () => [], resolve: () => undefined }, ops: {}, tags: new Map() }),
  makeRegistry: () => ({}),
  tracer: {},
});
if (replayed.commands !== 1 || replayed.seeds !== 1 || replayed.state.entities.length !== 0) {
  throw new Error("reopened world log did not replay its seed command");
}

const rawBeforeOverwrite = await kv().loadAll();
if (rawBeforeOverwrite.some(([key]) => key === "world.log.jsonl")) throw new Error("new trace used a monolithic IndexedDB value");
const beforeSegments = rawBeforeOverwrite.filter(([key]) => key.includes(":segment:world.log.jsonl:"));
if (beforeSegments.length !== 2) throw new Error("expected two append-sized IndexedDB segments");

reopened.op_write_trace("world.log.jsonl", validLog);
await reopened.whenIdle();
if (reopened.persistStatus.failures !== 0) throw new Error("overwrite or stale cleanup failed");
const rawAfterOverwrite = await kv().loadAll();
const metadata = JSON.parse(rawAfterOverwrite.find(([key]) => key.includes(":meta:") && key.endsWith("world.log.jsonl"))?.[1] ?? "null");
const afterSegments = rawAfterOverwrite.filter(([key]) => key.includes(":segment:world.log.jsonl:"));
if (afterSegments.length !== metadata.segmentCount || afterSegments.length !== 1) throw new Error("stale IndexedDB generation was not reclaimed");

const left = new DurableTraceStore(kv());
const right = new DurableTraceStore(kv());
await Promise.all([left.hydrate(), right.hydrate()]);
left.op_append_trace("race.jsonl", "left\\n");
right.op_append_trace("race.jsonl", "right\\n");
await Promise.all([left.whenIdle(), right.whenIdle()]);
if (left.persistStatus.failures + right.persistStatus.failures !== 1) throw new Error("real IndexedDB CAS did not reject exactly one competing writer");
const race = new DurableTraceStore(kv());
await race.hydrate();
const raceValue = race.op_read_trace("race.jsonl");
if (raceValue !== "left\\n" && raceValue !== "right\\n") throw new Error("real IndexedDB race fabricated combined content");

window.__liminaTraceIdb = {
  pass: true,
  commands: replayed.commands,
  segmentsBefore: beforeSegments.length,
  segmentsAfter: afterSegments.length,
  raceValue,
};
`;

let server;
let browser;
try {
  await build({
    stdin: { contents: entry, resolveDir: repo, sourcefile: "browser-trace-indexeddb-entry.ts", loader: "ts" },
    bundle: true,
    format: "esm",
    platform: "browser",
    outfile: join(directory, "entry.js"),
    logLevel: "silent",
  });
  await writeFile(join(directory, "index.html"), "<!doctype html><meta charset='utf-8'><script type='module' src='/entry.js'></script>\n");
  server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      if (pathname === "/favicon.ico") { response.writeHead(204); response.end(); return; }
      const path = join(directory, pathname === "/" ? "index.html" : pathname);
      const bytes = await readFile(path);
      response.writeHead(200, { "content-type": extname(path) === ".html" ? "text/html" : "text/javascript" });
      response.end(bytes);
    } catch { response.writeHead(404); response.end("not found"); }
  });
  await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
  browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "domcontentloaded", timeout: 15_000 });
  const result = await page.waitForFunction(() => window.__liminaTraceIdb ?? false, { timeout: 30_000 }).then((handle) => handle.jsonValue()).catch((error) => {
    throw new Error(errors.length > 0 ? errors.slice(0, 6).join(" | ") : `browser result timeout: ${error.message}`);
  });
  if (errors.length > 0) throw new Error(errors.slice(0, 6).join(" | "));
  if (result?.pass !== true) throw new Error(`unexpected browser result: ${JSON.stringify(result)}`);
  console.log(`browser-trace-indexeddb OK: real atomic IndexedDB publish/reopen/replay, ${result.segmentsBefore}->${result.segmentsAfter} generation cleanup, CAS winner ${JSON.stringify(result.raceValue)} (GPU disabled)`);
} finally {
  await browser?.close();
  if (server !== undefined) await new Promise((accept) => server.close(accept));
  await rm(directory, { recursive: true, force: true });
}
