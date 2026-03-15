/**
 * Get the module (directory) for a file path.
 * e.g. "src/core/config.ts" → "src/core"
 *      "index.ts" → "."
 */
export function getModuleFromPath(filePath: string): string {
  const lastSlash = filePath.lastIndexOf('/');
  return lastSlash >= 0 ? filePath.substring(0, lastSlash) : '.';
}
