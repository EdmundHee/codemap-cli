import fg from 'fast-glob';
import { join } from 'path';
import { CodemapConfig } from './config';

export interface ScannedFile {
  /** Absolute path */
  absolute: string;
  /** Relative path from project root */
  relative: string;
  /** Detected language */
  language: 'typescript' | 'javascript' | 'python' | 'vue' | 'go' | 'rust' | 'unknown';
}

const LANGUAGE_MAP: Record<string, ScannedFile['language']> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.vue': 'vue',
  '.go': 'go',
  '.rs': 'rust',
};

/**
 * Scan the project directory for source files, respecting include/exclude config.
 * When include contains ".", scans root-level files and all subdirectories.
 */
export async function scanFiles(config: CodemapConfig): Promise<ScannedFile[]> {
  const patterns = config.include.map((dir) => {
    // "." means scan everything from root
    if (dir === '.') return '**/*';
    return join(dir, '**/*');
  });

  const ignorePatterns = config.exclude.map((pattern) => {
    // If it's a directory name (no glob chars), convert to glob
    if (!pattern.includes('*') && !pattern.includes('?')) {
      return `**/${pattern}/**`;
    }
    return `**/${pattern}`;
  });

  const files = await fg(patterns, {
    cwd: config.root,
    absolute: false,
    ignore: ignorePatterns,
    onlyFiles: true,
    dot: false,
  });

  return files
    .map((relative) => {
      const ext = getExtension(relative);
      const language = LANGUAGE_MAP[ext] || 'unknown';

      return {
        absolute: join(config.root, relative),
        relative,
        language,
      };
    })
    .filter((f) => f.language !== 'unknown');
}

function getExtension(filepath: string): string {
  const lastDot = filepath.lastIndexOf('.');
  if (lastDot === -1) return '';
  return filepath.slice(lastDot).toLowerCase();
}
