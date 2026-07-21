import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateVisualDesignContract } from "../../js/src/architecture/visual-design-contract.ts";
import {
  collect,
  literalValue,
  objectProperty,
  parseTypeScript,
  propertyInitializer,
  propertyPath,
  ts,
  unwrapExpression,
} from "../architecture/test-source-semantics.mjs";

const root = new URL("../../", import.meta.url);
const read = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));
const sha256 = async (path) =>
  `sha256:${createHash("sha256")
    .update(await readFile(new URL(path, root)))
    .digest("hex")}`;
const acquisitionPath = "art-direction/furniture/hearth-settle-bounded-reference-acquisition.json";
const boardPath = "art-direction/furniture/hearth-settle-bounded-reference-board.json";
const designPath = "art-direction/furniture/hearth-settle-v3-visual-design.json";
const legacyAcquisitionPath = "art-direction/furniture/hearth-settle-reference-acquisition.json";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function newMap(expression) {
  const current = expression && unwrapExpression(expression);
  return current && ts.isNewExpression(current) && propertyPath(current.expression) === "Map" ? current : undefined;
}

function rangeHeaderInitializer(file) {
  const fetchCalls = collect(file, (node) => ts.isCallExpression(node) && propertyPath(node.expression) === "fetch");
  invariant(fetchCalls.length === 1, "reference acquisition must have exactly one fetch call");
  const [fetchCall] = fetchCalls;
  invariant(propertyPath(fetchCall.arguments[0]) === "source.imageUrl", "fetch must request the manifest image URL");
  const options = unwrapExpression(fetchCall.arguments[1]);
  invariant(options && ts.isObjectLiteralExpression(options), "fetch must use an explicit options object");
  invariant(
    literalValue(propertyInitializer(objectProperty(options, "redirect"))) === "follow",
    "fetch must preserve redirect-follow policy",
  );
  const headers = unwrapExpression(propertyInitializer(objectProperty(options, "headers")));
  invariant(headers && ts.isObjectLiteralExpression(headers), "fetch must use explicit request headers");
  invariant(
    literalValue(propertyInitializer(objectProperty(headers, "user-agent"))) === "Limina reference acquisition/1.0",
    "fetch must preserve the bounded acquisition user agent",
  );
  const range = propertyInitializer(objectProperty(headers, "range"));
  invariant(literalValue(range) === "bytes=0-", "fetch must request original bytes with Range: bytes=0-");
  return range;
}

function assertStableRetrievalAuthority(file) {
  const declarations = collect(
    file,
    (node) => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "previousSources",
  );
  invariant(declarations.length === 1, "previousSources must have one declaration");
  const initialMap = newMap(declarations[0].initializer);
  invariant(initialMap && (initialMap.arguments?.length ?? 0) === 0, "previousSources must start as an empty Map");

  const assignments = collect(file, (node) => {
    if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
    return propertyPath(node.left) === "previousSources" && newMap(node.right) !== undefined;
  });
  invariant(assignments.length === 1, "persisted sources must reconstruct previousSources as a Map");

  const timestampAssignments = collect(file, (node) => {
    if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
    return propertyPath(node.left) === "record.retrievedAt" && propertyPath(node.right) === "previous.retrievedAt";
  });
  invariant(timestampAssignments.length === 1, "byte-stable retrievals must preserve the previous retrievedAt value");
  let timestampIf = timestampAssignments[0].parent;
  while (timestampIf && !ts.isIfStatement(timestampIf) && !ts.isSourceFile(timestampIf))
    timestampIf = timestampIf.parent;
  invariant(timestampIf && ts.isIfStatement(timestampIf), "retrievedAt reuse must remain guarded by an if statement");
  invariant(
    collect(timestampIf.thenStatement, (node) => node === timestampAssignments[0]).length === 1,
    "retrievedAt reuse must occur in the stable-source guard body",
  );
  const guardPaths = new Set(
    collect(timestampIf.expression, (node) => ts.isExpression(node) && propertyPath(node) !== undefined).map((node) =>
      propertyPath(node),
    ),
  );
  invariant(
    guardPaths.has("stable.every") && guardPaths.has("Number.isFinite") && guardPaths.has("Date.parse"),
    "retrievedAt reuse must remain guarded by stable-field equality and a finite prior timestamp",
  );
}

function assertReferenceAcquisitionPolicy(source) {
  const file = parseTypeScript(source, "acquire-visual-reference-board.mjs");
  rangeHeaderInitializer(file);
  assertStableRetrievalAuthority(file);
}

test("bounded v3 is append-only and preserves every legacy hearth-settle authority byte", async () => {
  assert.equal(
    await sha256(legacyAcquisitionPath),
    "sha256:d33c7b2194b0a48ae25951415c01162e463eed598d208b73c57d1bdc0a67ab71",
  );
  assert.equal(
    await sha256("art-direction/furniture/hearth-settle-reference-board.json"),
    "sha256:b96358f6c0b3e6b3227f8f53d117cb0b8d36ef205317da10e1bdc983897ed090",
  );
  assert.equal(
    await sha256("art-direction/furniture/hearth-settle-visual-design.json"),
    "sha256:e995171f25df06a25946751d04ec8a207a4f982037f6a363923f2ca412e7b0ef",
  );
  assert.equal(
    await sha256("art-direction/furniture/hearth-settle-v2-visual-design.json"),
    "sha256:2cf7ea37ce8f466f56ea3671683e78e240375dd1b8f9e14acdd6a26b459f11ac",
  );
  const legacy = await read(legacyAcquisitionPath),
    bounded = await read(acquisitionPath);
  assert.equal(bounded.id, "furniture/hearth-settle/v3");
  assert.deepEqual(bounded.sources.slice(0, 3), legacy.sources, "the three legacy acquisition records drifted");
});

test("reference acquisition requests original bytes and preserves stable retrieval authority", async () => {
  const source = await readFile(new URL("tools/reference/acquire-visual-reference-board.mjs", root), "utf8");
  assert.doesNotThrow(() => assertReferenceAcquisitionPolicy(source));
});

test("reference acquisition policy check rejects semantic Range drift", async () => {
  const source = await readFile(new URL("tools/reference/acquire-visual-reference-board.mjs", root), "utf8"),
    file = parseTypeScript(source, "acquire-visual-reference-board.mjs"),
    range = rangeHeaderInitializer(file),
    mutated = `${source.slice(0, range.getStart(file))}"bytes=1-"${source.slice(range.end)}`;
  assert.throws(
    () => assertReferenceAcquisitionPolicy(mutated),
    /fetch must request original bytes with Range: bytes=0-/,
  );
});

test("bounded board pins both official Met 7390 Open Access views", async () => {
  const acquisition = await read(acquisitionPath),
    board = await read(boardPath),
    legacyBoard = await read("art-direction/furniture/hearth-settle-reference-board.json");
  assert.equal(board.id, "furniture/hearth-settle/v3");
  assert.equal(board.acquisitionManifest, acquisitionPath);
  assert.deepEqual(
    board.sources.map(({ id }) => id),
    [
      "commons/oak-settle-17c",
      "met/bench-chest-467989",
      "met/high-backed-chair-471833",
      "met/leather-settle-7390-primary",
      "met/leather-settle-7390-alternate",
    ],
  );
  assert.deepEqual(board.sources.slice(0, 3), legacyBoard.sources, "the three legacy pinned source records drifted");
  for (const source of board.sources) {
    const manifestSource = acquisition.sources.find(({ id }) => id === source.id);
    assert.ok(manifestSource, `${source.id} is absent from acquisition authority`);
    for (const field of ["sourceUrl", "imageUrl", "creator", "license", "roles"])
      assert.deepEqual(source[field], manifestSource[field], `${source.id}.${field} drifted during acquisition`);
    assert.equal(source.sha256, await sha256(source.localPath));
  }
  const met7390 = board.sources.slice(3);
  assert.ok(
    met7390.every(
      ({ sourceUrl, license }) =>
        sourceUrl === "https://www.metmuseum.org/art/collection/search/7390" &&
        license === "Public Domain / The Met Open Access",
    ),
  );
  assert.deepEqual(
    met7390.map(({ imageUrl }) => imageUrl),
    [
      "https://images.metmuseum.org/CRDImages/ad/original/85D_ACF143R7.jpg",
      "https://images.metmuseum.org/CRDImages/ad/original/134079.jpg",
    ],
  );
});

test("v3 visual authority locks the exact I1 r3 envelope and audited cue floor", async () => {
  const board = await read(boardPath),
    visual = validateVisualDesignContract(await read(designPath));
  assert.equal(visual.id, "furniture/hearth-settle/v3");
  assert.deepEqual(
    visual.references.map(({ id }) => id),
    board.sources.map(({ id }) => id),
  );
  for (const reference of visual.references) {
    const source = board.sources.find(({ id }) => id === reference.id);
    for (const field of ["sourceUrl", "creator", "license", "retrievedAt", "localPath", "sha256"])
      assert.deepEqual(reference[field], source[field], `${reference.id}.${field} is not pinned to the board`);
    if (reference.id !== "met/high-backed-chair-471833")
      assert.deepEqual(reference.roles, source.roles, `${reference.id}.roles is not pinned to the board`);
  }
  assert.deepEqual(visual.references.find(({ id }) => id === "met/high-backed-chair-471833").roles, [
    "anti-cue",
    "silhouette",
  ]);
  assert.deepEqual(visual.references.find(({ id }) => id === "met/leather-settle-7390-primary").roles, [
    "silhouette",
    "construction",
    "function",
  ]);
  const cues = new Map(
    visual.cues.map((cue) => [cue.id, new Map(cue.measurements.map((measurement) => [measurement.name, measurement]))]),
  );
  assert.deepEqual(cues.get("locked-i1-r3-envelope-and-axis").get("overall-width"), {
    name: "overall-width",
    unit: "m",
    target: 1.6,
    maximum: 1.6,
  });
  assert.deepEqual(cues.get("locked-i1-r3-envelope-and-axis").get("overall-height"), {
    name: "overall-height",
    unit: "m",
    target: 1.3,
    maximum: 1.3,
  });
  assert.deepEqual(cues.get("locked-i1-r3-envelope-and-axis").get("overall-depth"), {
    name: "overall-depth",
    unit: "m",
    target: 0.7,
    maximum: 0.7,
  });
  assert.deepEqual(cues.get("dimensioned-continuous-two-adult-seat").get("usable-seat-width"), {
    name: "usable-seat-width",
    unit: "m",
    minimum: 1.28,
    target: 1.33,
    maximum: 1.38,
  });
  assert.equal(cues.get("dimensioned-continuous-two-adult-seat").get("seat-top-height").target, 0.46);
  assert.equal(cues.get("dimensioned-continuous-two-adult-seat").get("physical-seat-depth").target, 0.5);
  assert.equal(cues.get("four-post-complete-load-frame").get("grounded-post-count").target, 4);
  assert.equal(cues.get("four-post-complete-load-frame").get("post-center-absolute-x").target, 0.73);
  assert.deepEqual(cues.get("supported-arms").get("arm-top-height"), {
    name: "arm-top-height",
    unit: "m",
    minimum: 0.68,
    target: 0.69,
    maximum: 0.7,
  });
  assert.equal(cues.get("separate-coherent-upper-back").get("upper-back-rake").target, 4);
  assert.equal(cues.get("four-inset-fielded-panels-and-simple-crest").get("back-panel-count").target, 4);
  assert.equal(cues.get("four-inset-fielded-panels-and-simple-crest").get("canopy-count").target, 0);
  assert.equal(cues.get("restrained-three-role-oak").get("material-role-count").target, 3);
  assert.equal(cues.get("exact-two-seat-function-and-compound-collision").get("occupancy-socket-count").target, 2);
  assert.equal(cues.get("exact-two-seat-function-and-compound-collision").get("approach-socket-count").target, 1);
  assert.ok(visual.avoid.includes("canopy or towering crest"));
  assert.ok(visual.avoid.includes("chest or false storage volume"));
  assert.ok(visual.avoid.includes("leather or upholstered surfaces"));
});
