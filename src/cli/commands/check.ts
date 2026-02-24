import { Command } from 'commander';
import { existsSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { Logger } from '../../utils/logger';
import fg from 'fast-glob';
import { loadConfig } from '../../core/config';

export const checkCommand = new Command('check')
  .description('Check if the codemap is stale and needs regeneration')
  .option('-p, --path <path>', 'Path to project root', '.')
  .option('-q, --quiet', 'Exit code only: 0 = fresh, 1 = stale, 2 = missing', false)
  .action(async (options) => {
    const logger = new Logger();
    const root = resolve(options.path);
    const codemapPath = join(root, '.codemap', 'codemap.json');

    // Check if codemap exists
    if (!existsSync(codemapPath)) {
      if (!options.quiet) {
        logger.warn('No codemap found. Run `codemap generate` first.');
      }
      process.exit(2);
    }

    const codemapMtime = statSync(codemapPath).mtimeMs;

    // Load config to know which files to check
    const config = await loadConfig(root);

    // Build glob patterns
    const patterns = config.include.map((dir: string) => {
      if (dir === '.') return '**/*';
      return join(dir, '**/*');
    });

    const ignorePatterns = config.exclude.map((pattern: string) => {
      if (!pattern.includes('*') && !pattern.includes('?')) {
        return `**/${pattern}/**`;
      }
      return `**/${pattern}`;
    });

    const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.vue'];

    const files = await fg(patterns, {
      cwd: root,
      absolute: true,
      ignore: ignorePatterns,
      onlyFiles: true,
      dot: false,
    });

    const sourceFiles = files.filter((f) =>
      EXTENSIONS.some((ext) => f.endsWith(ext))
    );

    // Check if any source file is newer than codemap.json
    let staleCount = 0;
    const staleFiles: string[] = [];

    for (const file of sourceFiles) {
      try {
        const fileMtime = statSync(file).mtimeMs;
        if (fileMtime > codemapMtime) {
          staleCount++;
          if (staleFiles.length < 10) {
            staleFiles.push(file.replace(root + '/', ''));
          }
        }
      } catch {
        // Skip files we can't stat
      }
    }

    if (staleCount === 0) {
      if (!options.quiet) {
        const generatedAt = new Date(codemapMtime);
        const ago = getTimeAgo(generatedAt);
        logger.success(`Codemap is up to date (generated ${ago}).`);
      }
      process.exit(0);
    } else {
      if (!options.quiet) {
        logger.warn(`Codemap is stale. ${staleCount} file(s) changed since last generation.`);
        for (const f of staleFiles) {
          logger.info(`  ${f}`);
        }
        if (staleCount > 10) {
          logger.info(`  ... and ${staleCount - 10} more`);
        }
        logger.info('Run `codemap generate` to update.');
      }
      process.exit(1);
    }
  });

function getTimeAgo(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
}
