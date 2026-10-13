import ts from 'typescript';

// Hermes can expand the lowered call graph into pathological control flow.
// Returning functions through Object.freeze preserves compiled call boundaries
// under normal -O without wrapper calls or changing numeric bodies, arguments,
// reentrancy or instance-local captures. Compiled functions have no reflection.
export function preserveJsFunctionBoundaries(source) {
  const parsed = ts.createSourceFile('compiled-core.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (parsed.parseDiagnostics.length) throw new Error('Invalid lowered JavaScript');
  const factories = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'asmFunc');
  if (factories.length !== 1 || !factories[0].body) throw new Error('Unexpected wasm2js factory');
  const factory = factories[0];
  const functions = factory.body.statements.filter(node => ts.isFunctionDeclaration(node) && /^\$\d+$/.test(node.name?.text ?? ''));
  if (!functions.length || functions.some(node => !node.name || !node.body || node.asteriskToken || node.modifiers?.length)) {
    throw new Error('Unexpected compiled function declaration');
  }
  const names = new Set(functions.map(node => node.name.text));
  if (names.size !== functions.length || factory.parameters.some(node => names.has(node.name.getText(parsed)))) {
    throw new Error('Conflicting compiled function bindings');
  }
  const check = (node, visible = names, insideFunction = false) => {
    if (ts.isFunctionLike(node) && node.body) {
      const locals = new Set(node.parameters.map(parameter => parameter.name.getText(parsed)));
      const collect = child => {
        if (ts.isFunctionLike(child)) return;
        if (ts.isVariableDeclaration(child)) locals.add(child.name.getText(parsed));
        ts.forEachChild(child, collect);
      };
      collect(node.body);
      check(node.body, new Set([...visible].filter(name => !locals.has(name))), true);
      return;
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword ||
      (ts.isIdentifier(node) && node.text === 'arguments') || ts.isMetaProperty(node) ||
      (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && visible.has(node.expression.text))) {
      throw new Error('Compiled function requires unsupported call semantics');
    }
    if (ts.isWithStatement(node) || (ts.isIdentifier(node) && ['eval', 'Function'].includes(node.text)) ||
      (!insideFunction && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && visible.has(node.name.text)) ||
      ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        ts.isIdentifier(node.expression) && visible.has(node.expression.text)) ||
      (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(node.left) && visible.has(node.left.text))) {
      throw new Error('Compiled function binding cannot be observed or mutated');
    }
    ts.forEachChild(node, child => check(child, visible, insideFunction));
  };
  check(factory.body);
  const bindings = functions.map(node => {
    const parameters = source.slice(node.name.end, node.body.getStart(parsed));
    const body = source.slice(node.body.getStart(parsed), node.body.end);
    return `var ${node.name.text} = Object.freeze(function${parameters}${body});`;
  }).join('\n');
  let insertion = factory.body.getStart(parsed) + 1;
  for (const statement of factory.body.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    insertion = statement.end;
  }
  // Initialize every reference before any existing factory statement can call
  // it or store it in a function table, preserving declaration hoisting.
  let output = source;
  for (const node of [...functions].reverse()) {
    output = output.slice(0, node.getStart(parsed)) + output.slice(node.end);
  }
  return output.slice(0, insertion) + `\n${bindings}\n` + output.slice(insertion);
}
