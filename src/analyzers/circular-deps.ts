/**
 * Circular dependency detection using Tarjan's SCC algorithm.
 *
 * Finds strongly connected components in the import graph, then
 * computes the minimum cut (the single edge easiest to break)
 * for each cycle.
 */

import { ImportGraph } from './import-graph';
import { ParsedFile } from '../parsers/parser.interface';

export interface CycleEdge {
  sourceFile: string;
  targetFile: string;
  /** Specific symbols imported across this edge */
  symbols: string[];
}

export interface CycleData {
  /** Files involved in the cycle */
  files: string[];
  /** Every import edge in the cycle with details */
  edges: CycleEdge[];
  /** The edge with fewest symbols — easiest to break */
  minimumCut: CycleEdge | null;
  /** How many symbols cross the minimum cut edge */
  minimumCutSymbolCount: number;
}

/**
 * Tarjan's algorithm for finding strongly connected components.
 */
function tarjanSCC(graph: Map<string, string[]>): string[][] {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const result: string[][] = [];

  function strongConnect(v: string) {
    indices.set(v, index);
    lowLinks.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    const neighbors = graph.get(v) || [];
    for (const w of neighbors) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowLinks.set(v, Math.min(lowLinks.get(v)!, lowLinks.get(w)!));
      } else if (onStack.has(w)) {
        lowLinks.set(v, Math.min(lowLinks.get(v)!, indices.get(w)!));
      }
    }

    if (lowLinks.get(v) === indices.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      result.push(component);
    }
  }

  for (const v of graph.keys()) {
    if (!indices.has(v)) {
      strongConnect(v);
    }
  }

  return result;
}

/**
 * Compute the minimum cut edge (fewest symbols) for a cycle.
 */
function computeMinimumCut(
  edges: CycleEdge[]
): { minimumCut: CycleEdge | null; minimumCutSymbolCount: number } {
  let minimumCut: CycleEdge | null = null;
  let minSymbols = Infinity;

  for (const edge of edges) {
    const count = edge.symbols.length || 1; // At least 1 if we couldn't resolve symbols
    if (count < minSymbols) {
      minSymbols = count;
      minimumCut = edge;
    }
  }

  return {
    minimumCut,
    minimumCutSymbolCount: minimumCut ? (minimumCut.symbols.length || 1) : 0,
  };
}

/**
 * Build a symbol map for each import edge: source → target → symbols.
 */
function buildSymbolMap(parsedFiles: ParsedFile[]): Map<string, Map<string, string[]>> {
  const symbolMap = new Map<string, Map<string, string[]>>();

  for (const parsed of parsedFiles) {
    const source = parsed.file.relative;
    if (!symbolMap.has(source)) symbolMap.set(source, new Map());

    for (const imp of parsed.imports) {
      // Store symbols per import source
      const targets = symbolMap.get(source)!;
      if (!targets.has(imp.from)) targets.set(imp.from, []);
      targets.get(imp.from)!.push(...imp.symbols);
    }
  }

  return symbolMap;
}

/**
 * Detect circular dependencies in the import graph.
 * Returns structured cycle data with minimum cut analysis.
 */
export function detectCircularDeps(
  importGraph: ImportGraph,
  parsedFiles: ParsedFile[]
): CycleData[] {
  // Convert ImportGraph to adjacency list
  const graph = new Map<string, string[]>();
  for (const [file, imports] of Object.entries(importGraph)) {
    graph.set(file, imports);
  }
  // Ensure all imported files are nodes even if they have no outgoing edges
  for (const imports of Object.values(importGraph)) {
    for (const imp of imports) {
      if (!graph.has(imp)) graph.set(imp, []);
    }
  }

  const symbolMap = buildSymbolMap(parsedFiles);

  // Find SCCs
  const sccs = tarjanSCC(graph);

  // Filter to only cycles (SCCs with >1 node)
  const cycles: CycleData[] = [];

  for (const scc of sccs) {
    if (scc.length <= 1) continue;

    const fileSet = new Set(scc);
    const edges: CycleEdge[] = [];

    // Find all edges within this SCC
    for (const file of scc) {
      const imports = graph.get(file) || [];
      for (const imp of imports) {
        if (fileSet.has(imp) && imp !== file) {
          // Look up symbols for this edge
          const fileSymbolMap = symbolMap.get(file);
          let symbols: string[] = [];
          if (fileSymbolMap) {
            // Try to find symbols — the import specifier in parsedFiles may differ from resolved path
            for (const [specifier, syms] of fileSymbolMap) {
              if (imp.endsWith(specifier.replace(/^\.\//, '')) || imp.includes(specifier)) {
                symbols = syms;
                break;
              }
            }
          }

          edges.push({ sourceFile: file, targetFile: imp, symbols });
        }
      }
    }

    // Find minimum cut: the edge with fewest symbols
    const { minimumCut, minimumCutSymbolCount } = computeMinimumCut(edges);

    cycles.push({
      files: scc.sort(),
      edges,
      minimumCut,
      minimumCutSymbolCount,
    });
  }

  return cycles;
}
