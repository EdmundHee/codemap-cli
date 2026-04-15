/**
 * Dead code detection from the reverse call graph.
 *
 * A function is "dead" if:
 * 1. It has zero callers in the reverse call graph
 *    (including synthetic framework callers injected by synthetic-callers.ts)
 * 2. It is not in an entry point file
 *
 * Framework awareness (lifecycle hooks, decorator patterns) is handled upstream
 * by synthetic caller injection — this module stays pure: no callers = dead.
 */

import { ParsedFile } from '../parsers/parser.interface';
import { ReverseCallGraph } from './call-graph';

export interface DeadFunction {
  name: string;
  file: string;
  lineCount: number;
  isExported: boolean;
  type: 'function' | 'method';
  className?: string;
  confidence: 'high' | 'low';
}

export interface DeadCodeData {
  deadFunctions: DeadFunction[];
  totalDeadLines: number;
  deadCodePercentage: number;
  totalFunctions: number;
  highConfidenceCount: number;
}

function findDeadFunctions(
  p: ParsedFile,
  isEntryFile: boolean,
  reverseCallGraph: ReverseCallGraph,
  allExportedNames: Set<string>
): { dead: DeadFunction[]; totalFunctions: number; totalLines: number } {
  const dead: DeadFunction[] = [];
  let totalFunctions = 0;
  let totalLines = 0;

  for (const func of p.functions) {
    totalFunctions++;
    if (isEntryFile) continue;
    const callers = reverseCallGraph[func.name];
    if (!callers || callers.length === 0) {
      const isReExported = !func.exported && allExportedNames.has(func.name);
      const confidence = (func.exported || isReExported) ? 'low' : 'high';
      dead.push({ name: func.name, file: p.file.relative, lineCount: func.lineCount, isExported: func.exported, type: 'function', confidence });
      totalLines += func.lineCount;
    }
  }

  for (const cls of p.classes) {
    for (const method of cls.methods) {
      totalFunctions++;
      if (isEntryFile) continue;
      // Constructors are always called implicitly by instantiation
      if (method.name === 'constructor' || method.name === '__init__') continue;
      const qualifiedName = `${cls.name}.${method.name}`;
      const callers = reverseCallGraph[qualifiedName];
      if (!callers || callers.length === 0) {
        const isPublic = method.access === 'public';
        const confidence = isPublic ? 'low' : 'high';
        dead.push({ name: qualifiedName, file: p.file.relative, lineCount: method.lineCount, isExported: isPublic, type: 'method', className: cls.name, confidence });
        totalLines += method.lineCount;
      }
    }
  }

  return { dead, totalFunctions, totalLines };
}

/**
 * Detect dead functions and methods.
 */
export function detectDeadCode(
  parsedFiles: ParsedFile[],
  reverseCallGraph: ReverseCallGraph,
  entryPoints: string[]
): DeadCodeData {
  const entryPointFiles = new Set(entryPoints);
  const dead: DeadFunction[] = [];
  let totalFunctions = 0;
  let totalLines = 0;

  // Build set of all exported names across all files (for re-export detection)
  const allExportedNames = new Set<string>();
  for (const p of parsedFiles) {
    for (const exp of p.exports) {
      allExportedNames.add(exp.name);
    }
  }

  for (const p of parsedFiles) {
    const result = findDeadFunctions(p, entryPointFiles.has(p.file.relative), reverseCallGraph, allExportedNames);
    dead.push(...result.dead);
    totalFunctions += result.totalFunctions;
    totalLines += result.totalLines;
  }

  const highConfidenceCount = dead.filter(d => d.confidence === 'high').length;

  return {
    deadFunctions: dead,
    totalDeadLines: totalLines,
    deadCodePercentage: totalFunctions > 0 ? Math.round((dead.length / totalFunctions) * 10000) / 100 : 0,
    totalFunctions,
    highConfidenceCount,
  };
}
