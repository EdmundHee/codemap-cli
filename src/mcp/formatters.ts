/**
 * Markdown formatters for MCP tool responses.
 * Converts structured codemap data into compact, token-efficient Markdown
 * that Claude can reason over more effectively than raw JSON.
 */

import { CodemapData, HealthData } from '../output/json-generator';
import { ModuleMetrics } from '../analyzers/coupling';
import { QueryResult } from '../core/query-engine';
import { HealthTrend } from '../analyzers/history';

// --- Overview ---

export function formatOverview(overview: any): string {
  const lines: string[] = [];

  lines.push(`# ${overview.project}`);
  lines.push('');
  lines.push(`**Languages:** ${overview.languages.join(', ')}`);
  if (overview.frameworks.length) {
    lines.push(`**Frameworks:** ${overview.frameworks.join(', ')}`);
  }
  if (overview.entry_points?.length) {
    lines.push(`**Entry points:** ${overview.entry_points.join(', ')}`);
  }
  lines.push(`**Totals:** ${overview.totals.files} files, ${overview.totals.classes} classes, ${overview.totals.functions} functions, ${overview.totals.types} types`);

  lines.push('');
  lines.push('## Modules');
  for (const [dir, stats] of Object.entries(overview.modules) as [string, any][]) {
    const parts = [];
    if (stats.files) parts.push(`${stats.files} files`);
    if (stats.classes) parts.push(`${stats.classes} classes`);
    if (stats.functions) parts.push(`${stats.functions} fn`);
    if (stats.types) parts.push(`${stats.types} types`);
    lines.push(`- \`${dir}/\` — ${parts.join(', ')}`);
  }

  const packages = overview.dependencies?.packages;
  if (packages && Object.keys(packages).length) {
    lines.push('');
    lines.push('## Dependencies');
    const prod = Object.entries(packages).filter(([, v]: [string, any]) => v.type !== 'dev');
    const dev = Object.entries(packages).filter(([, v]: [string, any]) => v.type === 'dev');
    if (prod.length) {
      for (const [name, info] of prod as [string, any][]) {
        lines.push(`- ${name} ${info.version}`);
      }
    }
    if (dev.length) {
      lines.push(`- dev: ${dev.map(([name]) => name).join(', ')}`);
    }
  }

  return lines.join('\n');
}

function formatModuleClasses(classes: any[]): string[] {
  const lines: string[] = [];
  for (const cls of classes) {
    let header = `- **${cls.name}**`;
    if (cls.extends) header += ` extends ${cls.extends}`;
    if (cls.implements?.length) header += ` implements ${cls.implements.join(', ')}`;
    header += ` — ${cls.file}`;
    lines.push(header);
    if (cls.decorators?.length) {
      lines.push(`  - decorators: ${cls.decorators.join(', ')}`);
    }
    if (cls.methods?.length) {
      lines.push(`  - methods: ${cls.methods.join(', ')}`);
    }
    if (cls.properties?.length) {
      lines.push(`  - properties: ${cls.properties.join(', ')}`);
    }
  }
  return lines;
}

function formatModuleFunctions(functions: any[]): string[] {
  const lines: string[] = [];
  for (const fn of functions) {
    const exported = fn.exported ? ' [exported]' : '';
    const ret = fn.return_type ? ` → ${fn.return_type}` : '';
    lines.push(`- \`${fn.name}(${fn.params})${ret}\`${exported} — ${fn.file}`);
    if (fn.calls?.length) {
      lines.push(`  - calls: ${fn.calls.join(', ')}`);
    }
    if (fn.called_by?.length) {
      lines.push(`  - called_by: ${fn.called_by.join(', ')}`);
    }
  }
  return lines;
}

function formatModuleTypes(types: any[]): string[] {
  const lines: string[] = [];
  for (const type of types) {
    const exported = type.exported ? ' [exported]' : '';
    lines.push(`- \`${type.name}\` (${type.kind})${exported} — ${type.file}`);
  }
  return lines;
}

function formatModuleImports(imports: Record<string, any[]>): string[] {
  const lines: string[] = [];
  for (const [file, importList] of Object.entries(imports) as [string, any[]][]) {
    const sources = importList.map((i: any) => i.source || i.from).filter(Boolean);
    if (sources.length) {
      lines.push(`- ${file}: ${sources.join(', ')}`);
    }
  }
  return lines;
}

// --- Module ---

export function formatModule(module: any): string {
  const lines: string[] = [];

  lines.push(`## ${module.directory}/ (${module.files.length} files)`);
  lines.push('');
  lines.push(`**Files:** ${module.files.join(', ')}`);

  if (module.classes.length) {
    lines.push('');
    lines.push('### Classes');
    lines.push(...formatModuleClasses(module.classes));
  }

  if (module.functions.length) {
    lines.push('');
    lines.push('### Functions');
    lines.push(...formatModuleFunctions(module.functions));
  }

  if (module.types.length) {
    lines.push('');
    lines.push('### Types');
    lines.push(...formatModuleTypes(module.types));
  }

  if (Object.keys(module.imports).length) {
    lines.push('');
    lines.push('### Imports');
    lines.push(...formatModuleImports(module.imports));
  }

  return lines.join('\n');
}

// --- Query / Search ---

export function formatQueryResult(result: QueryResult): string {
  return formatSingleResult(result);
}

export function formatSearchResults(results: { type: string; name: string; file?: string }[]): string {
  if (results.length === 0) return 'No results found.';

  const lines: string[] = [`Found ${results.length} result(s):`, ''];
  for (const r of results) {
    const loc = r.file ? ` — ${r.file}` : '';
    lines.push(`- **${r.type}** \`${r.name}\`${loc}`);
  }
  return lines.join('\n');
}

function formatFunctionResult(name: string, file: string, data: any): string {
  const lines: string[] = [];
  lines.push(`### Function: \`${name}\``);
  lines.push(`**File:** ${file}`);
  if (data.params?.length) {
    const params = data.params.map((p: any) => `${p.name}: ${p.type}`).join(', ');
    lines.push(`**Params:** ${params}`);
  }
  if (data.return_type) lines.push(`**Returns:** ${data.return_type}`);
  if (data.exported) lines.push(`**Exported:** yes`);
  if (data.decorators?.length) lines.push(`**Decorators:** ${data.decorators.join(', ')}`);
  if (data.calls?.length) lines.push(`**Calls:** ${data.calls.join(', ')}`);
  if (data.called_by?.length) lines.push(`**Called by:** ${data.called_by.join(', ')}`);
  return lines.join('\n');
}

function formatMethodResult(name: string, file: string, data: any): string {
  const lines: string[] = [];
  lines.push(`### Method: \`${name}\``);
  lines.push(`**File:** ${file}`);
  if (data.class) lines.push(`**Class:** ${data.class}`);
  if (data.params?.length) {
    const params = data.params.map((p: any) => `${p.name}: ${p.type}`).join(', ');
    lines.push(`**Params:** ${params}`);
  }
  if (data.return_type) lines.push(`**Returns:** ${data.return_type}`);
  if (data.decorators?.length) lines.push(`**Decorators:** ${data.decorators.join(', ')}`);
  return lines.join('\n');
}

function formatClassResult(name: string, file: string, data: any): string {
  const lines: string[] = [];
  lines.push(`### Class: \`${name}\``);
  lines.push(`**File:** ${file}`);
  if (data.extends) lines.push(`**Extends:** ${data.extends}`);
  if (data.implements?.length) lines.push(`**Implements:** ${data.implements.join(', ')}`);
  if (data.decorators?.length) lines.push(`**Decorators:** ${data.decorators.join(', ')}`);
  if (data.methods?.length) {
    const methodNames = data.methods.map((m: any) => m.name || m);
    lines.push(`**Methods:** ${methodNames.join(', ')}`);
  }
  if (data.properties?.length) {
    const props = data.properties.map((p: any) => `${p.name}: ${p.type}`);
    lines.push(`**Properties:** ${props.join(', ')}`);
  }
  return lines.join('\n');
}

function formatTypeResult(name: string, file: string, data: any): string {
  const lines: string[] = [];
  lines.push(`### Type: \`${name}\``);
  lines.push(`**File:** ${file}`);
  if (data.kind) lines.push(`**Kind:** ${data.kind}`);
  if (data.exported) lines.push(`**Exported:** yes`);
  return lines.join('\n');
}

function formatFileResult(name: string, data: any): string {
  const lines: string[] = [];
  lines.push(`### File: \`${name}\``);
  if (data.classes?.length) {
    lines.push(`**Classes:** ${data.classes.map((c: any) => c.name).join(', ')}`);
  }
  if (data.functions?.length) {
    lines.push(`**Functions:** ${data.functions.map((f: any) => f.name).join(', ')}`);
  }
  if (data.types?.length) {
    lines.push(`**Types:** ${data.types.map((t: any) => t.name).join(', ')}`);
  }
  if (data.imports?.length) {
    const sources = data.imports.map((i: any) => i.source || i.from).filter(Boolean);
    if (sources.length) lines.push(`**Imports from:** ${sources.join(', ')}`);
  }
  return lines.join('\n');
}

function formatSingleResult(result: QueryResult): string {
  switch (result.type) {
    case 'function':
      return formatFunctionResult(result.name, result.file || '', result.data);
    case 'method':
      return formatMethodResult(result.name, result.file || '', result.data);
    case 'class':
      return formatClassResult(result.name, result.file || '', result.data);
    case 'type':
      return formatTypeResult(result.name, result.file || '', result.data);
    case 'file':
      return formatFileResult(result.name, result.data);
    default: {
      const lines: string[] = [];
      lines.push(`### ${result.type}: \`${result.name}\``);
      if (result.file) lines.push(`**File:** ${result.file}`);
      return lines.join('\n');
    }
  }
}

// --- Callers / Calls ---

export function formatCallers(result: { function: string; callers: string[] }): string {
  if (result.callers.length === 0) {
    return `\`${result.function}\` has no known callers.`;
  }
  const lines = [`\`${result.function}\` is called by ${result.callers.length} function(s):`, ''];
  for (const caller of result.callers) {
    lines.push(`- \`${caller}\``);
  }
  return lines.join('\n');
}

export function formatCalls(result: { function: string; calls: string[] }): string {
  if (result.calls.length === 0) {
    return `\`${result.function}\` has no known outgoing calls.`;
  }
  const lines = [`\`${result.function}\` calls ${result.calls.length} function(s):`, ''];
  for (const call of result.calls) {
    lines.push(`- \`${call}\``);
  }
  return lines.join('\n');
}

// --- Health ---

export function formatHealth(health: HealthData, moduleMetrics: ModuleMetrics[], scope?: string): string {
  const lines: string[] = [];

  lines.push(`## Project Health: ${health.score}/100`);
  lines.push('');

  // Metrics summary
  const m = health.metrics;
  lines.push('### Metrics');
  lines.push(`- **Functions/methods:** ${m.total_functions} (${m.total_classes} classes)`);
  lines.push(`- **Avg complexity:** ${m.avg_function_complexity}`);
  if (m.max_function_complexity) {
    lines.push(`- **Max complexity:** ${m.max_function_complexity.value} (\`${m.max_function_complexity.name}\` in ${m.max_function_complexity.file})`);
  }
  lines.push(`- **Over complexity threshold:** ${m.functions_over_complexity_threshold}`);
  lines.push(`- **Over line threshold:** ${m.functions_over_line_threshold}`);
  lines.push(`- **Classes over method limit:** ${m.classes_over_method_limit}`);
  lines.push(`- **Dead functions:** ${m.dead_function_count} (${m.dead_function_percentage}%)`);

  // Hotspots
  if (health.hotspots.length > 0) {
    lines.push('');
    lines.push('### Hotspots');
    for (const h of health.hotspots) {
      const icon = h.severity === 'critical' ? '[CRITICAL]' : '[WARNING]';
      lines.push(`- ${icon} \`${h.target}\` — ${h.metric}: ${h.value} (threshold: ${h.threshold}) — ${h.file}`);
    }
  }

  // Module coupling (top 10 most unstable)
  if (moduleMetrics.length > 0) {
    const relevant = scope
      ? moduleMetrics.filter((m) => m.path === scope || m.path.startsWith(scope + '/'))
      : moduleMetrics.slice(0, 10);

    if (relevant.length > 0) {
      lines.push('');
      lines.push('### Module Coupling (most unstable first)');
      for (const mod of relevant) {
        lines.push(`- \`${mod.path}/\` — Ca=${mod.afferentCoupling} Ce=${mod.efferentCoupling} I=${mod.instability} | ${mod.fileCount} files, avg_complexity=${mod.avgComplexity}, max=${mod.maxComplexity}${mod.maxComplexityFunction ? ` (${mod.maxComplexityFunction})` : ''}`);
      }
    }
  }

  return lines.join('\n');
}

// --- Projects ---

export function formatProjects(projects: any[]): string {
  const lines: string[] = [`## Registered Projects (${projects.length})`, ''];

  for (const p of projects) {
    if (p.has_codemap) {
      lines.push(`- **${p.name}** — ${p.root}`);
      const parts = [];
      if (p.files) parts.push(`${p.files} files`);
      if (p.classes) parts.push(`${p.classes} classes`);
      if (p.functions) parts.push(`${p.functions} fn`);
      parts.push(`generated: ${p.generated_at}`);
      lines.push(`  ${parts.join(', ')}`);
      if (p.frameworks?.length) lines.push(`  frameworks: ${p.frameworks.join(', ')}`);
      if (p.languages?.length) lines.push(`  languages: ${p.languages.join(', ')}`);
    } else {
      lines.push(`- **${p.name}** — ${p.root} (no codemap — run \`codemap generate\`)`);
    }
  }

  return lines.join('\n');
}

// --- Health Diff ---

export function formatHealthDiff(trend: HealthTrend): string {
  const lines: string[] = [];

  const arrow = trend.direction === 'improving' ? '↑' : trend.direction === 'degrading' ? '↓' : '→';
  lines.push(`## Health Trend: ${arrow} ${trend.direction}`);
  lines.push('');
  lines.push(`**Current:** ${trend.current} | **Previous:** ${trend.previous} | **Delta:** ${trend.delta > 0 ? '+' : ''}${trend.delta}`);

  if (trend.degradingSince) {
    lines.push(`**Degrading since:** ${trend.degradingSince}`);
  }

  if (trend.topMovers.length > 0) {
    lines.push('');
    lines.push('### Top Movers');
    for (const m of trend.topMovers) {
      const dir = m.delta > 0 ? '↑' : '↓';
      lines.push(`- ${dir} **${m.metric}**: ${m.previous} → ${m.current} (${m.delta > 0 ? '+' : ''}${m.delta})`);
    }
  }

  return lines.join('\n');
}

// --- Structures ---

export function formatStructures(data: CodemapData, type: string, target?: string): string {
  switch (type) {
    case 'cohesion':
      return formatCohesionData(data, target);
    case 'hotspots':
      return formatHotspotData(data, target);
    case 'dead_code':
      return formatDeadCodeData(data);
    default:
      return `Unknown structure type: ${type}`;
  }
}

function connectMethodsBySharedState(
  methods: any[],
  propNames: string[],
  parent: Map<string, string>,
  find: (x: string) => string
): void {
  const union = (a: string, b: string) => {
    parent.set(find(a), find(b));
  };

  for (const method of methods) {
    const accesses = method.instanceVarAccesses || [];
    for (const prop of accesses) {
      if (propNames.includes(prop)) {
        for (const other of methods) {
          if (other.name === method.name) continue;
          const otherAccesses = other.instanceVarAccesses || [];
          if (otherAccesses.includes(prop)) {
            union(method.name, other.name);
          }
        }
      }
    }
  }
}

function connectMethodsByCalls(
  methods: any[],
  methodNames: string[],
  parent: Map<string, string>,
  find: (x: string) => string
): void {
  const union = (a: string, b: string) => {
    parent.set(find(a), find(b));
  };

  for (const method of methods) {
    const calls = method.calls || [];
    for (const call of calls) {
      if (methodNames.includes(call)) {
        union(method.name, call);
      }
    }
  }
}

/**
 * Computes LCOM4 (Lack of Cohesion of Methods) for a class using Union-Find.
 * Returns the lcom4 count and a map of clusters (connected components).
 */
function computeLCOM4ForClass(cls: any): { lcom4: number; clusters: Map<string, string[]> } {
  const methods = cls.methods || [];
  const properties = cls.properties || [];

  const methodNames = methods.map((m: any) => m.name);
  const propNames = properties.map((p: any) => p.name || p);

  // Union-Find for connected components
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!));
    return parent.get(x)!;
  };

  // Initialize all methods
  for (const m of methodNames) parent.set(m, m);

  // Connect by shared properties and internal calls
  connectMethodsBySharedState(methods, propNames, parent, find);
  connectMethodsByCalls(methods, methodNames, parent, find);

  // Count connected components
  const roots = new Set(methodNames.map((m: string) => find(m)));
  const lcom4 = roots.size;

  // Build clusters
  const clusters = new Map<string, string[]>();
  for (const m of methodNames) {
    const root = find(m);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root)!.push(m);
  }

  return { lcom4, clusters };
}

function formatCohesionData(data: CodemapData, target?: string): string {
  const lines: string[] = ['## Class Cohesion (LCOM4)', ''];

  const classEntries = Object.entries(data.classes) as [string, any][];
  const filtered = target
    ? classEntries.filter(([name]) => name === target || name.includes(target))
    : classEntries;

  if (filtered.length === 0) return target ? `No class matching "${target}" found.` : 'No classes found.';

  for (const [className, cls] of filtered) {
    const methods = cls.methods || [];
    const properties = cls.properties || [];

    if (methods.length === 0) continue;

    // Compute LCOM4 and clusters
    const { lcom4, clusters } = computeLCOM4ForClass(cls);

    lines.push(`### \`${className}\` — LCOM4: ${lcom4} (${methods.length} methods, ${properties.length} properties)`);
    lines.push(`**File:** ${cls.file}`);

    if (lcom4 > 1) {
      lines.push(`**Clusters:** ${lcom4} disconnected groups (potential split candidates)`);
      let i = 1;
      for (const [, members] of clusters) {
        lines.push(`- Cluster ${i}: ${members.join(', ')}`);
        i++;
      }
    } else {
      lines.push(`**Cohesive:** single connected component`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

type HotspotEntry = { name: string; file: string; complexity: number; lineCount: number; calls: string[]; calledBy: string[] };

function collectFunctionHotspots(data: CodemapData, target?: string): HotspotEntry[] {
  const hotspots: HotspotEntry[] = [];
  for (const [name, func] of Object.entries(data.functions) as [string, any][]) {
    if (target && !name.includes(target) && !func.file?.includes(target)) continue;
    hotspots.push({
      name,
      file: func.file,
      complexity: func.complexity || 1,
      lineCount: func.line_count || 0,
      calls: func.calls || [],
      calledBy: func.called_by || [],
    });
  }
  return hotspots;
}

function collectMethodHotspots(data: CodemapData, target?: string): HotspotEntry[] {
  const hotspots: HotspotEntry[] = [];
  for (const [className, cls] of Object.entries(data.classes) as [string, any][]) {
    for (const method of (cls.methods || [])) {
      const qualName = `${className}.${method.name}`;
      if (target && !qualName.includes(target) && !cls.file?.includes(target)) continue;
      hotspots.push({
        name: qualName,
        file: cls.file,
        complexity: method.complexity || 1,
        lineCount: method.line_count || method.lineCount || 0,
        calls: method.calls || [],
        calledBy: method.called_by || [],
      });
    }
  }
  return hotspots;
}

function collectHotspotEntries(data: CodemapData, target?: string): HotspotEntry[] {
  const functionHotspots = collectFunctionHotspots(data, target);
  const methodHotspots = collectMethodHotspots(data, target);
  const hotspots = [...functionHotspots, ...methodHotspots];
  hotspots.sort((a, b) => b.complexity - a.complexity);
  return hotspots;
}

function formatHotspotData(data: CodemapData, target?: string): string {
  const lines: string[] = ['## Complexity Hotspots', ''];

  const hotspots = collectHotspotEntries(data, target);
  const top = hotspots.slice(0, 30);
  if (top.length === 0) return target ? `No hotspots matching "${target}".` : 'No complexity data found.';

  for (const h of top) {
    lines.push(`- **\`${h.name}\`** complexity=${h.complexity} lines=${h.lineCount} — ${h.file}`);
    if (h.calls.length) lines.push(`  calls: ${h.calls.slice(0, 10).join(', ')}${h.calls.length > 10 ? ` (+${h.calls.length - 10} more)` : ''}`);
    if (h.calledBy.length) lines.push(`  called_by: ${h.calledBy.slice(0, 10).join(', ')}${h.calledBy.length > 10 ? ` (+${h.calledBy.length - 10} more)` : ''}`);
  }

  return lines.join('\n');
}

function formatDeadCodeData(data: CodemapData): string {
  const lines: string[] = ['## Dead Code Analysis', ''];

  const deadFunctions: { name: string; file: string; lineCount: number; exported: boolean }[] = [];

  for (const [name, func] of Object.entries(data.functions) as [string, any][]) {
    const calledBy = func.called_by || [];
    if (calledBy.length === 0 && func.exported) {
      // Check if it's in an entry point file
      const entryPoints = data.project.entry_points || [];
      if (!entryPoints.includes(func.file)) {
        deadFunctions.push({
          name,
          file: func.file,
          lineCount: func.line_count || 0,
          exported: func.exported,
        });
      }
    }
  }

  // Sort by line count descending (biggest waste first)
  deadFunctions.sort((a, b) => b.lineCount - a.lineCount);

  const totalDeadLines = deadFunctions.reduce((sum, f) => sum + f.lineCount, 0);
  const totalFunctions = Object.keys(data.functions).length;
  const pct = totalFunctions > 0 ? Math.round((deadFunctions.length / totalFunctions) * 100) : 0;

  lines.push(`**Dead functions:** ${deadFunctions.length}/${totalFunctions} (${pct}%) — ${totalDeadLines} total lines`);
  lines.push('');

  for (const df of deadFunctions.slice(0, 30)) {
    const exp = df.exported ? ' [exported]' : '';
    lines.push(`- \`${df.name}\`${exp} — ${df.file} (${df.lineCount} lines)`);
  }

  if (deadFunctions.length > 30) {
    lines.push(`... and ${deadFunctions.length - 30} more`);
  }

  return lines.join('\n');
}
