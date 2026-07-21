import assert from "node:assert/strict";
import {
  collect,
  findCalls,
  findPropertyAssignments,
  findVariable,
  hasPropertyPath,
  hasStringLiteral,
  literalValue,
  objectProperty,
  parseTypeScript,
  propertyInitializer,
  propertyName,
  propertyPath,
  ts,
  unwrapExpression,
  walk,
} from "../architecture/test-source-semantics.mjs";

export {
  collect,
  findCalls,
  findPropertyAssignments,
  findVariable,
  hasPropertyPath,
  hasStringLiteral,
  literalValue,
  objectProperty,
  parseTypeScript,
  propertyInitializer,
  propertyName,
  propertyPath,
  ts,
  unwrapExpression,
  walk,
};

const operatorKinds = Object.freeze({
  "===": ts.SyntaxKind.EqualsEqualsEqualsToken,
  "!==": ts.SyntaxKind.ExclamationEqualsEqualsToken,
  "<": ts.SyntaxKind.LessThanToken,
  "<=": ts.SyntaxKind.LessThanEqualsToken,
  ">": ts.SyntaxKind.GreaterThanToken,
  ">=": ts.SyntaxKind.GreaterThanEqualsToken,
});

export function expressionValue(expression) {
  const current = unwrapExpression(expression),
    literal = literalValue(current);
  if (literal !== undefined) return literal;
  if (
    ts.isPrefixUnaryExpression(current) &&
    current.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(current.operand)
  ) {
    return -Number(current.operand.text);
  }
  return propertyPath(current);
}

export function assertCall(file, callee, expectedArguments = undefined) {
  const calls = findCalls(file, callee),
    matches =
      expectedArguments === undefined
        ? calls
        : calls.filter(
            (call) =>
              call.arguments.length >= expectedArguments.length &&
              expectedArguments.every(
                (expected, index) => expected === undefined || expressionValue(call.arguments[index]) === expected,
              ),
          );
  assert.ok(matches.length > 0, `missing semantic call ${callee}(${expectedArguments?.join(", ") ?? "..."})`);
  return matches;
}

export function assertComparison(file, left, operator, right) {
  const kind = operatorKinds[operator];
  assert.notEqual(kind, undefined, `unsupported comparison operator ${operator}`);
  const matches = collect(
    file,
    (node) =>
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === kind &&
      propertyPath(node.left) === left &&
      expressionValue(node.right) === right,
  );
  assert.ok(matches.length > 0, `missing semantic comparison ${left} ${operator} ${String(right)}`);
  return matches;
}

export function assertVariableValue(file, name, expected) {
  const matches = findVariable(file, name).filter(
    (declaration) => declaration.initializer && expressionValue(declaration.initializer) === expected,
  );
  assert.ok(matches.length > 0, `missing semantic variable ${name} = ${String(expected)}`);
  return matches;
}

export function assertPropertyValue(file, name, expected) {
  const matches = findPropertyAssignments(file, name).filter(
    (property) => expressionValue(property.initializer) === expected,
  );
  assert.ok(matches.length > 0, `missing semantic property ${name}: ${String(expected)}`);
  return matches;
}

export function assertObject(file, expectedProperties) {
  const matches = collect(file, (node) => {
    if (!ts.isObjectLiteralExpression(node)) return false;
    return Object.entries(expectedProperties).every(([name, expected]) => {
      const property = objectProperty(node, name),
        initializer = property && propertyInitializer(property);
      return initializer !== undefined && expressionValue(initializer) === expected;
    });
  });
  assert.ok(matches.length > 0, `missing semantic object ${JSON.stringify(expectedProperties)}`);
  return matches;
}

export function assertDelete(file, path) {
  const matches = collect(file, (node) => ts.isDeleteExpression(node) && propertyPath(node.expression) === path);
  assert.ok(matches.length > 0, `missing semantic delete ${path}`);
  return matches;
}

export function assertImportedNames(file, moduleName, names) {
  const imported = new Set();
  for (const declaration of collect(file, ts.isImportDeclaration)) {
    if (literalValue(declaration.moduleSpecifier) !== moduleName) continue;
    for (const element of declaration.importClause?.namedBindings?.elements ?? []) imported.add(element.name.text);
  }
  for (const name of names) assert.equal(imported.has(name), true, `missing ${name} import from ${moduleName}`);
}

export function assertArrayLiteral(file, expectedValues) {
  const matches = collect(file, (node) => {
    if (!ts.isArrayLiteralExpression(node)) return false;
    const values = node.elements.map(expressionValue);
    return expectedValues.every((expected) => values.includes(expected));
  });
  assert.ok(matches.length > 0, `missing semantic array containing ${expectedValues.join(", ")}`);
  return matches;
}
