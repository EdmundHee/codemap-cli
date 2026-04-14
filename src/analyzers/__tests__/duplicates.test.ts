import { detectDuplicates, DuplicateGroup, computeMultiSignalSimilarity, FunctionSignature } from '../duplicates';
import { ParsedFile } from '../../parsers/parser.interface';
import { ScannedFile } from '../../core/scanner';

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

describe('detectDuplicates', () => {
  test('detects functions with same name in different files with identical calls', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/a.ts'),
        functions: [
          { name: 'formatDate', params: [{ name: 'date', type: 'Date' }], return_type: 'string', async: false, exported: true, calls: ['toISOString', 'split', 'join'], complexity: 1, lineCount: 5, nestingDepth: 0 },
        ],
      }),
      makeParsed({
        file: makeFile('src/b.ts'),
        functions: [
          { name: 'formatDate', params: [{ name: 'date', type: 'Date' }], return_type: 'string', async: false, exported: true, calls: ['toISOString', 'split', 'join'], complexity: 1, lineCount: 5, nestingDepth: 0 },
        ],
      }),
    ];

    const dupes = detectDuplicates(parsed);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].signature).toBe('formatDate');
    expect(dupes[0].similarity).toBe(1);
    expect(dupes[0].functions).toHaveLength(2);
  });

  test('detects functions with same name and partial call overlap', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/a.ts'),
        functions: [
          { name: 'validate', params: [{ name: 'data', type: 'any' }], return_type: 'boolean', async: false, exported: true, calls: ['checkType', 'checkNull', 'checkRange'], complexity: 3, lineCount: 10, nestingDepth: 1 },
        ],
      }),
      makeParsed({
        file: makeFile('src/b.ts'),
        functions: [
          { name: 'validate', params: [{ name: 'data', type: 'any' }], return_type: 'boolean', async: false, exported: true, calls: ['checkType', 'checkNull', 'formatError'], complexity: 3, lineCount: 10, nestingDepth: 1 },
        ],
      }),
    ];

    const dupes = detectDuplicates(parsed);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].similarity).toBeGreaterThan(0.3);
    expect(dupes[0].similarity).toBeLessThan(1);
  });

  test('does not flag functions in the same file as duplicates', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/utils.ts'),
        functions: [
          { name: 'helper', params: [], return_type: 'void', async: false, exported: false, calls: ['log'], complexity: 1, lineCount: 3, nestingDepth: 0 },
        ],
        classes: [{
          name: 'MyClass',
          extends: null,
          implements: [],
          decorators: [],
          methods: [
            { name: 'helper', params: [], return_type: 'void', decorators: [], access: 'public', async: false, static: false, calls: ['log'], complexity: 1, lineCount: 3, nestingDepth: 0, instanceVarAccesses: [] },
          ],
          properties: [],
        }],
      }),
    ];

    const dupes = detectDuplicates(parsed);
    expect(dupes).toHaveLength(0);
  });

  test('does not flag functions with low similarity (<= 0.3) and different signatures', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/a.ts'),
        functions: [
          { name: 'process', params: [{ name: 'x', type: 'number' }], return_type: 'number', async: false, exported: true, calls: ['Math.sqrt', 'Math.round'], complexity: 1, lineCount: 5, nestingDepth: 0 },
        ],
      }),
      makeParsed({
        file: makeFile('src/b.ts'),
        functions: [
          { name: 'process', params: [{ name: 'input', type: 'string' }], return_type: 'string', async: false, exported: true, calls: ['trim', 'toLowerCase', 'split', 'join', 'replace'], complexity: 1, lineCount: 5, nestingDepth: 0 },
        ],
      }),
    ];

    const dupes = detectDuplicates(parsed);
    // Low similarity + different param types = should not be flagged
    expect(dupes).toHaveLength(0);
  });

  test('flags functions with matching signatures even if call similarity is low', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/a.ts'),
        functions: [
          { name: 'convert', params: [{ name: 'value', type: 'string' }], return_type: 'number', async: false, exported: true, calls: ['parseInt'], complexity: 1, lineCount: 3, nestingDepth: 0 },
        ],
      }),
      makeParsed({
        file: makeFile('src/b.ts'),
        functions: [
          { name: 'convert', params: [{ name: 'value', type: 'string' }], return_type: 'number', async: false, exported: true, calls: ['parseFloat'], complexity: 1, lineCount: 3, nestingDepth: 0 },
        ],
      }),
    ];

    const dupes = detectDuplicates(parsed);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].signature).toBe('convert');
  });

  test('detects duplicates across class methods in different files', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/serviceA.ts'),
        classes: [{
          name: 'ServiceA',
          extends: null,
          implements: [],
          decorators: [],
          methods: [
            { name: 'serialize', params: [{ name: 'data', type: 'any' }], return_type: 'string', decorators: [], access: 'public', async: false, static: false, calls: ['JSON.stringify', 'encode'], complexity: 1, lineCount: 5, nestingDepth: 0, instanceVarAccesses: [] },
          ],
          properties: [],
        }],
      }),
      makeParsed({
        file: makeFile('src/serviceB.ts'),
        classes: [{
          name: 'ServiceB',
          extends: null,
          implements: [],
          decorators: [],
          methods: [
            { name: 'serialize', params: [{ name: 'data', type: 'any' }], return_type: 'string', decorators: [], access: 'public', async: false, static: false, calls: ['JSON.stringify', 'encode'], complexity: 1, lineCount: 5, nestingDepth: 0, instanceVarAccesses: [] },
          ],
          properties: [],
        }],
      }),
    ];

    const dupes = detectDuplicates(parsed);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].signature).toBe('serialize');
    expect(dupes[0].similarity).toBe(1);
  });

  test('sorts duplicates by similarity descending', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/a.ts'),
        functions: [
          { name: 'low', params: [], return_type: 'void', async: false, exported: true, calls: ['a', 'b', 'c'], complexity: 1, lineCount: 5, nestingDepth: 0 },
          { name: 'high', params: [{ name: 'x', type: 'string' }], return_type: 'string', async: false, exported: true, calls: ['trim', 'split'], complexity: 1, lineCount: 5, nestingDepth: 0 },
        ],
      }),
      makeParsed({
        file: makeFile('src/b.ts'),
        functions: [
          { name: 'low', params: [], return_type: 'void', async: false, exported: true, calls: ['a', 'd', 'e', 'f'], complexity: 1, lineCount: 5, nestingDepth: 0 },
          { name: 'high', params: [{ name: 'x', type: 'string' }], return_type: 'string', async: false, exported: true, calls: ['trim', 'split'], complexity: 1, lineCount: 5, nestingDepth: 0 },
        ],
      }),
    ];

    const dupes = detectDuplicates(parsed);
    expect(dupes.length).toBeGreaterThanOrEqual(1);
    // Should be sorted: highest similarity first
    for (let i = 1; i < dupes.length; i++) {
      expect(dupes[i].similarity).toBeLessThanOrEqual(dupes[i - 1].similarity);
    }
  });

  test('handles empty input', () => {
    expect(detectDuplicates([])).toEqual([]);
  });

  test('handles 3+ copies of the same function', () => {
    const parsed: ParsedFile[] = ['a', 'b', 'c'].map(name =>
      makeParsed({
        file: makeFile(`src/${name}.ts`),
        functions: [
          { name: 'helper', params: [], return_type: 'void', async: false, exported: false, calls: ['log', 'format'], complexity: 1, lineCount: 3, nestingDepth: 0 },
        ],
      }),
    );

    const dupes = detectDuplicates(parsed);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].functions).toHaveLength(3);
  });
});

// ─── Cross-name structural similarity ─────────────────────────────────────

describe('cross-name structural similarity detection', () => {
  test('detects functions with different names but identical calls/params/structure', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/a.ts'),
        functions: [
          { name: 'loadConfig', params: [{ name: 'path', type: 'string' }], return_type: 'Config', async: false, exported: true, calls: ['readFileSync', 'JSON.parse', 'validate'], complexity: 3, lineCount: 12, nestingDepth: 1 },
        ],
      }),
      makeParsed({
        file: makeFile('src/b.ts'),
        functions: [
          { name: 'parseSettings', params: [{ name: 'path', type: 'string' }], return_type: 'Config', async: false, exported: true, calls: ['readFileSync', 'JSON.parse', 'validate'], complexity: 3, lineCount: 12, nestingDepth: 1 },
        ],
      }),
    ];

    const dupes = detectDuplicates(parsed);
    const structural = dupes.filter(d => d.matchType === 'structural');
    expect(structural.length).toBeGreaterThanOrEqual(1);
    expect(structural[0].functions.map(f => f.name).sort()).toEqual(['loadConfig', 'parseSettings']);
  });

  test('does NOT match functions with different names AND different calls/structure', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/a.ts'),
        functions: [
          { name: 'readData', params: [], return_type: 'void', async: false, exported: true, calls: ['readFile', 'parse'], complexity: 1, lineCount: 5, nestingDepth: 0 },
        ],
      }),
      makeParsed({
        file: makeFile('src/b.ts'),
        functions: [
          { name: 'renderUI', params: [{ name: 'props', type: 'Props' }, { name: 'ref', type: 'Ref' }], return_type: 'JSX.Element', async: false, exported: true, calls: ['createElement', 'useState', 'useEffect', 'render'], complexity: 5, lineCount: 40, nestingDepth: 3 },
        ],
      }),
    ];

    const dupes = detectDuplicates(parsed);
    const structural = dupes.filter(d => d.matchType === 'structural');
    expect(structural).toHaveLength(0);
  });

  test('same-name matches have matchType: name', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/a.ts'),
        functions: [
          { name: 'formatDate', params: [{ name: 'date', type: 'Date' }], return_type: 'string', async: false, exported: true, calls: ['toISOString', 'split'], complexity: 1, lineCount: 5, nestingDepth: 0 },
        ],
      }),
      makeParsed({
        file: makeFile('src/b.ts'),
        functions: [
          { name: 'formatDate', params: [{ name: 'date', type: 'Date' }], return_type: 'string', async: false, exported: true, calls: ['toISOString', 'split'], complexity: 1, lineCount: 5, nestingDepth: 0 },
        ],
      }),
    ];

    const dupes = detectDuplicates(parsed);
    expect(dupes[0].matchType).toBe('name');
  });

  test('cross-name matches have matchType: structural', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/a.ts'),
        functions: [
          { name: 'loadConfig', params: [{ name: 'path', type: 'string' }], return_type: 'Config', async: false, exported: true, calls: ['readFileSync', 'JSON.parse', 'validate'], complexity: 3, lineCount: 12, nestingDepth: 1 },
        ],
      }),
      makeParsed({
        file: makeFile('src/b.ts'),
        functions: [
          { name: 'parseSettings', params: [{ name: 'path', type: 'string' }], return_type: 'Config', async: false, exported: true, calls: ['readFileSync', 'JSON.parse', 'validate'], complexity: 3, lineCount: 12, nestingDepth: 1 },
        ],
      }),
    ];

    const dupes = detectDuplicates(parsed);
    const structural = dupes.filter(d => d.matchType === 'structural');
    expect(structural.length).toBeGreaterThanOrEqual(1);
    expect(structural[0].matchType).toBe('structural');
  });

  test('results are sorted by similarity descending (mixed name and structural)', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/a.ts'),
        functions: [
          { name: 'low', params: [], return_type: 'void', async: false, exported: true, calls: ['a', 'b', 'c'], complexity: 1, lineCount: 5, nestingDepth: 0 },
          { name: 'loadConfig', params: [{ name: 'p', type: 'string' }], return_type: 'Config', async: false, exported: true, calls: ['readFileSync', 'JSON.parse', 'validate'], complexity: 3, lineCount: 12, nestingDepth: 1 },
        ],
      }),
      makeParsed({
        file: makeFile('src/b.ts'),
        functions: [
          { name: 'low', params: [], return_type: 'void', async: false, exported: true, calls: ['a', 'd', 'e', 'f'], complexity: 1, lineCount: 5, nestingDepth: 0 },
          { name: 'parseSettings', params: [{ name: 'p', type: 'string' }], return_type: 'Config', async: false, exported: true, calls: ['readFileSync', 'JSON.parse', 'validate'], complexity: 3, lineCount: 12, nestingDepth: 1 },
        ],
      }),
    ];

    const dupes = detectDuplicates(parsed);
    for (let i = 1; i < dupes.length; i++) {
      expect(dupes[i].similarity).toBeLessThanOrEqual(dupes[i - 1].similarity);
    }
  });

  test('pre-filter: functions with lineCount ratio > 2x are not compared cross-name', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/a.ts'),
        functions: [
          { name: 'shortFunc', params: [{ name: 'path', type: 'string' }], return_type: 'Config', async: false, exported: true, calls: ['readFileSync', 'JSON.parse', 'validate'], complexity: 3, lineCount: 5, nestingDepth: 1 },
        ],
      }),
      makeParsed({
        file: makeFile('src/b.ts'),
        functions: [
          { name: 'longFunc', params: [{ name: 'path', type: 'string' }], return_type: 'Config', async: false, exported: true, calls: ['readFileSync', 'JSON.parse', 'validate'], complexity: 3, lineCount: 50, nestingDepth: 1 },
        ],
      }),
    ];

    const dupes = detectDuplicates(parsed);
    const structural = dupes.filter(d => d.matchType === 'structural');
    expect(structural).toHaveLength(0);
  });
});

// ─── computeMultiSignalSimilarity ─────────────────────────────────────────

describe('computeMultiSignalSimilarity', () => {
  function makeSig(overrides: Partial<FunctionSignature>): FunctionSignature {
    return {
      name: 'fn',
      file: 'src/a.ts',
      paramSignature: '',
      calls: [],
      returnType: 'void',
      complexity: 1,
      lineCount: 10,
      nestingDepth: 0,
      paramCount: 0,
      ...overrides,
    };
  }

  test('identical functions return ~1.0', () => {
    const a = makeSig({ calls: ['readFile', 'JSON.parse', 'validate'], paramSignature: 'path:string', paramCount: 1, returnType: 'object', complexity: 3, lineCount: 15, nestingDepth: 1 });
    const b = makeSig({ calls: ['readFile', 'JSON.parse', 'validate'], paramSignature: 'path:string', paramCount: 1, returnType: 'object', complexity: 3, lineCount: 15, nestingDepth: 1, file: 'src/b.ts' });

    const sim = computeMultiSignalSimilarity(a, b);
    expect(sim).toBeGreaterThan(0.9);
  });

  test('completely different functions return ~0.0', () => {
    const a = makeSig({ calls: ['readFile', 'parse'], paramSignature: 'path:string', paramCount: 1, returnType: 'Buffer', complexity: 5, lineCount: 30, nestingDepth: 3 });
    const b = makeSig({ calls: ['render', 'mount', 'setState'], paramSignature: 'props:Props,ref:Ref', paramCount: 2, returnType: 'JSX.Element', complexity: 1, lineCount: 5, nestingDepth: 0, file: 'src/b.ts' });

    const sim = computeMultiSignalSimilarity(a, b);
    expect(sim).toBeLessThan(0.3);
  });

  test('same calls but different structure scores lower than identical', () => {
    const identical = makeSig({ calls: ['readFile', 'JSON.parse', 'validate'], complexity: 2, lineCount: 10, nestingDepth: 0 });
    const identicalB = makeSig({ ...identical, file: 'src/b.ts' });
    const different = makeSig({ calls: ['readFile', 'JSON.parse', 'validate'], complexity: 15, lineCount: 80, nestingDepth: 5, file: 'src/b.ts' });

    const identicalSim = computeMultiSignalSimilarity(identical, identicalB);
    const mismatchSim = computeMultiSignalSimilarity(identical, different);
    expect(mismatchSim).toBeGreaterThan(0.4);
    expect(mismatchSim).toBeLessThan(identicalSim);
  });

  test('same structure but different calls returns mid-range', () => {
    const a = makeSig({ calls: ['readFile', 'writeFile'], complexity: 3, lineCount: 15, nestingDepth: 1, paramCount: 2, paramSignature: 'a:string,b:string', returnType: 'void' });
    const b = makeSig({ calls: ['fetch', 'decode'], complexity: 3, lineCount: 15, nestingDepth: 1, paramCount: 2, paramSignature: 'a:string,b:string', returnType: 'void', file: 'src/b.ts' });

    const sim = computeMultiSignalSimilarity(a, b);
    expect(sim).toBeGreaterThan(0.35);
    expect(sim).toBeLessThan(0.75);
  });
});
