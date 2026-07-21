// Static import-graph purity for the derived verifier (H8, PR C1). The verify module
// must load in a dedicated Worker realm, so its TRANSITIVE import graph must pull no
// `three` (the render bundle) and no DOM surface. This is a source-text check (the
// limina host has no filesystem read op, so it cannot run inside the p99 gate); the
// behavioral twin — verify/reject parity across venues — is js/test/
// p99_derived_verify_worker.ts. The checker proves its own falsifiability below by
// flagging the render candidate module, which legitimately imports three.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const SRC_ROOT = path.join(__dirname, "../src");

function importSpecifiers(source) {
  const specifiers = [];
  const pattern = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    specifiers.push(match[1] ?? match[2] ?? match[3]);
  }
  return specifiers;
}

/** Walk the transitive relative import graph; returns { files, external } where
 *  `external` collects every non-relative specifier encountered anywhere. */
function walkImportGraph(entryFile) {
  const files = new Set();
  const external = new Set();
  const queue = [path.resolve(entryFile)];
  while (queue.length > 0) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    // Generated bundles are terminal: they are themselves a violation (matched by the
    // /build/ fragment below), and scanning megabytes of bundled output for import
    // syntax inside string literals would only produce unresolvable noise.
    if (file.includes(`${path.sep}build${path.sep}`)) continue;
    const source = fs.readFileSync(file, "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (specifier.startsWith(".")) {
        const resolved = path.resolve(path.dirname(file), specifier);
        assert.ok(fs.existsSync(resolved), `unresolvable import ${specifier} from ${file}`);
        queue.push(resolved);
      } else {
        external.add(specifier);
      }
    }
  }
  return { files, external };
}

const FORBIDDEN_PATH_FRAGMENTS = [
  `${path.sep}build${path.sep}`, // js/build/*.bundle.mjs (three, zod)
  `${path.sep}render${path.sep}`, // the three-importing render layer
];
// Word-boundary DOM globals in property-access position, matched against comment-
// stripped source so identifiers like `terrainWindow` and prose ("the keep window.")
// do not false-positive.
const DOM_PATTERN = /(?<![\w$.])(?:document|window)\s*[.[]|\bHTMLCanvasElement\b|\bOffscreenCanvas\b|\brequestAnimationFrame\b/;

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/[^\n]*/g, "$1");
}

function violations(entryFile) {
  const graph = walkImportGraph(entryFile);
  const found = [];
  for (const specifier of graph.external) {
    if (/three/.test(specifier)) found.push(`external specifier ${specifier}`);
  }
  for (const file of graph.files) {
    for (const fragment of FORBIDDEN_PATH_FRAGMENTS) {
      if (file.includes(fragment)) found.push(`forbidden module ${path.relative(SRC_ROOT, file)}`);
    }
    if (file.includes(`${path.sep}build${path.sep}`)) continue;
    if (/three\.bundle/.test(fs.readFileSync(file, "utf8").split("\n").filter((line) => /^\s*(?:import|export)\s/.test(line)).join("\n"))) {
      found.push(`three bundle import in ${path.relative(SRC_ROOT, file)}`);
    }
  }
  return { graph, found };
}

test("verify module import graph pulls no three and no render-layer module", () => {
  const { graph, found } = violations(path.join(SRC_ROOT, "browser/derived-runtime-verify.ts"));
  assert.deepEqual(found, [], `worker-realm purity violated: ${found.join(", ")}`);
  assert.ok(graph.files.size > 5, "walker did not traverse the transitive graph");
});

test("verify worker entry import graph is equally pure", () => {
  const { found } = violations(path.join(SRC_ROOT, "browser/derived-verify-worker-entry.ts"));
  assert.deepEqual(found, [], `worker entry purity violated: ${found.join(", ")}`);
});

test("verify graph sources use no DOM surface", () => {
  const graph = walkImportGraph(path.join(SRC_ROOT, "browser/derived-verify-worker-entry.ts"));
  for (const file of graph.files) {
    const source = stripComments(fs.readFileSync(file, "utf8"));
    assert.ok(!DOM_PATTERN.test(source), `DOM usage in worker-realm module ${path.relative(SRC_ROOT, file)}`);
  }
});

test("falsifiability: the checker flags the three-importing render candidate", () => {
  const { found } = violations(path.join(SRC_ROOT, "browser/derived-runtime-render-candidate.ts"));
  assert.ok(found.length > 0, "checker failed to detect a known three import — it proves nothing");
});

test("mounting no longer verifies: the candidate constructor asserts the brand", () => {
  const source = fs.readFileSync(path.join(SRC_ROOT, "browser/derived-runtime-render-candidate.ts"), "utf8");
  assert.match(source, /this\.#snapshot = assertVerifiedTransferredDerivedSnapshot\(snapshotInput\);/);
  assert.ok(!/function parseTransferredDerivedRuntimeSnapshot\(/.test(source),
    "a second verifier body exists in the render candidate — validation logic forked");
});
