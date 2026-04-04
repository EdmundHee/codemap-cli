/**
 * Shared query engine for codemap data.
 * Used by both the CLI query command and the MCP server tools.
 */

import { CodemapData } from '../output/json-generator';

export interface QueryResult {
  type: 'function' | 'class' | 'method' | 'file' | 'module' | 'type' | 'summary';
  name: string;
  file?: string;
  data: any;
}

/**
 * Get a high-level project overview.
 */
export function getOverview(data: CodemapData): any {
  // Group files by directory
  const modules: Record<string, { files: number; classes: number; functions: number; types: number }> = {};

  for (const filePath of Object.keys(data.files)) {
    const dir = filePath.includes('/') ? filePath.split('/').slice(0, -1).join('/') : '.';
    if (!modules[dir]) {
      modules[dir] = { files: 0, classes: 0, functions: 0, types: 0 };
    }
    modules[dir].files++;
  }

  for (const [, cls] of Object.entries(data.classes) as [string, any][]) {
    const dir = cls.file.includes('/') ? cls.file.split('/').slice(0, -1).join('/') : '.';
    if (modules[dir]) modules[dir].classes++;
  }

  for (const [, func] of Object.entries(data.functions) as [string, any][]) {
    const dir = func.file.includes('/') ? func.file.split('/').slice(0, -1).join('/') : '.';
    if (modules[dir]) modules[dir].functions++;
  }

  for (const [, type] of Object.entries(data.types) as [string, any][]) {
    const dir = type.file.includes('/') ? type.file.split('/').slice(0, -1).join('/') : '.';
    if (modules[dir]) modules[dir].types++;
  }

  // Framework enrichment summary
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

/**
 * Get complete framework data summary for a specific framework.
 */
export function getFrameworkData(data: CodemapData, framework: string): any {
  const extData = data as any;
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

  // Add framework-specific extras
  if (framework === 'django') {
    if (extData.signals?.length) result.signals = extData.signals.filter((s: any) => s.framework === 'django');
    if (extData.admin?.length) result.admin = extData.admin;
    if (extData.forms?.length) result.forms = extData.forms;
    if (extData.management_commands?.length) result.management_commands = extData.management_commands;
    if (extData.template_tags?.length) result.template_tags = extData.template_tags;
  }

  if (framework === 'fastapi') {
    if (extData.di_providers?.length) result.di_providers = extData.di_providers;
    if (extData.security_schemes?.length) result.security_schemes = extData.security_schemes;
  }

  if (framework === 'nuxt') {
    if (extData.plugins?.length) result.plugins = extData.plugins;
    if (extData.layouts?.length) result.layouts = extData.layouts;
    if (extData.components?.length) result.components = extData.components;
  }

  return result;
}
