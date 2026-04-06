/**
 * Metric computation functions for Python AST nodes.
 */

import { computeComplexity, computeLineCount, computeNestingDepth } from '../shared/metrics-base';

/**
 * Compute cyclomatic complexity by counting decision points in the AST.
 * Starts at 1 (the function itself is one execution path).
 */
export function computePyComplexity(node: any): number {
  const decisionTypes = new Set([
    'if_statement',
    'elif_clause',
    'for_statement',
    'while_statement',
    'except_clause',
    'conditional_expression',
    'list_comprehension',
    'set_comprehension',
    'dictionary_comprehension',
    'generator_expression',
  ]);
  return computeComplexity(node, decisionTypes);
}

/**
 * Compute number of lines in a function body.
 */
export function computePyLineCount(node: any): number {
  return computeLineCount(node);
}

/**
 * Compute maximum nesting depth of control flow structures.
 */
export function computePyNestingDepth(node: any): number {
  const controlFlowTypes = new Set([
    'if_statement',
    'for_statement',
    'while_statement',
    'try_statement',
    'with_statement',
  ]);
  return computeNestingDepth(node, controlFlowTypes);
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
