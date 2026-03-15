/**
 * Caller distribution analysis.
 *
 * For every function, computes where its callers live (by module).
 * When most callers are in a different module than the function itself,
 * the function is likely misplaced.
 */

import { ReverseCallGraph } from './call-graph';
import { ParsedFile } from '../parsers/parser.interface';
import { getModuleFromPath } from '../utils/module-path';

export interface CallerDistribution {
  functionName: string;
  file: string;
  currentModule: string;
  totalCallers: number;
  /** module path → count of callers in that module */
  callersByModule: Record<string, number>;
  /** Module with the most callers, if different from currentModule */
  dominantModule: string | null;
  /** What percentage of callers are in the dominant module */
  dominantModulePercentage: number;
}

const getModule = getModuleFromPath;

/**
 * Compute caller distributions for all functions.
 * Returns only functions where the dominant caller module differs from the current module.
 */
export function computeCallerDistributions(
  parsedFiles: ParsedFile[],
  reverseCallGraph: ReverseCallGraph,
  functionFileMap: Record<string, string>
): CallerDistribution[] {
  const results: CallerDistribution[] = [];

  // Build function → file mapping
  const funcToFile: Record<string, string> = { ...functionFileMap };
  for (const p of parsedFiles) {
    for (const func of p.functions) {
      funcToFile[func.name] = p.file.relative;
    }
    for (const cls of p.classes) {
      for (const method of cls.methods) {
        funcToFile[`${cls.name}.${method.name}`] = p.file.relative;
      }
    }
  }

  for (const [funcName, callers] of Object.entries(reverseCallGraph)) {
    if (!callers || callers.length === 0) continue;

    const funcFile = funcToFile[funcName];
    if (!funcFile) continue;

    const currentModule = getModule(funcFile);

    // Count callers by module
    const callersByModule: Record<string, number> = {};
    for (const caller of callers) {
      const callerFile = funcToFile[caller];
      if (!callerFile) continue;
      const callerModule = getModule(callerFile);
      callersByModule[callerModule] = (callersByModule[callerModule] || 0) + 1;
    }

    // Find dominant module
    let dominantModule: string | null = null;
    let dominantCount = 0;
    for (const [mod, count] of Object.entries(callersByModule)) {
      if (mod !== currentModule && count > dominantCount) {
        dominantModule = mod;
        dominantCount = count;
      }
    }

    const totalCallers = callers.length;
    const dominantPercentage = totalCallers > 0 ? Math.round((dominantCount / totalCallers) * 100) / 100 : 0;

    // Only include if dominant module differs from current and has significant callers
    if (dominantModule && dominantPercentage >= 0.5) {
      results.push({
        functionName: funcName,
        file: funcFile,
        currentModule,
        totalCallers,
        callersByModule,
        dominantModule,
        dominantModulePercentage: dominantPercentage,
      });
    }
  }

  // Sort by dominant percentage descending
  results.sort((a, b) => b.dominantModulePercentage - a.dominantModulePercentage);

  return results;
}
