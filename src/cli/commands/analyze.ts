import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { Logger } from '../../utils/logger';
import { CodemapData } from '../../output/json-generator';
import { buildReverseCallGraph } from '../../analyzers/call-graph';
import { detectDeadCode } from '../../analyzers/dead-code';
import { detectDuplicates } from '../../analyzers/duplicates';
import { detectCircularDeps } from '../../analyzers/circular-deps';
import { loadConfig } from '../../core/config';
import { scanFiles } from '../../core/scanner';
import { TypeScriptParser } from '../../parsers/typescript/ts-parser';
import { PythonParser } from '../../parsers/python/py-parser';
import { VueParser } from '../../parsers/vue/vue-parser';
import { ParsedFile, ParserInterface } from '../../parsers/parser.interface';

export const analyzeCommand = new Command('analyze')
  .description('Analyze codemap for dead code, duplicates, circular dependencies, and unused exports')
  .option('-p, --path <path>', 'Project root path', '.')
  .option('--dead-code', 'Detect unused functions and methods', false)
  .option('--duplicates', 'Detect redundant/duplicate functions', false)
  .option('--circular', 'Detect circular dependencies', false)
  .option('--all', 'Run all analysis checks', false)
  .option('--json', 'Output raw JSON', false)
  .action(async (options) => {
    const logger = new Logger();
    const root = resolve(options.path);
    const outputDir = join(root, '.codemap');
    const jsonPath = join(outputDir, 'codemap.json');

    if (!existsSync(jsonPath)) {
      logger.error('No codemap found. Run `codemap generate` first.');
      process.exit(1);
    }

    let data: CodemapData;
    try {
      data = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    } catch (error) {
      logger.error(`Failed to read codemap: ${(error as Error).message}`);
      process.exit(1);
    }

    // Determine which checks to run
    const runAll = options.all || (!options.deadCode && !options.duplicates && !options.circular);

    const reverseCallGraph = buildReverseCallGraph(data.call_graph);
    const entryPoints = data.project.entry_points || [];

    // For some analyses we need parsed files — we'll re-parse from the codemap data
    // For circular deps we need parsed files for symbol resolution
    let parsedFiles: ParsedFile[] | null = null;

    const results: any = {};

    // Dead code analysis
    if (runAll || options.deadCode) {
      logger.start('Detecting dead code...');

      // We need parsed files for full dead code analysis
      if (!parsedFiles) parsedFiles = await loadParsedFiles(root, logger);

      if (parsedFiles) {
        const deadCode = detectDeadCode(parsedFiles, reverseCallGraph, entryPoints);
        results.dead_code = deadCode;

        if (!options.json) {
          console.log(`\n  Dead Code: ${deadCode.deadFunctions.length} functions (${deadCode.totalDeadLines} lines, ${deadCode.deadCodePercentage}%)\n`);
          for (const df of deadCode.deadFunctions.slice(0, 15)) {
            const exported = df.isExported ? ' [exported]' : '';
            console.log(`    ${df.name}${exported} — ${df.file} (${df.lineCount} lines)`);
          }
          if (deadCode.deadFunctions.length > 15) {
            console.log(`    ... and ${deadCode.deadFunctions.length - 15} more`);
          }
        }
      }
    }

    // Duplicate detection
    if (runAll || options.duplicates) {
      logger.start('Detecting duplicates...');
      if (!parsedFiles) parsedFiles = await loadParsedFiles(root, logger);

      if (parsedFiles) {
        const duplicates = detectDuplicates(parsedFiles);
        results.duplicates = duplicates;

        if (!options.json) {
          console.log(`\n  Duplicates: ${duplicates.length} groups\n`);
          for (const dup of duplicates.slice(0, 10)) {
            console.log(`    "${dup.signature}" (similarity: ${dup.similarity})`);
            for (const f of dup.functions) {
              console.log(`      - ${f.name} in ${f.file}`);
            }
          }
          if (duplicates.length > 10) {
            console.log(`    ... and ${duplicates.length - 10} more groups`);
          }
        }
      }
    }

    // Circular dependency detection
    if (runAll || options.circular) {
      logger.start('Detecting circular dependencies...');
      if (!parsedFiles) parsedFiles = await loadParsedFiles(root, logger);

      if (parsedFiles) {
        const cycles = detectCircularDeps(data.import_graph, parsedFiles);
        results.circular_dependencies = cycles;

        if (!options.json) {
          console.log(`\n  Circular Dependencies: ${cycles.length} cycles\n`);
          for (const cycle of cycles) {
            console.log(`    Cycle: ${cycle.files.join(' ↔ ')}`);
            if (cycle.minimumCut) {
              console.log(`    Min cut: ${cycle.minimumCut.sourceFile} → ${cycle.minimumCut.targetFile} (${cycle.minimumCutSymbolCount} symbols)`);
            }
          }
        }
      }
    }

    if (options.json) {
      console.log(JSON.stringify(results, null, 2));
    }

    console.log('');
  });

/**
 * Re-parse source files for analysis.
 */
async function loadParsedFiles(root: string, logger: Logger): Promise<ParsedFile[] | null> {
  try {
    const config = await loadConfig(root);
    const files = await scanFiles(config);

    const tsParser = new TypeScriptParser();
    const parsers = new Map<string, ParserInterface>();
    parsers.set('typescript', tsParser);
    parsers.set('javascript', tsParser);
    parsers.set('python', new PythonParser());
    parsers.set('vue', new VueParser(tsParser));

    const results: ParsedFile[] = [];
    for (const file of files) {
      const parser = parsers.get(file.language);
      if (!parser) continue;
      try {
        results.push(await parser.parse(file));
      } catch {
        // Skip unparseable files
      }
    }
    return results;
  } catch (error) {
    logger.error(`Failed to parse files: ${(error as Error).message}`);
    return null;
  }
}
