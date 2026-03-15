/**
 * Module-level coupling metrics computed from the import graph.
 *
 * Exposes afferent coupling (Ca), efferent coupling (Ce), and instability (I)
 * for each module (directory). These are standard software engineering metrics
 * from Robert C. Martin's package principles.
 *
 * - Ca (afferent coupling): how many other modules depend on this one
 *   High Ca = this module is hard to change without breaking things
 *
 * - Ce (efferent coupling): how many other modules this one depends on
 *   High Ce = this module is fragile / sensitive to external changes
 *
 * - Instability I = Ce / (Ca + Ce), range [0, 1]
 *   0 = maximally stable (many dependents, few dependencies)
 *   1 = maximally unstable (few dependents, many dependencies)
 */

import { ImportGraph } from './import-graph';
import { ParsedFile } from '../parsers/parser.interface';
import { getModuleFromPath } from '../utils/module-path';

export interface ModuleMetrics {
  /** Module path (directory) */
  path: string;
  /** How many other modules depend on this one */
  afferentCoupling: number;
  /** How many other modules this one depends on */
  efferentCoupling: number;
  /** I = Ce / (Ca + Ce), range [0,1]. 0 = stable, 1 = unstable */
  instability: number;
  /** Number of source files in this module */
  fileCount: number;
  /** Sum of complexity of all functions/methods in this module */
  totalComplexity: number;
  /** Average complexity per function/method */
  avgComplexity: number;
  /** Highest single-function/method complexity */
  maxComplexity: number;
  /** Name of the function/method with highest complexity */
  maxComplexityFunction: string | null;
  /** Count of exported symbols */
  publicSurfaceArea: number;
}

// Re-export for backward compatibility
const getModule = getModuleFromPath;

/**
 * Step 1: Group files by their module (directory).
 */
function groupFilesByModule(parsedFiles: ParsedFile[]): Map<string, string[]> {
  const moduleFiles = new Map<string, string[]>();
  for (const parsed of parsedFiles) {
    const mod = getModule(parsed.file.relative);
    if (!moduleFiles.has(mod)) moduleFiles.set(mod, []);
    moduleFiles.get(mod)!.push(parsed.file.relative);
  }
  return moduleFiles;
}

/**
 * Step 2: Build module-level import edges from file-level import graph.
 * Returns moduleImports (module → modules it imports from)
 * and moduleImportedBy (module → modules that import from it).
 */
function buildModuleEdges(
  importGraph: ImportGraph,
  moduleFiles: Map<string, string[]>
): { imports: Map<string, Set<string>>; importedBy: Map<string, Set<string>> } {
  const moduleImports = new Map<string, Set<string>>();
  const moduleImportedBy = new Map<string, Set<string>>();

  for (const mod of moduleFiles.keys()) {
    moduleImports.set(mod, new Set());
    moduleImportedBy.set(mod, new Set());
  }

  for (const [filePath, importedFiles] of Object.entries(importGraph)) {
    const sourceMod = getModule(filePath);
    for (const importedFile of importedFiles) {
      const targetMod = getModule(importedFile);
      if (sourceMod !== targetMod) {
        // Cross-module import
        moduleImports.get(sourceMod)?.add(targetMod);
        moduleImportedBy.get(targetMod)?.add(sourceMod);
      }
    }
  }

  return { imports: moduleImports, importedBy: moduleImportedBy };
}

/**
 * Step 3: Aggregate complexity metrics and export counts per module.
 */
function computeModuleComplexity(
  parsedFiles: ParsedFile[]
): {
  complexity: Map<string, { total: number; count: number; max: number; maxName: string | null }>;
  exports: Map<string, number>;
} {
  const moduleComplexity = new Map<string, { total: number; count: number; max: number; maxName: string | null }>();
  const moduleExports = new Map<string, number>();

  for (const parsed of parsedFiles) {
    const mod = getModule(parsed.file.relative);
    if (!moduleComplexity.has(mod)) {
      moduleComplexity.set(mod, { total: 0, count: 0, max: 0, maxName: null });
    }
    const mc = moduleComplexity.get(mod)!;

    // Count exported symbols
    moduleExports.set(mod, (moduleExports.get(mod) || 0) + parsed.exports.length);

    // Aggregate function complexity
    for (const func of parsed.functions) {
      mc.total += func.complexity;
      mc.count++;
      if (func.complexity > mc.max) {
        mc.max = func.complexity;
        mc.maxName = func.name;
      }
    }

    // Aggregate method complexity
    for (const cls of parsed.classes) {
      for (const method of cls.methods) {
        mc.total += method.complexity;
        mc.count++;
        if (method.complexity > mc.max) {
          mc.max = method.complexity;
          mc.maxName = `${cls.name}.${method.name}`;
        }
      }
    }
  }

  return { complexity: moduleComplexity, exports: moduleExports };
}

/**
 * Compute coupling metrics for all modules in the project.
 * Orchestrates the four steps: group files, build edges, compute complexity, and assemble results.
 */
export function computeModuleCoupling(
  importGraph: ImportGraph,
  parsedFiles: ParsedFile[]
): ModuleMetrics[] {
  // Step 1: Group files by module
  const moduleFiles = groupFilesByModule(parsedFiles);

  // Step 2: Build module-level import edges
  const { imports: moduleImports, importedBy: moduleImportedBy } = buildModuleEdges(
    importGraph,
    moduleFiles
  );

  // Step 3: Compute complexity metrics per module
  const { complexity: moduleComplexity, exports: moduleExports } =
    computeModuleComplexity(parsedFiles);

  // Step 4: Assemble metrics per module
  const results: ModuleMetrics[] = [];

  for (const [mod, files] of moduleFiles) {
    const ca = moduleImportedBy.get(mod)?.size || 0;
    const ce = moduleImports.get(mod)?.size || 0;
    const instability = ca + ce > 0 ? ce / (ca + ce) : 0;
    const mc = moduleComplexity.get(mod) || { total: 0, count: 0, max: 0, maxName: null };

    results.push({
      path: mod,
      afferentCoupling: ca,
      efferentCoupling: ce,
      instability: Math.round(instability * 100) / 100,
      fileCount: files.length,
      totalComplexity: mc.total,
      avgComplexity: mc.count > 0 ? Math.round((mc.total / mc.count) * 100) / 100 : 0,
      maxComplexity: mc.max,
      maxComplexityFunction: mc.maxName,
      publicSurfaceArea: moduleExports.get(mod) || 0,
    });
  }

  // Sort by instability descending (most unstable first)
  results.sort((a, b) => b.instability - a.instability);

  return results;
}
