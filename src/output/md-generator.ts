import { CodemapData } from './json-generator';

/**
 * Helper: Extract directory from file path.
 */
function getDir(filePath: string): string {
  return filePath.includes('/') ? filePath.split('/').slice(0, -1).join('/') : '.';
}

/**
 * Helper: Build directory statistics from CodemapData.
 * Returns sorted array of [dir, stats] tuples.
 */
function generateDirStats(
  data: CodemapData
): Array<[string, { files: string[]; classes: string[]; functions: string[]; types: string[] }]> {
  const dirStats = new Map<string, {
    files: string[];
    classes: string[];
    functions: string[];
    types: string[];
  }>();

  // Aggregate files
  for (const filePath of Object.keys(data.files)) {
    const dir = getDir(filePath);
    if (!dirStats.has(dir)) dirStats.set(dir, { files: [], classes: [], functions: [], types: [] });
    dirStats.get(dir)!.files.push(filePath);
  }

  // Aggregate classes
  for (const [name, cls] of Object.entries(data.classes) as [string, any][]) {
    const dir = getDir(cls.file);
    if (dirStats.has(dir)) dirStats.get(dir)!.classes.push(name);
  }

  // Aggregate functions
  for (const [name, func] of Object.entries(data.functions) as [string, any][]) {
    const dir = getDir(func.file);
    if (dirStats.has(dir)) dirStats.get(dir)!.functions.push(name);
  }

  // Aggregate types
  for (const [name, type] of Object.entries(data.types) as [string, any][]) {
    const dir = getDir(type.file);
    if (dirStats.has(dir)) dirStats.get(dir)!.types.push(name);
  }

  return [...dirStats.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/**
 * Helper: Generate MODULES section.
 */
function generateModulesSection(
  sortedDirs: Array<[string, { files: string[]; classes: string[]; functions: string[]; types: string[] }]>
): string[] {
  const lines: string[] = [];
  lines.push('## MODULES');
  for (const [dir, stats] of sortedDirs) {
    const parts: string[] = [`${stats.files.length}f`];
    if (stats.classes.length > 0) parts.push(`${stats.classes.length}c`);
    if (stats.functions.length > 0) parts.push(`${stats.functions.length}fn`);
    if (stats.types.length > 0) parts.push(`${stats.types.length}t`);
    lines.push(`${dir}/ (${parts.join(', ')})`);
  }
  lines.push('');
  return lines;
}

/**
 * Helper: Generate CLASSES section.
 */
function generateClassesSection(
  sortedDirs: Array<[string, { files: string[]; classes: string[]; functions: string[]; types: string[] }]>
): string[] {
  const lines: string[] = [];
  const hasAny = sortedDirs.some(([, stats]) => stats.classes.length > 0);
  if (!hasAny) return lines;

  lines.push('## CLASSES');
  for (const [dir, stats] of sortedDirs) {
    if (stats.classes.length === 0) continue;
    lines.push(`${dir}/: ${stats.classes.join(', ')}`);
  }
  lines.push('');
  return lines;
}

/**
 * Helper: Generate FUNCTIONS section.
 */
function generateFunctionsSection(
  sortedDirs: Array<[string, { files: string[]; classes: string[]; functions: string[]; types: string[] }]>
): string[] {
  const lines: string[] = [];
  const hasAny = sortedDirs.some(([, stats]) => stats.functions.length > 0);
  if (!hasAny) return lines;

  lines.push('## FUNCTIONS');
  for (const [dir, stats] of sortedDirs) {
    if (stats.functions.length === 0) continue;
    if (stats.functions.length <= 20) {
      lines.push(`${dir}/: ${stats.functions.join(', ')}`);
    } else {
      // Show first 15 and count
      const shown = stats.functions.slice(0, 15).join(', ');
      lines.push(`${dir}/: ${shown} ... +${stats.functions.length - 15} more`);
    }
  }
  lines.push('');
  return lines;
}

/**
 * Helper: Generate TYPES section.
 */
function generateTypesSection(
  sortedDirs: Array<[string, { files: string[]; classes: string[]; functions: string[]; types: string[] }]>
): string[] {
  const lines: string[] = [];
  const hasAny = sortedDirs.some(([, stats]) => stats.types.length > 0);
  if (!hasAny) return lines;

  lines.push('## TYPES');
  for (const [dir, stats] of sortedDirs) {
    if (stats.types.length === 0) continue;
    if (stats.types.length <= 20) {
      lines.push(`${dir}/: ${stats.types.join(', ')}`);
    } else {
      const shown = stats.types.slice(0, 15).join(', ');
      lines.push(`${dir}/: ${shown} ... +${stats.types.length - 15} more`);
    }
  }
  lines.push('');
  return lines;
}

/**
 * Helper: Generate DEPENDENCIES section.
 */
function generateDepsSection(data: CodemapData): string[] {
  const lines: string[] = [];
  const pkgDeps = data.dependencies;
  if (!pkgDeps || Object.keys(pkgDeps.packages).length === 0) return lines;

  lines.push(`## DEPENDENCIES [${pkgDeps.source}]`);
  const byType = { production: [] as string[], dev: [] as string[], peer: [] as string[] };
  for (const [name, info] of Object.entries(pkgDeps.packages)) {
    byType[info.type].push(`${name}@${info.version}`);
  }
  if (byType.production.length) lines.push(`prod: ${byType.production.join(', ')}`);
  if (byType.dev.length) lines.push(`dev: ${byType.dev.join(', ')}`);
  if (byType.peer.length) lines.push(`peer: ${byType.peer.join(', ')}`);
  lines.push('');
  return lines;
}

/**
 * Helper: Generate ENV_DEPS section.
 */
function generateEnvSection(data: CodemapData): string[] {
  const lines: string[] = [];
  const envVars = data.config_dependencies?.env_vars;
  if (!envVars || Object.keys(envVars).length === 0) return lines;

  lines.push('## ENV_DEPS');
  for (const [varName, info] of Object.entries(envVars)) {
    lines.push(`${varName} → ${info.used_in.join(', ')}`);
  }
  lines.push('');
  return lines;
}

/**
 * Helper: Generate ROUTES section (from framework enrichers).
 */
function generateRoutesSection(data: CodemapData): string[] {
  const lines: string[] = [];
  if (!data.routes || data.routes.length === 0) return lines;

  lines.push('## ROUTES');
  for (const route of data.routes) {
    const methods = Array.isArray(route.method) ? route.method.join(',') : route.method;
    const auth = route.auth ? ` [auth: ${route.auth.join(', ')}]` : '';
    const framework = route.framework ? ` (${route.framework})` : '';
    lines.push(`${methods} ${route.path} → ${route.handler}${auth}${framework} [${route.file}]`);
  }
  lines.push('');
  return lines;
}

/**
 * Helper: Generate MODELS section (from framework enrichers).
 */
function generateModelsSection(data: CodemapData): string[] {
  const lines: string[] = [];
  if (!data.models || Object.keys(data.models).length === 0) return lines;

  lines.push('## MODELS');
  for (const [name, model] of Object.entries(data.models) as [string, any][]) {
    const kind = model.kind || 'model';
    const framework = model.framework ? ` (${model.framework})` : '';
    const ext = model.extends ? ` extends ${model.extends}` : '';
    lines.push(`${kind}: ${name}${ext}${framework} [${model.file}]`);

    // Show fields (compact)
    if (model.fields?.length > 0) {
      const fieldStrs = model.fields
        .slice(0, 10)
        .map((f: any) => {
          const rel = f.relationship ? ` → ${f.related_model || '?'}` : '';
          return `${f.name}: ${f.type}${rel}`;
        });
      const extra = model.fields.length > 10 ? ` ... +${model.fields.length - 10} more` : '';
      lines.push(`  fields: ${fieldStrs.join(', ')}${extra}`);
    }

    // Show relationships
    if (model.relationships?.length > 0) {
      lines.push(`  refs: ${model.relationships.join(', ')}`);
    }
  }
  lines.push('');
  return lines;
}

/**
 * Helper: Generate MIDDLEWARE section (from framework enrichers).
 */
function generateMiddlewareSection(data: CodemapData): string[] {
  const lines: string[] = [];
  if (!data.middleware || Object.keys(data.middleware).length === 0) return lines;

  lines.push('## MIDDLEWARE');
  for (const [name, mw] of Object.entries(data.middleware) as [string, any][]) {
    const type = mw.type || 'middleware';
    const framework = mw.framework ? ` (${mw.framework})` : '';
    const methods = mw.methods?.length > 0 ? ` [${mw.methods.join(', ')}]` : '';
    const global = mw.global ? ' [global]' : '';
    lines.push(`${type}: ${mw.name || name}${methods}${global}${framework} [${mw.file}]`);
  }
  lines.push('');
  return lines;
}

/**
 * Helper: Generate framework-specific extras (signals, admin, forms, plugins, etc.).
 */
function generateFrameworkExtrasSection(data: CodemapData): string[] {
  const lines: string[] = [];
  const extData = data as any;

  // Django signals
  if (extData.signals?.length > 0) {
    lines.push('## SIGNALS');
    for (const signal of extData.signals) {
      const sender = signal.sender ? ` (sender: ${signal.sender})` : '';
      lines.push(`${signal.signal} → ${signal.receiver}${sender} [${signal.file}]`);
    }
    lines.push('');
  }

  // Django admin registrations
  if (extData.admin?.length > 0) {
    lines.push('## ADMIN');
    for (const admin of extData.admin) {
      const model = admin.model ? ` → ${admin.model}` : '';
      lines.push(`${admin.admin_class}${model} [${admin.file}]`);
    }
    lines.push('');
  }

  // Django forms
  if (extData.forms?.length > 0) {
    lines.push('## FORMS');
    for (const form of extData.forms) {
      const model = form.model ? ` (model: ${form.model})` : '';
      const validators = form.validators?.length > 0 ? ` [validators: ${form.validators.join(', ')}]` : '';
      lines.push(`${form.kind}: ${form.name}${model}${validators} [${form.file}]`);
    }
    lines.push('');
  }

  // Django management commands
  if (extData.management_commands?.length > 0) {
    lines.push('## MANAGEMENT_COMMANDS');
    for (const cmd of extData.management_commands) {
      const help = cmd.help ? ` — ${cmd.help}` : '';
      lines.push(`${cmd.name}${help} [${cmd.file}]`);
    }
    lines.push('');
  }

  // Django template tags
  if (extData.template_tags?.length > 0) {
    lines.push('## TEMPLATE_TAGS');
    for (const tag of extData.template_tags) {
      lines.push(`${tag.kind}: ${tag.name} → ${tag.handler} [${tag.file}]`);
    }
    lines.push('');
  }

  // FastAPI dependencies
  if (extData.di_providers?.length > 0) {
    lines.push('## DEPENDENCIES (DI)');
    for (const dep of extData.di_providers) {
      const subDeps = dep.depends_on?.length > 0 ? ` ← ${dep.depends_on.join(', ')}` : '';
      const usedBy = dep.used_by?.length > 0 ? ` → ${dep.used_by.join(', ')}` : '';
      lines.push(`${dep.name}: ${dep.return_type}${subDeps}${usedBy} [${dep.file}]`);
    }
    lines.push('');
  }

  // Nuxt plugins
  if (extData.plugins?.length > 0) {
    lines.push('## PLUGINS');
    for (const plugin of extData.plugins) {
      const mode = plugin.mode ? ` [${plugin.mode}]` : '';
      const provides = plugin.provides?.length > 0 ? ` provides: ${plugin.provides.join(', ')}` : '';
      lines.push(`${plugin.name}${mode}${provides} [${plugin.file}]`);
    }
    lines.push('');
  }

  // Nuxt layouts
  if (extData.layouts?.length > 0) {
    lines.push('## LAYOUTS');
    for (const layout of extData.layouts) {
      const usedBy = layout.used_by?.length > 0 ? ` → ${layout.used_by.length} pages` : '';
      lines.push(`${layout.name}${usedBy} [${layout.file}]`);
    }
    lines.push('');
  }

  // Nuxt components
  if (extData.components?.length > 0) {
    lines.push('## COMPONENTS');
    const compNames = extData.components.map((c: any) => c.name);
    if (compNames.length <= 20) {
      lines.push(compNames.join(', '));
    } else {
      const shown = compNames.slice(0, 15).join(', ');
      lines.push(`${shown} ... +${compNames.length - 15} more`);
    }
    lines.push('');
  }

  return lines;
}

/**
 * Generate a COMPACT root-level summary.
 * Target: ~1500-2500 lines even for 5000+ file projects.
 *
 * Strategy:
 * - Header with stats
 * - Directory tree with file/class/function counts
 * - Classes grouped by directory (names only)
 * - Functions grouped by directory (names only)
 * - Dependencies and env vars (naturally compact)
 * - NO import graph (too large, use module files)
 * - NO call graph (too large, use `codemap query --calls`)
 * - Points user to module files and query command for details
 */
export function generateMarkdown(data: CodemapData): string {
  const lines: string[] = [];

  const fileCount = Object.keys(data.files).length;
  const classCount = Object.keys(data.classes).length;
  const funcCount = Object.keys(data.functions).length;
  const typeCount = Object.keys(data.types).length;

  // Header
  lines.push(`# CODEMAP: ${data.project.name}`);
  lines.push(`> Generated: ${data.generated_at} | Languages: ${data.project.languages.join(', ')} | Frameworks: ${data.project.frameworks.join(', ') || 'none'}`);
  lines.push(`> Files: ${fileCount} | Classes: ${classCount} | Functions: ${funcCount} | Types: ${typeCount}`);
  lines.push(`> Detail: use \`codemap query\` or see .codemap/modules/ for full signatures and call graphs`);
  lines.push('');

  // Entry points
  if (data.project.entry_points.length > 0) {
    lines.push(`> Entry: ${data.project.entry_points.join(', ')}`);
    lines.push('');
  }

  // Build directory-level aggregations and get sorted dirs
  const sortedDirs = generateDirStats(data);

  // Add all sections
  lines.push(...generateModulesSection(sortedDirs));
  if (classCount > 0) lines.push(...generateClassesSection(sortedDirs));
  if (funcCount > 0) lines.push(...generateFunctionsSection(sortedDirs));
  if (typeCount > 0) lines.push(...generateTypesSection(sortedDirs));
  lines.push(...generateRoutesSection(data));
  lines.push(...generateModelsSection(data));
  lines.push(...generateMiddlewareSection(data));
  lines.push(...generateFrameworkExtrasSection(data));
  lines.push(...generateDepsSection(data));
  lines.push(...generateEnvSection(data));

  return lines.join('\n');
}

/**
 * Helper: Generate FILES section for module.
 */
function generateModuleFiles(
  moduleFiles: Array<[string, any]>
): string[] {
  const lines: string[] = [];
  lines.push('## FILES');
  for (const [path, fileData] of moduleFiles) {
    const exports = fileData.exports.length > 0 ? ` → ${fileData.exports.join(', ')}` : '';
    lines.push(`${path} [${fileData.hash}]${exports}`);
  }
  lines.push('');
  return lines;
}

/**
 * Helper: Generate CLASSES section for module.
 */
function generateModuleClasses(
  data: CodemapData,
  filePaths: Set<string>
): string[] {
  const lines: string[] = [];
  const moduleClasses = Object.entries(data.classes)
    .filter(([, cls]: [string, any]) => filePaths.has(cls.file)) as [string, any][];

  if (moduleClasses.length === 0) return lines;

  lines.push('## CLASSES');
  for (const [name, cls] of moduleClasses) {
    const meta: string[] = [];
    if (cls.extends) meta.push(`extends: ${cls.extends}`);
    if (cls.implements?.length) meta.push(`implements: ${cls.implements.join(', ')}`);
    if (cls.decorators?.length) meta.push(`decorators: ${cls.decorators.join(', ')}`);

    lines.push(`### ${name} [${cls.file}]`);
    if (meta.length > 0) lines.push(meta.join(' | '));

    for (const method of cls.methods) {
      const params = method.params
        .map((p: any) => `${p.name}: ${p.type}`)
        .join(', ');
      const decorStr = method.decorators?.length ? ` [${method.decorators.join(', ')}]` : '';
      const asyncStr = method.async ? 'async ' : '';
      const staticStr = method.static ? 'static ' : '';
      const accessStr = method.access !== 'public' ? `${method.access} ` : '';

      lines.push(`├─ ${accessStr}${staticStr}${asyncStr}${method.name}(${params}) → ${method.return_type}${decorStr}`);

      if (method.calls?.length) {
        lines.push(`│  calls: ${method.calls.join(', ')}`);
      }
      if (method.called_by?.length) {
        lines.push(`│  called_by: ${method.called_by.join(', ')}`);
      }
    }
    lines.push('');
  }
  return lines;
}

/**
 * Helper: Generate FUNCTIONS section for module.
 */
function generateModuleFunctions(
  data: CodemapData,
  filePaths: Set<string>
): string[] {
  const lines: string[] = [];
  const moduleFunctions = Object.entries(data.functions)
    .filter(([, func]: [string, any]) => filePaths.has(func.file)) as [string, any][];

  if (moduleFunctions.length === 0) return lines;

  lines.push('## FUNCTIONS');
  for (const [name, func] of moduleFunctions) {
    const params = func.params
      .map((p: any) => `${p.name}: ${p.type}`)
      .join(', ');
    const asyncStr = func.async ? 'async ' : '';
    const exportStr = func.exported ? '[exported] ' : '';

    lines.push(`${exportStr}${asyncStr}${name}(${params}) → ${func.return_type} [${func.file}]`);

    if (func.calls?.length) {
      lines.push(`  calls: ${func.calls.join(', ')}`);
    }
    if (func.called_by?.length) {
      lines.push(`  called_by: ${func.called_by.join(', ')}`);
    }
  }
  lines.push('');
  return lines;
}

/**
 * Helper: Generate TYPES section for module.
 */
function generateModuleTypes(
  data: CodemapData,
  filePaths: Set<string>
): string[] {
  const lines: string[] = [];
  const moduleTypes = Object.entries(data.types)
    .filter(([, type]: [string, any]) => filePaths.has(type.file)) as [string, any][];

  if (moduleTypes.length === 0) return lines;

  lines.push('## TYPES');
  for (const [name, type] of moduleTypes) {
    const extendsStr = type.extends?.length ? ` extends ${type.extends.join(', ')}` : '';
    lines.push(`${type.kind} ${name}${extendsStr} [${type.file}]`);

    if (type.properties?.length) {
      const props = type.properties
        .map((p: any) => `${p.name}${p.optional ? '?' : ''}: ${p.type}`)
        .join(', ');
      lines.push(`  { ${props} }`);
    }
  }
  lines.push('');
  return lines;
}

/**
 * Helper: Generate IMPORTS section for module.
 */
function generateModuleImports(
  data: CodemapData,
  filePaths: Set<string>
): string[] {
  const lines: string[] = [];
  const moduleImports = Object.entries(data.import_graph)
    .filter(([file]) => filePaths.has(file))
    .filter(([, deps]) => deps.length > 0);

  if (moduleImports.length === 0) return lines;

  lines.push('## IMPORTS');
  for (const [file, deps] of moduleImports) {
    lines.push(`${file} ← ${deps.join(', ')}`);
  }
  lines.push('');
  return lines;
}

/**
 * Generate DETAILED markdown for a specific directory/module.
 * Includes full signatures, call graphs, and called_by data.
 */
export function generateModuleMarkdown(
  data: CodemapData,
  directory: string
): string {
  const lines: string[] = [];

  lines.push(`# MODULE: ${directory}`);
  lines.push(`> Project: ${data.project.name} | Generated: ${data.generated_at}`);
  lines.push('');

  // Filter to files in this directory
  const moduleFiles = Object.entries(data.files).filter(([path]) => {
    const fileDir = path.includes('/') ? path.split('/').slice(0, -1).join('/') : '.';
    return fileDir === directory;
  });

  if (moduleFiles.length === 0) return '';

  // File paths in this module
  const filePaths = new Set(moduleFiles.map(([path]) => path));

  // Add all sections
  lines.push(...generateModuleFiles(moduleFiles));
  lines.push(...generateModuleClasses(data, filePaths));
  lines.push(...generateModuleFunctions(data, filePaths));
  lines.push(...generateModuleTypes(data, filePaths));
  lines.push(...generateModuleImports(data, filePaths));

  return lines.join('\n');
}
