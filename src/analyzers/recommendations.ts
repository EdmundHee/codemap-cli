/**
 * Recommendation engine for codemap analysis.
 *
 * Generates detailed, actionable recommendations from analysis results
 * that can be directly handed to an AI coding assistant (like Claude)
 * as an implementation plan.
 */

import { DeadCodeData, DeadFunction } from './dead-code';
import { DuplicateGroup } from './duplicates';
import { CycleData } from './circular-deps';
import { CodemapData, HealthHotspot } from '../output/json-generator';

// ─── Types ────────────────────────────────────────────────────────────────

export interface Recommendation {
  id: string;
  category: 'dead-code' | 'duplicates' | 'circular-deps' | 'complexity' | 'coupling';
  priority: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  description: string;
  /** Specific files and functions affected */
  affected: Array<{ name: string; file: string; detail?: string }>;
  /** Step-by-step action plan */
  action_plan: string[];
  /** Estimated impact */
  impact: string;
  /** Effort estimate */
  effort: 'trivial' | 'small' | 'medium' | 'large';
  /** Rich context for Claude-ready prompt — populated when CodemapData available */
  context?: {
    /** Function signatures involved: "name(params): returnType" */
    signatures?: string[];
    /** What the function calls (its internal dependencies) */
    calls?: string[];
    /** What calls this function */
    called_by?: string[];
    /** Unique calls per copy (for duplicates) */
    unique_calls_per_copy?: Record<string, string[]>;
    /** Suggested new function/file names */
    suggested_names?: string[];
    /** Line count for effort estimation */
    total_lines?: number;
  };
}

export interface RecommendationReport {
  summary: {
    total: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    estimated_lines_saved: number;
    health_score?: number;
  };
  recommendations: Recommendation[];
}

// ─── Helpers for codemap lookups ──────────────────────────────────────────

function lookupFunction(data: CodemapData | null, name: string): any | null {
  if (!data) return null;
  // Try direct lookup
  if (data.functions[name]) return data.functions[name];
  // Try as class.method
  for (const [clsName, cls] of Object.entries(data.classes) as [string, any][]) {
    for (const method of cls.methods) {
      if (`${clsName}.${method.name}` === name) {
        return { ...method, file: cls.file, _class: clsName };
      }
    }
  }
  return null;
}

function getSignature(data: CodemapData | null, name: string): string | null {
  const fn = lookupFunction(data, name);
  if (!fn) return null;
  const params = (fn.params || []).map((p: any) => `${p.name}: ${p.type}`).join(', ');
  const ret = fn.return_type || 'void';
  return `${name}(${params}): ${ret}`;
}

function getCalls(data: CodemapData | null, name: string): string[] {
  if (!data?.call_graph) return [];
  return (data.call_graph[name] || []).filter((c: string) =>
    // Filter out noise: built-in property accesses
    !c.match(/^\w+\.(length|size|push|pop|shift|unshift|splice|slice|map|filter|reduce|forEach|find|some|every|includes|indexOf|join|split|trim|replace|match|test|exec|has|get|set|add|delete|keys|values|entries|toString|charAt|startsWith|endsWith)$/)
  );
}

function getCalledBy(data: CodemapData | null, name: string): string[] {
  const fn = lookupFunction(data, name);
  if (fn?.called_by) return fn.called_by;
  // Fallback: scan call graph
  if (!data?.call_graph) return [];
  const callers: string[] = [];
  for (const [caller, callees] of Object.entries(data.call_graph)) {
    if ((callees as string[]).includes(name)) callers.push(caller);
  }
  return callers;
}

// ─── Dead Code Recommendations ────────────────────────────────────────────

function prioritizeDeadCode(df: DeadFunction): 'critical' | 'high' | 'medium' | 'low' {
  if (df.lineCount > 50) return 'critical';
  if (df.lineCount > 20) return 'high';
  if (df.lineCount > 10 || df.isExported) return 'medium';
  return 'low';
}

function deadCodeEffort(df: DeadFunction): 'trivial' | 'small' | 'medium' {
  if (df.isExported) return 'medium';
  if (df.lineCount > 30) return 'small';
  return 'trivial';
}

function buildBatchDeadCodeRecommendation(file: string, funcs: DeadFunction[], data: CodemapData | null): Recommendation {
  const totalLines = funcs.reduce((sum, f) => sum + f.lineCount, 0);
  const names = funcs.map(f => f.name);
  const exported = funcs.filter(f => f.isExported);
  const priority = totalLines > 100 ? 'critical' : totalLines > 40 ? 'high' : 'medium';

  const signatures = data ? names.map(n => getSignature(data, n)).filter(Boolean) as string[] : [];

  const actionPlan = [
    `Open \`${file}\` and locate the following dead functions: ${names.map(n => `\`${n}\``).join(', ')}`,
  ];
  if (exported.length > 0) {
    actionPlan.push(
      `IMPORTANT: Verify exported functions are not used by external packages or CLI entry points: ${exported.map(f => `\`${f.name}\``).join(', ')}`,
      `Search across the project with: \`grep -r "${exported[0].name}" --include="*.ts" --include="*.js"\``,
    );
  }
  actionPlan.push(
    `Remove the ${funcs.length} dead functions and any imports they exclusively use`,
    `Remove any associated types/interfaces used only by these dead functions`,
    `Run \`npm test\` to confirm no regressions`,
    `Run \`codemap generate && codemap health\` to verify health score improvement`,
  );

  return {
    id: `dead-batch-${file.replace(/[^a-zA-Z0-9]/g, '-')}`,
    category: 'dead-code',
    priority,
    title: `Remove ${funcs.length} dead functions from ${file}`,
    description: `File \`${file}\` contains ${funcs.length} unreachable functions totaling ${totalLines} lines. ` +
      `These functions have zero callers in the reverse call graph and are not lifecycle hooks or framework handlers.`,
    affected: funcs.map(f => ({
      name: f.name,
      file: f.file,
      detail: `${f.lineCount} lines, ${f.type}${f.isExported ? ', exported' : ''}`,
    })),
    action_plan: actionPlan,
    impact: `Remove ${totalLines} lines of dead code (${funcs.length} functions), improving health score`,
    effort: totalLines > 100 ? 'medium' : 'small',
    context: {
      signatures: signatures.length > 0 ? signatures : undefined,
      total_lines: totalLines,
    },
  };
}

function buildIndividualDeadCodeRecommendation(df: DeadFunction, data: CodemapData | null): Recommendation {
  const priority = prioritizeDeadCode(df);
  const sig = getSignature(data, df.name);
  const calls = getCalls(data, df.name);
  const actionPlan: string[] = [];

  if (df.isExported) {
    actionPlan.push(
      `Search for external consumers of \`${df.name}\` — it is exported but has zero internal callers`,
      `Check: \`grep -r "${df.name.split('.').pop()}" --include="*.ts" --include="*.js" | grep -v "${df.file}"\``,
      `If no external usage found, remove the export and the function from \`${df.file}\``,
    );
  } else {
    actionPlan.push(
      `Remove \`${df.name}\` from \`${df.file}\` (${df.lineCount} lines)`,
    );
  }

  if (calls.length > 0) {
    actionPlan.push(
      `Check if any imports in \`${df.file}\` were used exclusively by \`${df.name}\` and can also be removed`,
    );
  }
  if (df.className) {
    actionPlan.push(
      `Review class \`${df.className}\` for other unused methods that could also be removed`,
    );
  }
  actionPlan.push(
    `Run \`npm test\` to confirm no regressions`,
  );

  return {
    id: `dead-${df.name.replace(/[^a-zA-Z0-9]/g, '-')}`,
    category: 'dead-code',
    priority,
    title: `Remove dead ${df.type} \`${df.name}\``,
    description: `\`${df.name}\` in \`${df.file}\` has ${df.lineCount} lines with zero callers in the call graph. ` +
      (df.isExported
        ? 'It is exported — verify no external packages depend on it before removal.'
        : 'It is not exported and can be safely removed.') +
      (calls.length > 0
        ? ` It internally calls: ${calls.slice(0, 6).join(', ')}${calls.length > 6 ? ` (+${calls.length - 6} more)` : ''}.`
        : ''),
    affected: [{ name: df.name, file: df.file, detail: `${df.lineCount} lines, ${df.type}` }],
    action_plan: actionPlan,
    impact: `Remove ${df.lineCount} lines of unreachable code`,
    effort: deadCodeEffort(df),
    context: {
      signatures: sig ? [sig] : undefined,
      calls: calls.length > 0 ? calls : undefined,
      total_lines: df.lineCount,
    },
  };
}

export function generateDeadCodeRecommendations(
  deadCode: DeadCodeData,
  data: CodemapData | null = null,
): Recommendation[] {
  if (deadCode.deadFunctions.length === 0) return [];

  const recommendations: Recommendation[] = [];

  // Group dead functions by file for batch removal recommendations
  const byFile = new Map<string, DeadFunction[]>();
  for (const df of deadCode.deadFunctions) {
    if (!byFile.has(df.file)) byFile.set(df.file, []);
    byFile.get(df.file)!.push(df);
  }

  // Generate per-file batch recommendations for files with multiple dead functions
  for (const [file, funcs] of byFile) {
    if (funcs.length >= 3) {
      recommendations.push(buildBatchDeadCodeRecommendation(file, funcs, data));
    }
  }

  // Individual recommendations for dead functions not already covered by batch
  const batchedFiles = new Set(
    [...byFile.entries()].filter(([, funcs]) => funcs.length >= 3).map(([file]) => file)
  );

  const individualFuncs = deadCode.deadFunctions
    .filter(df => !batchedFiles.has(df.file) && df.lineCount >= 5)
    .sort((a, b) => b.lineCount - a.lineCount);

  for (const df of individualFuncs.slice(0, 15)) {
    recommendations.push(buildIndividualDeadCodeRecommendation(df, data));
  }

  return recommendations;
}

// ─── Duplicate Recommendations ────────────────────────────────────────────

function duplicatePriority(dup: DuplicateGroup): 'critical' | 'high' | 'medium' | 'low' {
  if (dup.similarity >= 0.8 && dup.functions.length >= 3) return 'critical';
  if (dup.similarity >= 0.6) return 'high';
  if (dup.similarity >= 0.4) return 'medium';
  return 'low';
}

function suggestSharedLocation(files: string[]): string {
  const parts = files.map(f => f.split('/'));
  const minLen = Math.min(...parts.map(p => p.length));
  let commonDepth = 0;
  for (let i = 0; i < minLen - 1; i++) {
    if (parts.every(p => p[i] === parts[0][i])) {
      commonDepth = i + 1;
    } else {
      break;
    }
  }
  const commonDir = commonDepth > 0 ? parts[0].slice(0, commonDepth).join('/') : 'src/utils';
  return `${commonDir}/shared.ts`;
}

function suggestFunctionName(signature: string): string {
  // Convert "extractDecoratorArgs" to a shared name
  return signature;
}

interface DuplicateCallAnalysis {
  sharedCalls: string[];
  uniqueCallsPerCopy: Record<string, string[]>;
}

function analyzeDuplicateCalls(dup: DuplicateGroup): DuplicateCallAnalysis {
  const allCallSets = dup.functions.map(f => new Set(f.calls));
  const sharedCalls = dup.functions[0].calls.filter(c =>
    allCallSets.every(s => s.has(c))
  );
  const uniqueCallsPerCopy: Record<string, string[]> = {};
  for (const f of dup.functions) {
    const unique = f.calls.filter(c => !sharedCalls.includes(c));
    if (unique.length > 0) {
      uniqueCallsPerCopy[`${f.name} in ${f.file}`] = unique;
    }
  }
  return { sharedCalls, uniqueCallsPerCopy };
}

function buildHighSimilarityActionPlan(
  dup: DuplicateGroup,
  sharedLocation: string,
  signatures: string[],
  sharedCalls: string[],
  uniqueCallsPerCopy: Record<string, string[]>
): string[] {
  const plan: string[] = [
    `Create \`${sharedLocation}\` with a shared \`${suggestFunctionName(dup.signature)}\` function`,
    `Signature: \`${signatures[0] || `${dup.signature}(${dup.functions[0].params || '...'})`}\``,
  ];
  if (sharedCalls.length > 0) {
    plan.push(`The shared function should contain the common logic that calls: ${sharedCalls.slice(0, 8).join(', ')}`);
  }
  plan.push(`In each of these files, replace the local implementation with an import from \`${sharedLocation}\`:`);
  for (const f of dup.functions) {
    plan.push(`  - \`${f.file}\`: replace \`${f.name}\` with import`);
  }
  if (Object.keys(uniqueCallsPerCopy).length > 0) {
    plan.push('Handle divergent logic per copy:');
    for (const [loc, unique] of Object.entries(uniqueCallsPerCopy)) {
      plan.push(`  - ${loc} has unique calls: ${unique.join(', ')}`);
    }
    plan.push('Either add a configuration parameter to the shared function or keep thin wrappers for the divergent parts');
  }
  return plan;
}

function buildLowSimilarityActionPlan(
  dup: DuplicateGroup,
  sharedLocation: string,
  sharedCalls: string[]
): string[] {
  const plan: string[] = [`Compare the implementations side by side:`];
  for (const f of dup.functions) {
    plan.push(`  - \`${f.name}\` in \`${f.file}\` (params: ${f.params || 'none'})`);
  }
  plan.push(
    `Identify the common core logic (${Math.round(dup.similarity * 100)}% call overlap)`,
    `Extract the shared core into \`${sharedLocation}\``,
    `Keep the divergent parts as thin wrapper functions that delegate to the shared core`,
  );
  if (sharedCalls.length > 0) {
    plan.push(`Common calls to extract: ${sharedCalls.join(', ')}`);
  }
  return plan;
}

function buildDuplicateRecommendation(dup: DuplicateGroup, data: CodemapData | null): Recommendation {
  const priority = duplicatePriority(dup);
  const files = [...new Set(dup.functions.map(f => f.file))];
  const sharedLocation = suggestSharedLocation(files);
  const { sharedCalls, uniqueCallsPerCopy } = analyzeDuplicateCalls(dup);

  const signatures = data
    ? dup.functions.map(f => getSignature(data, f.name)).filter(Boolean) as string[]
    : [];

  const actionPlan = dup.similarity >= 0.7
    ? buildHighSimilarityActionPlan(dup, sharedLocation, signatures, sharedCalls, uniqueCallsPerCopy)
    : buildLowSimilarityActionPlan(dup, sharedLocation, sharedCalls);
  actionPlan.push(
    `Update all imports in affected files`,
    `Run \`npm test\` to confirm no regressions`,
  );

  return {
    id: `dup-${dup.signature.replace(/[^a-zA-Z0-9]/g, '-')}`,
    category: 'duplicates',
    priority,
    title: `Deduplicate \`${dup.signature}\` (${dup.functions.length} copies, ${Math.round(dup.similarity * 100)}% similar)`,
    description: `${dup.functions.length} functions named \`${dup.signature}\` exist across ${files.length} files ` +
      `with ${Math.round(dup.similarity * 100)}% call pattern similarity. ` +
      (sharedCalls.length > 0
        ? `They share ${sharedCalls.length} common internal calls (${sharedCalls.slice(0, 5).join(', ')}${sharedCalls.length > 5 ? '...' : ''}). `
        : '') +
      `Extract into \`${sharedLocation}\`.`,
    affected: dup.functions.map(f => ({
      name: f.name,
      file: f.file,
      detail: f.params ? `params: (${f.params})` : 'no params',
    })),
    action_plan: actionPlan,
    impact: `Eliminate ${dup.functions.length - 1} redundant implementations, improving maintainability`,
    effort: dup.similarity >= 0.7 ? 'small' : 'medium',
    context: {
      signatures: signatures.length > 0 ? signatures : undefined,
      calls: sharedCalls.length > 0 ? sharedCalls : undefined,
      unique_calls_per_copy: Object.keys(uniqueCallsPerCopy).length > 0 ? uniqueCallsPerCopy : undefined,
      suggested_names: [`${sharedLocation}`],
    },
  };
}

export function generateDuplicateRecommendations(
  duplicates: DuplicateGroup[],
  data: CodemapData | null = null,
): Recommendation[] {
  if (duplicates.length === 0) return [];

  const recommendations: Recommendation[] = [];

  for (const dup of duplicates.slice(0, 15)) {
    recommendations.push(buildDuplicateRecommendation(dup, data));
  }

  return recommendations;
}

// ─── Circular Dependency Recommendations ──────────────────────────────────

function cyclePriority(cycle: CycleData): 'critical' | 'high' | 'medium' | 'low' {
  if (cycle.files.length > 4) return 'critical';
  if (cycle.files.length > 2) return 'high';
  if (cycle.minimumCutSymbolCount > 5) return 'high';
  return 'medium';
}

export function generateCircularDepRecommendations(cycles: CycleData[]): Recommendation[] {
  if (cycles.length === 0) return [];

  const recommendations: Recommendation[] = [];

  for (const cycle of cycles) {
    const priority = cyclePriority(cycle);
    const actionPlan: string[] = [];

    if (cycle.minimumCut) {
      const mc = cycle.minimumCut;
      const symbolList = mc.symbols.length > 0
        ? mc.symbols.join(', ')
        : 'all imports';

      actionPlan.push(
        `Break the cycle at the minimum cut: \`${mc.sourceFile}\` → \`${mc.targetFile}\` (${cycle.minimumCutSymbolCount} symbols)`,
        `Symbols to relocate: ${symbolList}`,
      );

      const commonDir = mc.sourceFile.split('/').slice(0, -1).join('/') || 'src';
      if (mc.symbols.length <= 3) {
        actionPlan.push(
          `Option A: Create \`${commonDir}/shared-types.ts\`, move ${symbolList} there, update imports in both files`,
          `Option B: Use dependency injection — pass \`${mc.symbols[0] || 'the dependency'}\` as a parameter instead of importing directly`,
        );
      } else {
        actionPlan.push(
          `Create \`${commonDir}/interfaces.ts\` for shared types/interfaces`,
          `Move the ${mc.symbols.length} shared symbols there and have both files import from the new module`,
          `Move implementation dependencies behind the interface boundary`,
        );
      }
    } else {
      actionPlan.push(
        `Analyze the cycle between: ${cycle.files.join(' ↔ ')}`,
        `Identify shared types/interfaces and extract to a separate module`,
        `Apply dependency inversion: depend on abstractions, not implementations`,
      );
    }

    actionPlan.push(
      `Run \`codemap analyze --circular\` after refactoring to verify the cycle is resolved`,
    );

    recommendations.push({
      id: `cycle-${cycle.files.sort().join('-').replace(/[^a-zA-Z0-9]/g, '-').slice(0, 60)}`,
      category: 'circular-deps',
      priority,
      title: `Break circular dependency: ${cycle.files.length} files`,
      description: `Circular import chain involving ${cycle.files.length} files: ${cycle.files.join(' → ')}. ` +
        (cycle.minimumCut
          ? `Minimum cut: \`${cycle.minimumCut.sourceFile}\` → \`${cycle.minimumCut.targetFile}\` with ${cycle.minimumCutSymbolCount} symbols.`
          : 'No clear minimum cut found — consider restructuring the module.'),
      affected: cycle.edges.map(e => ({
        name: `${e.sourceFile} → ${e.targetFile}`,
        file: e.sourceFile,
        detail: e.symbols.length > 0 ? `imports: ${e.symbols.join(', ')}` : 'import *',
      })),
      action_plan: actionPlan,
      impact: `Resolve ${cycle.files.length}-file circular dependency, improving build reliability and testability`,
      effort: cycle.files.length > 3 ? 'large' : 'medium',
    });
  }

  return recommendations;
}

// ─── Complexity Hotspot Recommendations ───────────────────────────────────

function buildConcernDecompositionSteps(target: string, calls: string[]): string[] {
  const steps: string[] = [];
  const callGroups = groupCallsByConcern(calls);
  if (callGroups.length > 1) {
    steps.push(`This function has ${callGroups.length} identifiable concerns that should be separate functions:`);
    for (let i = 0; i < Math.min(callGroups.length, 6); i++) {
      const g = callGroups[i];
      const suggestedName = suggestHelperName(target, g.label);
      steps.push(`  ${i + 1}. \`${suggestedName}\` — handles: ${g.calls.slice(0, 5).join(', ')}${g.calls.length > 5 ? ` (+${g.calls.length - 5} more)` : ''}`);
    }
  } else {
    steps.push(`Key internal calls: ${calls.slice(0, 10).join(', ')}${calls.length > 10 ? ` (+${calls.length - 10} more)` : ''}`);
  }
  return steps;
}

function buildComplexityActionPlan(
  h: HealthHotspot,
  ratio: number,
  sig: string | null,
  lineCount: number,
  calls: string[]
): string[] {
  const plan = [
    `Open \`${h.file}\` and locate \`${h.target}\`${sig ? ` — signature: \`${sig}\`` : ''}`,
    `Current complexity: ${h.value} (threshold: ${h.threshold}, ratio: ${ratio.toFixed(1)}x)${lineCount ? `, ${lineCount} lines` : ''}`,
  ];

  if (calls.length > 0) {
    plan.push(...buildConcernDecompositionSteps(h.target, calls));
  }

  plan.push(
    `Refactoring strategy:`,
    `  a. Identify each conditional branch (if/else/switch/ternary/try-catch) — each adds 1 to complexity`,
    `  b. Extract each logical block into a well-named private helper function`,
    `  c. Use early returns to flatten nested conditionals`,
    `  d. The main function should read like a high-level orchestration of the helpers`,
  );

  if (ratio > 3) {
    plan.push(
      `WARNING: At ${ratio.toFixed(1)}x threshold, consider a full structural rewrite:`,
      `  - Use strategy pattern if branching on a type/mode flag`,
      `  - Use lookup table/map if dispatching based on string keys`,
      `  - Use pipeline pattern if processing data through sequential stages`,
    );
  }

  plan.push(
    `After refactoring, verify: \`codemap generate && codemap health\` — target complexity below ${h.threshold}`,
  );

  return plan;
}

function buildComplexityRecommendation(h: HealthHotspot, data: CodemapData | null): Recommendation {
  const ratio = h.value / h.threshold;
  const priority = h.severity === 'critical' ? 'critical' : ratio > 2 ? 'high' : 'medium';

  const calls = getCalls(data, h.target);
  const sig = getSignature(data, h.target);
  const fn = lookupFunction(data, h.target);
  const lineCount = fn?.line_count || fn?.lineCount || 0;

  const actionPlan = buildComplexityActionPlan(h, ratio, sig, lineCount, calls);

  return {
    id: `complexity-${h.target.replace(/[^a-zA-Z0-9]/g, '-')}`,
    category: 'complexity',
    priority,
    title: `Reduce complexity of \`${h.target}\` (${h.value}/${h.threshold})`,
    description: `\`${h.target}\` in \`${h.file}\` has cyclomatic complexity of ${h.value} ` +
      `(${ratio.toFixed(1)}x the threshold of ${h.threshold}).` +
      (lineCount ? ` It spans ${lineCount} lines.` : '') +
      (calls.length > 3 ? ` It makes ${calls.length} distinct internal calls, suggesting multiple responsibilities.` : ''),
    affected: [{ name: h.target, file: h.file, detail: `complexity: ${h.value}, ${lineCount ? `${lineCount} lines` : 'threshold: ' + h.threshold}` }],
    action_plan: actionPlan,
    impact: `Reduce complexity from ${h.value} to below ${h.threshold}, improving testability and maintainability`,
    effort: ratio > 3 ? 'large' : 'medium',
    context: {
      signatures: sig ? [sig] : undefined,
      calls: calls.length > 0 ? calls : undefined,
      total_lines: lineCount || undefined,
    },
  };
}

function buildGodClassRecommendation(h: HealthHotspot, data: CodemapData | null): Recommendation {
  // Get method list from codemap
  const cls = data?.classes?.[h.target] as any;
  const methods = cls?.methods?.map((m: any) => m.name) || [];
  const methodDetails = cls?.methods?.map((m: any) => `${m.name}(${(m.params || []).map((p: any) => p.name).join(', ')}) — complexity: ${m.complexity || '?'}, ${m.line_count || m.lineCount || '?'} lines`) || [];

  const actionPlan = [
    `Open \`${h.file}\` and review class \`${h.target}\` (${h.value} methods, threshold: ${h.threshold})`,
  ];

  if (methodDetails.length > 0) {
    actionPlan.push(`Current methods:`);
    for (const md of methodDetails.slice(0, 15)) {
      actionPlan.push(`  - ${md}`);
    }
    if (methodDetails.length > 15) {
      actionPlan.push(`  ... and ${methodDetails.length - 15} more`);
    }
  }

  actionPlan.push(
    `Group these methods by responsibility/concern (e.g., data access, validation, formatting, I/O)`,
    `Extract each concern group into a dedicated class:`,
    `  - Name each extracted class by its specific responsibility (e.g., \`${h.target}Validator\`, \`${h.target}Formatter\`)`,
    `  - The original \`${h.target}\` should delegate to these via composition`,
    `  - Each extracted class should be independently testable`,
    `Update existing tests and add new tests for extracted classes`,
    `Run \`npm test\` to confirm no regressions`,
  );

  return {
    id: `god-class-${h.target.replace(/[^a-zA-Z0-9]/g, '-')}`,
    category: 'complexity',
    priority: h.severity === 'critical' ? 'critical' : 'high',
    title: `Split god class \`${h.target}\` (${h.value} methods)`,
    description: `\`${h.target}\` in \`${h.file}\` has ${h.value} methods (threshold: ${h.threshold}). ` +
      `Large classes violate the Single Responsibility Principle and are hard to maintain and test.` +
      (methods.length > 0 ? ` Methods: ${methods.slice(0, 8).join(', ')}${methods.length > 8 ? `... (+${methods.length - 8})` : ''}.` : ''),
    affected: [{ name: h.target, file: h.file, detail: `${h.value} methods` }],
    action_plan: actionPlan,
    impact: `Split ${h.value}-method class into focused, independently testable components`,
    effort: 'large',
    context: {
      suggested_names: methods.length > 0 ? methods : undefined,
    },
  };
}

function buildCouplingRecommendation(h: HealthHotspot): Recommendation {
  return {
    id: `coupling-${h.target.replace(/[^a-zA-Z0-9]/g, '-')}`,
    category: 'coupling',
    priority: h.severity === 'critical' ? 'high' : 'medium',
    title: `Reduce coupling in module \`${h.target}\``,
    description: `Module \`${h.target}\` has high coupling (${h.metric}: ${h.value}, threshold: ${h.threshold}). ` +
      `Changes in this module ripple across many dependents.`,
    affected: [{ name: h.target, file: h.file, detail: `${h.metric}: ${h.value}` }],
    action_plan: [
      `Identify the most imported symbols from \`${h.target}\` using \`codemap query --module ${h.target}\``,
      `Create a stable public API barrel file (\`${h.target}/index.ts\`) that re-exports only necessary symbols`,
      `Move internal helpers to private modules not re-exported from the barrel`,
      `Consider introducing interfaces to decouple concrete implementations from consumers`,
      `Run \`codemap analyze --circular\` after changes to verify no new cycles`,
    ],
    impact: `Reduce module instability from ${h.value} toward ${h.threshold}, making refactoring safer`,
    effort: 'medium',
  };
}

export function generateHotspotRecommendations(
  hotspots: HealthHotspot[],
  data: CodemapData | null = null,
): Recommendation[] {
  if (!hotspots || hotspots.length === 0) return [];

  const recommendations: Recommendation[] = [];

  const complexityHotspots = hotspots.filter(h => h.type === 'high_complexity');
  const godClasses = hotspots.filter(h => h.type === 'god_class');
  const highCoupling = hotspots.filter(h => h.type === 'high_coupling');

  for (const h of complexityHotspots.slice(0, 10)) {
    recommendations.push(buildComplexityRecommendation(h, data));
  }

  for (const h of godClasses.slice(0, 5)) {
    recommendations.push(buildGodClassRecommendation(h, data));
  }

  for (const h of highCoupling.slice(0, 5)) {
    recommendations.push(buildCouplingRecommendation(h));
  }

  return recommendations;
}

// ─── Concern grouping for complexity decomposition ────────────────────────

interface CallGroup {
  label: string;
  calls: string[];
}

function groupCallsByConcern(calls: string[]): CallGroup[] {
  const groups: Map<string, string[]> = new Map();

  for (const call of calls) {
    let concern = 'core';
    if (call.match(/\.(push|pop|shift|unshift|splice|concat|flat|map|filter|reduce|forEach|find|some|every|sort)\b/)) {
      concern = 'data-transform';
    } else if (call.match(/\b(log|warn|error|info|debug|success|start)\b/i)) {
      concern = 'logging';
    } else if (call.match(/\b(read|write|exist|mkdir|unlink|stat|readFile|writeFile)\b/i)) {
      concern = 'file-io';
    } else if (call.match(/\b(parse|JSON\.|stringify|encode|decode)\b/i)) {
      concern = 'parsing';
    } else if (call.match(/\b(valid|check|assert|verify|is[A-Z]|has[A-Z])\b/)) {
      concern = 'validation';
    } else if (call.match(/\b(format|render|generate|template|toString)\b/i)) {
      concern = 'formatting';
    } else if (call.match(/\b(fetch|request|get|post|put|delete|query|connect)\b/i) && !call.match(/^(Map|Set|Array)\./)) {
      concern = 'data-access';
    } else if (call.match(/\b(config|option|setting|env)\b/i)) {
      concern = 'configuration';
    }

    if (!groups.has(concern)) groups.set(concern, []);
    groups.get(concern)!.push(call);
  }

  return [...groups.entries()]
    .filter(([, calls]) => calls.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([label, calls]) => ({ label, calls }));
}

function suggestHelperName(parentName: string, concern: string): string {
  const base = parentName.includes('.') ? parentName.split('.').pop()! : parentName;
  const prefix = base.length > 20 ? '' : base;
  const suffixMap: Record<string, string> = {
    'data-transform': 'transformData',
    'logging': 'logProgress',
    'file-io': 'handleFileIO',
    'parsing': 'parseInput',
    'validation': 'validateInput',
    'formatting': 'formatOutput',
    'data-access': 'fetchData',
    'configuration': 'loadConfig',
    'core': 'processCore',
  };
  const suffix = suffixMap[concern] || concern;
  return prefix ? `${prefix}_${suffix}` : suffix;
}

// ─── Full Report ──────────────────────────────────────────────────────────

export function generateRecommendationReport(
  deadCode: DeadCodeData | null,
  duplicates: DuplicateGroup[] | null,
  cycles: CycleData[] | null,
  hotspots: HealthHotspot[] | null,
  data: CodemapData | null = null,
): RecommendationReport {
  const allRecs: Recommendation[] = [];

  if (deadCode) allRecs.push(...generateDeadCodeRecommendations(deadCode, data));
  if (duplicates) allRecs.push(...generateDuplicateRecommendations(duplicates, data));
  if (cycles) allRecs.push(...generateCircularDepRecommendations(cycles));
  if (hotspots) allRecs.push(...generateHotspotRecommendations(hotspots, data));

  // Sort by priority
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  allRecs.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  const estimatedLinesSaved = deadCode ? deadCode.totalDeadLines : 0;

  return {
    summary: {
      total: allRecs.length,
      critical: allRecs.filter(r => r.priority === 'critical').length,
      high: allRecs.filter(r => r.priority === 'high').length,
      medium: allRecs.filter(r => r.priority === 'medium').length,
      low: allRecs.filter(r => r.priority === 'low').length,
      estimated_lines_saved: estimatedLinesSaved,
      health_score: data?.health?.score,
    },
    recommendations: allRecs,
  };
}

// ─── Formatters ───────────────────────────────────────────────────────────

const PRIORITY_ICONS: Record<string, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🟢',
};

function formatSingleRecommendation(rec: Recommendation, index: number): string[] {
  const lines: string[] = [];
  const icon = PRIORITY_ICONS[rec.priority] || '⚪';

  lines.push(`  ─── ${index + 1}. ${icon} [${rec.priority.toUpperCase()}] ${rec.title} ───`);
  lines.push('');
  lines.push(`  ${rec.description}`);
  lines.push('');

  // Show signatures if available
  if (rec.context?.signatures && rec.context.signatures.length > 0) {
    lines.push('  Signatures:');
    for (const sig of rec.context.signatures.slice(0, 5)) {
      lines.push(`    ${sig}`);
    }
    lines.push('');
  }

  // Affected items
  lines.push('  Affected:');
  for (const a of rec.affected.slice(0, 10)) {
    lines.push(`    • ${a.name} — ${a.file}${a.detail ? ` (${a.detail})` : ''}`);
  }
  if (rec.affected.length > 10) {
    lines.push(`    ... and ${rec.affected.length - 10} more`);
  }
  lines.push('');

  // Action plan
  lines.push('  Action plan:');
  for (let j = 0; j < rec.action_plan.length; j++) {
    const step = rec.action_plan[j];
    if (step.startsWith('  ')) {
      // Indented sub-step
      lines.push(`    ${step}`);
    } else {
      lines.push(`    ${j + 1}. ${step}`);
    }
  }
  lines.push('');

  lines.push(`  Impact: ${rec.impact}`);
  lines.push(`  Effort: ${rec.effort}`);
  lines.push('');

  return lines;
}

export function formatRecommendationReport(report: RecommendationReport): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('  ═══════════════════════════════════════════════════════════');
  lines.push('  RECOMMENDATIONS');
  lines.push('  ═══════════════════════════════════════════════════════════');
  lines.push('');

  const { summary } = report;
  lines.push(`  Found ${summary.total} recommendations:`);
  if (summary.critical > 0) lines.push(`    🔴 Critical: ${summary.critical}`);
  if (summary.high > 0) lines.push(`    🟠 High:     ${summary.high}`);
  if (summary.medium > 0) lines.push(`    🟡 Medium:   ${summary.medium}`);
  if (summary.low > 0) lines.push(`    🟢 Low:      ${summary.low}`);
  if (summary.estimated_lines_saved > 0) {
    lines.push(`    📉 Est. lines removable: ${summary.estimated_lines_saved}`);
  }
  if (summary.health_score !== undefined) {
    lines.push(`    💊 Current health score: ${summary.health_score}/100`);
  }
  lines.push('');

  for (let i = 0; i < report.recommendations.length; i++) {
    lines.push(...formatSingleRecommendation(report.recommendations[i], i));
  }

  // Claude-ready prompt block
  if (report.recommendations.length > 0) {
    lines.push(generateClaudePrompt(report));
  }

  return lines.join('\n');
}

// ─── Claude-Ready Implementation Brief ────────────────────────────────────

function formatCategorySection(category: string, recs: Recommendation[], startTaskNum: number): { lines: string[]; nextTaskNum: number } {
  const lines: string[] = [];
  const categoryLabels: Record<string, string> = {
    'dead-code': 'Phase 1: Remove Dead Code',
    'duplicates': 'Phase 2: Deduplicate Shared Logic',
    'circular-deps': 'Phase 3: Break Circular Dependencies',
    'complexity': 'Phase 4: Reduce Complexity',
    'coupling': 'Phase 5: Improve Module Coupling',
  };

  lines.push(`  ## ${categoryLabels[category] || category}`);
  lines.push('');

  let taskNum = startTaskNum;
  for (const rec of recs) {
    lines.push(`  ### Task ${taskNum}: ${rec.title}`);
    lines.push(`  Priority: ${rec.priority} | Effort: ${rec.effort}`);
    lines.push('');

    // Files involved
    const uniqueFiles = [...new Set(rec.affected.map(a => a.file))];
    lines.push(`  Files: ${uniqueFiles.map(f => `\`${f}\``).join(', ')}`);

    // Signatures
    if (rec.context?.signatures && rec.context.signatures.length > 0) {
      lines.push(`  Signatures:`);
      for (const sig of rec.context.signatures) {
        lines.push(`    - \`${sig}\``);
      }
    }

    // What it calls (for context)
    if (rec.context?.calls && rec.context.calls.length > 0) {
      lines.push(`  Internal calls: ${rec.context.calls.slice(0, 12).join(', ')}${rec.context.calls.length > 12 ? ` (+${rec.context.calls.length - 12} more)` : ''}`);
    }

    lines.push('');
    lines.push('  Steps:');
    for (let j = 0; j < rec.action_plan.length; j++) {
      const step = rec.action_plan[j];
      if (step.startsWith('  ')) {
        lines.push(`  ${step}`);
      } else {
        lines.push(`    ${j + 1}. ${step}`);
      }
    }
    lines.push('');
    lines.push(`  Expected impact: ${rec.impact}`);
    lines.push('');

    taskNum++;
  }

  return { lines, nextTaskNum: taskNum };
}

function generateClaudePrompt(report: RecommendationReport): string {
  const lines: string[] = [];

  lines.push('  ═══════════════════════════════════════════════════════════');
  lines.push('  CLAUDE IMPLEMENTATION BRIEF');
  lines.push('  ═══════════════════════════════════════════════════════════');
  lines.push('');
  lines.push('  Copy everything between the --- markers and paste to Claude:');
  lines.push('');
  lines.push('  ---');
  lines.push('');
  lines.push('  # Code Quality Improvement Plan');
  lines.push('');
  if (report.summary.health_score !== undefined) {
    lines.push(`  Current health score: ${report.summary.health_score}/100`);
  }
  lines.push(`  Issues found: ${report.summary.critical} critical, ${report.summary.high} high, ${report.summary.medium} medium, ${report.summary.low} low`);
  if (report.summary.estimated_lines_saved > 0) {
    lines.push(`  Estimated removable lines: ${report.summary.estimated_lines_saved}`);
  }
  lines.push('');
  lines.push('  Work through each task below one at a time. After each task,');
  lines.push('  run `npm test` to verify no regressions, then move to the next.');
  lines.push('  After all tasks, run `codemap generate && codemap health` to');
  lines.push('  verify the health score improved.');
  lines.push('');

  // Group recommendations by category for a structured brief
  const byCategory = new Map<string, Recommendation[]>();
  for (const rec of report.recommendations) {
    if (!byCategory.has(rec.category)) byCategory.set(rec.category, []);
    byCategory.get(rec.category)!.push(rec);
  }

  const categoryOrder = ['dead-code', 'duplicates', 'circular-deps', 'complexity', 'coupling'];

  let taskNum = 1;
  for (const cat of categoryOrder) {
    const recs = byCategory.get(cat);
    if (!recs || recs.length === 0) continue;

    const section = formatCategorySection(cat, recs, taskNum);
    lines.push(...section.lines);
    taskNum = section.nextTaskNum;
  }

  lines.push('  ## Verification');
  lines.push('');
  lines.push('  After completing all tasks:');
  lines.push('  1. Run `npm test` — all tests must pass');
  lines.push('  2. Run `npm run build` — must compile cleanly');
  lines.push('  3. Run `codemap generate && codemap health` — health score should improve');
  lines.push('  4. Run `codemap analyze --all` — recommendation count should decrease');
  lines.push('  5. Commit changes with a descriptive message per phase');
  lines.push('');
  lines.push('  ---');
  lines.push('');

  return lines.join('\n');
}
