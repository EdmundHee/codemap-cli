/**
 * Shared query engine for codemap data.
 * Used by both the CLI query command and the MCP server tools.
 */

import { CodemapData } from '../output/json-generator';
import { clusterSearchResults, ClusteredSearchResult } from '../analyzers/cluster';

export interface QueryResult {
  type: 'function' | 'class' | 'method' | 'file' | 'module' | 'type' | 'summary';
  name: string;
  file?: string;
  data: any;
}

function dirFromPath(filePath: string): string {
  return filePath.includes('/') ? filePath.split('/').slice(0, -1).join('/') : '.';
}

function buildModuleStats(data: CodemapData): Record<string, { files: number; classes: number; functions: number; types: number }> {
  const modules: Record<string, { files: number; classes: number; functions: number; types: number }> = {};

  for (const filePath of Object.keys(data.files)) {
    const dir = dirFromPath(filePath);
    if (!modules[dir]) modules[dir] = { files: 0, classes: 0, functions: 0, types: 0 };
    modules[dir].files++;
  }

  for (const [, cls] of Object.entries(data.classes) as [string, any][]) {
    const dir = dirFromPath(cls.file);
    if (modules[dir]) modules[dir].classes++;
  }

  for (const [, func] of Object.entries(data.functions) as [string, any][]) {
    const dir = dirFromPath(func.file);
    if (modules[dir]) modules[dir].functions++;
  }

  for (const [, type] of Object.entries(data.types) as [string, any][]) {
    const dir = dirFromPath(type.file);
    if (modules[dir]) modules[dir].types++;
  }

  return modules;
}

function buildFrameworkSummary(data: CodemapData): any {
  const framework_data: any = {};
  if (data.routes?.length > 0) framework_data.routes = data.routes.length;
  if (data.models && Object.keys(data.models).length > 0) {
    framework_data.models = Object.keys(data.models).length;
  }
  if (data.middleware && Object.keys(data.middleware).length > 0) {
    framework_data.middleware = Object.keys(data.middleware).length;
  }
  const extData = data as any;
  if (extData.signals?.length > 0) framework_data.signals = extData.signals.length;
  if (extData.admin?.length > 0) framework_data.admin_registrations = extData.admin.length;
  if (extData.forms?.length > 0) framework_data.forms = extData.forms.length;
  if (extData.di_providers?.length > 0) framework_data.dependency_providers = extData.di_providers.length;
  if (extData.plugins?.length > 0) framework_data.plugins = extData.plugins.length;
  if (extData.layouts?.length > 0) framework_data.layouts = extData.layouts.length;
  if (extData.components?.length > 0) framework_data.components = extData.components.length;
  return framework_data;
}

/**
 * Get a high-level project overview.
 */
export function getOverview(data: CodemapData): any {
  const modules = buildModuleStats(data);
  const framework_data = buildFrameworkSummary(data);

  return {
    project: data.project.name,
    languages: data.project.languages,
    frameworks: data.project.frameworks,
    entry_points: data.project.entry_points,
    totals: {
      files: Object.keys(data.files).length,
      classes: Object.keys(data.classes).length,
      functions: Object.keys(data.functions).length,
      types: Object.keys(data.types).length,
    },
    modules,
    dependencies: data.dependencies,
    ...(Object.keys(framework_data).length > 0 ? { framework_data } : {}),
  };
}

/**
 * Get detailed info about a specific module/directory.
 */
export function getModule(data: CodemapData, directory: string): any | null {
  const moduleFiles = Object.keys(data.files).filter((f) => {
    const fileDir = f.includes('/') ? f.split('/').slice(0, -1).join('/') : '.';
    return fileDir === directory || fileDir.startsWith(directory + '/');
  });

  if (moduleFiles.length === 0) return null;

  const filePaths = new Set(moduleFiles);

  const classes = Object.entries(data.classes)
    .filter(([, cls]: [string, any]) => filePaths.has(cls.file))
    .map(([name, cls]: [string, any]) => ({
      name,
      file: cls.file,
      extends: cls.extends,
      implements: cls.implements,
      decorators: cls.decorators,
      methods: cls.methods.map((m: any) => m.name),
      properties: cls.properties?.map((p: any) => `${p.name}: ${p.type}`),
    }));

  const functions = Object.entries(data.functions)
    .filter(([, func]: [string, any]) => filePaths.has(func.file))
    .map(([name, func]: [string, any]) => ({
      name,
      file: func.file,
      params: func.params.map((p: any) => `${p.name}: ${p.type}`).join(', '),
      return_type: func.return_type,
      exported: func.exported,
      calls: func.calls,
      called_by: func.called_by,
    }));

  const types = Object.entries(data.types)
    .filter(([, type]: [string, any]) => filePaths.has(type.file))
    .map(([name, type]: [string, any]) => ({
      name,
      file: type.file,
      kind: type.kind,
      exported: type.exported,
    }));

  const imports: Record<string, any[]> = {};
  for (const filePath of moduleFiles) {
    const fileData = data.files[filePath];
    if (fileData?.imports?.length) {
      imports[filePath] = fileData.imports;
    }
  }

  return {
    directory,
    files: moduleFiles,
    classes,
    functions,
    types,
    imports,
  };
}

/**
 * Search across all names (classes, functions, methods, types, files).
 * Used as a fuzzy fallback in codemap_query when exact lookups fail.
 */
export function search(data: CodemapData, term: string): QueryResult[] {
  const lowerTerm = term.toLowerCase();
  const results: QueryResult[] = [];

  // Search files
  for (const filePath of Object.keys(data.files)) {
    if (filePath.toLowerCase().includes(lowerTerm)) {
      results.push({ type: 'file', name: filePath, file: filePath, data: data.files[filePath] });
    }
  }

  // Search classes
  for (const [name, cls] of Object.entries(data.classes) as [string, any][]) {
    if (name.toLowerCase().includes(lowerTerm)) {
      results.push({ type: 'class', name, file: cls.file, data: cls });
    }
    for (const method of cls.methods) {
      if (method.name.toLowerCase().includes(lowerTerm)) {
        results.push({
          type: 'method',
          name: `${name}.${method.name}`,
          file: cls.file,
          data: { ...method, class: name },
        });
      }
    }
  }

  // Search functions
  for (const [name, func] of Object.entries(data.functions) as [string, any][]) {
    if (name.toLowerCase().includes(lowerTerm)) {
      results.push({ type: 'function', name, file: func.file, data: func });
    }
  }

  // Search types
  for (const [name, type] of Object.entries(data.types) as [string, any][]) {
    if (name.toLowerCase().includes(lowerTerm)) {
      results.push({ type: 'type', name, file: type.file, data: type });
    }
  }

  // Search routes
  for (const route of (data.routes || []) as any[]) {
    if (
      route.handler?.toLowerCase().includes(lowerTerm) ||
      route.path?.toLowerCase().includes(lowerTerm)
    ) {
      const methods = Array.isArray(route.method) ? route.method.join(',') : route.method;
      results.push({
        type: 'function',
        name: `[${methods}] ${route.path} → ${route.handler}`,
        file: route.file,
        data: route,
      });
    }
  }

  // Search models
  for (const [name, model] of Object.entries(data.models || {}) as [string, any][]) {
    if (name.toLowerCase().includes(lowerTerm)) {
      results.push({ type: 'class', name: `${model.kind}: ${name}`, file: model.file, data: model });
    }
  }

  return results;
}

/**
 * Clustered search: groups matching results by call-graph relationships.
 *
 * Instead of returning a flat list of 20 matches, identifies the "hub"
 * functions (tree roots) and folds child helpers under them. The LLM gets
 * the big picture with fewer tokens and can drill deeper if needed.
 *
 * Example: searching "parse" might return 3 hubs instead of 20 flat matches:
 *   parseConfig (hub, 5 related) — parseYaml, parseEnv, validateConfig, ...
 *   parseToken (hub, 3 related) — decodeJWT, validateSignature, ...
 *   parseDate (standalone)
 */
export function searchClustered(data: CodemapData, term: string): ClusteredSearchResult[] {
  const results = search(data, term);
  if (results.length <= 3) {
    // Few results: no need to cluster, return as single-item clusters
    return results.map((r) => ({
      hub: { name: r.name, type: r.type as any, file: r.file },
      children: [],
      size: 1,
    }));
  }
  return clusterSearchResults(results, data.call_graph);
}

/**
 * BFS/DFS traversal from a function through the call graph.
 * Returns the neighborhood of a function: what it calls, what calls it,
 * up to a configurable depth. Inspired by graphify's query_graph.
 */
export function exploreFunction(
  data: CodemapData,
  name: string,
  options: { depth?: number; direction?: 'calls' | 'callers' | 'both' } = {}
): {
  root: string;
  nodes: Array<{ name: string; file?: string; depth: number; relation: 'calls' | 'called_by' | 'root' }>;
  edges: Array<{ from: string; to: string }>;
} | null {
  const depth = Math.min(options.depth || 2, 5);
  const direction = options.direction || 'both';

  // Verify the function exists in the call graph
  const hasKey = data.call_graph[name] !== undefined;
  const hasCaller = Object.values(data.call_graph).some((callees) => callees.includes(name));
  if (!hasKey && !hasCaller) return null;

  const visited = new Set<string>();
  const nodes: Array<{ name: string; file?: string; depth: number; relation: 'calls' | 'called_by' | 'root' }> = [];
  const edges: Array<{ from: string; to: string }> = [];

  // Resolve file for a function name
  function getFile(fn: string): string | undefined {
    const func = data.functions[fn];
    if (func) return func.file;
    const dotIdx = fn.indexOf('.');
    if (dotIdx > 0) {
      const clsName = fn.substring(0, dotIdx);
      const cls = data.classes[clsName];
      if (cls) return cls.file;
    }
    return undefined;
  }

  // Add root
  visited.add(name);
  nodes.push({ name, file: getFile(name), depth: 0, relation: 'root' });

  // BFS forward (calls)
  if (direction === 'calls' || direction === 'both') {
    let frontier = new Set<string>([name]);
    for (let d = 1; d <= depth; d++) {
      const nextFrontier = new Set<string>();
      for (const fn of frontier) {
        const callees = data.call_graph[fn] || [];
        for (const callee of callees) {
          if (visited.has(callee)) continue;
          visited.add(callee);
          nodes.push({ name: callee, file: getFile(callee), depth: d, relation: 'calls' });
          edges.push({ from: fn, to: callee });
          nextFrontier.add(callee);
        }
      }
      frontier = nextFrontier;
      if (frontier.size === 0) break;
    }
  }

  // BFS backward (callers)
  if (direction === 'callers' || direction === 'both') {
    let frontier = new Set<string>([name]);
    for (let d = 1; d <= depth; d++) {
      const nextFrontier = new Set<string>();
      for (const fn of frontier) {
        for (const [caller, callees] of Object.entries(data.call_graph)) {
          if (callees.includes(fn) && !visited.has(caller)) {
            visited.add(caller);
            nodes.push({ name: caller, file: getFile(caller), depth: d, relation: 'called_by' });
            edges.push({ from: caller, to: fn });
            nextFrontier.add(caller);
          }
        }
      }
      frontier = nextFrontier;
      if (frontier.size === 0) break;
    }
  }

  return { root: name, nodes, edges };
}

/**
 * Find all callers of a function/method.
 */
export function getCallers(data: CodemapData, name: string): { function: string; callers: string[] } {
  const callers: string[] = [];

  for (const [caller, callees] of Object.entries(data.call_graph)) {
    if (callees.includes(name)) {
      callers.push(caller);
    }
  }

  return { function: name, callers };
}

/**
 * Find all functions/methods called by a function/method.
 */
export function getCalls(data: CodemapData, name: string): { function: string; calls: string[] } {
  const calls = data.call_graph[name] || [];
  return { function: name, calls };
}

/**
 * Query a specific function by name (standalone or class method).
 */
export function getFunction(data: CodemapData, name: string): QueryResult | null {
  // Check standalone functions
  const func = data.functions[name];
  if (func) {
    return { type: 'function', name, file: func.file, data: func };
  }

  // Check class methods
  for (const [clsName, cls] of Object.entries(data.classes) as [string, any][]) {
    for (const method of cls.methods) {
      if (method.name === name || `${clsName}.${method.name}` === name) {
        return {
          type: 'method',
          name: `${clsName}.${method.name}`,
          file: cls.file,
          data: { ...method, class: clsName, file: cls.file },
        };
      }
    }
  }

  return null;
}

/**
 * Query a specific class by name.
 */
export function getClass(data: CodemapData, name: string): QueryResult | null {
  const cls = data.classes[name];
  if (!cls) return null;
  return { type: 'class', name, file: cls.file, data: cls };
}

/**
 * Query a specific file by path (supports partial matching).
 */
export function getFile(data: CodemapData, filePath: string): QueryResult | QueryResult[] | null {
  const fileData = data.files[filePath];
  if (fileData) {
    // Gather all entities in this file
    const classes = Object.entries(data.classes)
      .filter(([, cls]: [string, any]) => cls.file === filePath)
      .map(([name, cls]) => ({ name, ...cls }));
    const functions = Object.entries(data.functions)
      .filter(([, func]: [string, any]) => func.file === filePath)
      .map(([name, func]) => ({ name, ...func }));
    const types = Object.entries(data.types)
      .filter(([, type]: [string, any]) => type.file === filePath)
      .map(([name, type]) => ({ name, ...type }));

    return {
      type: 'file',
      name: filePath,
      file: filePath,
      data: { ...fileData, classes, functions, types },
    };
  }

  // Partial match
  const matches = Object.keys(data.files).filter((f) => f.includes(filePath));
  if (matches.length === 0) return null;
  if (matches.length === 1) return getFile(data, matches[0]) as QueryResult;

  return matches.map((m) => ({
    type: 'file' as const,
    name: m,
    file: m,
    data: data.files[m],
  }));
}

/**
 * Query a specific type/interface by name.
 */
export function getType(data: CodemapData, name: string): QueryResult | null {
  const type = data.types[name];
  if (!type) return null;
  return { type: 'type', name, file: type.file, data: type };
}

// ─── Framework-specific queries ────────────────────────────────────────────

/**
 * Get all routes, optionally filtered by method, path, or framework.
 */
export function getRoutes(
  data: CodemapData,
  filter?: { method?: string; path?: string; framework?: string }
): any[] {
  let routes = data.routes || [];

  if (filter?.method) {
    const m = filter.method.toUpperCase();
    routes = routes.filter((r: any) => {
      const methods = Array.isArray(r.method) ? r.method : [r.method];
      return methods.some((rm: string) => rm.toUpperCase() === m || rm === 'ALL');
    });
  }

  if (filter?.path) {
    const p = filter.path.toLowerCase();
    routes = routes.filter((r: any) => r.path?.toLowerCase().includes(p));
  }

  if (filter?.framework) {
    routes = routes.filter((r: any) => r.framework === filter.framework);
  }

  return routes;
}

/**
 * Get all models, optionally filtered by framework or kind.
 */
export function getModels(
  data: CodemapData,
  filter?: { framework?: string; kind?: string }
): any[] {
  const models = Object.entries(data.models || {}).map(([name, model]: [string, any]) => ({
    name,
    ...model,
  }));

  let filtered = models;

  if (filter?.framework) {
    filtered = filtered.filter((m) => m.framework === filter.framework);
  }

  if (filter?.kind) {
    filtered = filtered.filter((m) => m.kind === filter.kind);
  }

  return filtered;
}

/**
 * Get all middleware entries, optionally filtered by framework.
 */
export function getMiddleware(
  data: CodemapData,
  filter?: { framework?: string }
): any[] {
  const mws = Object.entries(data.middleware || {}).map(([key, mw]: [string, any]) => ({
    key,
    ...mw,
  }));

  if (filter?.framework) {
    return mws.filter((m) => m.framework === filter.framework);
  }

  return mws;
}

function addFrameworkExtras(result: any, extData: any, framework: string): void {
  if (framework === 'django') {
    if (extData.signals?.length) result.signals = extData.signals.filter((s: any) => s.framework === 'django');
    if (extData.admin?.length) result.admin = extData.admin;
    if (extData.forms?.length) result.forms = extData.forms;
    if (extData.management_commands?.length) result.management_commands = extData.management_commands;
    if (extData.template_tags?.length) result.template_tags = extData.template_tags;
  } else if (framework === 'fastapi') {
    if (extData.di_providers?.length) result.di_providers = extData.di_providers;
    if (extData.security_schemes?.length) result.security_schemes = extData.security_schemes;
  } else if (framework === 'nuxt') {
    if (extData.plugins?.length) result.plugins = extData.plugins;
    if (extData.layouts?.length) result.layouts = extData.layouts;
    if (extData.components?.length) result.components = extData.components;
  }
}

/**
 * Get complete framework data summary for a specific framework.
 */
export function getFrameworkData(data: CodemapData, framework: string): any {
  const result: any = {
    framework,
    routes: (data.routes || []).filter((r: any) => r.framework === framework),
    models: Object.entries(data.models || {})
      .filter(([, m]: [string, any]) => m.framework === framework)
      .map(([name, m]) => ({ name, ...m as any })),
    middleware: Object.entries(data.middleware || {})
      .filter(([, m]: [string, any]) => m.framework === framework)
      .map(([key, m]) => ({ key, ...m as any })),
  };

  addFrameworkExtras(result, data as any, framework);
  return result;
}

// ─── File dependency queries ─────────────────────────────────────────────

/**
 * Resolve a file path to an exact match in the import graph.
 * Supports partial matching (e.g. "query-engine" matches "src/core/query-engine.ts").
 */
function resolveFilePath(data: CodemapData, filePath: string): string | string[] | null {
  // Exact match
  if (data.import_graph[filePath]) return filePath;
  if (data.files[filePath]) return filePath;

  // Partial match
  const allFiles = new Set([
    ...Object.keys(data.files),
    ...Object.keys(data.import_graph),
  ]);
  const matches = [...allFiles].filter((f) => f.includes(filePath));

  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  return matches;
}

/**
 * Get file-level dependencies: what a file imports.
 */
export function getFileDependencies(
  data: CodemapData,
  filePath: string
): { file: string; imports: string[] } | { file: string; imports: string[] }[] | null {
  const resolved = resolveFilePath(data, filePath);
  if (!resolved) return null;

  if (Array.isArray(resolved)) {
    return resolved.map((f) => ({
      file: f,
      imports: data.import_graph[f] || [],
    }));
  }

  return {
    file: resolved,
    imports: data.import_graph[resolved] || [],
  };
}

/**
 * Get file-level dependents: what files import a given file.
 */
export function getFileDependents(
  data: CodemapData,
  filePath: string
): { file: string; imported_by: string[] } | { file: string; imported_by: string[] }[] | null {
  const resolved = resolveFilePath(data, filePath);
  if (!resolved) return null;

  function findDependents(target: string): string[] {
    const dependents: string[] = [];
    for (const [source, deps] of Object.entries(data.import_graph)) {
      if (deps.includes(target)) {
        dependents.push(source);
      }
    }
    return dependents;
  }

  if (Array.isArray(resolved)) {
    return resolved.map((f) => ({
      file: f,
      imported_by: findDependents(f),
    }));
  }

  return {
    file: resolved,
    imported_by: findDependents(resolved),
  };
}

// ─── Analysis from codemap data ──────────────────────────────────────────

export interface DuplicateGroupData {
  signature: string;
  functions: Array<{ name: string; file: string; params: string; calls: string[] }>;
  similarity: number;
}

/**
 * Compute Jaccard similarity between two string arrays.
 */
function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Detect duplicate functions from pre-built codemap data.
 * Same algorithm as src/analyzers/duplicates.ts but operates on CodemapData
 * instead of ParsedFile[].
 */
export function computeDuplicatesFromData(data: CodemapData, scope?: string): DuplicateGroupData[] {
  const allFunctions: Array<{ name: string; file: string; paramSignature: string; calls: string[] }> = [];

  // Collect standalone functions
  for (const [name, func] of Object.entries(data.functions) as [string, any][]) {
    if (scope && !func.file?.startsWith(scope)) continue;
    allFunctions.push({
      name,
      file: func.file,
      paramSignature: (func.params || []).map((p: any) => `${p.name}:${p.type}`).join(','),
      calls: func.calls || [],
    });
  }

  // Collect class methods
  for (const [clsName, cls] of Object.entries(data.classes) as [string, any][]) {
    if (scope && !cls.file?.startsWith(scope)) continue;
    for (const method of cls.methods || []) {
      allFunctions.push({
        name: `${clsName}.${method.name}`,
        file: cls.file,
        paramSignature: (method.params || []).map((p: any) => `${p.name}:${p.type}`).join(','),
        calls: method.calls || [],
      });
    }
  }

  // Group by base name
  const nameGroups = new Map<string, typeof allFunctions>();
  for (const func of allFunctions) {
    const baseName = func.name.includes('.') ? func.name.split('.').pop()! : func.name;
    if (!nameGroups.has(baseName)) nameGroups.set(baseName, []);
    nameGroups.get(baseName)!.push(func);
  }

  const duplicates: DuplicateGroupData[] = [];

  for (const [name, funcs] of nameGroups) {
    if (funcs.length <= 1) continue;
    const uniqueFiles = new Set(funcs.map((f) => f.file));
    if (uniqueFiles.size <= 1) continue;

    let maxSimilarity = 0;
    for (let i = 0; i < funcs.length; i++) {
      for (let j = i + 1; j < funcs.length; j++) {
        const sim = jaccardSimilarity(funcs[i].calls, funcs[j].calls);
        if (sim > maxSimilarity) maxSimilarity = sim;
      }
    }

    const sigMatch = funcs.some((a, i) =>
      funcs.some((b, j) => i !== j && a.paramSignature === b.paramSignature && a.paramSignature !== '')
    );

    if (maxSimilarity > 0.3 || sigMatch) {
      duplicates.push({
        signature: name,
        functions: funcs.map((f) => ({
          name: f.name,
          file: f.file,
          params: f.paramSignature,
          calls: f.calls,
        })),
        similarity: Math.round(maxSimilarity * 100) / 100,
      });
    }
  }

  duplicates.sort((a, b) => b.similarity - a.similarity);
  return duplicates;
}

export interface CircularDepData {
  files: string[];
  edges: Array<{ source: string; target: string }>;
  minimum_cut: { source: string; target: string; weight: number } | null;
}

/**
 * Detect circular dependencies from import_graph using Tarjan's SCC.
 * Operates directly on CodemapData without needing ParsedFile[].
 */
export function computeCircularDepsFromData(data: CodemapData): CircularDepData[] {
  const graph = new Map<string, string[]>();

  // Build graph from import_graph
  for (const [file, imports] of Object.entries(data.import_graph)) {
    graph.set(file, imports);
  }
  // Ensure all imported files are nodes too
  for (const imports of Object.values(data.import_graph)) {
    for (const imp of imports) {
      if (!graph.has(imp)) graph.set(imp, []);
    }
  }

  // Tarjan's SCC
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const sccs: string[][] = [];

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
      sccs.push(component);
    }
  }

  for (const v of graph.keys()) {
    if (!indices.has(v)) strongConnect(v);
  }

  // Filter to cycles (SCCs with >1 node)
  const cycles: CircularDepData[] = [];
  for (const scc of sccs) {
    if (scc.length <= 1) continue;

    const fileSet = new Set(scc);
    const edges: Array<{ source: string; target: string }> = [];

    for (const file of scc) {
      const imports = graph.get(file) || [];
      for (const imp of imports) {
        if (fileSet.has(imp) && imp !== file) {
          edges.push({ source: file, target: imp });
        }
      }
    }

    // Find minimum cut (edge with fewest connections)
    let minimumCut: { source: string; target: string; weight: number } | null = null;
    const edgeWeights = new Map<string, number>();
    for (const edge of edges) {
      const key = `${edge.source}→${edge.target}`;
      edgeWeights.set(key, (edgeWeights.get(key) || 0) + 1);
    }

    let minWeight = Infinity;
    for (const edge of edges) {
      const key = `${edge.source}→${edge.target}`;
      const weight = edgeWeights.get(key) || 1;
      if (weight < minWeight) {
        minWeight = weight;
        minimumCut = { source: edge.source, target: edge.target, weight };
      }
    }

    cycles.push({
      files: scc.sort(),
      edges,
      minimum_cut: minimumCut,
    });
  }

  return cycles;
}
