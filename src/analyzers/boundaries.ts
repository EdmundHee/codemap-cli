/**
 * Architectural boundary violation checker.
 *
 * Evaluates the import graph against user-defined layer boundaries
 * from .codemaprc. Produces structured violation data for Claude Code
 * to act on.
 */

import { ImportGraph } from './import-graph';

export interface BoundaryConfig {
  [layerName: string]: {
    path: string;         // Glob pattern: "src/domain/**"
    canImport: string[];  // Layer names this layer may import from
  };
}

export interface BoundaryViolation {
  type: 'illegal_import';
  sourceFile: string;
  sourceLayer: string;
  targetFile: string;
  targetLayer: string;
  importSpecifier: string;
  message: string;
}

/**
 * Resolve which layer a file belongs to.
 * Returns null if the file doesn't match any boundary layer.
 */
function resolveLayer(filePath: string, boundaries: BoundaryConfig): string | null {
  for (const [layerName, config] of Object.entries(boundaries)) {
    // Support glob patterns like "src/domain/**"
    // Simple glob matching: strip trailing /** or /* and check prefix
    const basePath = config.path.replace(/\/\*\*$/, '').replace(/\/\*$/, '');
    if (filePath.startsWith(basePath)) {
      return layerName;
    }
  }
  return null;
}

/**
 * Check all import graph edges against boundary rules.
 * Returns violations where a file imports from a layer it shouldn't.
 */
export function checkBoundaries(
  importGraph: ImportGraph,
  boundaries: BoundaryConfig
): BoundaryViolation[] {
  if (!boundaries || Object.keys(boundaries).length === 0) return [];

  const violations: BoundaryViolation[] = [];

  for (const [sourceFile, importedFiles] of Object.entries(importGraph)) {
    const sourceLayer = resolveLayer(sourceFile, boundaries);
    if (!sourceLayer) continue; // File not in any defined layer

    const allowedLayers = boundaries[sourceLayer].canImport;

    for (const targetFile of importedFiles) {
      const targetLayer = resolveLayer(targetFile, boundaries);
      if (!targetLayer) continue; // Target not in any defined layer
      if (targetLayer === sourceLayer) continue; // Same layer is always OK

      if (!allowedLayers.includes(targetLayer)) {
        violations.push({
          type: 'illegal_import',
          sourceFile,
          sourceLayer,
          targetFile,
          targetLayer,
          importSpecifier: targetFile,
          message: `${sourceLayer} layer cannot import from ${targetLayer} layer`,
        });
      }
    }
  }

  return violations;
}
