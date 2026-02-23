import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

/**
 * Ensure the directory for a file path exists, creating it if needed.
 */
export function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Normalize a file path to use forward slashes (cross-platform).
 */
export function normalizePath(filepath: string): string {
  return filepath.replace(/\\/g, '/');
}

/**
 * Convert a relative file path to a safe filename for per-directory outputs.
 * e.g., "src/controllers" → "src__controllers"
 */
export function pathToModuleKey(relativePath: string): string {
  return relativePath.replace(/\//g, '__').replace(/\\/g, '__');
}
