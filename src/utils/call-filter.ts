/**
 * Filters and normalizes call expressions to reduce noise in the call graph.
 *
 * Removes:
 * - Built-in methods (.map, .filter, .join, .push, .includes, etc.)
 * - Python built-ins (isinstance, len, str, int, list, dict, etc.)
 * - Common test assertions (assert_equal, assert_raises, etc.)
 * - Exception constructors (ValueError, TypeError, etc.)
 * - Chained intermediate expressions (keeps only the meaningful root call)
 * - Very short calls (single char)
 *
 * Normalizes:
 * - Strips `this.` and `self.` prefixes
 * - Truncates excessively long call expressions
 */

/** Built-in methods and functions that add no relationship value */
const BUILTIN_CALLS = new Set([
  // JS/TS builtins
  'map', 'filter', 'reduce', 'forEach', 'some', 'every', 'find', 'findIndex',
  'includes', 'indexOf', 'join', 'split', 'slice', 'splice', 'push', 'pop',
  'shift', 'unshift', 'concat', 'flat', 'flatMap', 'sort', 'reverse',
  'keys', 'values', 'entries', 'has', 'get', 'set', 'delete', 'clear',
  'toString', 'valueOf', 'toJSON', 'toFixed', 'toPrecision',
  'trim', 'trimStart', 'trimEnd', 'toLowerCase', 'toUpperCase',
  'replace', 'replaceAll', 'match', 'matchAll', 'search', 'test',
  'startsWith', 'endsWith', 'padStart', 'padEnd', 'repeat',
  'charAt', 'charCodeAt', 'codePointAt', 'normalize',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'JSON.stringify', 'JSON.parse',
  'Object.keys', 'Object.values', 'Object.entries', 'Object.assign',
  'Object.create', 'Object.freeze', 'Object.defineProperty',
  'Array.isArray', 'Array.from',
  'Promise.all', 'Promise.resolve', 'Promise.reject', 'Promise.allSettled',
  'Math.floor', 'Math.ceil', 'Math.round', 'Math.max', 'Math.min', 'Math.abs',
  'Date.now', 'console.log', 'console.error', 'console.warn', 'console.info',
  'process.exit',

  // Python builtins
  'isinstance', 'issubclass', 'type', 'id', 'hash', 'dir', 'vars', 'getattr',
  'setattr', 'hasattr', 'delattr', 'callable', 'property', 'staticmethod',
  'classmethod', 'super',
  'len', 'range', 'enumerate', 'zip', 'sorted', 'reversed', 'min', 'max',
  'sum', 'abs', 'round', 'pow', 'divmod',
  'str', 'int', 'float', 'bool', 'bytes', 'bytearray',
  'list', 'tuple', 'dict', 'set', 'frozenset',
  'print', 'input', 'open', 'repr', 'format', 'chr', 'ord',
  'map', 'filter', 'any', 'all', 'next', 'iter',

  // Common test/assertion noise
  'assert_equal', 'assert_not_equal', 'assert_raises', 'assert_true',
  'assert_false', 'assert_is_none', 'assert_is_not_none',
  'assertEqual', 'assertNotEqual', 'assertRaises', 'assertTrue',
  'assertFalse', 'assertIsNone', 'assertIsNotNone', 'assertIn',
  'assertNotIn', 'assertIs', 'assertIsNot', 'assertGreater',
  'assertLess', 'assertAlmostEqual',
  'pytest.raises', 'pytest.mark',

  // Go builtins
  'fmt.Println', 'fmt.Printf', 'fmt.Sprintf', 'fmt.Fprintf', 'fmt.Errorf',
  'make', 'append', 'len', 'cap', 'close', 'delete', 'copy',
  'panic', 'recover', 'new', 'println', 'print',

  // Rust builtins
  'vec', 'todo', 'unimplemented', 'dbg',
  'assert', 'assert_eq', 'assert_ne',
  'eprintln', 'eprint', 'write', 'writeln',

  // Common exception constructors
  'ValueError', 'TypeError', 'KeyError', 'IndexError', 'AttributeError',
  'RuntimeError', 'NotImplementedError', 'StopIteration', 'IOError',
  'OSError', 'FileNotFoundError', 'PermissionError',
  'Exception', 'BaseException', 'Error',
]);

/** Patterns for chained expressions that are just intermediate steps */
const CHAIN_NOISE_PATTERNS = [
  /\)\.\w+$/,           // foo(...).bar — intermediate chain step
  /\]\.\w+$/,           // foo[...].bar — intermediate chain step
  /\.\w+\(.*\)\.\w+/,  // a.b(...).c — multi-step chain
];

/**
 * Filter and normalize a list of call expressions.
 * Returns only meaningful, unique calls.
 */
export function filterCalls(rawCalls: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of rawCalls) {
    const normalized = normalizeCall(raw);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;

    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function isChainedBuiltin(normalized: string): boolean {
  const lastDot = normalized.lastIndexOf('.');
  if (lastDot === -1) return false;
  const lastSegment = normalized.slice(lastDot + 1);
  if (!BUILTIN_CALLS.has(lastSegment) || normalized.includes('(')) return false;
  const prefix = normalized.slice(0, lastDot);
  return prefix.includes('.') || prefix.includes('(') || prefix.includes('[');
}

function collapseMultiline(normalized: string): string | null {
  const firstLine = normalized.split('\n')[0].trim();
  return firstLine.length > 2 ? firstLine : null;
}

function truncateLongCall(normalized: string): string {
  const parenIdx = normalized.indexOf('(');
  if (parenIdx !== -1 && parenIdx < 80) {
    return normalized.slice(0, parenIdx);
  }
  return normalized.slice(0, 80);
}

function extractRootCall(normalized: string): string {
  const chainMatch = normalized.match(/^([a-zA-Z_][\w.]*?)(\(|$)/);
  return chainMatch ? chainMatch[1] : normalized;
}

function normalizeCall(call: string): string | null {
  let normalized = call.trim();
  if (normalized.length <= 1) return null;

  const hadThisSelfPrefix = /^(this|self)\./.test(normalized);
  normalized = normalized.replace(/^(this|self)\./, '');

  if (!hadThisSelfPrefix) {
    if (BUILTIN_CALLS.has(normalized)) return null;
    if (isChainedBuiltin(normalized)) return null;
  }

  if (normalized.includes('\n')) {
    const collapsed = collapseMultiline(normalized);
    if (!collapsed) return null;
    normalized = collapsed;
  }

  if (normalized.length > 100) {
    normalized = truncateLongCall(normalized);
  }

  normalized = extractRootCall(normalized);

  if (!normalized || normalized.length <= 1) return null;
  if (!hadThisSelfPrefix && BUILTIN_CALLS.has(normalized)) return null;

  return normalized;
}

/**
 * Truncate a type signature to a reasonable length.
 * Removes inline documentation, collapses Annotated types, etc.
 */
export function truncateType(typeStr: string, maxLength: number = 120): string {
  if (!typeStr || typeStr.length <= maxLength) return typeStr;

  let cleaned = typeStr;

  // Remove Doc(...) annotations common in FastAPI
  cleaned = cleaned.replace(/,?\s*Doc\(\s*"""[\s\S]*?"""\s*\)/g, '');
  cleaned = cleaned.replace(/,?\s*Doc\(\s*"[^"]*"\s*\)/g, '');

  // Collapse Annotated[X, ...] to just X if it's still too long
  cleaned = cleaned.replace(/Annotated\[([^,\]]+),\s*[^\]]+\]/g, '$1');

  // Remove excessive whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  // If still too long, truncate with ellipsis
  if (cleaned.length > maxLength) {
    cleaned = cleaned.slice(0, maxLength - 3) + '...';
  }

  return cleaned;
}
