/**
 * Call-graph based function clustering and hub detection.
 *
 * Groups functions into clusters using connected components of the call graph,
 * then identifies "hub" functions — the tree roots that best represent each
 * cluster. This enables search results that surface the important entry points
 * instead of every leaf function, dramatically reducing token usage.
 *
 * Example: searching "parse" returns 3 hubs (parseConfig, parseToken, parseDate)
 * instead of 20 flat matches including their internal helpers.
 */

import { CallGraph } from './call-graph';

export interface FunctionCluster {
  /** Hub function name — the "root" that best represents this cluster */
  hub: string;
  /** Hub score (higher = more central) */
  hubScore: number;
  /** All function names in this cluster (including the hub) */
  members: string[];
  /** Number of members */
  size: number;
}

export interface ClusteredSearchResult {
  /** The hub (root) function of this result group */
  hub: {
    name: string;
    type: 'function' | 'class' | 'method' | 'type' | 'file';
    file?: string;
  };
  /** Child functions folded under this hub */
  children: Array<{
    name: string;
    type: 'function' | 'class' | 'method' | 'type' | 'file';
    file?: string;
  }>;
  /** Total count (hub + children) */
  size: number;
}

/**
 * Given a set of search results, cluster them using the call graph.
 *
 * Algorithm:
 *  1. Collect all search match names
 *  2. For each match, check if any OTHER match calls it
 *  3. If no other match calls it → it's a root (hub)
 *  4. If another match calls it → it's a child, folded under the nearest parent
 *  5. Return roots with their children
 *
 * This naturally gives you the "tree trunks" — the important entry points —
 * while folding away the internal helpers.
 */
export function clusterSearchResults(
  results: Array<{ type: string; name: string; file?: string; data?: any }>,
  callGraph: CallGraph
): ClusteredSearchResult[] {
  if (results.length <= 1) {
    return results.map((r) => ({
      hub: { name: r.name, type: r.type as any, file: r.file },
      children: [],
      size: 1,
    }));
  }

  const resultNames = new Set(results.map((r) => r.name));
  const resultMap = new Map(results.map((r) => [r.name, r]));

  // Build parent map: for each result, find which other results call it
  // A "parent" is a result that calls this result
  const parentOf = new Map<string, string>(); // child → parent (best one)
  const childrenOf = new Map<string, string[]>(); // parent → children

  for (const result of results) {
    const callerName = result.name;
    const callees = callGraph[callerName] || [];
    for (const callee of callees) {
      // Direct match
      if (resultNames.has(callee) && callee !== callerName) {
        recordParent(callee, callerName);
      }
      // Also check qualified form: "method" might match "Class.method"
      for (const rName of resultNames) {
        if (rName !== callerName && rName.endsWith('.' + callee)) {
          recordParent(rName, callerName);
        }
      }
    }
  }

  function recordParent(child: string, parent: string) {
    // Prefer the parent that is itself not a child of anyone
    // (break ties by first-seen)
    if (!parentOf.has(child)) {
      parentOf.set(child, parent);
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      childrenOf.get(parent)!.push(child);
    }
  }

  // Resolve transitive: if A calls B calls C, and all three match,
  // C should be under A (the ultimate root), not B.
  // Walk parent chains to find roots.
  function findRoot(name: string, visited: Set<string>): string {
    if (visited.has(name)) return name; // cycle protection
    visited.add(name);
    const parent = parentOf.get(name);
    if (!parent || !resultNames.has(parent)) return name;
    return findRoot(parent, visited);
  }

  // Group all results under their ultimate root
  const rootGroups = new Map<string, string[]>(); // root → all descendants

  for (const name of resultNames) {
    const root = findRoot(name, new Set());
    if (!rootGroups.has(root)) rootGroups.set(root, []);
    if (root !== name) {
      rootGroups.get(root)!.push(name);
    }
  }

  // Ensure roots that have no children still appear
  for (const name of resultNames) {
    const root = findRoot(name, new Set());
    if (!rootGroups.has(root)) rootGroups.set(root, []);
  }

  // Build output, sorted by cluster size descending
  const clusters: ClusteredSearchResult[] = [];

  for (const [rootName, childNames] of rootGroups) {
    const rootResult = resultMap.get(rootName);
    if (!rootResult) continue;

    clusters.push({
      hub: { name: rootResult.name, type: rootResult.type as any, file: rootResult.file },
      children: childNames
        .map((n) => {
          const r = resultMap.get(n);
          return r ? { name: r.name, type: r.type as any, file: r.file } : null;
        })
        .filter(Boolean) as any[],
      size: 1 + childNames.length,
    });
  }

  clusters.sort((a, b) => b.size - a.size);
  return clusters;
}

/**
 * Score how "hub-like" a function is within the full call graph.
 * Used to rank results when multiple roots are found.
 *
 * Scoring factors:
 * - callerCount (in-degree): heavily weighted — hubs are called by many
 * - calleeCount (out-degree): orchestrators call many functions
 * - exported: entry points get a bonus
 * - private/internal names: penalized
 */
export function scoreHubness(
  name: string,
  callGraph: CallGraph,
  functions: Record<string, any>,
  classes: Record<string, any>
): number {
  let score = 0;

  // In-degree (callers)
  let callerCount = 0;
  for (const callees of Object.values(callGraph)) {
    if (callees.includes(name)) callerCount++;
  }
  score += callerCount * 3;

  // Out-degree (callees)
  const callees = callGraph[name] || [];
  score += callees.length * 2;

  // Exported → likely an entry point
  const func = functions[name];
  if (func?.exported) score += 5;

  // Class method: public methods score higher
  const dotIdx = name.indexOf('.');
  if (dotIdx > 0) {
    const clsName = name.substring(0, dotIdx);
    const methodName = name.substring(dotIdx + 1);
    const cls = classes[clsName];
    if (cls) {
      const method = (cls.methods || []).find((m: any) => m.name === methodName);
      if (method && (method.access === 'public' || !method.access)) score += 2;
    }
  }

  // Penalize internal-looking names
  if (name.startsWith('_') || name.startsWith('__module__')) score -= 10;

  return score;
}

/**
 * Build function clusters from the full call graph using connected components.
 * Returns clusters sorted by size descending, each with an identified hub.
 */
export function buildFunctionClusters(
  callGraph: CallGraph,
  functions: Record<string, any>,
  classes: Record<string, any>
): FunctionCluster[] {
  // Build undirected adjacency list
  const adj = new Map<string, Set<string>>();
  const allNodes = new Set<string>();

  for (const [caller, callees] of Object.entries(callGraph)) {
    allNodes.add(caller);
    if (!adj.has(caller)) adj.set(caller, new Set());
    for (const callee of callees) {
      allNodes.add(callee);
      if (!adj.has(callee)) adj.set(callee, new Set());
      adj.get(caller)!.add(callee);
      adj.get(callee)!.add(caller);
    }
  }

  // BFS connected components
  const visited = new Set<string>();
  const components: string[][] = [];

  for (const node of allNodes) {
    if (visited.has(node)) continue;
    const component: string[] = [];
    const queue = [node];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      component.push(current);
      for (const neighbor of adj.get(current) || []) {
        if (!visited.has(neighbor)) queue.push(neighbor);
      }
    }
    components.push(component);
  }

  // For each component, find the hub
  const clusters: FunctionCluster[] = [];
  for (const members of components) {
    if (members.length === 0) continue;

    let bestHub = members[0];
    let bestScore = -Infinity;
    for (const member of members) {
      const s = scoreHubness(member, callGraph, functions, classes);
      if (s > bestScore) {
        bestScore = s;
        bestHub = member;
      }
    }

    clusters.push({
      hub: bestHub,
      hubScore: bestScore,
      members: members.sort(),
      size: members.length,
    });
  }

  clusters.sort((a, b) => b.size - a.size);
  return clusters;
}
