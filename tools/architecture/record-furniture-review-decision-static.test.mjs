import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./record-furniture-review-decision.mjs", import.meta.url), "utf8");
assert.match(source, /all\("--dependency"\)/);
assert.match(source, /\[\.\.\.dependencies,candidate\]/);
assert.match(source, /flag:"wx"/);
console.log("furniture decision recorder requires exact dependency closure and append-only output");
