import { buildCallGraph, buildReverseCallGraph, CallGraph } from '../call-graph';
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

// ─── buildCallGraph ────────────────────────────────────────────────────────

describe('buildCallGraph', () => {
  test('maps standalone functions to their calls', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/utils.ts'),
        functions: [
          { name: 'fetchData', params: [], return_type: 'void', async: true, exported: true, calls: ['parseJSON', 'validate'], complexity: 1, lineCount: 10, nestingDepth: 0 },
          { name: 'parseJSON', params: [], return_type: 'any', async: false, exported: false, calls: [], complexity: 1, lineCount: 5, nestingDepth: 0 },
        ],
      }),
    ];

    const graph = buildCallGraph(parsed);
    expect(graph['fetchData']).toEqual(['parseJSON', 'validate']);
    expect(graph['parseJSON']).toEqual([]);
  });

  test('maps class methods with qualified names', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/service.ts'),
        classes: [{
          name: 'UserService',
          extends: null,
          implements: [],
          decorators: [],
          methods: [
            { name: 'getUser', params: [], return_type: 'User', decorators: [], access: 'public', async: false, static: false, calls: ['db.query', 'validate'], complexity: 3, lineCount: 15, nestingDepth: 1, instanceVarAccesses: [] },
            { name: 'validate', params: [], return_type: 'boolean', decorators: [], access: 'private', async: false, static: false, calls: [], complexity: 1, lineCount: 5, nestingDepth: 0, instanceVarAccesses: [] },
          ],
          properties: [],
        }],
      }),
    ];

    const graph = buildCallGraph(parsed);
    expect(graph['UserService.getUser']).toEqual(['db.query', 'validate']);
    expect(graph['UserService.validate']).toEqual([]);
  });

  test('captures module-level calls from closures/initializers', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/config.ts'),
        moduleCalls: ['dotenv.config', 'path.resolve', 'console.log'],
      }),
    ];

    const graph = buildCallGraph(parsed);
    expect(graph['__module__src/config.ts']).toEqual(['dotenv.config', 'path.resolve', 'console.log']);
  });

  test('skips module calls entry when moduleCalls is empty', () => {
    const parsed: ParsedFile[] = [
      makeParsed({ file: makeFile('src/empty.ts'), moduleCalls: [] }),
    ];

    const graph = buildCallGraph(parsed);
    expect(graph['__module__src/empty.ts']).toBeUndefined();
  });

  test('handles files with both functions and classes', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/mixed.ts'),
        functions: [
          { name: 'helper', params: [], return_type: 'void', async: false, exported: false, calls: ['Logger.info'], complexity: 1, lineCount: 3, nestingDepth: 0 },
        ],
        classes: [{
          name: 'Logger',
          extends: null,
          implements: [],
          decorators: [],
          methods: [
            { name: 'info', params: [], return_type: 'void', decorators: [], access: 'public', async: false, static: true, calls: ['console.log'], complexity: 1, lineCount: 3, nestingDepth: 0, instanceVarAccesses: [] },
          ],
          properties: [],
        }],
      }),
    ];

    const graph = buildCallGraph(parsed);
    expect(graph['helper']).toEqual(['Logger.info']);
    expect(graph['Logger.info']).toEqual(['console.log']);
  });

  test('uses null-prototype object to avoid Object.prototype collisions', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/edge.ts'),
        functions: [
          { name: 'constructor', params: [], return_type: 'void', async: false, exported: false, calls: [], complexity: 1, lineCount: 1, nestingDepth: 0 },
          { name: 'toString', params: [], return_type: 'string', async: false, exported: false, calls: [], complexity: 1, lineCount: 1, nestingDepth: 0 },
        ],
      }),
    ];

    const graph = buildCallGraph(parsed);
    expect(graph['constructor']).toEqual([]);
    expect(graph['toString']).toEqual([]);
    // Should NOT have inherited Object prototype methods
    expect(graph['hasOwnProperty']).toBeUndefined();
  });
});

// ─── buildReverseCallGraph ─────────────────────────────────────────────────

describe('buildReverseCallGraph', () => {
  test('inverts a simple call graph', () => {
    const graph: CallGraph = Object.create(null);
    graph['main'] = ['helper', 'validate'];
    graph['helper'] = ['validate'];
    graph['validate'] = [];

    const reverse = buildReverseCallGraph(graph);
    expect(reverse['validate']).toEqual(expect.arrayContaining(['main', 'helper']));
    expect(reverse['helper']).toEqual(expect.arrayContaining(['main']));
    expect(reverse['main']).toEqual([]);
  });

  test('resolves intra-class method calls (this.method)', () => {
    const graph: CallGraph = Object.create(null);
    graph['MyClass.process'] = ['validate']; // calls this.validate() — parsed as "validate"
    graph['MyClass.validate'] = [];

    const reverse = buildReverseCallGraph(graph);
    // "validate" from MyClass.process should resolve to MyClass.validate
    expect(reverse['MyClass.validate']).toContain('MyClass.process');
  });

  test('resolves instance variable calls (logger.success → Logger.success)', () => {
    const graph: CallGraph = Object.create(null);
    graph['main'] = ['logger.success'];
    graph['Logger.success'] = [];

    const reverse = buildReverseCallGraph(graph);
    // "logger.success" should resolve to "Logger.success" via method name matching
    expect(reverse['Logger.success']).toContain('main');
  });

  test('handles functions with no callers (dead code candidates)', () => {
    const graph: CallGraph = Object.create(null);
    graph['usedFunction'] = [];
    graph['unusedFunction'] = [];
    graph['main'] = ['usedFunction'];

    const reverse = buildReverseCallGraph(graph);
    expect(reverse['usedFunction']).toEqual(['main']);
    expect(reverse['unusedFunction']).toEqual([]);
  });

  test('avoids duplicate callers', () => {
    const graph: CallGraph = Object.create(null);
    graph['caller'] = ['target', 'target']; // duplicate calls

    const reverse = buildReverseCallGraph(graph);
    expect(reverse['target']?.filter(c => c === 'caller')).toHaveLength(1);
  });

  test('handles module-level callers correctly', () => {
    const graph: CallGraph = Object.create(null);
    graph['__module__src/index.ts'] = ['init', 'configure'];
    graph['init'] = [];
    graph['configure'] = [];

    const reverse = buildReverseCallGraph(graph);
    expect(reverse['init']).toContain('__module__src/index.ts');
    expect(reverse['configure']).toContain('__module__src/index.ts');
  });

  test('resolves namespace import calls: utils.foo → standalone foo', () => {
    const graph: CallGraph = Object.create(null);
    graph['foo'] = [];
    graph['caller'] = ['utils.foo'];

    const reverse = buildReverseCallGraph(graph);
    expect(reverse['foo']).toContain('caller');
  });

  test('resolves namespace import calls: prefix.bar → standalone bar', () => {
    const graph: CallGraph = Object.create(null);
    graph['bar'] = [];
    graph['main'] = ['prefix.bar'];

    const reverse = buildReverseCallGraph(graph);
    expect(reverse['bar']).toContain('main');
  });

  test('namespace import does NOT resolve to class method only', () => {
    const graph: CallGraph = Object.create(null);
    graph['SomeClass.baz'] = [];
    graph['caller'] = ['prefix.baz'];
    // 'baz' does NOT exist as standalone function

    const reverse = buildReverseCallGraph(graph);
    // Should resolve via method lookup to SomeClass.baz
    expect(reverse['SomeClass.baz']).toContain('caller');
  });

  test('backward compat: buildReverseCallGraph without parsedFiles works', () => {
    const graph: CallGraph = Object.create(null);
    graph['a'] = ['b'];
    graph['b'] = [];

    const reverse = buildReverseCallGraph(graph);
    expect(reverse['b']).toContain('a');
    expect(reverse['a']).toEqual([]);
  });
});
