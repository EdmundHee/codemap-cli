import { Command } from 'commander';
import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { Logger } from '../../utils/logger';
import { DEFAULT_CONFIG } from '../../core/config';

export const initCommand = new Command('init')
  .description('Create a .codemaprc config file in the current directory')
  .option('-p, --path <path>', 'Directory to create config in', '.')
  .option('--force', 'Overwrite existing config', false)
  .action(async (options) => {
    const logger = new Logger();
    const configPath = join(options.path, '.codemaprc');

    if (existsSync(configPath) && !options.force) {
      logger.warn('.codemaprc already exists. Use --force to overwrite.');
      return;
    }

    try {
      writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
      logger.success(`Created ${configPath}`);
    } catch (error) {
      logger.error(`Failed to create config: ${(error as Error).message}`);
      process.exit(1);
    }
  });
