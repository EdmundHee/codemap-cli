import { Command } from 'commander';
import { writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { Logger } from '../../utils/logger';
import { DEFAULT_CONFIG, detectIncludeDirs } from '../../core/config';

export const initCommand = new Command('init')
  .description('Create a .codemaprc config file in the current directory')
  .option('-p, --path <path>', 'Directory to create config in', '.')
  .option('--force', 'Overwrite existing config', false)
  .action(async (options) => {
    const logger = new Logger();
    const root = resolve(options.path);
    const configPath = join(root, '.codemaprc');

    if (existsSync(configPath) && !options.force) {
      logger.warn('.codemaprc already exists. Use --force to overwrite.');
      return;
    }

    try {
      // Auto-detect include directories based on actual project structure
      const detectedDirs = detectIncludeDirs(root);
      const config = {
        ...DEFAULT_CONFIG,
        include: detectedDirs,
      };

      writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
      logger.success(`Created ${configPath}`);
      logger.info(`Auto-detected include dirs: ${detectedDirs.join(', ')}`);
    } catch (error) {
      logger.error(`Failed to create config: ${(error as Error).message}`);
      process.exit(1);
    }
  });
