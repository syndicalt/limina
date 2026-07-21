import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { symlink, utimes, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import {
  createReviewServer,
  listenReviewServer,
  listReviewArtifacts,
  stageReviewArtifact,
} from "./dgx-spark-review-bridge.mjs";

function png(width, height, marker = 0) {
  const bytes = Buffer.alloc(25);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = marker;
  return bytes;
}

async function http(address, path, { method = "GET", host = `127.0.0.1:${address.port}` } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = request({ hostname: "127.0.0.1", port: address.port, path, method, headers: { Host: host }, agent: false }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "limina-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("stages PNG bytes idempotently and reports dimensions and hash", async (t) => {
  const root = await fixture(t);
  const source = join(root, "source.png");
  const artifactDirectory = join(root, "artifacts");
  const bytes = png(1921, 1081, 7);
  await writeFile(source, bytes);
  const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
  const first = await stageReviewArtifact({ source, artifactDirectory, name: "checkpoint.png", expectedSha256, expectedWidth: 1921, expectedHeight: 1081 });
  const second = await stageReviewArtifact({ source, artifactDirectory, name: "checkpoint.png", expectedSha256 });
  assert.equal(first.staged, true);
  assert.equal(second.staged, false);
  assert.equal(first.sha256, expectedSha256);
  assert.deepEqual([first.width, first.height], [1921, 1081]);
});

test("gallery metadata is newest-first with deterministic filename ties", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "a.png"), png(10, 20, 1));
  await writeFile(join(root, "b.png"), png(30, 40, 2));
  await writeFile(join(root, "new.png"), png(50, 60, 3));
  await utimes(join(root, "a.png"), new Date(1_000), new Date(1_000));
  await utimes(join(root, "b.png"), new Date(1_000), new Date(1_000));
  await utimes(join(root, "new.png"), new Date(2_000), new Date(2_000));
  const artifacts = await listReviewArtifacts(root);
  assert.deepEqual(artifacts.map(({ name }) => name), ["new.png", "a.png", "b.png"]);
  assert.deepEqual([artifacts[0].width, artifacts[0].height], [50, 60]);
});

test("server is loopback-only and exposes only regular PNG artifacts", async (t) => {
  const root = await fixture(t);
  const outside = join(root, "..", `secret-${process.pid}.png`);
  await writeFile(join(root, "safe.png"), png(12, 34, 4));
  await writeFile(join(root, "note.txt"), Buffer.from("secret"));
  await writeFile(outside, png(1, 1, 9));
  await symlink(outside, join(root, "linked.png"));
  t.after(() => rm(outside, { force: true }));
  const server = createReviewServer({ artifactDirectory: root });
  const address = await listenReviewServer(server, 0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  assert.equal(address.address, "127.0.0.1");

  const manifest = await http(address, "/manifest.json");
  assert.equal(manifest.status, 200);
  assert.deepEqual(JSON.parse(manifest.body), [{
    filename: "safe.png",
    modifiedAt: JSON.parse(manifest.body)[0].modifiedAt,
    width: 12,
    height: 34,
    byteLength: 25,
    sha256: createHash("sha256").update(png(12, 34, 4)).digest("hex"),
    reviewStatus: "review required",
  }]);
  assert.match(manifest.headers["content-security-policy"], /default-src 'none'/);
  assert.equal((await http(address, "/artifacts/safe.png")).status, 200);
  assert.equal((await http(address, "/artifacts/linked.png")).status, 404);
  assert.equal((await http(address, "/artifacts/note.txt")).status, 404);
  assert.equal((await http(address, "/artifacts/%2e%2e%2fsecret.png")).status, 404);
  assert.equal((await http(address, "/.env")).status, 404);
  assert.equal((await http(address, "/traces/example.jsonl")).status, 404);
  assert.equal((await http(address, "/", { method: "POST" })).status, 405);
  assert.equal((await http(address, "/", { host: `evil.example:${address.port}` })).status, 421);
  const head = await http(address, "/artifacts/safe.png", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body.byteLength, 0);
  assert.equal(Number(head.headers["content-length"]), 25);
});

test("gallery escapes an adversarial PNG filename", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "<img onerror=alert(1)>.png"), png(2, 3));
  const server = createReviewServer({ artifactDirectory: root });
  const address = await listenReviewServer(server, 0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const gallery = (await http(address, "/")).body.toString("utf8");
  assert.doesNotMatch(gallery, /<img onerror=alert\(1\)>\.png/);
  assert.match(gallery, /&lt;img onerror=alert\(1\)&gt;\.png/);
  assert.match(gallery, /%3Cimg%20onerror%3Dalert\(1\)%3E\.png/);
});
