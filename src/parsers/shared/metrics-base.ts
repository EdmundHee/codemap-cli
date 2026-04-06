/**
 * Language-agnostic metric computation functions for tree-sitter AST nodes.
 */

/**
 * Compute cyclomatic complexity by counting decision points in the AST.
 * Starts at 1 (the function itself is one execution path).
 */
export function computeComplexity(node: any, decisionTypes: Set<string>): number {
  let complexity = 1;
  const walk = (n: any) => {
    if (decisionTypes.has(n.type)) complexity++;
    if (n.type === 'boolean_operator') complexity++;
    for (const child of n.namedChildren || []) walk(child);
  };
  const body = node.childForFieldName('body');
  if (body) walk(body);
  return complexity;
}

/**
 * Compute maximum nesting depth of control flow structures.
 */
export function computeNestingDepth(node: any, controlFlowTypes: Set<string>): number {
  let maxDepth = 0;
  const walk = (n: any, depth: number) => {
    const isControlFlow = controlFlowTypes.has(n.type);
    const newDepth = isControlFlow ? depth + 1 : depth;
    if (newDepth > maxDepth) maxDepth = newDepth;
    for (const child of n.namedChildren || []) walk(child, newDepth);
  };
  const body = node.childForFieldName('body');
  if (body) walk(body, 0);
  return maxDepth;
}

/**
 * Compute number of lines in a function body.
 */
export function computeLineCount(node: any): number {
  return node.endPosition.row - node.startPosition.row + 1;
}
