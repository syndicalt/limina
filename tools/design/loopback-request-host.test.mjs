import assert from "node:assert/strict";
import test from "node:test";

import { isAllowedLoopbackRequestHost } from "./loopback-request-host.mjs";

test("design request Host admission accepts only the exact loopback endpoint", () => {
  assert.equal(isAllowedLoopbackRequestHost("localhost:4321", 4321), true);
  assert.equal(isAllowedLoopbackRequestHost("127.0.0.1:4321", 4321), true);

  for (const hostile of [
    undefined,
    "localhost",
    "localhost:4322",
    "127.0.0.1",
    "127.0.0.1:4322",
    "evil.example:4321",
    "evil.example:4321@localhost:4321",
    "localhost:4321.evil.example",
    "[::1]:4321",
    "localhost:4321/path",
    "localhost:4321?x=y",
    "localhost:4321#fragment",
    "localhost:4321, evil.example",
  ]) {
    assert.equal(isAllowedLoopbackRequestHost(hostile, 4321), false, String(hostile));
  }
});
