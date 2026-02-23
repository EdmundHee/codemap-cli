import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';

export interface CodemapConfig {
  /** Root path to scan */
  root: string;
  /** Directories to include */
  include: string[];
  /** Patterns to exclude */
  exclude: string[];
  /** Override framework detection (null = auto-detect) */
  framework: string | null;
  /** Output directory */
  output: string;
  /** Feature toggles */
  features: {
    call_graph: boolean;
    import_graph: boolean;
    routes: boolean;
    models: boolean;
    types: boolean;
    data_flow: boolean;
    config_deps: boolean;
    middleware: boolean;
  };
  /** Detail level: 'full' | 'names-only' */
  detail: 'full' | 'names-only';
  /** Max depth for call graph traversal */
  max_call_depth: number;
  /** Custom entry points (null = auto-detect) */
  entry_points: string[] | null;
}

export const DEFAULT_CONFIG: Omit<CodemapConfig, 'root'> = {
  include: ['src', 'lib', 'app'],
  exclude: [
    'node_modules',
    '__pycache__',
    'dist',
    'build',
    '.git',
    '*.test.*',
    '*.spec.*',
  ],
  framework: null,
  output: '.codemap',
  features: {
    call_graph: true,
    import_graph: true,
    routes: true,
    models: true,
    types: true,
    data_flow: true,
    config_deps: true,
    middleware: true,
  },
  detail: 'full',
  max_call_depth: 5,
  entry_points: null,
};

/**
 * Load config from .codemaprc file, merging with defaults and CLI overrides.
 */
export async function loadConfig(
  rootPath: string,
  overrides: Partial<Pick<CodemapConfig, 'output' | 'framework' | 'detail'>> = {}
): Promise<CodemapConfig> {
  const root = resolve(rootPath);
  const configPath = join(root, '.codemaprc');

  let fileConfig: Partial<CodemapConfig> = {};

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      fileConfig = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Failed to parse .codemaprc: ${(error as Error).message}`);
    }
  }

  return {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    root,
    // CLI overrides take precedence
    ...(overrides.output && { output: overrides.output }),
    ...(overrides.framework && { framework: overrides.framework }),
    ...(overrides.detail && { detail: overrides.detail }),
    features: {
      ...DEFAULT_CONFIG.features,
      ...(fileConfig.features || {}),
    },
  };
}
