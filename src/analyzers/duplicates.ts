/**
 * Duplicate function detection by signature and call pattern.
 *
 * Two functions are likely duplicates if they have:
 * - Same name across different files
 * - OR similar param types + similar call patterns (Jaccard similarity)
 *
 * No source code comparison needed — works from structured data only.
 */

import { ParsedFile } from '../parsers/parser.interface';

export interface DuplicateGroup {
  /** Shared signature pattern or name */
  signature: string;
  /** All functions in this duplicate group */
  functions: Array<{ name: string; file: string; params: string; calls: string[] }>;
  /** Similarity score 0-1 based on call pattern overlap */
  similarity: number;
  /** How the match was detected: by name or structural similarity */
  matchType?: 'name' | 'structural';
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

export interface FunctionSignature {
  name: string;
  file: string;
  paramSignature: string;
  calls: string[];
  returnType: string;
  complexity: number;
  lineCount: number;
  nestingDepth: number;
  paramCount: number;
}

/**
 * Build function signatures from parsed files.
 */
function buildFunctionSignatures(
  parsedFiles: ParsedFile[]
): FunctionSignature[] {
  const allFunctions: FunctionSignature[] = [];

  for (const p of parsedFiles) {
    for (const func of p.functions) {
      allFunctions.push({
        name: func.name,
        file: p.file.relative,
        paramSignature: func.params.map(p => `${p.name}:${p.type}`).join(','),
        calls: func.calls,
        returnType: func.return_type,
        complexity: func.complexity,
        lineCount: func.lineCount,
        nestingDepth: func.nestingDepth,
        paramCount: func.params.length,
      });
    }
    for (const cls of p.classes) {
      for (const method of cls.methods) {
        allFunctions.push({
          name: `${cls.name}.${method.name}`,
          file: p.file.relative,
          paramSignature: method.params.map(p => `${p.name}:${p.type}`).join(','),
          calls: method.calls,
          returnType: method.return_type,
          complexity: method.complexity,
          lineCount: method.lineCount,
          nestingDepth: method.nestingDepth,
          paramCount: method.params.length,
        });
      }
    }
  }

  return allFunctions;
}

/**
 * Call categories for semantic grouping.
 * Functions using similar categories of calls are more likely to be doing the same thing.
 */
const CALL_CATEGORIES: Record<string, string> = {
  // File I/O
  readFile: 'file-io', writeFile: 'file-io', readFileSync: 'file-io', writeFileSync: 'file-io',
  existsSync: 'file-io', mkdirSync: 'file-io', readdir: 'file-io', readdirSync: 'file-io',
  unlink: 'file-io', unlinkSync: 'file-io', stat: 'file-io', statSync: 'file-io',
  open: 'file-io', close: 'file-io', read: 'file-io', write: 'file-io',
  // Path manipulation
  'path.join': 'path', 'path.resolve': 'path', 'path.dirname': 'path', 'path.basename': 'path',
  'path.extname': 'path', 'path.relative': 'path', join: 'path', resolve: 'path',
  // Logging
  'console.log': 'logging', 'console.error': 'logging', 'console.warn': 'logging',
  log: 'logging', warn: 'logging', error: 'logging', info: 'logging', debug: 'logging',
  // HTTP/Network
  fetch: 'http', request: 'http', get: 'http', post: 'http', put: 'http', delete: 'http',
  axios: 'http', 'axios.get': 'http', 'axios.post': 'http',
  // JSON
  'JSON.parse': 'json', 'JSON.stringify': 'json', parse: 'json', stringify: 'json',
  // String manipulation
  replace: 'string', split: 'string', trim: 'string', toLowerCase: 'string',
  toUpperCase: 'string', startsWith: 'string', endsWith: 'string', includes: 'string',
  match: 'string', search: 'string', slice: 'string', substring: 'string',
  // Array manipulation
  map: 'array', filter: 'array', reduce: 'array', forEach: 'array', find: 'array',
  sort: 'array', concat: 'array', flat: 'array', flatMap: 'array', some: 'array', every: 'array',
  push: 'array', pop: 'array', shift: 'array', unshift: 'array', splice: 'array',
  // Async/Promise
  'Promise.all': 'async', 'Promise.resolve': 'async', 'Promise.reject': 'async',
  'Promise.allSettled': 'async', then: 'async', catch: 'async', finally: 'async',
  // Error handling
  'Error': 'error', throw: 'error', TypeError: 'error', RangeError: 'error',
  // Validation
  validate: 'validation', assert: 'validation', check: 'validation', verify: 'validation',
  isValid: 'validation',
};

function getCallCategory(call: string): string | null {
  if (CALL_CATEGORIES[call]) return CALL_CATEGORIES[call];
  // Try last segment for qualified calls like obj.method
  const dot = call.lastIndexOf('.');
  if (dot > 0) {
    const method = call.substring(dot + 1);
    if (CALL_CATEGORIES[method]) return CALL_CATEGORIES[method];
  }
  return null;
}

/**
 * Compute multi-signal similarity between two function signatures.
 * Combines 5 weighted signals:
 * - Call pattern overlap (Jaccard): 0.35
 * - Param structure similarity: 0.25
 * - Return type match: 0.10
 * - Structural shape (complexity, lineCount, nestingDepth): 0.15
 * - Call category overlap (semantic): 0.15
 */
export function computeMultiSignalSimilarity(a: FunctionSignature, b: FunctionSignature): number {
  // 1. Call pattern overlap (Jaccard) — weight 0.35
  const callSim = jaccardSimilarity(a.calls, b.calls);

  // 2. Param structure similarity — weight 0.25
  let paramSim = 0;
  if (a.paramCount === 0 && b.paramCount === 0) {
    paramSim = 1;
  } else if (a.paramCount === b.paramCount) {
    // Same count — check if signatures match
    paramSim = a.paramSignature === b.paramSignature ? 1 : 0.6;
  } else {
    // Different count — partial credit based on ratio
    const minP = Math.min(a.paramCount, b.paramCount);
    const maxP = Math.max(a.paramCount, b.paramCount);
    paramSim = maxP > 0 ? minP / maxP * 0.5 : 0;
  }

  // 3. Return type match — weight 0.10
  const returnSim = (a.returnType === b.returnType && a.returnType !== '') ? 1 :
    (a.returnType === '' || b.returnType === '') ? 0.3 : 0;

  // 4. Structural shape — weight 0.15
  const complexityRatio = (Math.min(a.complexity, b.complexity) + 1) / (Math.max(a.complexity, b.complexity) + 1);
  const lineRatio = (Math.min(a.lineCount, b.lineCount) + 1) / (Math.max(a.lineCount, b.lineCount) + 1);
  const nestingRatio = (Math.min(a.nestingDepth, b.nestingDepth) + 1) / (Math.max(a.nestingDepth, b.nestingDepth) + 1);
  const structSim = (complexityRatio + lineRatio + nestingRatio) / 3;

  // 5. Call category overlap — weight 0.15
  const aCats = new Set(a.calls.map(getCallCategory).filter(Boolean) as string[]);
  const bCats = new Set(b.calls.map(getCallCategory).filter(Boolean) as string[]);
  let catSim = 0;
  if (aCats.size === 0 && bCats.size === 0) {
    catSim = 0.5; // neutral when no categorizable calls
  } else {
    let catIntersection = 0;
    for (const cat of aCats) {
      if (bCats.has(cat)) catIntersection++;
    }
    const catUnion = aCats.size + bCats.size - catIntersection;
    catSim = catUnion > 0 ? catIntersection / catUnion : 0;
  }

  return callSim * 0.35 + paramSim * 0.25 + returnSim * 0.10 + structSim * 0.15 + catSim * 0.15;
}

/**
 * Find similar groups of functions by name and call pattern.
 */
function findSimilarGroups(
  allFunctions: Array<{ name: string; file: string; paramSignature: string; calls: string[] }>
): DuplicateGroup[] {
  const duplicates: DuplicateGroup[] = [];

  // Group by base name (exact name matches across different files)
  const nameGroups = new Map<string, typeof allFunctions>();
  for (const func of allFunctions) {
    // Use base name (strip class prefix for methods)
    const baseName = func.name.includes('.') ? func.name.split('.').pop()! : func.name;
    if (!nameGroups.has(baseName)) nameGroups.set(baseName, []);
    nameGroups.get(baseName)!.push(func);
  }

  for (const [name, funcs] of nameGroups) {
    if (funcs.length <= 1) continue;

    // Only flag if in different files
    const uniqueFiles = new Set(funcs.map(f => f.file));
    if (uniqueFiles.size <= 1) continue;

    // Compute pairwise similarity
    let maxSimilarity = 0;
    for (let i = 0; i < funcs.length; i++) {
      for (let j = i + 1; j < funcs.length; j++) {
        const sim = jaccardSimilarity(funcs[i].calls, funcs[j].calls);
        if (sim > maxSimilarity) maxSimilarity = sim;
      }
    }

    // Only report if call patterns are similar (>0.3) or signatures match
    const sigMatch = funcs.some((a, i) =>
      funcs.some((b, j) => i !== j && a.paramSignature === b.paramSignature && a.paramSignature !== '')
    );

    if (maxSimilarity > 0.3 || sigMatch) {
      duplicates.push({
        signature: name,
        functions: funcs.map(f => ({
          name: f.name,
          file: f.file,
          params: f.paramSignature,
          calls: f.calls,
        })),
        similarity: Math.round(maxSimilarity * 100) / 100,
        matchType: 'name',
      });
    }
  }

  // Sort by similarity descending
  duplicates.sort((a, b) => b.similarity - a.similarity);

  return duplicates;
}

/**
 * Find structurally similar functions with different names across different files.
 * Uses computeMultiSignalSimilarity with a 0.6 threshold.
 * Pre-filters pairs where lineCount ratio > 2x to avoid comparing wildly different functions.
 */
function findCrossNameSimilarities(
  allFunctions: FunctionSignature[],
  sameNamePairs: Set<string>
): DuplicateGroup[] {
  const results: DuplicateGroup[] = [];

  for (let i = 0; i < allFunctions.length; i++) {
    for (let j = i + 1; j < allFunctions.length; j++) {
      const a = allFunctions[i];
      const b = allFunctions[j];

      // Skip same-file comparisons
      if (a.file === b.file) continue;

      // Skip same-name pairs (already handled by findSimilarGroups)
      const baseName = (n: string) => n.includes('.') ? n.split('.').pop()! : n;
      if (baseName(a.name) === baseName(b.name)) continue;

      // Skip already-matched pairs from same-name detection
      const pairKey = [a.name, b.name].sort().join('||');
      if (sameNamePairs.has(pairKey)) continue;

      // Pre-filter: skip if lineCount ratio > 2x
      const lineRatio = Math.max(a.lineCount, b.lineCount) / Math.max(Math.min(a.lineCount, b.lineCount), 1);
      if (lineRatio > 2) continue;

      const sim = computeMultiSignalSimilarity(a, b);
      if (sim >= 0.6) {
        results.push({
          signature: `${a.name} ~ ${b.name}`,
          functions: [
            { name: a.name, file: a.file, params: a.paramSignature, calls: a.calls },
            { name: b.name, file: b.file, params: b.paramSignature, calls: b.calls },
          ],
          similarity: Math.round(sim * 100) / 100,
          matchType: 'structural',
        });
      }
    }
  }

  return results;
}

/**
 * Detect duplicate functions across the codebase.
 * Combines same-name detection and cross-name structural similarity detection.
 */
export function detectDuplicates(parsedFiles: ParsedFile[]): DuplicateGroup[] {
  const allFunctions = buildFunctionSignatures(parsedFiles);

  // Same-name detection
  const sameNameDupes = findSimilarGroups(allFunctions);

  // Build set of pairs already matched by name
  const sameNamePairs = new Set<string>();
  for (const group of sameNameDupes) {
    for (let i = 0; i < group.functions.length; i++) {
      for (let j = i + 1; j < group.functions.length; j++) {
        const key = [group.functions[i].name, group.functions[j].name].sort().join('||');
        sameNamePairs.add(key);
      }
    }
  }

  // Cross-name structural similarity detection
  const crossNameDupes = findCrossNameSimilarities(allFunctions, sameNamePairs);

  // Merge and sort by similarity descending
  const all = [...sameNameDupes, ...crossNameDupes];
  all.sort((a, b) => b.similarity - a.similarity);
  return all;
}
