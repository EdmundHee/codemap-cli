import { ParsedFile } from '../parsers/parser.interface';

export interface CallGraph {
  /** "ClassName.methodName" or "functionName" → list of calls */
  [caller: string]: string[];
}

export interface ReverseCallGraph {
  /** function/method → list of callers */
  [callee: string]: string[];
}

/**
 * Build a call graph from parsed files.
 * Maps each function/method to the functions it calls.
 *
 * Also creates a synthetic "__module__<filepath>" entry per file when
 * moduleCalls are present, covering calls from closures, array
 * initializers, and other top-level expressions not attributed to any
 * named function or method.
 */
export function buildCallGraph(parsedFiles: ParsedFile[]): CallGraph {
  // Use null-prototype object to avoid collisions with Object.prototype
  // (e.g., "constructor", "toString", "hasOwnProperty")
  const graph: CallGraph = Object.create(null);

  for (const parsed of parsedFiles) {
    // Class methods
    for (const cls of parsed.classes) {
      for (const method of cls.methods) {
        const key = `${cls.name}.${method.name}`;
        graph[key] = method.calls;
      }
    }

    // Standalone functions
    for (const func of parsed.functions) {
      graph[func.name] = func.calls;
    }

    // Module-level calls from closures, array initializers, etc.
    // These are call expressions at the top level that aren't inside
    // any named function or method body.
    if (parsed.moduleCalls && parsed.moduleCalls.length > 0) {
      const moduleKey = `__module__${parsed.file.relative}`;
      graph[moduleKey] = parsed.moduleCalls;
    }
  }

  return graph;
}

/**
 * Build a reverse call graph (callee → callers).
 * Useful for dead code detection.
 * Uses Map internally to avoid Object.prototype key collisions.
 */
export function buildReverseCallGraph(callGraph: CallGraph): ReverseCallGraph {
  const reverseMap = new Map<string, string[]>();
  const allKeys = new Set(Object.keys(callGraph));

  // Initialize all known functions with empty arrays
  for (const caller of allKeys) {
    if (!reverseMap.has(caller)) {
      reverseMap.set(caller, []);
    }
  }

  function addCaller(callee: string, caller: string): void {
    if (!reverseMap.has(callee)) {
      reverseMap.set(callee, []);
    }
    const callers = reverseMap.get(callee)!;
    if (!callers.includes(caller)) {
      callers.push(caller);
    }
  }

  // Build a map of unqualified method names → qualified keys for resolving
  // instance method calls like logger.success() → Logger.success
  const methodToQualified = new Map<string, string[]>();
  for (const key of allKeys) {
    const dotIdx = key.indexOf('.');
    if (dotIdx > 0 && !key.startsWith('__module__')) {
      const methodName = key.substring(dotIdx + 1);
      if (!methodToQualified.has(methodName)) {
        methodToQualified.set(methodName, []);
      }
      methodToQualified.get(methodName)!.push(key);
    }
  }

  // Populate reverse mappings
  for (const [caller, callees] of Object.entries(callGraph)) {
    // Extract class name if caller is "ClassName.methodName"
    const dotIndex = caller.indexOf('.');
    const callerClass = dotIndex > 0 && !caller.startsWith('__module__')
      ? caller.substring(0, dotIndex)
      : null;

    for (const callee of callees) {
      addCaller(callee, caller);

      const calleeDotIdx = callee.indexOf('.');
      const calleeMethod = calleeDotIdx > 0 ? callee.substring(calleeDotIdx + 1) : callee;
      const calleeIsQualified = calleeDotIdx > 0;

      // If the callee is already a known call graph key, no resolution needed
      if (allKeys.has(callee)) continue;

      // Try to resolve the callee to a qualified class method name:
      // 1. Intra-class: this.method() → "method" should resolve to "ClassName.method"
      // 2. Instance var: logger.success() → "logger.success" should resolve to "Logger.success"
      // 3. Direct call: method() → "method" should resolve to "ClassName.method"

      // For intra-class calls, try same-class resolution first
      if (!calleeIsQualified && callerClass) {
        const sameClassCallee = `${callerClass}.${callee}`;
        if (allKeys.has(sameClassCallee)) {
          addCaller(sameClassCallee, caller);
          continue;
        }
      }

      // Resolve by method name — handles both unqualified ("success")
      // and variable-qualified ("logger.success") callees by matching
      // against known class methods in the call graph.
      const qualifiedMatches = methodToQualified.get(calleeMethod);
      if (qualifiedMatches) {
        for (const qualified of qualifiedMatches) {
          addCaller(qualified, caller);
        }
      }
    }
  }

  // Convert back to plain null-prototype object for JSON serialization
  const reverse: ReverseCallGraph = Object.create(null);
  for (const [key, value] of reverseMap) {
    reverse[key] = value;
  }

  return reverse;
}
