import {
  compactQueryResult,
  compactClusteredResults,
  compactExplore,
  compactCallers,
  compactCalls,
  compactOverview,
  compactModule,
  compactHealth,
  compactDependencies,
} from '../compact-formatter';
import {
  formatQueryResult,
  formatClusteredResults,
  formatExplore,
  formatCallers,
  formatCalls,
  formatOverview,
  formatModule,
  formatHealth,
  formatDependencies,
} from '../formatters';
import { ClusteredSearchResult } from '../../analyzers/cluster';

// ─── compactQueryResult ──────────────────────────────────────────────────────

describe('compactQueryResult', () => {
  test('formats function with signature detail', () => {
    const result = {
      type: 'function' as const,
      name: 'buildCallGraph',
      file: 'src/analyzers/call-graph.ts',
      data: {
        params: [{ name: 'parsedFiles', type: 'ParsedFile[]' }],
        return_type: 'CallGraph',
        exported: true,
        calls: ['filterBuiltins'],
        called_by: ['Orchestrator.run'],
      },
    };

    const compact = compactQueryResult(result, 'signature');
    expect(compact).toContain('fn buildCallGraph');
    expect(compact).toContain('parsedFiles:ParsedFile[]');
    expect(compact).toContain('→CallGraph');
    expect(compact).toContain('exp');
    // Signature level should NOT include calls/callers
    expect(compact).not.toContain('↑');
    expect(compact).not.toContain('↓');
  });

  test('full detail includes calls and callers', () => {
    const result = {
      type: 'function' as const,
      name: 'buildCallGraph',
      file: 'src/analyzers/call-graph.ts',
      data: {
        params: [{ name: 'files', type: 'ParsedFile[]' }],
        return_type: 'CallGraph',
        exported: true,
        calls: ['filterBuiltins'],
        called_by: ['Orchestrator.run'],
      },
    };

    const compact = compactQueryResult(result, 'full');
    expect(compact).toContain('↑ Orchestrator.run');
    expect(compact).toContain('↓ filterBuiltins');
  });

  test('summary detail is minimal', () => {
    const result = {
      type: 'function' as const,
      name: 'buildCallGraph',
      file: 'src/analyzers/call-graph.ts',
      data: { params: [{ name: 'files', type: 'ParsedFile[]' }], return_type: 'CallGraph', exported: true },
    };

    const compact = compactQueryResult(result, 'summary');
    expect(compact).toContain('fn buildCallGraph');
    expect(compact).not.toContain('ParsedFile');
    expect(compact).not.toContain('→CallGraph');
  });

  test('class result includes methods', () => {
    const result = {
      type: 'class' as const,
      name: 'PythonParser',
      file: 'src/parsers/python/py-parser.ts',
      data: {
        extends: 'BaseParser',
        implements: [],
        methods: [{ name: 'parse' }, { name: 'extract' }],
      },
    };

    const compact = compactQueryResult(result, 'signature');
    expect(compact).toContain('class PythonParser');
    expect(compact).toContain('< BaseParser');
    expect(compact).toContain('methods: parse, extract');
  });

  test('compact is smaller than markdown', () => {
    const result = {
      type: 'function' as const,
      name: 'buildCallGraph',
      file: 'src/analyzers/call-graph.ts',
      data: {
        params: [{ name: 'parsedFiles', type: 'ParsedFile[]' }],
        return_type: 'CallGraph',
        exported: true,
        calls: ['filterBuiltins', 'normalizeCallExpression'],
        called_by: ['Orchestrator.run'],
      },
    };

    const compact = compactQueryResult(result, 'full');
    const markdown = formatQueryResult(result);

    expect(compact.length).toBeLessThan(markdown.length);
    // At least 40% smaller
    expect(compact.length).toBeLessThan(markdown.length * 0.7);
  });
});

// ─── compactClusteredResults ─────────────────────────────────────────────────

describe('compactClusteredResults', () => {
  test('formats clusters with hub tags', () => {
    const clusters: ClusteredSearchResult[] = [
      {
        hub: { name: 'parseConfig', type: 'function', file: 'src/core/config.ts' },
        children: [
          { name: 'parseYaml', type: 'function', file: 'src/core/config.ts' },
          { name: 'parseEnv', type: 'function', file: 'src/core/config.ts' },
        ],
        size: 3,
      },
    ];

    const compact = compactClusteredResults(clusters);
    expect(compact).toContain('3 results, 1 clusters');
    expect(compact).toContain('[hub:3]');
    expect(compact).toContain('parseConfig');
    expect(compact).toContain('parseYaml');
    expect(compact).toContain('parseEnv');
  });

  test('omits child path when same as hub', () => {
    const clusters: ClusteredSearchResult[] = [
      {
        hub: { name: 'parseConfig', type: 'function', file: 'src/core/config.ts' },
        children: [
          { name: 'parseYaml', type: 'function', file: 'src/core/config.ts' },
          { name: 'externalParse', type: 'function', file: 'src/utils/parse.ts' },
        ],
        size: 3,
      },
    ];

    const compact = compactClusteredResults(clusters);
    // parseYaml should NOT have a path (same file as hub)
    const parseYamlLine = compact.split('\n').find((l) => l.includes('parseYaml'));
    expect(parseYamlLine).not.toContain('@');

    // externalParse SHOULD have a path (different file)
    const externalLine = compact.split('\n').find((l) => l.includes('externalParse'));
    expect(externalLine).toContain('@');
  });

  test('compact clusters are smaller than markdown', () => {
    const clusters: ClusteredSearchResult[] = [
      {
        hub: { name: 'parseConfig', type: 'function', file: 'src/core/config.ts' },
        children: [
          { name: 'parseYaml', type: 'function', file: 'src/core/config.ts' },
          { name: 'parseEnv', type: 'function', file: 'src/core/config.ts' },
          { name: 'validateConfig', type: 'function', file: 'src/core/config.ts' },
        ],
        size: 4,
      },
      {
        hub: { name: 'PythonParser', type: 'class', file: 'src/parsers/python/py-parser.ts' },
        children: [
          { name: 'PythonParser.parseFile', type: 'method', file: 'src/parsers/python/py-parser.ts' },
        ],
        size: 2,
      },
    ];

    const compact = compactClusteredResults(clusters);
    const markdown = formatClusteredResults(clusters);

    expect(compact.length).toBeLessThan(markdown.length);
  });
});

// ─── compactExplore ──────────────────────────────────────────────────────────

describe('compactExplore', () => {
  test('formats explore result with depth markers', () => {
    const result = {
      root: 'buildCallGraph',
      nodes: [
        { name: 'buildCallGraph', file: 'src/analyzers/call-graph.ts', depth: 0, relation: 'root' as const },
        { name: 'Orchestrator.run', file: 'src/core/orchestrator.ts', depth: 1, relation: 'called_by' as const },
        { name: 'filterBuiltins', file: 'src/utils/call-filter.ts', depth: 1, relation: 'calls' as const },
      ],
      edges: [
        { from: 'Orchestrator.run', to: 'buildCallGraph' },
        { from: 'buildCallGraph', to: 'filterBuiltins' },
      ],
    };

    const compact = compactExplore(result);
    expect(compact).toContain('explore buildCallGraph 3n 2e');
    expect(compact).toContain('↑1 Orchestrator.run');
    expect(compact).toContain('* buildCallGraph');
    expect(compact).toContain('↓1 filterBuiltins');
  });

  test('compact explore omits redundant edge list', () => {
    const result = {
      root: 'fn',
      nodes: [
        { name: 'fn', file: 'a.ts', depth: 0, relation: 'root' as const },
        { name: 'caller', file: 'b.ts', depth: 1, relation: 'called_by' as const },
      ],
      edges: [{ from: 'caller', to: 'fn' }],
    };

    const compact = compactExplore(result);
    // Compact format should NOT have a separate "Edges" section
    expect(compact).not.toContain('Edges');
    expect(compact).not.toContain('→');
  });

  test('compact explore is smaller than markdown', () => {
    const result = {
      root: 'buildCallGraph',
      nodes: [
        { name: 'buildCallGraph', file: 'src/analyzers/call-graph.ts', depth: 0, relation: 'root' as const },
        { name: 'Orchestrator.run', file: 'src/core/orchestrator.ts', depth: 1, relation: 'called_by' as const },
        { name: 'generateCommand', file: 'src/cli/commands/generate.ts', depth: 2, relation: 'called_by' as const },
        { name: 'filterBuiltins', file: 'src/utils/call-filter.ts', depth: 1, relation: 'calls' as const },
        { name: 'normalizeCall', file: 'src/utils/call-filter.ts', depth: 1, relation: 'calls' as const },
        { name: 'isBuiltinCall', file: 'src/utils/call-filter.ts', depth: 2, relation: 'calls' as const },
      ],
      edges: [
        { from: 'Orchestrator.run', to: 'buildCallGraph' },
        { from: 'generateCommand', to: 'Orchestrator.run' },
        { from: 'buildCallGraph', to: 'filterBuiltins' },
        { from: 'buildCallGraph', to: 'normalizeCall' },
        { from: 'filterBuiltins', to: 'isBuiltinCall' },
      ],
    };

    const compact = compactExplore(result);
    const markdown = formatExplore(result);

    expect(compact.length).toBeLessThan(markdown.length);
    // Explore should be significantly smaller (no edge list duplication)
    expect(compact.length).toBeLessThan(markdown.length * 0.7);
  });
});

// ─── compactCallers / compactCalls ───────────────────────────────────────────

describe('compactCallers', () => {
  test('formats callers inline', () => {
    const result = { function: 'buildCallGraph', callers: ['Orchestrator.run', 'cli.main'] };
    const compact = compactCallers(result);
    expect(compact).toBe('buildCallGraph ↑ 2: Orchestrator.run, cli.main');
  });

  test('handles zero callers', () => {
    const result = { function: 'orphan', callers: [] };
    expect(compactCallers(result)).toBe('orphan ↑ 0');
  });
});

describe('compactCalls', () => {
  test('formats calls inline', () => {
    const result = { function: 'buildCallGraph', calls: ['filterBuiltins', 'normalizeCall'] };
    const compact = compactCalls(result);
    expect(compact).toBe('buildCallGraph ↓ 2: filterBuiltins, normalizeCall');
  });

  test('handles zero calls', () => {
    const result = { function: 'leaf', calls: [] };
    expect(compactCalls(result)).toBe('leaf ↓ 0');
  });
});

// ─── compactOverview ─────────────────────────────────────────────────────────

describe('compactOverview', () => {
  test('formats overview compactly', () => {
    const overview = {
      project: 'test-project',
      languages: ['typescript'],
      frameworks: [],
      entry_points: ['src/index.ts'],
      totals: { files: 10, classes: 3, functions: 50, types: 5 },
      modules: {
        'src/core': { files: 3, classes: 1, functions: 20, types: 2 },
        'src/utils': { files: 2, classes: 0, functions: 10, types: 0 },
      },
    };

    const compact = compactOverview(overview);
    expect(compact).toContain('test-project | typescript');
    expect(compact).toContain('10 files, 3 classes, 50 fn, 5 types');
    expect(compact).toContain('src/core/ 3f 1c 20fn 2t');
  });

  test('compact overview is smaller than markdown', () => {
    const overview = {
      project: 'test-project',
      languages: ['typescript', 'python'],
      frameworks: ['django'],
      entry_points: ['src/index.ts', 'manage.py'],
      totals: { files: 50, classes: 15, functions: 200, types: 30 },
      modules: {
        'src/core': { files: 5, classes: 2, functions: 40, types: 5 },
        'src/utils': { files: 3, classes: 0, functions: 15, types: 0 },
        'src/api': { files: 8, classes: 4, functions: 60, types: 10 },
      },
      dependencies: {
        packages: {
          express: { version: '^4.18.0', type: 'prod' },
          jest: { version: '^29.0.0', type: 'dev' },
        },
      },
    };

    const compact = compactOverview(overview);
    const markdown = formatOverview(overview);

    expect(compact.length).toBeLessThan(markdown.length);
  });
});

// ─── compactDependencies ─────────────────────────────────────────────────────

describe('compactDependencies', () => {
  test('formats imports compactly', () => {
    const result = {
      file: 'src/core/query-engine.ts',
      imports: ['src/output/json-generator.ts', 'src/analyzers/cluster.ts'],
    };

    const compact = compactDependencies(result, 'imports');
    expect(compact).toContain('→ 2:');
  });

  test('formats imported_by compactly', () => {
    const result = {
      file: 'src/core/query-engine.ts',
      imported_by: ['src/mcp/server.ts', 'src/cli/commands/query.ts'],
    };

    const compact = compactDependencies(result, 'imported_by');
    expect(compact).toContain('← 2:');
  });
});
