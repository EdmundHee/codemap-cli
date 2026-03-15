import { Command } from 'commander';
import { resolve } from 'path';
import { Orchestrator } from '../../core/orchestrator';
import { loadConfig } from '../../core/config';
import { Logger } from '../../utils/logger';
import { generateClaudeCommands } from './init';

export const generateCommand = new Command('generate')
  .description('Scan the project and generate codemap files')
  .option('-p, --path <path>', 'Path to scan', '.')
  .option('-o, --output <dir>', 'Output directory')
  .option('-f, --framework <name>', 'Override framework auto-detection')
  .option('--detail <level>', 'Detail level: full | names-only', 'full')
  .option('--no-claude-commands', 'Skip generating .claude/commands/')
  .action(async (options) => {
    const logger = new Logger();

    try {
      logger.start('Loading configuration...');
      const config = await loadConfig(options.path, {
        output: options.output,
        framework: options.framework,
        detail: options.detail,
      });

      const orchestrator = new Orchestrator(config, logger);
      await orchestrator.run();

      // Generate/update Claude Code commands alongside codemap data
      if (options.claudeCommands !== false) {
        const root = resolve(options.path);
        generateClaudeCommands(root, logger);
      }

      logger.success('Codemap generated successfully');
    } catch (error) {
      logger.error(`Generation failed: ${(error as Error).message}`);
      process.exit(1);
    }
  });
