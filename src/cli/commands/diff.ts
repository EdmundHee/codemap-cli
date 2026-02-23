import { Command } from 'commander';
import { Logger } from '../../utils/logger';

export const diffCommand = new Command('diff')
  .description('Show changes since the last codemap generation')
  .option('-p, --path <path>', 'Path to scan', '.')
  .option('--update', 'Regenerate after showing diff', false)
  .action(async (options) => {
    const logger = new Logger();
    // TODO: Phase 5 — implement diff using content hashes
    logger.info('codemap diff is not yet implemented. Coming in a future release.');
  });
