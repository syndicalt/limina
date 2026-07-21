import assert from "node:assert/strict";
import test from "node:test";
import { BoundedByteTail } from "./bounded-byte-tail.mjs";

test("retains exactly the newest bounded subprocess bytes", () => {
  const tail = new BoundedByteTail(8);
  tail.append(Buffer.from("abc"));
  tail.append(Buffer.from("defgh"));
  assert.equal(tail.toString(), "abcdefgh");
  tail.append(Buffer.from("ijk"));
  assert.equal(tail.toString(), "defghijk");
  assert.equal(tail.byteLength, 8);
  tail.append(Buffer.from("0123456789"));
  assert.equal(tail.toString(), "23456789");
  assert.equal(tail.byteLength, 8);
});

test("rejects invalid limits", () => {
  assert.throws(() => new BoundedByteTail(0), /positive safe integer/);
});
