/**
 * Go-specific metric computation functions using the shared metrics base.
 */
import { computeComplexity, computeLineCount, computeNestingDepth } from '../shared/metrics-base';

const GO_DECISION_TYPES = new Set([
  'if_statement', 'for_statement', 'select_statement',
  'case_clause', 'communication_case', 'expression_case', 'default_case',
]);

const GO_CONTROL_FLOW_TYPES = new Set([
  'if_statement', 'for_statement', 'select_statement',
]);

export function computeGoComplexity(node: any): number {
  return computeComplexity(node, GO_DECISION_TYPES);
}

export function computeGoLineCount(node: any): number {
  return computeLineCount(node);
}

export function computeGoNestingDepth(node: any): number {
  return computeNestingDepth(node, GO_CONTROL_FLOW_TYPES);
}
