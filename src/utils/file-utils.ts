/**
 * Convert a relative file path to a safe filename for per-directory outputs.
 * e.g., "src/controllers" → "src__controllers"
 */
export function pathToModuleKey(relativePath: string): string {
  return relativePath.replace(/\//g, '__').replace(/\\/g, '__');
}
