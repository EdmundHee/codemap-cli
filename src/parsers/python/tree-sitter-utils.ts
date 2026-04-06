/**
 * Tree-sitter utility functions specific to Python parsing.
 */

/**
 * Find __all__ definition from source code and return exported names.
 */
export function findAllDefinition(rootNode: any, source: string): string[] {
  // Look for __all__ = ["x", "y", "z"]
  const match = source.match(/__all__\s*=\s*\[([\s\S]*?)\]/);
  if (!match) return [];

  const names: string[] = [];
  const entries = match[1].matchAll(/['"](\w+)['"]/g);
  for (const entry of entries) {
    names.push(entry[1]);
  }
  return names;
}
