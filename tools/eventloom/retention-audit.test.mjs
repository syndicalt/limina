import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { auditEventloomRetention } from "./retention-audit.mjs";

test("EventLoom retention audit is read-only, deterministic, and holds at the configured boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "limina-eventloom-retention-"));
  try {
    await writeFile(join(directory, "small.jsonl"), "1234");
    await writeFile(join(directory, "boundary.jsonl"), "12345");
    await writeFile(join(directory, "ignored.txt"), "x".repeat(100));
    const report = await auditEventloomRetention(directory, 5);
    assert.equal(report.pass, false);
    assert.deepEqual(report.logs, [
      { name: "boundary.jsonl", bytes: 5, overLimit: true },
      { name: "small.jsonl", bytes: 4, overLimit: false },
    ]);
    assert.equal(await readFile(join(directory, "boundary.jsonl"), "utf8"), "12345");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
