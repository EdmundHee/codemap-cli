#!/usr/bin/env node

import { Command } from 'commander';
import { generateCommand } from './commands/generate';
import { initCommand } from './commands/init';
import { diffCommand } from './commands/diff';
import { analyzeCommand } from './commands/analyze';
import { queryCommand } from './commands/query';
import { checkCommand } from './commands/check';
import { healthCommand } from './commands/health';

const program = new Command();

program
  .name('codemap')
  .description('Static analysis CLI that generates relationship maps of codebases for AI-assisted development')
  .version('0.1.0');

program.addCommand(generateCommand);
program.addCommand(initCommand);
program.addCommand(diffCommand);
program.addCommand(analyzeCommand);
program.addCommand(queryCommand);
program.addCommand(checkCommand);
program.addCommand(healthCommand);

program.parse(process.argv);
