// LIMITATION (known, accepted): this is a SOURCE-TEXT wiring test rather than a
// browser execution test. Legacy checks below remain formatting-sensitive; the CAS
// publication and standalone-relay checks use falsifiable AST semantics. A green
// result here is only supplemental to the mandatory *_browser.test.cjs authorities.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  collect,
  findCalls,
  findPropertyAssignments,
  findVariable,
  literalValue,
  objectProperty,
  parseTypeScript,
  propertyInitializer,
  propertyPath,
  ts,
  unwrapExpression,
} from "../../tools/architecture/test-source-semantics.mjs";

const [html, css, viewport, map, app, net, util, atlasHtml, relay, editorApp, serve, launcher] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../styles.css", import.meta.url), "utf8"),
  readFile(new URL("../src/viewport.js", import.meta.url), "utf8"),
  readFile(new URL("../../tools/design/frontend/map.js", import.meta.url), "utf8"),
  readFile(new URL("../../tools/design/frontend/app.js", import.meta.url), "utf8"),
  readFile(new URL("../../tools/design/frontend/net.js", import.meta.url), "utf8"),
  readFile(new URL("../../tools/design/frontend/util.js", import.meta.url), "utf8"),
  readFile(new URL("../../tools/design/frontend/index.html", import.meta.url), "utf8"),
  readFile(new URL("../src/atlas-handoff-relay.js", import.meta.url), "utf8"),
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../../tools/scaffold/scripts/serve.mjs", import.meta.url), "utf8"),
  readFile(new URL("../../tools/scaffold/scripts/editor.mjs", import.meta.url), "utf8"),
]);

const semanticSources = Object.freeze({
  map: parseTypeScript(map, "tools/design/frontend/map.js"),
  relay: parseTypeScript(relay, "editor/src/atlas-handoff-relay.js"),
  editorApp: parseTypeScript(editorApp, "editor/src/app.js"),
  viewport: parseTypeScript(viewport, "editor/src/viewport.js"),
  net: parseTypeScript(net, "tools/design/frontend/net.js"),
  serve: parseTypeScript(serve, "tools/scaffold/scripts/serve.mjs"),
  launcher: parseTypeScript(launcher, "tools/scaffold/scripts/editor.mjs"),
});

function htmlIdCount(source, expectedId) {
  let count = 0;
  for (const match of source.matchAll(/\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    if ((match[1] ?? match[2]) === expectedId) count++;
  }
  return count;
}

function statementReturns(statement) {
  return collect(statement, (node) => ts.isReturnStatement(node)).length > 0;
}

function logicalOrOperands(expression) {
  const value = unwrapExpression(expression);
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return [...logicalOrOperands(value.left), ...logicalOrOperands(value.right)];
  }
  return [value];
}

function comparisonExists(node, leftPath, operator, rightPath) {
  return (
    collect(node, (candidate) => {
      if (!ts.isBinaryExpression(candidate)) return false;
      return (
        propertyPath(candidate.left) === leftPath &&
        candidate.operatorToken.kind === operator &&
        propertyPath(candidate.right) === rightPath
      );
    }).length > 0
  );
}

function assertGuardedComparisons(file, comparisons, label) {
  const guards = collect(file, (node) => {
    if (!ts.isIfStatement(node) || !statementReturns(node.thenStatement)) return false;
    const operands = logicalOrOperands(node.expression);
    return comparisons.every(([left, operator, right]) =>
      operands.some(
        (operand) =>
          ts.isBinaryExpression(operand) &&
          propertyPath(operand.left) === left &&
          operand.operatorToken.kind === operator &&
          propertyPath(operand.right) === right,
      ),
    );
  });
  assert.ok(guards.length > 0, label);
}

function isExactCall(expression, calleePath, expectedArguments = []) {
  const value = unwrapExpression(expression);
  if (!ts.isCallExpression(value) || propertyPath(value.expression) !== calleePath) return false;
  if (value.arguments.length !== expectedArguments.length) return false;
  return expectedArguments.every((expected, index) => {
    const argument = value.arguments[index];
    return expected.kind === "path"
      ? propertyPath(argument) === expected.value
      : literalValue(argument) === expected.value;
  });
}

function assertExactCall(file, calleePath, expectedArguments, label) {
  const calls = findCalls(file, calleePath).filter((call) => isExactCall(call, calleePath, expectedArguments));
  assert.ok(calls.length > 0, label);
}

function assertStandalonePopupOpen(source, fileName = "standalone-popup.js") {
  const file = parseTypeScript(source, fileName);
  const calls = findCalls(file, "window.open");
  assert.equal(calls.length, 1, "standalone launch must create exactly one popup");
  assert.equal(calls[0].arguments.length, 2, "popup launch must provide a URL and browsing-context target");
  assert.equal(literalValue(calls[0].arguments[0]), "about:blank", "popup must begin on an inert same-origin document");
  assert.equal(literalValue(calls[0].arguments[1]), "_blank", "popup must use a new browsing context");
}

function assertActiveMapFallback(file) {
  const matches = collect(file, (node) => {
    if (!ts.isIfStatement(node) || !ts.isPrefixUnaryExpression(node.expression)) return false;
    if (
      node.expression.operator !== ts.SyntaxKind.ExclamationToken ||
      propertyPath(node.expression.operand) !== "activeMapId"
    ) {
      return false;
    }
    return (
      collect(node.thenStatement, (candidate) => {
        if (!ts.isBinaryExpression(candidate) || candidate.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
          return false;
        if (propertyPath(candidate.left) !== "activeMapId") return false;
        const value = unwrapExpression(candidate.right);
        return (
          ts.isBinaryExpression(value) &&
          value.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
          propertyPath(value.left) === "S.state.activeMapId" &&
          isExactCall(value.right, "primaryMapId")
        );
      }).length > 0
    );
  });
  assert.ok(matches.length > 0, "standalone focus must recover the active map before building the handoff");
}

function assertSaveAndLaunchCoordination(file) {
  const matches = findCalls(file, "Promise.all").filter((call) => {
    if (call.arguments.length !== 1 || !ts.isArrayLiteralExpression(unwrapExpression(call.arguments[0]))) return false;
    const elements = unwrapExpression(call.arguments[0]).elements;
    if (elements.length !== 2 || !isExactCall(elements[0], "flushMapSave")) return false;
    const launch = unwrapExpression(elements[1]);
    return (
      ts.isConditionalExpression(launch) &&
      propertyPath(launch.condition) === "standalone" &&
      isExactCall(launch.whenTrue, "getEditorLaunchConfig") &&
      isExactCall(launch.whenFalse, "Promise.resolve", [{ kind: "path", value: "undefined" }])
    );
  });
  assert.ok(matches.length > 0, "the authoritative save and standalone launch lookup must settle together");
}

function assertImportBinding(file, moduleName, binding) {
  const imports = collect(file, (node) => {
    if (!ts.isImportDeclaration(node) || literalValue(node.moduleSpecifier) !== moduleName) return false;
    const bindings = node.importClause?.namedBindings;
    return ts.isNamedImports(bindings) && bindings.elements.some((element) => element.name.text === binding);
  });
  assert.ok(imports.length > 0, `${binding} must be imported from ${moduleName}`);
}

function assertFalseObjectArgument(file, calleePath, propertyName) {
  const calls = findCalls(file, calleePath).filter((call) => {
    if (call.arguments.length !== 2 || propertyPath(call.arguments[0]) !== "focus") return false;
    const options = unwrapExpression(call.arguments[1]);
    const property = objectProperty(options, propertyName);
    return property !== undefined && literalValue(propertyInitializer(property)) === false;
  });
  assert.ok(calls.length > 0, `${calleePath} must explicitly set ${propertyName} to false`);
}

function assertHandoffHeaders(file) {
  const declarations = findVariable(file, "handoffHeaders").filter((declaration) => {
    const value = declaration.initializer && unwrapExpression(declaration.initializer);
    if (!value || !ts.isObjectLiteralExpression(value)) return false;
    const cache = objectProperty(value, "cache-control");
    const referrer = objectProperty(value, "referrer-policy");
    return (
      cache !== undefined &&
      referrer !== undefined &&
      literalValue(propertyInitializer(cache)) === "no-store" &&
      literalValue(propertyInitializer(referrer)) === "no-referrer"
    );
  });
  assert.ok(declarations.length > 0, "handoff responses must suppress caching and referrer disclosure");
}

function templateShape(expression) {
  const value = unwrapExpression(expression);
  if (!ts.isTemplateExpression(value)) return undefined;
  return {
    head: value.head.text,
    spans: value.templateSpans.map((span) => ({ expression: propertyPath(span.expression), tail: span.literal.text })),
  };
}

function assertLauncherEnvironment(file) {
  const handoff = findPropertyAssignments(file, "LIMINA_EDITOR_HANDOFF_URL");
  assert.equal(handoff.length, 1, "launcher must provide exactly one handoff URL");
  assert.deepEqual(templateShape(handoff[0].initializer), {
    head: "http://localhost:",
    spans: [{ expression: "uiPort", tail: "/atlas-handoff.html" }],
  });

  const atlasOrigin = findPropertyAssignments(file, "LIMINA_ATLAS_PUBLIC_ORIGIN");
  assert.equal(atlasOrigin.length, 1, "launcher must provide exactly one public Atlas origin");
  assert.equal(propertyPath(atlasOrigin[0].initializer), "atlasLaunch.origin");

  const editorUrl = findPropertyAssignments(file, "LIMINA_EDITOR_PUBLIC_URL");
  assert.equal(editorUrl.length, 1, "launcher must provide exactly one editor public URL");
  assert.deepEqual(templateShape(editorUrl[0].initializer), {
    head: "http://localhost:",
    spans: [{ expression: "uiPort", tail: "/" }],
  });
}

function oneMatch(matches, label) {
  assert.equal(matches.length, 1, label);
  return matches[0];
}

function namedFunction(file, name) {
  return oneMatch(
    collect(file, (node) => ts.isFunctionDeclaration(node) && node.name?.text === name),
    `expected exactly one ${name} function`,
  );
}

function namedDeclaration(node, name) {
  return oneMatch(
    findVariable(node, name),
    `expected exactly one ${name} declaration in ${node.name?.text ?? "the function"}`,
  );
}

function isGuardedProperty(expression, basePath, property) {
  const value = unwrapExpression(expression);
  return (
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
    propertyPath(value.left) === basePath &&
    propertyPath(value.right) === property
  );
}

function isSavedHead(expression) {
  const value = unwrapExpression(expression);
  return (
    ts.isBinaryExpression(value) &&
    value.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
    isGuardedProperty(value.left, "saved", "saved.authoring") &&
    propertyPath(value.right) === "saved.authoring.head"
  );
}

function arrayElementPath(expression, arrayPath, index) {
  const value = unwrapExpression(expression);
  return (
    ts.isElementAccessExpression(value) &&
    propertyPath(value.expression) === arrayPath &&
    literalValue(value.argumentExpression) === index
  );
}

function assertCanonicalWorldDeclaration(focusFunction) {
  const declaration = namedDeclaration(focusFunction, "world");
  const call = declaration.initializer && unwrapExpression(declaration.initializer);
  assert.ok(ts.isCallExpression(call) && propertyPath(call.expression) === "atlasLocalToCanonicalWorld");
  assert.equal(call.arguments.length, 2);
  assert.equal(propertyPath(call.arguments[0]), "map.units");
  const local = unwrapExpression(call.arguments[1]);
  assert.ok(ts.isArrayLiteralExpression(local) && local.elements.length === 2);
  assert.ok(arrayElementPath(local.elements[0], "local", 0));
  assert.ok(arrayElementPath(local.elements[1], "local", 1));
  return declaration;
}

function findSaveLaunchDeclaration(focusFunction) {
  const declarations = collect(focusFunction, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isArrayBindingPattern(node.name)) return false;
    return (
      node.name.elements.map((element) => (ts.isIdentifier(element.name) ? element.name.text : undefined)).join(",") ===
      "saveResult,launch"
    );
  });
  const declaration = oneMatch(declarations, "focus must bind one saveResult/launch pair");
  const awaited = declaration.initializer && unwrapExpression(declaration.initializer);
  assert.ok(ts.isAwaitExpression(awaited), "saveResult/launch must await Promise.all");
  const promiseAll = unwrapExpression(awaited.expression);
  assert.ok(ts.isCallExpression(promiseAll) && propertyPath(promiseAll.expression) === "Promise.all");
  assert.equal(promiseAll.arguments.length, 1);
  const work = unwrapExpression(promiseAll.arguments[0]);
  assert.ok(ts.isArrayLiteralExpression(work) && work.elements.length === 2);
  assert.ok(isExactCall(work.elements[0], "flushMapSave"), "CAS save must be the first coordinated operation");
  const launch = unwrapExpression(work.elements[1]);
  assert.ok(ts.isConditionalExpression(launch) && propertyPath(launch.condition) === "standalone");
  assert.ok(isExactCall(launch.whenTrue, "getEditorLaunchConfig"));
  assert.ok(isExactCall(launch.whenFalse, "Promise.resolve", [{ kind: "path", value: "undefined" }]));
  return declaration;
}

function assertCanonicalFocusMessage(focusFunction) {
  const head = namedDeclaration(focusFunction, "head");
  assert.ok(head.initializer && isSavedHead(head.initializer), "focus head must derive from the committed save result");

  const message = namedDeclaration(focusFunction, "message");
  const call = message.initializer && unwrapExpression(message.initializer);
  assert.ok(ts.isCallExpression(call) && propertyPath(call.expression) === "parseAtlasFocusRequest");
  assert.equal(call.arguments.length, 1);
  const payload = unwrapExpression(call.arguments[0]);
  const source = objectProperty(payload, "source");
  const world = objectProperty(payload, "world");
  assert.ok(source !== undefined && world !== undefined);
  assert.equal(propertyPath(propertyInitializer(world)), "world");
  const sourceValue = unwrapExpression(propertyInitializer(source));
  const revision = objectProperty(sourceValue, "revision");
  const headHash = objectProperty(sourceValue, "headHash");
  assert.ok(revision !== undefined && headHash !== undefined);
  assert.ok(isGuardedProperty(propertyInitializer(revision), "head", "head.revision"));
  assert.ok(isGuardedProperty(propertyInitializer(headHash), "head", "head.headHash"));
  return { head, message, call };
}

function containingStatement(block, node) {
  return oneMatch(
    block.statements.filter((statement) => statement.pos <= node.pos && statement.end >= node.end),
    "semantic node must belong to one top-level pipeline statement",
  );
}

function containingTryStatement(node) {
  let current = node.parent;
  while (current) {
    if (ts.isBlock(current) && ts.isTryStatement(current.parent) && current.parent.tryBlock === current) {
      return current.parent;
    }
    current = current.parent;
  }
  assert.fail("save/launch coordination must be inside a guarded try block");
}

function assertCasFocusPipeline(source, fileName = "atlas-focus-pipeline.js") {
  const file = parseTypeScript(source, fileName);
  const focusFunction = namedFunction(file, "focusEditorFromAtlas");
  assert.ok(
    focusFunction.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword),
    "focusEditorFromAtlas must remain async",
  );
  const mapDeclaration = namedDeclaration(focusFunction, "map");
  assert.ok(mapDeclaration.initializer && isExactCall(mapDeclaration.initializer, "activeMap"));
  const worldDeclaration = assertCanonicalWorldDeclaration(focusFunction);
  const saveLaunch = findSaveLaunchDeclaration(focusFunction);
  const tryStatement = containingTryStatement(saveLaunch);
  const saved = namedDeclaration(focusFunction, "saved");
  const committedCall = saved.initializer && unwrapExpression(saved.initializer);
  assert.ok(
    committedCall &&
      isExactCall(committedCall, "requireCommittedMapSave", [
        { kind: "path", value: "saveResult" },
        { kind: "literal", value: "Open in Editor" },
      ]),
    "requireCommittedMapSave(saveResult) must gate focus publication",
  );
  const { head, message } = assertCanonicalFocusMessage(focusFunction);
  const embeddedEmit = oneMatch(
    findCalls(focusFunction, "window.parent.postMessage").filter((call) =>
      isExactCall(call, "window.parent.postMessage", [
        { kind: "path", value: "message" },
        { kind: "path", value: "window.location.origin" },
      ]),
    ),
    "embedded Atlas must emit one canonical focus to its own origin",
  );
  const standaloneEmit = oneMatch(
    findCalls(focusFunction, "openStandaloneEditorHandoff").filter((call) =>
      isExactCall(call, "openStandaloneEditorHandoff", [
        { kind: "path", value: "popup" },
        { kind: "path", value: "launch" },
        { kind: "path", value: "message" },
      ]),
    ),
    "standalone Atlas must publish the same canonical focus through its relay",
  );
  const order = [mapDeclaration, worldDeclaration, saveLaunch, saved, head, message, standaloneEmit, embeddedEmit].map(
    (node) => node.getStart(file),
  );
  assert.deepEqual(
    order,
    [...order].sort((left, right) => left - right),
    "CAS save, committed-save gate, canonical message construction, and both emits must remain ordered",
  );
  return {
    file,
    committedCall,
    savedStatement: containingStatement(tryStatement.tryBlock, saved),
    emitStatement: containingStatement(tryStatement.tryBlock, embeddedEmit),
  };
}

function assertFlushMapSaveContract(file) {
  const flush = namedFunction(file, "flushMapSave");
  assert.ok(flush.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
  assert.ok(flush.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword));
  const returns = collect(flush, (node) => ts.isReturnStatement(node));
  assert.equal(returns.length, 1, "flushMapSave must return exactly one authoritative save promise");
  assert.ok(returns[0].expression && isExactCall(returns[0].expression, "doSave"));
}

function replaceNode(source, file, node, replacement) {
  return `${source.slice(0, node.getStart(file))}${replacement}${source.slice(node.end)}`;
}

function swapStatements(source, file, first, second) {
  const [earlier, later] = first.getStart(file) < second.getStart(file) ? [first, second] : [second, first];
  const earlierStart = earlier.getStart(file);
  const laterStart = later.getStart(file);
  return `${source.slice(0, earlierStart)}${source.slice(laterStart, later.end)}${source.slice(
    earlier.end,
    laterStart,
  )}${source.slice(earlierStart, earlier.end)}${source.slice(later.end)}`;
}

test("the editor exposes one persisted resizable and maximizable Atlas workspace", () => {
  for (const id of [
    "viewport-atlas-toggle",
    "viewport-atlas",
    "viewport-atlas-frame",
    "viewport-atlas-status",
    "viewport-atlas-reveal",
    "viewport-atlas-maximize",
    "viewport-atlas-splitter",
    "viewport-atlas-close",
  ]) {
    assert.equal((html.match(new RegExp(`id=["']${id}["']`, "g")) ?? []).length, 1, id);
  }
  assert.match(html, /id="viewport-atlas"[^>]*aria-labelledby="viewport-atlas-title"[^>]*hidden/);
  assert.match(
    html,
    /id="viewport-atlas-splitter"[^>]*role="separator"[^>]*tabindex="0"[^>]*aria-orientation="vertical"/s,
  );
  assert.match(css, /\.viewport\s*\{[^}]*--atlas-dock-width:\s*560px/s);
  assert.match(css, /\.atlas-overview\s*\{[^}]*width:\s*var\(--atlas-dock-width\)/s);
  assert.match(css, /body\.atlas-workspace-maximized \.atlas-overview[\s\S]*position:\s*absolute/);
  assert.match(css, /body\.atlas-workspace-compact \.atlas-overview/);
  assert.match(viewport, /setPointerCapture/);
  assert.match(viewport, /ResizeObserver/);
  assert.match(viewport, /insertBefore\(playCanvas, viewportUi\.atlasPanel \?\? null\)/);
  assert.match(viewport, /writeAtlasWorkspaceState/);
  assert.match(css, /body\.atlas-overview-open #inspector\s*\{\s*display:\s*none !important/);
  assert.match(css, /@media \(max-width:\s*720px\)[\s\S]*\.atlas-overview\s*\{[^}]*position:\s*absolute/s);
});

test("Atlas focus is source-fenced, residency-coordinated, and terrain-grounded", () => {
  assert.match(viewport, /parseTrustedAtlasEditorMessageEvent\(event, source, window\.location\.origin\)/);
  assert.match(viewport, /active\?\.revision === source\.revision && active\?\.headHash === source\.headHash/);
  assert.match(viewport, /await waitForAtlasDerivedSource\(message\.source, generation, requireAtlasOpen\)/);
  assert.match(viewport, /navigation\.destinationPose\(target, message\.radiusM\)/);
  assert.match(viewport, /derivedTerrainHeightAt\(message\.world\[0\], message\.world\[1\]\)/);
  assert.match(viewport, /resolvePose:\s*\(\{ context \}\)/);
});

test("Frame World owns and releases the overview presentation lifecycle", () => {
  assert.match(viewport, /function leaveWorldOverviewPresentation\(\)[\s\S]*setWorldOverviewPresentation\?\.\(false\)/);
  assert.match(
    viewport,
    /if \(result\) runtime\.setWorldOverviewPresentation\?\.\(true\);[\s\S]*else leaveWorldOverviewPresentation\(\);/,
  );
  assert.match(viewport, /function focusNavigationSelection\(\)[\s\S]*leaveWorldOverviewPresentation\(\);/);
});

test("reverse reveal uses exact selected world coordinates without POI inference", () => {
  assert.match(viewport, /selected\.mesh\.getWorldPosition\(atlasWorldPosition\)/);
  assert.match(viewport, /\[atlasWorldPosition\.x, atlasWorldPosition\.z\]/);
  assert.match(viewport, /target\.postMessage\(message, window\.location\.origin\)/);
  assert.doesNotMatch(viewport, /nearest.*(?:place|marker)|distanceTo.*(?:place|marker)/i);
});

test("Atlas flushes its authoritative CAS save before emitting a canonical focus", () => {
  assertCasFocusPipeline(map, "tools/design/frontend/map.js");
  assertFlushMapSaveContract(semanticSources.net);
});

test("CAS focus semantics reject publication reordering and committed-save bypass", () => {
  const baseline = assertCasFocusPipeline(map, "tools/design/frontend/map.js");
  const reordered = swapStatements(map, baseline.file, baseline.savedStatement, baseline.emitStatement);
  assert.throws(() => assertCasFocusPipeline(reordered, "mutated-focus-publication-order.js"), /must remain ordered/);
  const bypassed = replaceNode(map, baseline.file, baseline.committedCall, "saveResult");
  assert.throws(
    () => assertCasFocusPipeline(bypassed, "mutated-focus-save-bypass.js"),
    /requireCommittedMapSave\(saveResult\) must gate focus publication/,
  );
});

test("embedded Atlas opens directly to the map and attribute escaping covers quotes", () => {
  assert.match(app, /get\("embed"\) === "editor"/);
  assert.match(app, /S\.activeView = "map"/);
  assert.match(util, /&quot;/);
  assert.match(util, /&#39;/);
});

test("standalone Atlas launches through a non-secret one-shot relay", () => {
  assert.equal(htmlIdCount(atlasHtml, "open-editor"), 1, "Atlas must expose exactly one editor-launch control");
  assertStandalonePopupOpen(map, "tools/design/frontend/map.js");
  assertActiveMapFallback(semanticSources.map);
  assertSaveAndLaunchCoordination(semanticSources.map);
  assertGuardedComparisons(
    semanticSources.map,
    [
      ["event.source", ts.SyntaxKind.ExclamationEqualsEqualsToken, "popup"],
      ["event.origin", ts.SyntaxKind.ExclamationEqualsEqualsToken, "config.editorOrigin"],
    ],
    "Atlas must accept relay readiness only from the opened popup at the configured editor origin",
  );
  assertExactCall(
    semanticSources.map,
    "popup.postMessage",
    [
      { kind: "path", value: "message" },
      { kind: "path", value: "config.editorOrigin" },
    ],
    "Atlas must send the focus message only to the configured editor origin",
  );
  assertGuardedComparisons(
    semanticSources.relay,
    [
      ["event.source", ts.SyntaxKind.ExclamationEqualsEqualsToken, "opener"],
      ["event.origin", ts.SyntaxKind.ExclamationEqualsEqualsToken, "atlasOrigin"],
    ],
    "the relay must accept focus only from its opener at the configured Atlas origin",
  );
  assertExactCall(
    semanticSources.relay,
    "storeAtlasEditorHandoff",
    [
      { kind: "path", value: "sessionStorage" },
      { kind: "path", value: "handoff" },
    ],
    "the relay must store the one-shot handoff in session storage",
  );
  assert.ok(
    collect(
      semanticSources.relay,
      (node) =>
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        propertyPath(node.left) === "window.opener" &&
        literalValue(node.right) === null,
    ).length > 0,
    "the relay must sever its opener after the handoff",
  );
  assertImportBinding(semanticSources.editorApp, "./atlas-handoff-bootstrap.js", "atlasEditorHandoff");
  assert.ok(
    collect(
      semanticSources.editorApp,
      (node) => ts.isExpression(node) && propertyPath(node) === "atlasEditorHandoff.serverUrl",
    ).length > 0,
    "the editor must consume the relayed server URL",
  );
  assertFalseObjectArgument(semanticSources.viewport, "focusAtlasRequest", "requireAtlasOpen");
  assert.ok(
    comparisonExists(
      semanticSources.map,
      "launch.atlasOrigin",
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
      "window.location.origin",
    ),
    "standalone focus must reject a launch configuration for a different Atlas origin",
  );
  assertHandoffHeaders(semanticSources.serve);
  assertLauncherEnvironment(semanticSources.launcher);
});

test("standalone popup semantics reject URL and browsing-context mutations", () => {
  assert.throws(
    () => assertStandalonePopupOpen('window.open("https://example.invalid", "_blank");', "mutated-popup-url.js"),
    /inert same-origin document/,
  );
  assert.throws(
    () => assertStandalonePopupOpen('window.open("about:blank", "_self");', "mutated-popup-target.js"),
    /new browsing context/,
  );
});
