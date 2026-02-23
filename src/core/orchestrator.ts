import { CodemapConfig } from './config';
import { scanFiles, ScannedFile } from './scanner';
import { Logger } from '../utils/logger';
import { ParserInterface, ParsedFile } from '../parsers/parser.interface';
import { TypeScriptParser } from '../parsers/typescript/ts-parser';
import { PythonParser } from '../parsers/python/py-parser';
import { detectFrameworks } from '../frameworks/detector';
import { buildImportGraph } from '../analyzers/import-graph';
import { buildCallGraph } from '../analyzers/call-graph';
import { generateJson, CodemapData } from '../output/json-generator';
import { generateMarkdown } from '../output/md-generator';
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
    this.parsers.set('typescript', new TypeScriptParser());
    this.parsers.set('javascript', new TypeScriptParser()); // ts-morph handles JS too
    this.parsers.set('python', new PythonParser());
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

    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    // Write root JSON
    const jsonPath = join(outputDir, 'codemap.json');
    writeFileSync(jsonPath, JSON.stringify(data, null, 2));
    this.logger.info(`Written: ${jsonPath}`);

    // Write root MD
    const mdContent = generateMarkdown(data);
    const mdPath = join(outputDir, 'codemap.md');
    writeFileSync(mdPath, mdContent);
    this.logger.info(`Written: ${mdPath}`);

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
