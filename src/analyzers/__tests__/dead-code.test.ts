import { detectDeadCode, DeadCodeData } from '../dead-code';
import { ReverseCallGraph } from '../call-graph';
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

describe('detectDeadCode', () => {
  test('identifies functions with no callers as dead', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/utils.ts'),
        functions: [
          { name: 'usedFunc', params: [], return_type: 'void', async: false, exported: false, calls: [], complexity: 1, lineCount: 10, nestingDepth: 0 },
          { name: 'deadFunc', params: [], return_type: 'void', async: false, exported: false, calls: [], complexity: 1, lineCount: 20, nestingDepth: 0 },
        ],
      }),
    ];

    const reverseGraph: ReverseCallGraph = Object.create(null);
    reverseGraph['usedFunc'] = ['main'];
    reverseGraph['deadFunc'] = [];

    const result = detectDeadCode(parsed, reverseGraph, []);
    expect(result.deadFunctions).toHaveLength(1);
    expect(result.deadFunctions[0].name).toBe('deadFunc');
    expect(result.deadFunctions[0].lineCount).toBe(20);
    expect(result.totalDeadLines).toBe(20);
  });

  test('exempts lifecycle hooks from dead code detection', () => {
    const lifecycleHooks = ['constructor', 'init', 'setup', 'render', 'ngOnInit', 'mounted', '__init__', 'main'];

    for (const hookName of lifecycleHooks) {
      const parsed: ParsedFile[] = [
        makeParsed({
          file: makeFile('src/component.ts'),
          functions: [
            { name: hookName, params: [], return_type: 'void', async: false, exported: false, calls: [], complexity: 1, lineCount: 5, nestingDepth: 0 },
          ],
        }),
      ];

      const reverseGraph: ReverseCallGraph = Object.create(null);
      reverseGraph[hookName] = [];

      const result = detectDeadCode(parsed, reverseGraph, []);
      expect(result.deadFunctions.find(f => f.name === hookName)).toBeUndefined();
    }
  });

  test('exempts functions in entry point files', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/index.ts'),
        functions: [
          { name: 'bootstrap', params: [], return_type: 'void', async: false, exported: true, calls: [], complexity: 1, lineCount: 30, nestingDepth: 0 },
        ],
      }),
    ];

    const reverseGraph: ReverseCallGraph = Object.create(null);
    reverseGraph['bootstrap'] = [];

    const result = detectDeadCode(parsed, reverseGraph, ['src/index.ts']);
    expect(result.deadFunctions).toHaveLength(0);
  });

  test('exempts methods with framework decorators', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/controller.ts'),
        classes: [{
          name: 'UserController',
          extends: null,
          implements: [],
          decorators: [],
          methods: [
            { name: 'getUsers', params: [], return_type: 'User[]', decorators: ['@Get("/users")'], access: 'public', async: false, static: false, calls: [], complexity: 1, lineCount: 10, nestingDepth: 0, instanceVarAccesses: [] },
          ],
          properties: [],
        }],
      }),
    ];

    const reverseGraph: ReverseCallGraph = Object.create(null);
    reverseGraph['UserController.getUsers'] = [];

    const result = detectDeadCode(parsed, reverseGraph, []);
    expect(result.deadFunctions).toHaveLength(0);
  });

  test('detects dead class methods', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/service.ts'),
        classes: [{
          name: 'Service',
          extends: null,
          implements: [],
          decorators: [],
          methods: [
            { name: 'deadMethod', params: [], return_type: 'void', decorators: [], access: 'public', async: false, static: false, calls: [], complexity: 1, lineCount: 15, nestingDepth: 0, instanceVarAccesses: [] },
          ],
          properties: [],
        }],
      }),
    ];

    const reverseGraph: ReverseCallGraph = Object.create(null);
    reverseGraph['Service.deadMethod'] = [];

    const result = detectDeadCode(parsed, reverseGraph, []);
    expect(result.deadFunctions).toHaveLength(1);
    expect(result.deadFunctions[0].name).toBe('Service.deadMethod');
    expect(result.deadFunctions[0].type).toBe('method');
    expect(result.deadFunctions[0].className).toBe('Service');
  });

  test('calculates correct dead code percentage', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/app.ts'),
        functions: [
          { name: 'alive1', params: [], return_type: 'void', async: false, exported: false, calls: [], complexity: 1, lineCount: 5, nestingDepth: 0 },
          { name: 'alive2', params: [], return_type: 'void', async: false, exported: false, calls: [], complexity: 1, lineCount: 5, nestingDepth: 0 },
          { name: 'dead1', params: [], return_type: 'void', async: false, exported: false, calls: [], complexity: 1, lineCount: 10, nestingDepth: 0 },
          { name: 'dead2', params: [], return_type: 'void', async: false, exported: false, calls: [], complexity: 1, lineCount: 10, nestingDepth: 0 },
        ],
      }),
    ];

    const reverseGraph: ReverseCallGraph = Object.create(null);
    reverseGraph['alive1'] = ['main'];
    reverseGraph['alive2'] = ['main'];
    reverseGraph['dead1'] = [];
    reverseGraph['dead2'] = [];

    const result = detectDeadCode(parsed, reverseGraph, []);
    expect(result.deadFunctions).toHaveLength(2);
    expect(result.totalFunctions).toBe(4);
    expect(result.deadCodePercentage).toBe(50);
    expect(result.totalDeadLines).toBe(20);
  });

  test('marks exported dead functions correctly', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/api.ts'),
        functions: [
          { name: 'exportedDead', params: [], return_type: 'void', async: false, exported: true, calls: [], complexity: 1, lineCount: 10, nestingDepth: 0 },
        ],
      }),
    ];

    const reverseGraph: ReverseCallGraph = Object.create(null);
    reverseGraph['exportedDead'] = [];

    const result = detectDeadCode(parsed, reverseGraph, []);
    expect(result.deadFunctions[0].isExported).toBe(true);
  });

  test('handles empty parsed files', () => {
    const result = detectDeadCode([], Object.create(null), []);
    expect(result.deadFunctions).toHaveLength(0);
    expect(result.totalFunctions).toBe(0);
    expect(result.deadCodePercentage).toBe(0);
  });

  test('exempts constructors in classes', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/model.ts'),
        classes: [{
          name: 'Model',
          extends: null,
          implements: [],
          decorators: [],
          methods: [
            { name: 'constructor', params: [], return_type: '', decorators: [], access: 'public', async: false, static: false, calls: [], complexity: 1, lineCount: 5, nestingDepth: 0, instanceVarAccesses: [] },
            { name: '__init__', params: [], return_type: '', decorators: [], access: 'public', async: false, static: false, calls: [], complexity: 1, lineCount: 5, nestingDepth: 0, instanceVarAccesses: [] },
          ],
          properties: [],
        }],
      }),
    ];

    const reverseGraph: ReverseCallGraph = Object.create(null);
    reverseGraph['Model.constructor'] = [];
    reverseGraph['Model.__init__'] = [];

    const result = detectDeadCode(parsed, reverseGraph, []);
    expect(result.deadFunctions).toHaveLength(0);
  });
});
