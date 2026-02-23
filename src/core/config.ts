import { readFileSync, existsSync, readdirSync } from 'fs';
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

export const WELL_KNOWN_SOURCE_DIRS = [
  'src', 'app', 'api', 'routes', 'controllers',
  'models', 'services', 'middleware', 'utils', 'helpers',
  'components', 'pages', 'views', 'handlers', 'modules',
];

export const DEFAULT_CONFIG: Omit<CodemapConfig, 'root'> = {
  include: ['.'],
  exclude: [
    'node_modules',
    '__pycache__',
    'dist',
    'build',
    'lib',
    '.git',
    '.codemap',
    '*.test.*',
    '*.spec.*',
    '*.min.*',
    'coverage',
    'vendor',
    '.next',
    '.nuxt',
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
  } else {
    // No config file — auto-detect include directories
    fileConfig.include = detectIncludeDirs(root);
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

/**
 * Auto-detect which directories to scan.
 * If well-known source directories exist (src, lib, app, etc.), use those.
 * Otherwise fall back to "." to scan everything from root.
 */
export function detectIncludeDirs(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const matched = WELL_KNOWN_SOURCE_DIRS.filter((d) => dirs.includes(d));

  // If we found known source dirs, use them
  // Otherwise scan from root (handles projects with root-level files)
  if (matched.length > 0) {
    // Also include root "." if there are source files at the root level
    const rootHasSourceFiles = entries.some(
      (e) => e.isFile() && /\.(ts|tsx|js|jsx|mjs|cjs|py)$/.test(e.name)
    );
    return rootHasSourceFiles ? ['.'] : matched;
  }

  return ['.'];
}
