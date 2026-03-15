import { CodemapConfig } from './config';
import { scanFiles, ScannedFile } from './scanner';
import { Logger } from '../utils/logger';
import { ParserInterface, ParsedFile } from '../parsers/parser.interface';
import { TypeScriptParser } from '../parsers/typescript/ts-parser';
import { PythonParser } from '../parsers/python/py-parser';
import { VueParser } from '../parsers/vue/vue-parser';
import { detectFrameworks } from '../frameworks/detector';
import { buildImportGraph } from '../analyzers/import-graph';
import { buildCallGraph } from '../analyzers/call-graph';
import { generateJson, CodemapData } from '../output/json-generator';
import { generateMarkdown, generateModuleMarkdown } from '../output/md-generator';
import { pathToModuleKey } from '../utils/file-utils';
import { appendHistory } from '../analyzers/history';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';

export class Orchestrator {
  private config: CodemapConfig;
  private logger: Logger;
  private parsers: Map<string, ParserInterface>;

  constructor(config: CodemapConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.parsers = new Map();

    // Register parsers for supported languages
    const tsParser = new TypeScriptParser();
    this.parsers.set('typescript', tsParser);
    this.parsers.set('javascript', tsParser); // ts-morph handles JS too
    this.parsers.set('python', new PythonParser());
    this.parsers.set('vue', new VueParser(tsParser)); // delegates script blocks to TS parser
  }

  async run(): Promise<void> {
    // Step 1: Scan for files
    this.logger.start('Scanning project files...');
    const files = await scanFiles(this.config);
    this.logger.info(`Found ${files.length} source files`);

    if (files.length === 0) {
      this.logger.warn('No source files found. Check your include/exclude config.');
      return;
    }

    // Step 2: Detect frameworks
    this.logger.start('Detecting frameworks...');
    const frameworks = this.config.framework
      ? [this.config.framework]
      : await detectFrameworks(this.config.root);
    this.logger.info(`Detected frameworks: ${frameworks.length > 0 ? frameworks.join(', ') : 'none'}`);

    // Step 3: Parse all files
    this.logger.start('Parsing source files...');
    const parsed = await this.parseFiles(files);
    this.logger.info(`Parsed ${parsed.length} files`);

    // Step 4: Build relationship graphs
    this.logger.start('Building relationship graphs...');
    const importGraph = buildImportGraph(parsed);
    const callGraph = buildCallGraph(parsed);

    // Step 5: Assemble codemap data
    this.logger.start('Assembling codemap...');
    const languages = [...new Set(files.map((f) => f.language))];
    const codemapData = generateJson({
      config: this.config,
      files,
      parsed,
      frameworks,
      languages,
      importGraph,
      callGraph,
    });

    // Step 6: Write output
    this.logger.start('Writing output files...');
    await this.writeOutput(codemapData);

    // Step 7: Save health history
    if (codemapData.health) {
      const outputDir = join(this.config.root, this.config.output);
      appendHistory(outputDir, codemapData.health, parsed.length, 0, 0);
    }

    // Print summary (visible in Claude Code hook output)
    const totalClasses = Object.keys(codemapData.classes || {}).length;
    const totalFunctions = Object.keys(codemapData.functions || {}).length;
    const healthScore = codemapData.health ? ` | Health: ${codemapData.health.score}/100` : '';
    this.logger.success(
      `Codemap generated: ${parsed.length} files, ${totalClasses} classes, ${totalFunctions} functions${healthScore}`
    );
  }

  private async parseFiles(files: ScannedFile[]): Promise<ParsedFile[]> {
    const results: ParsedFile[] = [];

    for (const file of files) {
      const parser = this.parsers.get(file.language);
      if (!parser) {
        this.logger.warn(`No parser for ${file.language}: ${file.relative}`);
        continue;
      }

      try {
        const parsed = await parser.parse(file);
        results.push(parsed);
      } catch (error) {
        this.logger.warn(`Failed to parse ${file.relative}: ${(error as Error).message}`);
      }
    }

    return results;
  }

  private async writeOutput(data: CodemapData): Promise<void> {
    const outputDir = join(this.config.root, this.config.output);
    const modulesDir = join(outputDir, 'modules');

    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }
    if (!existsSync(modulesDir)) {
      mkdirSync(modulesDir, { recursive: true });
    }

    // Write root JSON
    const jsonPath = join(outputDir, 'codemap.json');
    writeFileSync(jsonPath, JSON.stringify(data, null, 2));
    this.logger.info(`Written: ${jsonPath}`);

    // Write compact root MD summary
    const mdContent = generateMarkdown(data);
    const mdPath = join(outputDir, 'codemap.md');
    writeFileSync(mdPath, mdContent);
    const mdLines = mdContent.split('\n').length;
    this.logger.info(`Written: ${mdPath} (${mdLines} lines)`);

    // Write per-directory detailed module files
    const directories = new Set<string>();
    for (const filePath of Object.keys(data.files)) {
      const dir = filePath.includes('/') ? filePath.split('/').slice(0, -1).join('/') : '.';
      directories.add(dir);
    }

    let moduleCount = 0;
    for (const dir of [...directories].sort()) {
      const moduleContent = generateModuleMarkdown(data, dir);
      if (!moduleContent) continue;

      const moduleKey = pathToModuleKey(dir);
      const modulePath = join(modulesDir, `${moduleKey}.md`);
      writeFileSync(modulePath, moduleContent);
      moduleCount++;
    }
    this.logger.info(`Written: ${moduleCount} module files in ${modulesDir}`);

    // Write content hashes for diff support
    const hashes = this.computeHashes(data);
    const hashPath = join(outputDir, '.hashes');
    writeFileSync(hashPath, JSON.stringify(hashes, null, 2));
  }

  private computeHashes(data: CodemapData): Record<string, string> {
    const hashes: Record<string, string> = {};

    for (const [filePath, fileData] of Object.entries(data.files)) {
      hashes[filePath] = fileData.hash;
    }

    return hashes;
  }
}
