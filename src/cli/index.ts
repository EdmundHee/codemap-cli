#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { join } from 'path';
import { generateCommand } from './commands/generate';
import { initCommand } from './commands/init';
import { diffCommand } from './commands/diff';
import { analyzeCommand } from './commands/analyze';
import { queryCommand } from './commands/query';
import { checkCommand } from './commands/check';
import { healthCommand } from './commands/health';

// Read version from package.json so it stays in sync with npm version
let version = '0.0.0';
try {
  // Try multiple paths — global vs local installs have different structures
  const candidates = [
    join(__dirname, '..', '..', 'package.json'),  // local: dist/cli/../../package.json
    join(__dirname, '..', 'package.json'),          // global: might flatten
  ];
  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf-8'));
      if (pkg.name === '@gingerdev/codemap-cli') {
        version = pkg.version;
        break;
      }
    } catch {
      continue;
    }
  }
} catch {
  // fallback to hardcoded
}

const program = new Command();

program
  .name('codemap')
  .description('Static analysis CLI that generates relationship maps of codebases for AI-assisted development')
  .version(version);

program.addCommand(generateCommand);
program.addCommand(initCommand);
program.addCommand(diffCommand);
program.addCommand(analyzeCommand);
program.addCommand(queryCommand);
program.addCommand(checkCommand);
program.addCommand(healthCommand);

program.parse(process.argv);
