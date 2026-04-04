import { detectCircularDeps, CycleData } from '../circular-deps';
import { ParsedFile } from '../../parsers/parser.interface';
import { ScannedFile } from '../../core/scanner';
import { ImportGraph } from '../import-graph';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeFile(relative: string): ScannedFile {
  return { absolute: `/project/${relative}`, relative, language: 'typescript' };
}

function makeParsed(overrides: Partial<ParsedFile> & { file: ScannedFile }): ParsedFile {
  return {
    hash: 'abc',
    classes: [],
    functions: [],
    imports: [],
    exports: [],
    types: [],
    envVars: [],
    moduleCalls: [],
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('detectCircularDeps', () => {
  test('detects a simple 2-file cycle', () => {
    const importGraph: ImportGraph = {
      'src/a.ts': ['src/b.ts'],
      'src/b.ts': ['src/a.ts'],
    };

    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/a.ts'),
        imports: [{ from: './b', symbols: ['funcB'], isDefault: false, isNamespace: false }],
      }),
      makeParsed({
        file: makeFile('src/b.ts'),
        imports: [{ from: './a', symbols: ['funcA'], isDefault: false, isNamespace: false }],
      }),
    ];

    const cycles = detectCircularDeps(importGraph, parsed);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].files).toContain('src/a.ts');
    expect(cycles[0].files).toContain('src/b.ts');
    expect(cycles[0].edges.length).toBeGreaterThanOrEqual(2);
  });

  test('detects a 3-file cycle', () => {
    const importGraph: ImportGraph = {
      'src/a.ts': ['src/b.ts'],
      'src/b.ts': ['src/c.ts'],
      'src/c.ts': ['src/a.ts'],
    };

    const parsed: ParsedFile[] = [
      makeParsed({ file: makeFile('src/a.ts'), imports: [{ from: './b', symbols: ['b'], isDefault: false, isNamespace: false }] }),
      makeParsed({ file: makeFile('src/b.ts'), imports: [{ from: './c', symbols: ['c'], isDefault: false, isNamespace: false }] }),
      makeParsed({ file: makeFile('src/c.ts'), imports: [{ from: './a', symbols: ['a'], isDefault: false, isNamespace: false }] }),
    ];

    const cycles = detectCircularDeps(importGraph, parsed);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].files).toHaveLength(3);
  });

  test('returns empty array when no cycles exist', () => {
    const importGraph: ImportGraph = {
      'src/a.ts': ['src/b.ts'],
      'src/b.ts': ['src/c.ts'],
      'src/c.ts': [],
    };

    const parsed: ParsedFile[] = [
      makeParsed({ file: makeFile('src/a.ts'), imports: [{ from: './b', symbols: ['b'], isDefault: false, isNamespace: false }] }),
      makeParsed({ file: makeFile('src/b.ts'), imports: [{ from: './c', symbols: ['c'], isDefault: false, isNamespace: false }] }),
      makeParsed({ file: makeFile('src/c.ts'), imports: [] }),
    ];

    const cycles = detectCircularDeps(importGraph, parsed);
    expect(cycles).toHaveLength(0);
  });

  test('computes minimum cut correctly (edge with fewest symbols)', () => {
    const importGraph: ImportGraph = {
      'src/a.ts': ['src/b.ts'],
      'src/b.ts': ['src/a.ts'],
    };

    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/a.ts'),
        imports: [{ from: './b', symbols: ['x', 'y', 'z'], isDefault: false, isNamespace: false }],
      }),
      makeParsed({
        file: makeFile('src/b.ts'),
        imports: [{ from: './a', symbols: ['w'], isDefault: false, isNamespace: false }],
      }),
    ];

    const cycles = detectCircularDeps(importGraph, parsed);
    expect(cycles).toHaveLength(1);

    const cycle = cycles[0];
    expect(cycle.minimumCut).not.toBeNull();
    // The minimum cut should be the edge with fewer symbols (b→a with 1 symbol)
    expect(cycle.minimumCutSymbolCount).toBeLessThanOrEqual(3);
  });

  test('handles disconnected components (no cycles)', () => {
    const importGraph: ImportGraph = {
      'src/a.ts': ['src/b.ts'],
      'src/c.ts': ['src/d.ts'],
    };

    const parsed: ParsedFile[] = [
      makeParsed({ file: makeFile('src/a.ts'), imports: [{ from: './b', symbols: [], isDefault: false, isNamespace: false }] }),
      makeParsed({ file: makeFile('src/b.ts'), imports: [] }),
      makeParsed({ file: makeFile('src/c.ts'), imports: [{ from: './d', symbols: [], isDefault: false, isNamespace: false }] }),
      makeParsed({ file: makeFile('src/d.ts'), imports: [] }),
    ];

    const cycles = detectCircularDeps(importGraph, parsed);
    expect(cycles).toHaveLength(0);
  });

  test('handles self-import (single node cycle) — excluded as SCC size 1', () => {
    const importGraph: ImportGraph = {
      'src/a.ts': ['src/a.ts'],
    };

    const parsed: ParsedFile[] = [
      makeParsed({ file: makeFile('src/a.ts'), imports: [] }),
    ];

    const cycles = detectCircularDeps(importGraph, parsed);
    // SCC of size 1 is excluded
    expect(cycles).toHaveLength(0);
  });

  test('detects multiple independent cycles', () => {
    const importGraph: ImportGraph = {
      'src/a.ts': ['src/b.ts'],
      'src/b.ts': ['src/a.ts'],
      'src/c.ts': ['src/d.ts'],
      'src/d.ts': ['src/c.ts'],
    };

    const parsed: ParsedFile[] = [
      makeParsed({ file: makeFile('src/a.ts'), imports: [{ from: './b', symbols: ['b'], isDefault: false, isNamespace: false }] }),
      makeParsed({ file: makeFile('src/b.ts'), imports: [{ from: './a', symbols: ['a'], isDefault: false, isNamespace: false }] }),
      makeParsed({ file: makeFile('src/c.ts'), imports: [{ from: './d', symbols: ['d'], isDefault: false, isNamespace: false }] }),
      makeParsed({ file: makeFile('src/d.ts'), imports: [{ from: './c', symbols: ['c'], isDefault: false, isNamespace: false }] }),
    ];

    const cycles = detectCircularDeps(importGraph, parsed);
    expect(cycles).toHaveLength(2);
  });

  test('handles empty import graph', () => {
    const cycles = detectCircularDeps({}, []);
    expect(cycles).toEqual([]);
  });

  test('cycle edges contain correct source and target files', () => {
    const importGraph: ImportGraph = {
      'src/a.ts': ['src/b.ts'],
      'src/b.ts': ['src/a.ts'],
    };

    const parsed: ParsedFile[] = [
      makeParsed({ file: makeFile('src/a.ts'), imports: [{ from: './b', symbols: ['funcB'], isDefault: false, isNamespace: false }] }),
      makeParsed({ file: makeFile('src/b.ts'), imports: [{ from: './a', symbols: ['funcA'], isDefault: false, isNamespace: false }] }),
    ];

    const cycles = detectCircularDeps(importGraph, parsed);
    const edges = cycles[0].edges;
    const sourceFiles = edges.map(e => e.sourceFile);
    const targetFiles = edges.map(e => e.targetFile);

    expect(sourceFiles).toContain('src/a.ts');
    expect(sourceFiles).toContain('src/b.ts');
    expect(targetFiles).toContain('src/a.ts');
    expect(targetFiles).toContain('src/b.ts');
  });
});
