import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { CodemapConfig } from '../core/config';
import { ScannedFile } from '../core/scanner';
import { ParsedFile } from '../parsers/parser.interface';
import { ImportGraph } from '../analyzers/import-graph';
import { CallGraph, buildReverseCallGraph, ReverseCallGraph } from '../analyzers/call-graph';
import { computeModuleCoupling, ModuleMetrics } from '../analyzers/coupling';
import { detectDeadCode } from '../analyzers/dead-code';

export interface CodemapData {
  version: string;
  generated_at: string;
  project: {
    name: string;
    root: string;
    languages: string[];
    frameworks: string[];
    entry_points: string[];
  };
  files: Record<string, any>;
  classes: Record<string, any>;
  functions: Record<string, any>;
  types: Record<string, any>;
  call_graph: CallGraph;
  import_graph: ImportGraph;
  config_dependencies: {
    env_vars: Record<string, { used_in: string[]; accessed_by: string[] }>;
  };
  dependencies: {
    packages: Record<string, { version: string; type: 'production' | 'dev' | 'peer' }>;
    source: string;
  };
  routes: any[];
  models: Record<string, any>;
  middleware: Record<string, any>;
  health: HealthData;
  module_metrics: ModuleMetrics[];
}

export interface HealthHotspot {
  type: 'high_complexity' | 'god_class' | 'low_cohesion' | 'dead_code' | 'high_coupling';
  target: string;
  file: string;
  metric: string;
  value: number;
  threshold: number;
  severity: 'warning' | 'critical';
}

export interface HealthData {
  score: number;
  computed_at: string;
  metrics: {
    total_functions: number;
    total_classes: number;
    total_complexity: number;
    avg_function_complexity: number;
    max_function_complexity: { name: string; file: string; value: number } | null;
    functions_over_complexity_threshold: number;
    functions_over_line_threshold: number;
    classes_over_method_limit: number;
    dead_function_count: number;
    dead_function_percentage: number;
  };
  hotspots: HealthHotspot[];
}

interface GenerateInput {
  config: CodemapConfig;
  files: ScannedFile[];
  parsed: ParsedFile[];
  frameworks: string[];
  languages: string[];
  importGraph: ImportGraph;
  callGraph: CallGraph;
}

function buildFileMap(parsed: ParsedFile[]): Record<string, any> {
  const files: Record<string, any> = Object.create(null);
  for (const p of parsed) {
    files[p.file.relative] = {
      language: p.file.language,
      hash: p.hash,
      exports: p.exports.map((e) => e.name),
      imports: p.imports.map((i) => ({ from: i.from, symbols: i.symbols })),
    };
  }
  return files;
}

function buildClassMap(parsed: ParsedFile[], reverseCallGraph: ReverseCallGraph): Record<string, any> {
  const classes: Record<string, any> = Object.create(null);
  for (const p of parsed) {
    for (const cls of p.classes) {
      classes[cls.name] = {
        file: p.file.relative,
        extends: cls.extends,
        implements: cls.implements,
        decorators: cls.decorators,
        methods: cls.methods.map((m) => ({
          ...m,
          called_by: reverseCallGraph[`${cls.name}.${m.name}`] || [],
        })),
        properties: cls.properties,
      };
    }
  }
  return classes;
}

function buildFunctionMap(parsed: ParsedFile[], reverseCallGraph: ReverseCallGraph): Record<string, any> {
  const functions: Record<string, any> = Object.create(null);
  for (const p of parsed) {
    for (const func of p.functions) {
      functions[func.name] = {
        file: p.file.relative,
        params: func.params,
        return_type: func.return_type,
        async: func.async,
        exported: func.exported,
        calls: func.calls,
        called_by: reverseCallGraph[func.name] || [],
        complexity: func.complexity,
        line_count: func.lineCount,
        nesting_depth: func.nestingDepth,
      };
    }
  }
  return functions;
}

function buildTypeMap(parsed: ParsedFile[]): Record<string, any> {
  const types: Record<string, any> = Object.create(null);
  for (const p of parsed) {
    for (const type of p.types) {
      types[type.name] = {
        file: p.file.relative,
        kind: type.kind,
        extends: type.extends,
        properties: type.properties,
        exported: type.exported,
      };
    }
  }
  return types;
}

function buildEnvVarMap(parsed: ParsedFile[]): Record<string, { used_in: string[]; accessed_by: string[] }> {
  const envVars: Record<string, { used_in: string[]; accessed_by: string[] }> = Object.create(null);
  for (const p of parsed) {
    for (const envVar of p.envVars) {
      if (!envVars[envVar]) envVars[envVar] = { used_in: [], accessed_by: [] };
      if (!envVars[envVar].used_in.includes(p.file.relative)) {
        envVars[envVar].used_in.push(p.file.relative);
      }
    }
  }
  return envVars;
}

/**
 * Generate the root-level codemap JSON structure.
 */
export function generateJson(input: GenerateInput): CodemapData {
  const { config, parsed, frameworks, languages, importGraph, callGraph } = input;
  const reverseCallGraph = buildReverseCallGraph(callGraph);
  const projectName = config.root.split('/').pop() || 'unknown';
  const entryPoints = config.entry_points || detectEntryPoints(parsed);

  return {
    version: '1.0.0',
    generated_at: new Date().toISOString(),
    project: {
      name: projectName,
      root: config.root,
      languages,
      frameworks,
      entry_points: entryPoints,
    },
    files: buildFileMap(parsed),
    classes: buildClassMap(parsed, reverseCallGraph),
    functions: buildFunctionMap(parsed, reverseCallGraph),
    types: buildTypeMap(parsed),
    call_graph: callGraph,
    import_graph: importGraph,
    dependencies: extractDependencies(config.root),
    config_dependencies: { env_vars: buildEnvVarMap(parsed) },
    routes: [],
    models: {},
    middleware: {},
    health: computeHealth(parsed, reverseCallGraph, entryPoints),
    module_metrics: computeModuleCoupling(importGraph, parsed),
  };
}

// --- Health computation ---

/** Default thresholds — will be configurable via .codemaprc in Phase 2 */
const THRESHOLDS = {
  functionComplexity: 10,
  functionLines: 50,
  classMethods: 10,
};

/**
 * Collect function and class metrics from all parsed files.
 * Iterates over all parsed files and aggregates complexity, counts, and hotspots.
 */
interface CollectedMetrics {
  totalComplexity: number;
  totalFunctions: number;
  totalClasses: number;
  functionsOverComplexity: number;
  functionsOverLines: number;
  classesOverMethodLimit: number;
  maxFunc: { name: string; file: string; value: number } | null;
  hotspots: HealthHotspot[];
}

interface FunctionMetricsAccum {
  totalComplexity: number;
  totalFunctions: number;
  functionsOverComplexity: number;
  functionsOverLines: number;
  maxFunc: { name: string; file: string; value: number } | null;
  hotspots: HealthHotspot[];
}

function processFunctionMetrics(
  func: any,
  file: string
): FunctionMetricsAccum {
  const accum: FunctionMetricsAccum = {
    totalComplexity: func.complexity,
    totalFunctions: 1,
    functionsOverComplexity: 0,
    functionsOverLines: 0,
    maxFunc: { name: func.name, file, value: func.complexity },
    hotspots: [],
  };

  if (func.complexity > THRESHOLDS.functionComplexity) {
    accum.functionsOverComplexity++;
    const severity = func.complexity > THRESHOLDS.functionComplexity * 2 ? 'critical' : 'warning';
    accum.hotspots.push({
      type: 'high_complexity',
      target: func.name,
      file,
      metric: 'complexity',
      value: func.complexity,
      threshold: THRESHOLDS.functionComplexity,
      severity,
    });
  }

  if (func.lineCount > THRESHOLDS.functionLines) {
    accum.functionsOverLines++;
  }

  return accum;
}

function processClassMetrics(
  cls: any,
  file: string
): { totalFunctions: number; totalComplexity: number; functionsOverComplexity: number; functionsOverLines: number; maxFunc: { name: string; file: string; value: number } | null; hotspots: HealthHotspot[]; classesOverMethodLimit: number } {
  let totalFunctions = 0;
  let totalComplexity = 0;
  let functionsOverComplexity = 0;
  let functionsOverLines = 0;
  let maxFunc: { name: string; file: string; value: number } | null = null;
  const hotspots: HealthHotspot[] = [];
  let classesOverMethodLimit = 0;

  for (const method of cls.methods) {
    totalFunctions++;
    totalComplexity += method.complexity;

    const qualifiedName = `${cls.name}.${method.name}`;
    if (!maxFunc || method.complexity > maxFunc.value) {
      maxFunc = { name: qualifiedName, file, value: method.complexity };
    }

    if (method.complexity > THRESHOLDS.functionComplexity) {
      functionsOverComplexity++;
      const severity = method.complexity > THRESHOLDS.functionComplexity * 2 ? 'critical' : 'warning';
      hotspots.push({
        type: 'high_complexity',
        target: qualifiedName,
        file,
        metric: 'complexity',
        value: method.complexity,
        threshold: THRESHOLDS.functionComplexity,
        severity,
      });
    }

    if (method.lineCount > THRESHOLDS.functionLines) {
      functionsOverLines++;
    }
  }

  if (cls.methods.length > THRESHOLDS.classMethods) {
    classesOverMethodLimit++;
    const severity = cls.methods.length > THRESHOLDS.classMethods * 2 ? 'critical' : 'warning';
    hotspots.push({
      type: 'god_class',
      target: cls.name,
      file,
      metric: 'method_count',
      value: cls.methods.length,
      threshold: THRESHOLDS.classMethods,
      severity,
    });
  }

  return { totalFunctions, totalComplexity, functionsOverComplexity, functionsOverLines, maxFunc, hotspots, classesOverMethodLimit };
}

function collectFunctionMetrics(
  parsed: ParsedFile[]
): CollectedMetrics {
  let totalComplexity = 0;
  let totalFunctions = 0;
  let totalClasses = 0;
  let functionsOverComplexity = 0;
  let functionsOverLines = 0;
  let classesOverMethodLimit = 0;
  let maxFunc: { name: string; file: string; value: number } | null = null;
  const hotspots: HealthHotspot[] = [];

  for (const p of parsed) {
    for (const func of p.functions) {
      const metrics = processFunctionMetrics(func, p.file.relative);
      totalFunctions += metrics.totalFunctions;
      totalComplexity += metrics.totalComplexity;
      functionsOverComplexity += metrics.functionsOverComplexity;
      functionsOverLines += metrics.functionsOverLines;
      hotspots.push(...metrics.hotspots);
      if (!maxFunc || (metrics.maxFunc && metrics.maxFunc.value > maxFunc.value)) {
        maxFunc = metrics.maxFunc;
      }
    }

    for (const cls of p.classes) {
      totalClasses++;
      const classMetrics = processClassMetrics(cls, p.file.relative);
      totalFunctions += classMetrics.totalFunctions;
      totalComplexity += classMetrics.totalComplexity;
      functionsOverComplexity += classMetrics.functionsOverComplexity;
      functionsOverLines += classMetrics.functionsOverLines;
      classesOverMethodLimit += classMetrics.classesOverMethodLimit;
      hotspots.push(...classMetrics.hotspots);
      if (!maxFunc || (classMetrics.maxFunc && classMetrics.maxFunc.value > maxFunc.value)) {
        maxFunc = classMetrics.maxFunc;
      }
    }
  }

  return {
    totalComplexity,
    totalFunctions,
    totalClasses,
    functionsOverComplexity,
    functionsOverLines,
    classesOverMethodLimit,
    maxFunc,
    hotspots,
  };
}

/**
 * Compute health score from collected metrics.
 * Takes aggregated metrics and computes the final score (0-100) based on penalties.
 */
function computeHealthScore(metrics: CollectedMetrics, deadFunctionCount: number): number {
  const { totalFunctions, totalClasses, functionsOverComplexity, functionsOverLines, classesOverMethodLimit } = metrics;

  // Use percentages to be fair across project sizes
  const complexityPct = totalFunctions > 0 ? (functionsOverComplexity / totalFunctions) * 100 : 0;
  const sizePct = totalFunctions > 0 ? (functionsOverLines / totalFunctions) * 100 : 0;
  const godClassPct = totalClasses > 0 ? (classesOverMethodLimit / totalClasses) * 100 : 0;
  const deadPct = totalFunctions > 0 ? (deadFunctionCount / totalFunctions) * 100 : 0;

  const penalties = [
    Math.min(25, complexityPct * 0.8),                 // complexity: 25% of fns over threshold → 20pt penalty
    Math.min(20, sizePct * 0.5),                       // size: 40% of fns over line limit → 20pt penalty
    Math.min(15, godClassPct * 0.5),                   // god classes: 30% of classes over limit → 15pt penalty
    Math.min(10, deadPct * 0.5),                       // dead code: 20% dead → 10pt penalty
  ];
  const totalPenalty = penalties.reduce((a, b) => a + b, 0);
  return Math.max(0, Math.round(100 - totalPenalty));
}

/**
 * Compute project health metrics from parsed data.
 * Pure computation — no opinions or suggestions, just facts.
 */
function computeHealth(
  parsed: ParsedFile[],
  reverseCallGraph: ReverseCallGraph,
  entryPoints: string[]
): HealthData {
  // Collect complexity/size metrics from parsed files
  const metrics = collectFunctionMetrics(parsed);

  // Use the dead code analyzer for consistent dead code counting
  const deadCodeData = detectDeadCode(parsed, reverseCallGraph, entryPoints);

  // Health penalty uses only high-confidence dead code
  const score = computeHealthScore(metrics, deadCodeData.highConfidenceCount);

  // Sort hotspots by severity (critical first) then by value descending
  metrics.hotspots.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'critical' ? -1 : 1;
    return b.value - a.value;
  });

  return {
    score,
    computed_at: new Date().toISOString(),
    metrics: {
      total_functions: metrics.totalFunctions,
      total_classes: metrics.totalClasses,
      total_complexity: metrics.totalComplexity,
      avg_function_complexity: metrics.totalFunctions > 0 ? Math.round((metrics.totalComplexity / metrics.totalFunctions) * 100) / 100 : 0,
      max_function_complexity: metrics.maxFunc,
      functions_over_complexity_threshold: metrics.functionsOverComplexity,
      functions_over_line_threshold: metrics.functionsOverLines,
      classes_over_method_limit: metrics.classesOverMethodLimit,
      dead_function_count: deadCodeData.deadFunctions.length,
      dead_function_percentage: deadCodeData.deadCodePercentage,
    },
    hotspots: metrics.hotspots.slice(0, 20), // Top 20 hotspots
  };
}

/** Auto-detect entry points by looking for common patterns */
function detectEntryPoints(parsed: ParsedFile[]): string[] {
  const entryPatterns = [
    /^src\/index\.[tj]sx?$/,
    /^src\/main\.[tj]sx?$/,
    /^src\/app\.[tj]sx?$/,
    /^index\.[tj]sx?$/,
    /^app\.[tj]sx?$/,
    /^server\.[tj]sx?$/,
    /^main\.py$/,
    /^app\.py$/,
    // CLI commands and MCP servers are entry points (called by framework, not by app code)
    /\/commands\/[^/]+\.[tj]sx?$/,
    /\/cli\/index\.[tj]sx?$/,
    /\/mcp\/server\.[tj]sx?$/,
    // Test files are entry points (called by test runner)
    /\.test\.[tj]sx?$/,
    /\.spec\.[tj]sx?$/,
    /test_.*\.py$/,
    /.*_test\.py$/,
  ];

  return parsed
    .filter((p) => entryPatterns.some((pattern) => pattern.test(p.file.relative)))
    .map((p) => p.file.relative);
}

/**
 * Extract Node.js dependencies from package.json.
 * Handles dependencies, devDependencies, and peerDependencies.
 */
function extractNodeDependencies(root: string): {
  packages: Record<string, { version: string; type: 'production' | 'dev' | 'peer' }>;
  source: string | null;
} {
  const packages: Record<string, { version: string; type: 'production' | 'dev' | 'peer' }> = {};
  const pkgJsonPath = join(root, 'package.json');

  if (!existsSync(pkgJsonPath)) {
    return { packages, source: null };
  }

  try {
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));

    if (pkgJson.dependencies) {
      for (const [name, version] of Object.entries(pkgJson.dependencies)) {
        packages[name] = { version: version as string, type: 'production' };
      }
    }
    if (pkgJson.devDependencies) {
      for (const [name, version] of Object.entries(pkgJson.devDependencies)) {
        packages[name] = { version: version as string, type: 'dev' };
      }
    }
    if (pkgJson.peerDependencies) {
      for (const [name, version] of Object.entries(pkgJson.peerDependencies)) {
        packages[name] = { version: version as string, type: 'peer' };
      }
    }

    return { packages, source: 'package.json' };
  } catch {
    // Ignore malformed package.json
    return { packages, source: null };
  }
}

/**
 * Parse a single requirements file and add packages to the provided record.
 */
function parseRequirementsFile(
  filePath: string,
  type: 'production' | 'dev',
  packages: Record<string, { version: string; type: 'production' | 'dev' | 'peer' }>
): boolean {
  if (!existsSync(filePath)) return false;
  try {
    const content = readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
      const match = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*([><=!~]+\s*.+)?$/);
      if (match) {
        packages[match[1]] = { version: match[2]?.trim() || '*', type };
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract Python dependencies from requirements.txt and requirements-dev.txt.
 * Handles both production and dev requirements.
 */
function extractPythonRequirements(root: string): {
  packages: Record<string, { version: string; type: 'production' | 'dev' | 'peer' }>;
  source: string | null;
} {
  const packages: Record<string, { version: string; type: 'production' | 'dev' | 'peer' }> = {};
  const sources: string[] = [];

  if (parseRequirementsFile(join(root, 'requirements.txt'), 'production', packages)) {
    sources.push('requirements.txt');
  }
  if (parseRequirementsFile(join(root, 'requirements-dev.txt'), 'dev', packages)) {
    sources.push('requirements-dev.txt');
  }

  return {
    packages,
    source: sources.length > 0 ? sources.join(', ') : null,
  };
}

/**
 * Extract Python dependencies from pyproject.toml.
 * Parses [project.dependencies] section.
 */
function extractPyprojectDependencies(root: string): {
  packages: Record<string, { version: string; type: 'production' | 'dev' | 'peer' }>;
  source: string | null;
} {
  const packages: Record<string, { version: string; type: 'production' | 'dev' | 'peer' }> = {};
  const pyprojectPath = join(root, 'pyproject.toml');

  if (!existsSync(pyprojectPath)) {
    return { packages, source: null };
  }

  try {
    const content = readFileSync(pyprojectPath, 'utf-8');

    // Extract from [project.dependencies] section — basic line-by-line parsing
    const depMatch = content.match(/\[project\]\s[\s\S]*?dependencies\s*=\s*\[([\s\S]*?)\]/);
    if (depMatch) {
      const depBlock = depMatch[1];
      for (const line of depBlock.split('\n')) {
        const cleaned = line.replace(/[",]/g, '').trim();
        if (!cleaned) continue;
        const match = cleaned.match(/^([a-zA-Z0-9_.-]+)\s*([><=!~]+\s*.+)?$/);
        if (match) {
          packages[match[1]] = {
            version: match[2]?.trim() || '*',
            type: 'production',
          };
        }
      }
    }

    return { packages, source: Object.keys(packages).length > 0 ? 'pyproject.toml' : null };
  } catch {
    // Ignore malformed pyproject.toml
    return { packages, source: null };
  }
}

/**
 * Extract dependency versions from package.json and/or requirements.txt.
 * Orchestrator that delegates to language-specific extractors and merges results.
 * Tracks version constraints without scanning library source code.
 */
function extractDependencies(root: string): CodemapData['dependencies'] {
  const allPackages: Record<string, { version: string; type: 'production' | 'dev' | 'peer' }> = {};
  const sources: string[] = [];

  // Extract from Node.js
  const nodeResult = extractNodeDependencies(root);
  Object.assign(allPackages, nodeResult.packages);
  if (nodeResult.source) sources.push(nodeResult.source);

  // Extract from Python requirements
  const pythonReqResult = extractPythonRequirements(root);
  Object.assign(allPackages, pythonReqResult.packages);
  if (pythonReqResult.source) sources.push(pythonReqResult.source);

  // Extract from pyproject.toml
  const pyprojectResult = extractPyprojectDependencies(root);
  Object.assign(allPackages, pyprojectResult.packages);
  if (pyprojectResult.source) sources.push(pyprojectResult.source);

  return {
    packages: allPackages,
    source: sources.length > 0 ? sources.join(', ') : '',
  };
}
