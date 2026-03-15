/**
 * Class cohesion analysis using LCOM4 (Lack of Cohesion of Methods).
 *
 * LCOM4 measures how many disconnected groups of methods exist in a class:
 * - Two methods are connected if they share an instance variable access
 *   or if one calls the other
 * - LCOM = number of connected components in this graph
 * - LCOM=1 means the class is fully cohesive (all methods work together)
 * - LCOM>1 means the class has N independent concerns and could be split
 *
 * Returns the actual clusters (connected components) with their methods
 * and shared state, so Claude Code can decide how to split.
 */

import { CodemapData } from '../output/json-generator';
import { ParsedFile, ClassInfo, MethodInfo } from '../parsers/parser.interface';

export interface CohesionCluster {
  /** Methods in this cluster */
  methods: string[];
  /** Instance variables shared by methods in this cluster */
  sharedState: string[];
  /** Methods within this cluster that call each other */
  internalCalls: string[];
  /** External callers: file → which methods from this cluster they call */
  externalCallers: Record<string, string[]>;
}

export interface ClassCohesionData {
  className: string;
  file: string;
  methodCount: number;
  /** Number of connected components — 1 = cohesive, >1 = split candidate */
  lcom: number;
  /** The actual clusters (empty if lcom <= 1) */
  clusters: CohesionCluster[];
}

/**
 * Union-Find data structure for connected components.
 */
class UnionFind {
  private parent: Map<string, string>;
  private rank: Map<string, number>;

  constructor(elements: string[]) {
    this.parent = new Map();
    this.rank = new Map();
    for (const e of elements) {
      this.parent.set(e, e);
      this.rank.set(e, 0);
    }
  }

  find(x: string): string {
    if (this.parent.get(x) !== x) {
      this.parent.set(x, this.find(this.parent.get(x)!));
    }
    return this.parent.get(x)!;
  }

  union(x: string, y: string): void {
    const rootX = this.find(x);
    const rootY = this.find(y);
    if (rootX === rootY) return;

    const rankX = this.rank.get(rootX)!;
    const rankY = this.rank.get(rootY)!;
    if (rankX < rankY) {
      this.parent.set(rootX, rootY);
    } else if (rankX > rankY) {
      this.parent.set(rootY, rootX);
    } else {
      this.parent.set(rootY, rootX);
      this.rank.set(rootX, rankX + 1);
    }
  }

  getComponents(): Map<string, string[]> {
    const components = new Map<string, string[]>();
    for (const element of this.parent.keys()) {
      const root = this.find(element);
      if (!components.has(root)) components.set(root, []);
      components.get(root)!.push(element);
    }
    return components;
  }
}

/**
 * Connect methods that share instance variables using Union-Find.
 */
function connectBySharedVars(
  methods: MethodInfo[],
  uf: UnionFind,
  methodVars: Map<string, Set<string>>
): void {
  for (let i = 0; i < methods.length; i++) {
    const varsI = methodVars.get(methods[i].name)!;
    for (let j = i + 1; j < methods.length; j++) {
      const varsJ = methodVars.get(methods[j].name)!;
      // Check intersection
      for (const v of varsI) {
        if (varsJ.has(v)) {
          uf.union(methods[i].name, methods[j].name);
          break;
        }
      }
    }
  }
}

/**
 * Build cohesion clusters from connected components.
 */
function buildCohesionClusters(
  components: Map<string, string[]>,
  methods: MethodInfo[],
  methodVars: Map<string, Set<string>>,
  cls: ClassInfo,
  reverseCallGraph: Record<string, string[]>
): CohesionCluster[] {
  const clusters: CohesionCluster[] = [];

  for (const [, componentMethods] of components) {
    // Collect shared state for this cluster
    const allVars = new Set<string>();
    for (const methodName of componentMethods) {
      const vars = methodVars.get(methodName);
      if (vars) {
        for (const v of vars) allVars.add(v);
      }
    }

    // Find internal calls (method-to-method within this cluster)
    const methodSet = new Set(componentMethods);
    const internalCalls: string[] = [];
    for (const methodName of componentMethods) {
      const method = methods.find(m => m.name === methodName);
      if (!method) continue;
      for (const call of method.calls) {
        if (methodSet.has(call) && call !== methodName) {
          internalCalls.push(`${methodName} → ${call}`);
        }
      }
    }

    // Find external callers from reverse call graph
    const externalCallers: Record<string, string[]> = {};
    for (const methodName of componentMethods) {
      const qualifiedName = `${cls.name}.${methodName}`;
      const callers = reverseCallGraph[qualifiedName] || [];
      for (const caller of callers) {
        // Skip internal callers (same class)
        if (caller.startsWith(`${cls.name}.`)) continue;
        if (!externalCallers[caller]) externalCallers[caller] = [];
        externalCallers[caller].push(methodName);
      }
    }

    clusters.push({
      methods: componentMethods.sort(),
      sharedState: Array.from(allVars).sort(),
      internalCalls,
      externalCallers,
    });
  }

  // Sort clusters by size descending
  clusters.sort((a, b) => b.methods.length - a.methods.length);

  return clusters;
}

/**
 * Compute cohesion data for a single class.
 */
function analyzeClassCohesion(
  cls: ClassInfo,
  file: string,
  reverseCallGraph: Record<string, string[]>
): ClassCohesionData {
  const methods = cls.methods;
  if (methods.length <= 1) {
    return { className: cls.name, file, methodCount: methods.length, lcom: 1, clusters: [] };
  }

  const methodNames = methods.map(m => m.name);
  const uf = new UnionFind(methodNames);

  // Build method → instance var accesses map
  const methodVars = new Map<string, Set<string>>();
  for (const method of methods) {
    methodVars.set(method.name, new Set(method.instanceVarAccesses || []));
  }

  // Connect methods that share instance variables
  connectBySharedVars(methods, uf, methodVars);

  // Connect methods that call each other (within the class)
  const classMethodSet = new Set(methodNames);
  for (const method of methods) {
    for (const call of method.calls) {
      // Check if this call refers to another method in the same class
      if (classMethodSet.has(call)) {
        uf.union(method.name, call);
      }
    }
  }

  const components = uf.getComponents();
  const lcom = components.size;

  if (lcom <= 1) {
    return { className: cls.name, file, methodCount: methods.length, lcom: 1, clusters: [] };
  }

  // Build clusters with detail
  const clusters = buildCohesionClusters(components, methods, methodVars, cls, reverseCallGraph);

  return { className: cls.name, file, methodCount: methods.length, lcom, clusters };
}

/**
 * Compute cohesion data for all classes in the project.
 * Only returns classes with LCOM > 1 (split candidates) unless target is specified.
 */
export function computeCohesion(
  parsedFiles: ParsedFile[],
  reverseCallGraph: Record<string, string[]>,
  target?: string
): ClassCohesionData[] {
  const results: ClassCohesionData[] = [];

  for (const p of parsedFiles) {
    for (const cls of p.classes) {
      if (target && cls.name !== target) continue;

      const data = analyzeClassCohesion(cls, p.file.relative, reverseCallGraph);
      results.push(data);
    }
  }

  // Sort by LCOM descending (worst cohesion first)
  results.sort((a, b) => b.lcom - a.lcom);

  // If no target specified, only return split candidates
  if (!target) {
    return results.filter(r => r.lcom > 1);
  }

  return results;
}
