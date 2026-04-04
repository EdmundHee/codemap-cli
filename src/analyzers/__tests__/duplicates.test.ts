import { detectDuplicates, DuplicateGroup } from '../duplicates';
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
