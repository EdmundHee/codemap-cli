/**
 * Rust-specific metric computation functions using the shared metrics base.
 */
import { computeComplexity, computeLineCount, computeNestingDepth } from '../shared/metrics-base';

const RUST_DECISION_TYPES = new Set([
  'if_expression', 'match_expression', 'match_arm',
  'for_expression', 'while_expression', 'loop_expression',
  'if_let_expression', 'while_let_expression',
]);

const RUST_CONTROL_FLOW_TYPES = new Set([
  'if_expression', 'match_expression',
  'for_expression', 'while_expression', 'loop_expression',
  'if_let_expression', 'while_let_expression',
]);

export function computeRustComplexity(node: any): number {
  return computeComplexity(node, RUST_DECISION_TYPES);
}

export function computeRustLineCount(node: any): number {
  return computeLineCount(node);
}

export function computeRustNestingDepth(node: any): number {
  return computeNestingDepth(node, RUST_CONTROL_FLOW_TYPES);
}
