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
 * Build a map of unqualified method names → qualified keys.
 * Used to resolve instance method calls like logger.success() → Logger.success.
 */
function buildMethodIndex(allKeys: Set<string>): Map<string, string[]> {
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
  return methodToQualified;
}

/**
 * Resolve a callee to qualified call graph key(s) using three strategies:
 * 1. Intra-class: unqualified call from same class → "ClassName.method"
 * 2. Method name lookup: "logger.success" → "Logger.success"
 * Returns an empty array if no resolution is found.
 */
function resolveCallee(
  callee: string,
  callerClass: string | null,
  methodToQualified: Map<string, string[]>,
  allKeys: Set<string>
): string[] {
  const calleeDotIdx = callee.indexOf('.');
  const calleeMethod = calleeDotIdx > 0 ? callee.substring(calleeDotIdx + 1) : callee;
  const calleeIsQualified = calleeDotIdx > 0;

  // Intra-class: this.method() → "ClassName.method"
  if (!calleeIsQualified && callerClass) {
    const sameClassCallee = `${callerClass}.${callee}`;
    if (allKeys.has(sameClassCallee)) {
      return [sameClassCallee];
    }
  }

  // Method name lookup: "logger.success" or "success" → "Logger.success"
  return methodToQualified.get(calleeMethod) || [];
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

  const methodToQualified = buildMethodIndex(allKeys);

  // Populate reverse mappings
  for (const [caller, callees] of Object.entries(callGraph)) {
    // Extract class name if caller is "ClassName.methodName"
    const dotIndex = caller.indexOf('.');
    const callerClass = dotIndex > 0 && !caller.startsWith('__module__')
      ? caller.substring(0, dotIndex)
      : null;

    for (const callee of callees) {
      addCaller(callee, caller);

      // If already a known key, no further resolution needed
      if (allKeys.has(callee)) continue;

      // Resolve to qualified key(s) and register those callers too
      const resolved = resolveCallee(callee, callerClass, methodToQualified, allKeys);
      for (const r of resolved) {
        addCaller(r, caller);
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
