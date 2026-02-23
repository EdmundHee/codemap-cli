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

      // Write both include and exclude so users can see and customize both.
      // Default excludes are always merged in loadConfig, so any extras
      // the user adds here will be combined with the built-in defaults.
      const config: Record<string, any> = {
        include: detectedDirs,
        exclude: [...DEFAULT_CONFIG.exclude],
      };

      writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
      logger.success(`Created ${configPath}`);
      logger.info(`Auto-detected include dirs: ${detectedDirs.join(', ')}`);
      logger.info(`Default excludes written — customize as needed`);
    } catch (error) {
      logger.error(`Failed to create config: ${(error as Error).message}`);
      process.exit(1);
    }
  });
