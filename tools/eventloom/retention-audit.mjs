import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EVENTLOOM_SESSION_LOG_MAX_BYTES = 64 * 1024 * 1024;

export async function auditEventloomRetention(directory, maximumBytes = EVENTLOOM_SESSION_LOG_MAX_BYTES) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError("EventLoom retention maximum must be a positive safe integer");
  }
  const root = resolve(directory);
  const entries = await readdir(root, { withFileTypes: true });
  const logs = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const info = await stat(resolve(root, entry.name));
    logs.push(Object.freeze({ name: entry.name, bytes: info.size, overLimit: info.size >= maximumBytes }));
  }
  logs.sort((left, right) => left.name.localeCompare(right.name));
  return Object.freeze({ root, maximumBytes, logs: Object.freeze(logs), pass: logs.every((log) => !log.overLimit) });
}

const isMain = resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
if (isMain) {
  const report = await auditEventloomRetention(process.argv[2] ?? ".eventloom");
  for (const log of report.logs) {
    console.log(`${log.overLimit ? "HOLD" : "ok"} ${log.name} ${log.bytes}/${report.maximumBytes} bytes`);
  }
  if (!report.pass) {
    console.error("EventLoom retention HOLD: pause writers and follow docs/eventloom-retention.md; this audit never mutates authority logs.");
    process.exitCode = 1;
  }
}
