import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
const path = process.argv[2];
if (!path) throw new Error("usage: node tools/reference/visual-reference-board-static.test.mjs <board.json>");
const board = JSON.parse(fs.readFileSync(path));
assert.equal(board.schema, "limina.visual-reference-board/v1");
assert.ok(board.sources.length >= 3);
for (const source of board.sources) {
  assert.match(source.sourceUrl, /^https:/);
  assert.notEqual(source.license, "unknown");
  const bytes = fs.readFileSync(source.localPath);
  assert.equal(source.sha256, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
  assert.equal(source.bytes, bytes.length);
  assert.ok(source.roles.length > 0);
}
console.log(`visual-reference-board OK: ${board.id}, ${board.sources.length} pinned licensed sources`);
