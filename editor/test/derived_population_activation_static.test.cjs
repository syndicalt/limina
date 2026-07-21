// LIMITATION (known, accepted): this is a SOURCE-TEXT wiring test — it asserts exact
// code fragments in the module's source instead of executing it (execution needs a
// real DOM/WebGPU browser realm; the behavioral twins are the *_browser.test.cjs
// suites, which need chromium). It can FAIL on a harmless rename and stay GREEN
// through a logic inversion the grepped fragments survive. A green here is a wiring
// check, never a behavioral verdict.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const browserEntry = fs.readFileSync(path.join(__dirname, "../../js/src/browser-entry.ts"), "utf8");
const transport = fs.readFileSync(path.join(__dirname, "../../js/src/browser/derived-runtime-transport.ts"), "utf8");
const populationMount = fs.readFileSync(path.join(__dirname, "../../js/src/browser/derived-biome-population-mount.ts"), "utf8");

function functionBody(source, name) {
  const signature = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*(?::[^\\{]+)?\\{`, "m");
  const match = signature.exec(source);
  assert.ok(match, `missing ${name}`);
  const start = match.index + match[0].lastIndexOf("{");
  let depth = 0;
  for (let index = start; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0) return source.slice(start + 1, index);
  }
  assert.fail(`unterminated ${name}`);
}

function ordered(source, fragments, label) {
  let cursor = -1;
  for (const fragment of fragments) {
    const next = source.indexOf(fragment, cursor + 1);
    assert.ok(next > cursor, `${label}: '${fragment}' is missing or out of order`);
    cursor = next;
  }
}

function between(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `missing ${label}`);
  return source.slice(start, end);
}

test("main-realm content fetch is authenticated, manifest-bound, length-bound, and portable-hash verified", () => {
  const fetchContent = between(transport, "  async fetchContent(", "  async #request(", "fetchContent");
  ordered(fetchContent, [
    "/v1/derived/manifests/${manifestHash.slice(7)}/content/${contentHash.slice(7)}",
    'exactHeader(response.headers, "etag"',
    'exactHeader(response.headers, "x-limina-content-hash"',
    'exactHeader(response.headers, "x-limina-manifest-hash"',
    'exactHeader(response.headers, "content-type", "application/octet-stream"',
    "parseLength(response.headers",
    "readBounded(",
    "portableAssetContentHash(bytes)",
  ], "content verification");
  assert.match(transport, /Authorization: `Bearer \$\{this\.#config\.token\}`/);
});

test("population activation fetches a bounded closure subset and cannot fall back to the live asset root", () => {
  const mount = between(populationMount, "export async function mountDerivedBiomePopulation(", "/** Production adapter", "mountDerivedBiomePopulation");
  const transportMount = between(populationMount, "export async function mountTransportDerivedBiomePopulation(", "\n}", "mountTransportDerivedBiomePopulation");
  assert.match(populationMount, /const DERIVED_CONTENT_FETCH_CONCURRENCY = 4/);
  const bounded = between(populationMount, "async function boundedMap<", "function closureEntry(", "boundedMap");
  assert.match(bounded, /const controller = new AbortController\(\)/);
  assert.match(bounded, /controller\.abort\(error\)/);
  assert.match(bounded, /await Promise\.allSettled\(workers\)/);
  assert.match(mount, /entry\.kind !== "population-descriptor"/);
  assert.ok(mount.match(/input\.loadContent\(/g)?.length === 2,
    "descriptor and referenced-leaf fetch stages must remain independently bounded through the injected loader");
  assert.match(transportMount, /transport\.fetchContent\(input\.manifestHash/,
    "production adapter no longer uses authenticated manifest-scoped transport");
  ordered(mount, [
    "const fetchedDescriptors = await boundedMap(",
    "parseBiomePopulationAsset(",
    "const fetchedLeaves = await boundedMap(",
    "const packageOps: EngineOps",
    "derived package registry has no closure-authorized asset",
    "AssetRegistry.fromBundle(",
    "input.gltfCache.prewarmActiveWorld(",
    "visualPackages.register(INTERACTIVE_TEMPERATE_MEADOW_PACKAGE)",
    "visualPackages.register(RIPARIAN_REED_GRASS_PACKAGE)",
    "BiomePopulationMount.create(",
  ], "population content activation");
  assert.doesNotMatch(populationMount, /fetch\(["'`]\/assets\//,
    "derived population activation regained a live asset-root fetch fallback");
  assert.match(mount, /tree\.sourceAssetId, tree\.sourceContentHash, "model-source"/);
  assert.match(mount, /tree\.reducedAssetId, tree\.reducedContentHash, "model-lod"/);
  assert.match(mount, /tree\.impostorAssetId, tree\.impostorContentHash, "impostor"/);
  assert.match(mount, /instanced\.assetId, instanced\.contentHash, "model-source"/);
});

test("verified population staging precedes simulation staging, scene attach, and commit", () => {
  const activationStart = browserEntry.indexOf("const activateDerivedRevision = (");
  const activationEnd = browserEntry.indexOf("const runningLive: RunningLive", activationStart);
  assert.ok(activationStart >= 0 && activationEnd > activationStart, "missing derived activation body");
  const activation = browserEntry.slice(activationStart, activationEnd);
  ordered(activation, [
    "derivedActivationInProgress = true",
    "await DetachedDerivedRenderCandidate.createWithFrameBudget(verifiedSnapshot",
    "await candidate.stagePopulation(",
    'requestDerivedWorker("stageDerivedRevision"',
    "scene.add(candidate.root)",
    'requestDerivedWorker("commitDerivedRevision"',
  ], "atomic derived activation");
  assert.match(activation, /populationPlan !== null[\s\S]*contentAccess === undefined[\s\S]*requires authenticated main-realm content access/);
  // Construction can fail before a candidate exists (the factory disposes its own
  // partial mount); cleanup must therefore guard on builtCandidate.
  assert.match(activation, /if \(builtCandidate !== undefined\) disposeDerivedCandidate\(builtCandidate, "derived candidate cleanup failed"\)/);
  ordered(activation, [
    "derivedActivationInProgress = true",
    "await DetachedDerivedRenderCandidate.createWithFrameBudget(verifiedSnapshot",
    "await candidate.stagePopulation(",
    "catch (error)",
    'disposeDerivedCandidate(builtCandidate, "derived candidate cleanup failed")',
    "finally {",
    "derivedActivationInProgress = false",
  ], "population staging rollback");
  assert.match(activation, /finally \{[\s\S]*derivedActivationInProgress = false/,
    "render gate is not reset through the activation finally path");
});
