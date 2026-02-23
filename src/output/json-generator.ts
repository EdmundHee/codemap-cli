import { CodemapConfig } from '../core/config';
import { ScannedFile } from '../core/scanner';
import { ParsedFile } from '../parsers/parser.interface';
import { ImportGraph } from '../analyzers/import-graph';
import { CallGraph, buildReverseCallGraph } from '../analyzers/call-graph';

export interface CodemapData {
  version: string;
  generated_at: string;
  project: {
    name: string;
    root: string;
    languages: string[];
    frameworks: string[];
    entry_points: string[];
  };
  files: Record<string, any>;
  classes: Record<string, any>;
  functions: Record<string, any>;
  types: Record<string, any>;
  call_graph: CallGraph;
  import_graph: ImportGraph;
  config_dependencies: {
    env_vars: Record<string, { used_in: string[]; accessed_by: string[] }>;
  };
  routes: any[];
  models: Record<string, any>;
  middleware: Record<string, any>;
}

interface GenerateInput {
  config: CodemapConfig;
  files: ScannedFile[];
  parsed: ParsedFile[];
  frameworks: string[];
  languages: string[];
  importGraph: ImportGraph;
  callGraph: CallGraph;
}

/**
 * Generate the root-level codemap JSON structure.
 */
export function generateJson(input: GenerateInput): CodemapData {
  const { config, parsed, frameworks, languages, importGraph, callGraph } = input;
  const reverseCallGraph = buildReverseCallGraph(callGraph);

  // Build project name from directory
  const projectName = config.root.split('/').pop() || 'unknown';

  // Build files map
  const files: Record<string, any> = {};
  for (const p of parsed) {
    files[p.file.relative] = {
      language: p.file.language,
      hash: p.hash,
      exports: p.exports.map((e) => e.name),
      imports: p.imports.map((i) => ({
        from: i.from,
        symbols: i.symbols,
      })),
    };
  }

  // Build classes map
  const classes: Record<string, any> = {};
  for (const p of parsed) {
    for (const cls of p.classes) {
      classes[cls.name] = {
        file: p.file.relative,
        extends: cls.extends,
        implements: cls.implements,
        decorators: cls.decorators,
        methods: cls.methods.map((m) => ({
          ...m,
          called_by: reverseCallGraph[`${cls.name}.${m.name}`] || [],
        })),
        properties: cls.properties,
      };
    }
  }

  // Build functions map
  const functions: Record<string, any> = {};
  for (const p of parsed) {
    for (const func of p.functions) {
      functions[func.name] = {
        file: p.file.relative,
        params: func.params,
        return_type: func.return_type,
        async: func.async,
        exported: func.exported,
        calls: func.calls,
        called_by: reverseCallGraph[func.name] || [],
      };
    }
  }

  // Build types map
  const types: Record<string, any> = {};
  for (const p of parsed) {
    for (const type of p.types) {
      types[type.name] = {
        file: p.file.relative,
        kind: type.kind,
        extends: type.extends,
        properties: type.properties,
        exported: type.exported,
      };
    }
  }

  // Build env var dependencies
  const envVars: Record<string, { used_in: string[]; accessed_by: string[] }> = {};
  for (const p of parsed) {
    for (const envVar of p.envVars) {
      if (!envVars[envVar]) {
        envVars[envVar] = { used_in: [], accessed_by: [] };
      }
      if (!envVars[envVar].used_in.includes(p.file.relative)) {
        envVars[envVar].used_in.push(p.file.relative);
      }
    }
  }

  // Detect entry points
  const entryPoints = config.entry_points || detectEntryPoints(parsed);

  return {
    version: '1.0.0',
    generated_at: new Date().toISOString(),
    project: {
      name: projectName,
      root: config.root,
      languages,
      frameworks,
      entry_points: entryPoints,
    },
    files,
    classes,
    functions,
    types,
    call_graph: callGraph,
    import_graph: importGraph,
    config_dependencies: {
      env_vars: envVars,
    },
    // TODO: Phase 3 — populate from framework adapters
    routes: [],
    models: {},
    middleware: {},
  };
}

/** Auto-detect entry points by looking for common patterns */
function detectEntryPoints(parsed: ParsedFile[]): string[] {
  const entryPatterns = [
    /^src\/index\.[tj]sx?$/,
    /^src\/main\.[tj]sx?$/,
    /^src\/app\.[tj]sx?$/,
    /^index\.[tj]sx?$/,
    /^app\.[tj]sx?$/,
    /^server\.[tj]sx?$/,
    /^main\.py$/,
    /^app\.py$/,
  ];

  return parsed
    .filter((p) => entryPatterns.some((pattern) => pattern.test(p.file.relative)))
    .map((p) => p.file.relative);
}
