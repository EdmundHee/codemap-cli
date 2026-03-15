/**
 * Metric computation functions for Python AST nodes.
 */

/**
 * Compute cyclomatic complexity by counting decision points in the AST.
 * Starts at 1 (the function itself is one execution path).
 */
export function computePyComplexity(node: any): number {
  let complexity = 1;

  const decisionTypes = new Set([
    'if_statement',
    'elif_clause',
    'for_statement',
    'while_statement',
    'except_clause',
    'conditional_expression',  // ternary: x if cond else y
    'list_comprehension',      // [x for x in y if z]
    'set_comprehension',
    'dictionary_comprehension',
    'generator_expression',
  ]);

  // Walk the AST manually
  const walk = (n: any) => {
    if (decisionTypes.has(n.type)) {
      complexity++;
    }
    // Count 'and' / 'or' boolean operators
    if (n.type === 'boolean_operator') {
      complexity++;
    }
    for (const child of n.namedChildren || []) {
      walk(child);
    }
  };

  const body = node.childForFieldName('body');
  if (body) {
    walk(body);
  }

  return complexity;
}

/**
 * Compute number of lines in a function body.
 */
export function computePyLineCount(node: any): number {
  return node.endPosition.row - node.startPosition.row + 1;
}

/**
 * Compute maximum nesting depth of control flow structures.
 */
export function computePyNestingDepth(node: any): number {
  let maxDepth = 0;

  const controlFlowTypes = new Set([
    'if_statement',
    'for_statement',
    'while_statement',
    'try_statement',
    'with_statement',
  ]);

  const walk = (n: any, depth: number) => {
    const isControlFlow = controlFlowTypes.has(n.type);
    const newDepth = isControlFlow ? depth + 1 : depth;
    if (newDepth > maxDepth) maxDepth = newDepth;

    for (const child of n.namedChildren || []) {
      walk(child, newDepth);
    }
  };

  const body = node.childForFieldName('body');
  if (body) {
    walk(body, 0);
  }

  return maxDepth;
}

/**
 * Extract instance variable accesses (self.x) from a method body.
 * Returns deduplicated variable names (without "self." prefix).
 */
export function extractPyInstanceVarAccesses(node: any): string[] {
  const accesses = new Set<string>();

  const walk = (n: any) => {
    // Match self.attribute_name patterns
    if (n.type === 'attribute' && n.childCount >= 2) {
      const obj = n.childForFieldName('object');
      const attr = n.childForFieldName('attribute');
      if (obj?.text === 'self' && attr) {
        accesses.add(attr.text);
      }
    }
    for (const child of n.namedChildren || []) {
      walk(child);
    }
  };

  const body = node.childForFieldName('body');
  if (body) {
    walk(body);
  }

  return Array.from(accesses);
}
