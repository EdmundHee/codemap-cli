import { createHash } from 'crypto';
import { readFileSync } from 'fs';

/**
 * Compute a short MD5 hash of a file's contents.
 * Used for change detection in codemap diff.
 */
export function hashFile(filePath: string): string {
  const content = readFileSync(filePath, 'utf-8');
  return hashContent(content);
}

/**
 * Compute a short MD5 hash of a string.
 */
export function hashContent(content: string): string {
  return createHash('md5').update(content).digest('hex').slice(0, 8);
}
