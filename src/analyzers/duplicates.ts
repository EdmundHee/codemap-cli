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

/**
 * Build function signatures from parsed files.
 */
function buildFunctionSignatures(
  parsedFiles: ParsedFile[]
): Array<{ name: string; file: string; paramSignature: string; calls: string[] }> {
  const allFunctions: Array<{
    name: string;
    file: string;
    paramSignature: string;
    calls: string[];
  }> = [];

  for (const p of parsedFiles) {
    for (const func of p.functions) {
      allFunctions.push({
        name: func.name,
        file: p.file.relative,
        paramSignature: func.params.map(p => `${p.name}:${p.type}`).join(','),
        calls: func.calls,
      });
    }
    for (const cls of p.classes) {
      for (const method of cls.methods) {
        allFunctions.push({
          name: `${cls.name}.${method.name}`,
          file: p.file.relative,
          paramSignature: method.params.map(p => `${p.name}:${p.type}`).join(','),
          calls: method.calls,
        });
      }
    }
  }

  return allFunctions;
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
      });
    }
  }

  // Sort by similarity descending
  duplicates.sort((a, b) => b.similarity - a.similarity);

  return duplicates;
}

/**
 * Detect duplicate functions across the codebase.
 */
export function detectDuplicates(parsedFiles: ParsedFile[]): DuplicateGroup[] {
  const allFunctions = buildFunctionSignatures(parsedFiles);
  const duplicates = findSimilarGroups(allFunctions);
  return duplicates;
}
