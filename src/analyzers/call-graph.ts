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
 */
export function buildCallGraph(parsedFiles: ParsedFile[]): CallGraph {
  const graph: CallGraph = {};

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
  }

  return graph;
}

/**
 * Build a reverse call graph (callee → callers).
 * Useful for dead code detection.
 */
export function buildReverseCallGraph(callGraph: CallGraph): ReverseCallGraph {
  const reverse: ReverseCallGraph = {};

  // Initialize all known functions with empty arrays
  for (const caller of Object.keys(callGraph)) {
    if (!reverse[caller]) {
      reverse[caller] = [];
    }
  }

  // Populate reverse mappings
  for (const [caller, callees] of Object.entries(callGraph)) {
    for (const callee of callees) {
      if (!reverse[callee]) {
        reverse[callee] = [];
      }
      if (!reverse[callee].includes(caller)) {
        reverse[callee].push(caller);
      }
    }
  }

  return reverse;
}
