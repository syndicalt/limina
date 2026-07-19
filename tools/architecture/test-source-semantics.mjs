import ts from "../../js/node_modules/typescript/lib/typescript.js";

export { ts };

export function parseTypeScript(source, fileName = "source.ts") {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (file.parseDiagnostics.length) {
    const diagnostic = file.parseDiagnostics[0];
    throw new Error(
      `${fileName}:${diagnostic.start ?? 0}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
    );
  }
  return file;
}

export function walk(node, visit) {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

export function collect(node, predicate) {
  const matches = [];
  walk(node, (candidate) => {
    if (predicate(candidate)) matches.push(candidate);
  });
  return matches;
}

export function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

export function propertyPath(expression) {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) return current.text;
  if (ts.isPropertyAccessExpression(current)) {
    const base = propertyPath(current.expression);
    return base === undefined ? undefined : `${base}.${current.name.text}`;
  }
  if (ts.isElementAccessExpression(current) && current.argumentExpression) {
    const base = propertyPath(current.expression),
      key = literalValue(current.argumentExpression);
    return base === undefined || typeof key !== "string" ? undefined : `${base}.${key}`;
  }
  return undefined;
}

export function literalValue(expression) {
  const current = unwrapExpression(expression);
  if (ts.isStringLiteralLike(current)) return current.text;
  if (ts.isNumericLiteral(current)) return Number(current.text);
  if (current.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (current.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (current.kind === ts.SyntaxKind.NullKeyword) return null;
  return undefined;
}

export function propertyName(node) {
  if (!node.name) return undefined;
  if (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name) || ts.isNumericLiteral(node.name)) {
    return node.name.text;
  }
  return undefined;
}

export function findCalls(file, calleePath) {
  return collect(file, (node) => ts.isCallExpression(node) && propertyPath(node.expression) === calleePath);
}

export function findVariable(file, name) {
  return collect(
    file,
    (node) => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name,
  );
}

export function findPropertyAssignments(file, name) {
  return collect(file, (node) => ts.isPropertyAssignment(node) && propertyName(node) === name);
}

export function objectProperty(object, name) {
  if (!ts.isObjectLiteralExpression(object)) return undefined;
  return object.properties.find(
    (property) =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      propertyName(property) === name,
  );
}

export function propertyInitializer(property) {
  if (ts.isPropertyAssignment(property)) return property.initializer;
  if (ts.isShorthandPropertyAssignment(property)) return property.name;
  return undefined;
}

export function hasPropertyPath(file, path) {
  return collect(file, (node) => ts.isExpression(node) && propertyPath(node) === path).length > 0;
}

export function hasStringLiteral(file, value) {
  return collect(file, (node) => ts.isStringLiteralLike(node) && node.text === value).length > 0;
}
