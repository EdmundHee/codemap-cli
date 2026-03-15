import { Node, SyntaxKind } from 'ts-morph';

/**
 * Compute cyclomatic complexity by counting decision points.
 * Starts at 1 (the function itself is one execution path).
 */
export function computeTSComplexity(node: Node): number {
  let complexity = 1;

  node.forEachDescendant((descendant) => {
    switch (descendant.getKind()) {
      case SyntaxKind.IfStatement:
      case SyntaxKind.ForStatement:
      case SyntaxKind.ForInStatement:
      case SyntaxKind.ForOfStatement:
      case SyntaxKind.WhileStatement:
      case SyntaxKind.DoStatement:
      case SyntaxKind.CaseClause:       // each case in switch
      case SyntaxKind.CatchClause:
      case SyntaxKind.ConditionalExpression: // ternary ? :
        complexity++;
        break;
      case SyntaxKind.BinaryExpression: {
        // Count && and || as decision points
        const opToken = (descendant as any).getOperatorToken?.();
        if (opToken) {
          const kind = opToken.getKind();
          if (
            kind === SyntaxKind.AmpersandAmpersandToken ||
            kind === SyntaxKind.BarBarToken ||
            kind === SyntaxKind.QuestionQuestionToken // nullish coalescing
          ) {
            complexity++;
          }
        }
        break;
      }
    }
  });

  return complexity;
}

/**
 * Compute the number of lines in a function/method body.
 */
export function computeTSLineCount(node: Node): number {
  const startLine = node.getStartLineNumber();
  const endLine = node.getEndLineNumber();
  return endLine - startLine + 1;
}

/**
 * Compute the maximum nesting depth of control flow structures.
 */
export function computeTSNestingDepth(node: Node): number {
  let maxDepth = 0;

  const controlFlowKinds = new Set([
    SyntaxKind.IfStatement,
    SyntaxKind.ForStatement,
    SyntaxKind.ForInStatement,
    SyntaxKind.ForOfStatement,
    SyntaxKind.WhileStatement,
    SyntaxKind.DoStatement,
    SyntaxKind.SwitchStatement,
    SyntaxKind.TryStatement,
  ]);

  const walk = (current: Node, depth: number) => {
    const isControlFlow = controlFlowKinds.has(current.getKind());
    const newDepth = isControlFlow ? depth + 1 : depth;
    if (newDepth > maxDepth) maxDepth = newDepth;

    for (const child of current.getChildren()) {
      walk(child, newDepth);
    }
  };

  walk(node, 0);
  return maxDepth;
}

/**
 * Extract instance variable accesses (this.x) from a method body.
 * Returns deduplicated variable names (without "this." prefix).
 */
export function extractTSInstanceVarAccesses(node: Node): string[] {
  const accesses = new Set<string>();

  node.forEachDescendant((descendant) => {
    if (Node.isPropertyAccessExpression(descendant)) {
      const expr = descendant.getExpression();
      if (expr.getKind() === SyntaxKind.ThisKeyword) {
        accesses.add(descendant.getName());
      }
    }
  });

  return Array.from(accesses);
}
