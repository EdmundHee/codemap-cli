/**
 * AI-optimized compact formatters for MCP tool responses.
 *
 * Designed for LLM consumption, not human readability:
 * - One entity per line, inline signatures
 * - Symbolic notation: → (returns), ↑ (callers), ↓ (calls), @ (file)
 * - No markdown decoration (###, **, backticks)
 * - Path abbreviation: strips common source root
 * - Progressive disclosure via detail parameter
 *
 * ~60-75% fewer tokens than the markdown formatters.
 */

import { CodemapData, HealthData } from '../output/json-generator';
import { ModuleMetrics } from '../analyzers/coupling';
import { QueryResult } from '../core/query-engine';
import { HealthTrend } from '../analyzers/history';
import { ClusteredSearchResult } from '../analyzers/cluster';

export type DetailLevel = 'summary' | 'signature' | 'full';

// ─── Path Abbreviation ──────────────────────────────────────────────────────

/**
 * Find the longest common directory prefix among a set of file paths.
 * Returns the prefix to strip (e.g. "src/") or empty string if none.
 */
function findCommonPrefix(paths: string[]): string {
  const valid = paths.filter(Boolean);
  if (valid.length === 0) return '';

  const parts = valid.map((p) => p.split('/'));
  const minLen = Math.min(...parts.map((p) => p.length));

  let commonDepth = 0;
  for (let i = 0; i < minLen - 1; i++) {
    const segment = parts[0][i];
    if (parts.every((p) => p[i] === segment)) {
      commonDepth = i + 1;
    } else {
      break;
    }
  }

  if (commonDepth === 0) return '';
  return parts[0].slice(0, commonDepth).join('/') + '/';
}

function abbreviate(filePath: string, prefix: string): string {
  if (!filePath) return '';
  if (prefix && filePath.startsWith(prefix)) return filePath.slice(prefix.length);
  return filePath;
}

/**
 * Collect all file paths from an array of items for prefix detection.
 */
function collectPaths(items: Array<{ file?: string }>): string[] {
  return items.map((i) => i.file).filter(Boolean) as string[];
}

// ─── Entity Formatting ──────────────────────────────────────────────────────

function formatParams(params: any[]): string {
  if (!params?.length) return '';
  return params.map((p: any) => {
    const type = p.type && p.type !== 'any' ? `:${p.type}` : '';
    return `${p.name}${type}`;
  }).join(',');
}

function formatFnLine(
  name: string,
  file: string | undefined,
  data: any,
  prefix: string,
  detail: DetailLevel,
  indent: string = ''
): string {
  const loc = file ? ` @${abbreviate(file, prefix)}` : '';
  const exp = data.exported ? ' exp' : '';

  if (detail === 'summary') {
    return `${indent}fn ${name}${loc}${exp}`;
  }

  const params = formatParams(data.params);
  const ret = data.return_type ? `→${data.return_type}` : '';
  const sig = `(${params})${ret}`;

  if (detail === 'signature') {
    return `${indent}fn ${name}${sig}${loc}${exp}`;
  }

  // full
  const cx = data.complexity ? ` cx:${data.complexity}` : '';
  const ln = (data.line_count || data.lineCount) ? ` ln:${data.line_count || data.lineCount}` : '';
  return `${indent}fn ${name}${sig}${loc}${exp}${cx}${ln}`;
}

function formatMethodLine(
  name: string,
  file: string | undefined,
  data: any,
  prefix: string,
  detail: DetailLevel,
  indent: string = ''
): string {
  const loc = file ? ` @${abbreviate(file, prefix)}` : '';

  if (detail === 'summary') {
    return `${indent}.${name}${loc}`;
  }

  const params = formatParams(data.params);
  const ret = data.return_type ? `→${data.return_type}` : '';
  const sig = `(${params})${ret}`;

  if (detail === 'signature') {
    return `${indent}.${name}${sig}${loc}`;
  }

  const cx = data.complexity ? ` cx:${data.complexity}` : '';
  const ln = (data.line_count || data.lineCount) ? ` ln:${data.line_count || data.lineCount}` : '';
  return `${indent}.${name}${sig}${loc}${cx}${ln}`;
}

function formatClassLine(
  name: string,
  file: string | undefined,
  data: any,
  prefix: string,
  detail: DetailLevel,
  indent: string = ''
): string {
  const loc = file ? ` @${abbreviate(file, prefix)}` : '';
  const ext = data.extends ? ` < ${data.extends}` : '';
  const impl = data.implements?.length ? ` impl ${data.implements.join(',')}` : '';

  if (detail === 'summary') {
    return `${indent}class ${name}${loc}`;
  }

  return `${indent}class ${name}${ext}${impl}${loc}`;
}

function formatTypeLine(
  name: string,
  file: string | undefined,
  data: any,
  prefix: string,
  detail: DetailLevel,
  indent: string = ''
): string {
  const loc = file ? ` @${abbreviate(file, prefix)}` : '';
  const kind = data.kind ? `${data.kind} ` : '';
  const exp = data.exported ? ' exp' : '';
  return `${indent}${kind}${name}${loc}${exp}`;
}

function formatFileLine(
  name: string,
  data: any,
  prefix: string,
): string {
  const loc = abbreviate(name, prefix);
  return `file ${loc}`;
}

function formatCallRelationships(data: any, indent: string = ''): string[] {
  const lines: string[] = [];
  if (data.called_by?.length) {
    lines.push(`${indent}  ↑ ${data.called_by.join(', ')}`);
  }
  if (data.calls?.length) {
    const calls = data.calls.slice(0, 15);
    const more = data.calls.length > 15 ? ` +${data.calls.length - 15}` : '';
    lines.push(`${indent}  ↓ ${calls.join(', ')}${more}`);
  }
  return lines;
}

// ─── Single Result ───────────────────────────────────────────────────────────

function compactSingleResult(
  result: QueryResult,
  prefix: string,
  detail: DetailLevel
): string {
  const lines: string[] = [];

  switch (result.type) {
    case 'function': {
      lines.push(formatFnLine(result.name, result.file, result.data, prefix, detail));
      if (detail === 'full') lines.push(...formatCallRelationships(result.data));
      break;
    }
    case 'method': {
      const methodName = result.name.includes('.') ? result.name.split('.').pop()! : result.name;
      const className = result.data.class || '';
      lines.push(formatMethodLine(result.name, result.file, result.data, prefix, detail));
      if (detail === 'full') lines.push(...formatCallRelationships(result.data));
      break;
    }
    case 'class': {
      lines.push(formatClassLine(result.name, result.file, result.data, prefix, detail));
      if (detail !== 'summary' && result.data.methods?.length) {
        const methodNames = result.data.methods.map((m: any) => m.name || m);
        lines.push(`  methods: ${methodNames.join(', ')}`);
      }
      if (detail === 'full' && result.data.properties?.length) {
        const props = result.data.properties.map((p: any) => `${p.name}:${p.type}`);
        lines.push(`  props: ${props.join(', ')}`);
      }
      break;
    }
    case 'type':
      lines.push(formatTypeLine(result.name, result.file, result.data, prefix, detail));
      break;
    case 'file': {
      lines.push(formatFileLine(result.name, result.data, prefix));
      if (result.data.classes?.length) {
        lines.push(`  classes: ${result.data.classes.map((c: any) => c.name).join(', ')}`);
      }
      if (result.data.functions?.length) {
        lines.push(`  functions: ${result.data.functions.map((f: any) => f.name).join(', ')}`);
      }
      break;
    }
    default:
      lines.push(`${result.type} ${result.name}${result.file ? ` @${abbreviate(result.file, prefix)}` : ''}`);
  }

  return lines.join('\n');
}

// ─── Public Formatters ───────────────────────────────────────────────────────

export function compactQueryResult(result: QueryResult, detail: DetailLevel = 'full'): string {
  const prefix = findCommonPrefix(collectPaths([result]));
  return compactSingleResult(result, prefix, detail);
}

export function compactSearchResults(
  results: Array<{ type: string; name: string; file?: string }>,
  detail: DetailLevel = 'signature'
): string {
  if (results.length === 0) return 'No results.';
  const prefix = findCommonPrefix(collectPaths(results));
  const header = prefix ? `@=${prefix}\n` : '';
  const lines = results.map((r) => {
    const loc = r.file ? ` @${abbreviate(r.file, prefix)}` : '';
    return `${r.type} ${r.name}${loc}`;
  });
  return `${header}${results.length} results:\n${lines.join('\n')}`;
}

export function compactClusteredResults(
  clusters: ClusteredSearchResult[],
  detail: DetailLevel = 'signature'
): string {
  if (clusters.length === 0) return 'No results.';

  const totalItems = clusters.reduce((sum, c) => sum + c.size, 0);

  // Collect all paths for abbreviation
  const allPaths: string[] = [];
  for (const c of clusters) {
    if (c.hub.file) allPaths.push(c.hub.file);
    for (const child of c.children) {
      if (child.file) allPaths.push(child.file);
    }
  }
  const prefix = findCommonPrefix(allPaths);
  const header = prefix ? `@=${prefix}\n` : '';

  const lines: string[] = [`${totalItems} results, ${clusters.length} clusters`];

  for (const cluster of clusters) {
    const hub = cluster.hub;
    const loc = hub.file ? ` @${abbreviate(hub.file, prefix)}` : '';
    const hubTag = cluster.children.length > 0 ? ` [hub:${cluster.size}]` : '';

    lines.push(`${hub.type} ${hub.name}${loc}${hubTag}`);

    for (const child of cluster.children) {
      // Omit path if same as hub's file
      const childLoc = child.file && child.file !== hub.file
        ? ` @${abbreviate(child.file, prefix)}`
        : '';
      lines.push(`  ${child.type} ${child.name}${childLoc}`);
    }
  }

  return `${header}${lines.join('\n')}`;
}

export function compactExplore(result: {
  root: string;
  nodes: Array<{ name: string; file?: string; depth: number; relation: 'calls' | 'called_by' | 'root' }>;
  edges: Array<{ from: string; to: string }>;
}): string {
  const prefix = findCommonPrefix(collectPaths(result.nodes));
  const header = prefix ? `@=${prefix}\n` : '';

  const lines: string[] = [`explore ${result.root} ${result.nodes.length}n ${result.edges.length}e`];

  // Callers (upstream) — sorted deepest first so they read top-down
  const callerNodes = result.nodes
    .filter((n) => n.relation === 'called_by')
    .sort((a, b) => b.depth - a.depth);

  for (const n of callerNodes) {
    const loc = n.file ? ` @${abbreviate(n.file, prefix)}` : '';
    lines.push(`↑${n.depth} ${n.name}${loc}`);
  }

  // Root
  const rootNode = result.nodes.find((n) => n.relation === 'root');
  if (rootNode) {
    const loc = rootNode.file ? ` @${abbreviate(rootNode.file, prefix)}` : '';
    lines.push(`* ${rootNode.name}${loc}`);
  }

  // Calls (downstream) — sorted shallowest first
  const callNodes = result.nodes
    .filter((n) => n.relation === 'calls')
    .sort((a, b) => a.depth - b.depth);

  for (const n of callNodes) {
    const loc = n.file ? ` @${abbreviate(n.file, prefix)}` : '';
    lines.push(`↓${n.depth} ${n.name}${loc}`);
  }

  return `${header}${lines.join('\n')}`;
}

export function compactCallers(result: { function: string; callers: string[] }): string {
  if (result.callers.length === 0) return `${result.function} ↑ 0`;
  return `${result.function} ↑ ${result.callers.length}: ${result.callers.join(', ')}`;
}

export function compactCalls(result: { function: string; calls: string[] }): string {
  if (result.calls.length === 0) return `${result.function} ↓ 0`;
  return `${result.function} ↓ ${result.calls.length}: ${result.calls.join(', ')}`;
}

// ─── Overview ────────────────────────────────────────────────────────────────

export function compactOverview(overview: any): string {
  const lines: string[] = [];

  lines.push(`${overview.project} | ${overview.languages.join(',')}${overview.frameworks?.length ? ' | ' + overview.frameworks.join(',') : ''}`);
  lines.push(`${overview.totals.files} files, ${overview.totals.classes} classes, ${overview.totals.functions} fn, ${overview.totals.types} types`);

  if (overview.entry_points?.length) {
    lines.push(`entry: ${overview.entry_points.join(', ')}`);
  }

  lines.push('');
  for (const [dir, stats] of Object.entries(overview.modules) as [string, any][]) {
    const parts = [];
    if (stats.files) parts.push(`${stats.files}f`);
    if (stats.classes) parts.push(`${stats.classes}c`);
    if (stats.functions) parts.push(`${stats.functions}fn`);
    if (stats.types) parts.push(`${stats.types}t`);
    lines.push(`${dir}/ ${parts.join(' ')}`);
  }

  if (overview.framework_data) {
    lines.push('');
    for (const [key, count] of Object.entries(overview.framework_data)) {
      lines.push(`${key}: ${count}`);
    }
  }

  if (overview.dependencies?.packages) {
    const pkgs = Object.entries(overview.dependencies.packages);
    const prod = pkgs.filter(([, v]: [string, any]) => v.type !== 'dev');
    const dev = pkgs.filter(([, v]: [string, any]) => v.type === 'dev');
    if (prod.length) {
      lines.push('');
      lines.push(`deps: ${prod.map(([n, v]: [string, any]) => `${n}@${v.version}`).join(', ')}`);
    }
    if (dev.length) {
      lines.push(`dev: ${dev.map(([n]) => n).join(', ')}`);
    }
  }

  return lines.join('\n');
}

// ─── Module ──────────────────────────────────────────────────────────────────

export function compactModule(module: any, detail: DetailLevel = 'signature'): string {
  const prefix = findCommonPrefix(module.files);
  const header = prefix ? `@=${prefix}\n` : '';
  const lines: string[] = [`${module.directory}/ ${module.files.length} files`];

  if (module.classes.length) {
    for (const cls of module.classes) {
      lines.push(formatClassLine(cls.name, cls.file, cls, prefix, detail));
      if (detail !== 'summary' && cls.methods?.length) {
        lines.push(`  methods: ${cls.methods.join(', ')}`);
      }
    }
  }

  if (module.functions.length) {
    for (const fn of module.functions) {
      const exp = fn.exported ? ' exp' : '';
      const loc = ` @${abbreviate(fn.file, prefix)}`;

      if (detail === 'summary') {
        lines.push(`fn ${fn.name}${loc}${exp}`);
      } else {
        const ret = fn.return_type ? `→${fn.return_type}` : '';
        lines.push(`fn ${fn.name}(${fn.params})${ret}${loc}${exp}`);
        if (detail === 'full') {
          if (fn.calls?.length) lines.push(`  ↓ ${fn.calls.join(', ')}`);
          if (fn.called_by?.length) lines.push(`  ↑ ${fn.called_by.join(', ')}`);
        }
      }
    }
  }

  if (module.types.length) {
    for (const type of module.types) {
      lines.push(formatTypeLine(type.name, type.file, type, prefix, detail));
    }
  }

  return `${header}${lines.join('\n')}`;
}

// ─── Health ──────────────────────────────────────────────────────────────────

export function compactHealth(health: HealthData, moduleMetrics: ModuleMetrics[], scope?: string): string {
  const lines: string[] = [];
  const m = health.metrics;

  lines.push(`health ${health.score}/100 | ${m.total_functions}fn ${m.total_classes}cls | avg_cx:${m.avg_function_complexity} dead:${m.dead_function_count}(${m.dead_function_percentage}%)`);

  if (m.max_function_complexity) {
    lines.push(`max_cx: ${m.max_function_complexity.value} ${m.max_function_complexity.name} @${m.max_function_complexity.file}`);
  }
  lines.push(`over_cx:${m.functions_over_complexity_threshold} over_ln:${m.functions_over_line_threshold} over_methods:${m.classes_over_method_limit}`);

  if (health.hotspots.length > 0) {
    lines.push('');
    for (const h of health.hotspots) {
      const sev = h.severity === 'critical' ? '!!' : '!';
      lines.push(`${sev} ${h.target} ${h.metric}:${h.value}/${h.threshold} @${h.file}`);
    }
  }

  if (moduleMetrics.length > 0) {
    const relevant = scope
      ? moduleMetrics.filter((m) => m.path === scope || m.path.startsWith(scope + '/'))
      : moduleMetrics.slice(0, 10);

    if (relevant.length > 0) {
      lines.push('');
      for (const mod of relevant) {
        lines.push(`${mod.path}/ Ca:${mod.afferentCoupling} Ce:${mod.efferentCoupling} I:${mod.instability} ${mod.fileCount}f avg_cx:${mod.avgComplexity}`);
      }
    }
  }

  return lines.join('\n');
}

// ─── Health Diff ─────────────────────────────────────────────────────────────

export function compactHealthDiff(trend: HealthTrend): string {
  const arrow = trend.direction === 'improving' ? '↑' : trend.direction === 'degrading' ? '↓' : '→';
  const lines: string[] = [
    `health ${arrow} ${trend.current}/${trend.previous} delta:${trend.delta > 0 ? '+' : ''}${trend.delta}`,
  ];

  if (trend.degradingSince) lines.push(`degrading since ${trend.degradingSince}`);

  if (trend.topMovers.length > 0) {
    for (const m of trend.topMovers) {
      const dir = m.delta > 0 ? '↑' : '↓';
      lines.push(`${dir} ${m.metric}: ${m.previous}→${m.current} (${m.delta > 0 ? '+' : ''}${m.delta})`);
    }
  }

  return lines.join('\n');
}

// ─── Dependencies ────────────────────────────────────────────────────────────

export function compactDependencies(
  result: { file: string; imports?: string[]; imported_by?: string[] } | { file: string; imports?: string[]; imported_by?: string[] }[],
  direction: 'imports' | 'imported_by' | 'both'
): string {
  const entries = Array.isArray(result) ? result : [result];
  const allPaths = entries.map((e) => e.file);
  const prefix = findCommonPrefix(allPaths);
  const header = prefix ? `@=${prefix}\n` : '';

  const lines: string[] = [];
  for (const entry of entries) {
    const loc = abbreviate(entry.file, prefix);
    if ((direction === 'imports' || direction === 'both') && entry.imports) {
      lines.push(`${loc} → ${entry.imports.length}: ${entry.imports.map((i) => abbreviate(i, prefix)).join(', ') || 'none'}`);
    }
    if ((direction === 'imported_by' || direction === 'both') && entry.imported_by) {
      lines.push(`${loc} ← ${entry.imported_by.length}: ${entry.imported_by.map((i) => abbreviate(i, prefix)).join(', ') || 'none'}`);
    }
  }

  return `${header}${lines.join('\n')}`;
}

// ─── Projects ────────────────────────────────────────────────────────────────

export function compactProjects(projects: any[]): string {
  const lines: string[] = [`${projects.length} projects`];
  for (const p of projects) {
    if (p.has_codemap) {
      const parts = [];
      if (p.files) parts.push(`${p.files}f`);
      if (p.functions) parts.push(`${p.functions}fn`);
      if (p.frameworks?.length) parts.push(p.frameworks.join(','));
      lines.push(`${p.name} ${p.root} ${parts.join(' ')}`);
    } else {
      lines.push(`${p.name} ${p.root} (no codemap)`);
    }
  }
  return lines.join('\n');
}
