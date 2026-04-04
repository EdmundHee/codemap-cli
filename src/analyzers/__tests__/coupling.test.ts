import { computeModuleCoupling, ModuleMetrics } from '../coupling';
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

describe('computeModuleCoupling', () => {
  test('computes basic afferent and efferent coupling', () => {
    const importGraph: ImportGraph = {
      'src/core/engine.ts': ['src/utils/helper.ts'],
      'src/cli/main.ts': ['src/core/engine.ts', 'src/utils/helper.ts'],
      'src/utils/helper.ts': [],
    };

    const parsed: ParsedFile[] = [
      makeParsed({ file: makeFile('src/core/engine.ts'), exports: [{ name: 'Engine', kind: 'class' }] }),
      makeParsed({ file: makeFile('src/cli/main.ts'), exports: [{ name: 'main', kind: 'function' }] }),
      makeParsed({ file: makeFile('src/utils/helper.ts'), exports: [{ name: 'helper', kind: 'function' }] }),
    ];

    const metrics = computeModuleCoupling(importGraph, parsed);

    // src/utils/ is imported by core and cli → Ca=2, Ce=0, I=0
    const utilsMod = metrics.find(m => m.path === 'src/utils');
    expect(utilsMod).toBeDefined();
    expect(utilsMod!.afferentCoupling).toBe(2);
    expect(utilsMod!.efferentCoupling).toBe(0);
    expect(utilsMod!.instability).toBe(0);

    // src/cli/ imports core and utils → Ca=0, Ce=2, I=1
    const cliMod = metrics.find(m => m.path === 'src/cli');
    expect(cliMod).toBeDefined();
    expect(cliMod!.afferentCoupling).toBe(0);
    expect(cliMod!.efferentCoupling).toBe(2);
    expect(cliMod!.instability).toBe(1);
  });

  test('computes instability formula I = Ce / (Ca + Ce)', () => {
    const importGraph: ImportGraph = {
      'src/a/x.ts': ['src/b/y.ts'],  // a depends on b
      'src/c/z.ts': ['src/b/y.ts'],  // c depends on b
      'src/b/y.ts': ['src/d/w.ts'],  // b depends on d
      'src/d/w.ts': [],
    };

    const parsed: ParsedFile[] = [
      makeParsed({ file: makeFile('src/a/x.ts') }),
      makeParsed({ file: makeFile('src/b/y.ts') }),
      makeParsed({ file: makeFile('src/c/z.ts') }),
      makeParsed({ file: makeFile('src/d/w.ts') }),
    ];

    const metrics = computeModuleCoupling(importGraph, parsed);
    const bMod = metrics.find(m => m.path === 'src/b');

    expect(bMod).toBeDefined();
    // b: Ca=2 (a, c import it), Ce=1 (imports d)
    expect(bMod!.afferentCoupling).toBe(2);
    expect(bMod!.efferentCoupling).toBe(1);
    // I = 1 / (2+1) = 0.33
    expect(bMod!.instability).toBeCloseTo(0.33, 1);
  });

  test('aggregates complexity metrics per module', () => {
    const importGraph: ImportGraph = {
      'src/core/a.ts': [],
      'src/core/b.ts': [],
    };

    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/core/a.ts'),
        functions: [
          { name: 'funcA', params: [], return_type: 'void', async: false, exported: true, calls: [], complexity: 5, lineCount: 10, nestingDepth: 0 },
          { name: 'funcB', params: [], return_type: 'void', async: false, exported: false, calls: [], complexity: 15, lineCount: 30, nestingDepth: 2 },
        ],
      }),
      makeParsed({
        file: makeFile('src/core/b.ts'),
        classes: [{
          name: 'Svc',
          extends: null,
          implements: [],
          decorators: [],
          methods: [
            { name: 'run', params: [], return_type: 'void', decorators: [], access: 'public', async: false, static: false, calls: [], complexity: 8, lineCount: 20, nestingDepth: 1, instanceVarAccesses: [] },
          ],
          properties: [],
        }],
      }),
    ];

    const metrics = computeModuleCoupling(importGraph, parsed);
    const coreMod = metrics.find(m => m.path === 'src/core');

    expect(coreMod).toBeDefined();
    expect(coreMod!.totalComplexity).toBe(28); // 5+15+8
    expect(coreMod!.maxComplexity).toBe(15);
    expect(coreMod!.maxComplexityFunction).toBe('funcB');
    expect(coreMod!.avgComplexity).toBeCloseTo(9.33, 1); // 28/3
    expect(coreMod!.fileCount).toBe(2);
  });

  test('counts public surface area from exports', () => {
    const importGraph: ImportGraph = { 'src/api/routes.ts': [] };

    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/api/routes.ts'),
        exports: [
          { name: 'getUser', kind: 'function' },
          { name: 'createUser', kind: 'function' },
          { name: 'UserType', kind: 'type' },
        ],
      }),
    ];

    const metrics = computeModuleCoupling(importGraph, parsed);
    const apiMod = metrics.find(m => m.path === 'src/api');
    expect(apiMod!.publicSurfaceArea).toBe(3);
  });

  test('sorts by instability descending', () => {
    const importGraph: ImportGraph = {
      'src/a/x.ts': ['src/b/y.ts', 'src/c/z.ts'], // a: Ce=2
      'src/b/y.ts': [],                               // b: Ca=1
      'src/c/z.ts': ['src/b/y.ts'],                    // c: Ce=1, Ca=1
    };

    const parsed: ParsedFile[] = [
      makeParsed({ file: makeFile('src/a/x.ts') }),
      makeParsed({ file: makeFile('src/b/y.ts') }),
      makeParsed({ file: makeFile('src/c/z.ts') }),
    ];

    const metrics = computeModuleCoupling(importGraph, parsed);
    for (let i = 1; i < metrics.length; i++) {
      expect(metrics[i].instability).toBeLessThanOrEqual(metrics[i - 1].instability);
    }
  });

  test('handles empty input', () => {
    const metrics = computeModuleCoupling({}, []);
    expect(metrics).toEqual([]);
  });

  test('does not count intra-module imports as coupling', () => {
    const importGraph: ImportGraph = {
      'src/core/a.ts': ['src/core/b.ts'],
      'src/core/b.ts': ['src/core/a.ts'],
    };

    const parsed: ParsedFile[] = [
      makeParsed({ file: makeFile('src/core/a.ts') }),
      makeParsed({ file: makeFile('src/core/b.ts') }),
    ];

    const metrics = computeModuleCoupling(importGraph, parsed);
    const coreMod = metrics.find(m => m.path === 'src/core');
    expect(coreMod!.afferentCoupling).toBe(0);
    expect(coreMod!.efferentCoupling).toBe(0);
  });
});
