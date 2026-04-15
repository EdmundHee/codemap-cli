import { generateSyntheticEdges, compileUserRules, SyntheticCallerRule } from '../synthetic-callers';
import { ParsedFile } from '../../parsers/parser.interface';
import { ScannedFile } from '../../core/scanner';

function makeFile(relative: string, language: ScannedFile['language'] = 'typescript'): ScannedFile {
  return { absolute: `/project/${relative}`, relative, language };
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

describe('generateSyntheticEdges', () => {
  test('universal rules: Python magic methods get __runtime__ caller', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/model.py', 'python'),
        classes: [{
          name: 'User',
          extends: null,
          implements: [],
          decorators: [],
          methods: [
            { name: '__init__', params: [], return_type: 'None', decorators: [], access: 'public', async: false, static: false, calls: [], complexity: 1, lineCount: 5, nestingDepth: 0, instanceVarAccesses: [] },
            { name: '__str__', params: [], return_type: 'str', decorators: [], access: 'public', async: false, static: false, calls: [], complexity: 1, lineCount: 3, nestingDepth: 0, instanceVarAccesses: [] },
            { name: 'save', params: [], return_type: 'None', decorators: [], access: 'public', async: false, static: false, calls: [], complexity: 1, lineCount: 10, nestingDepth: 0, instanceVarAccesses: [] },
          ],
          properties: [],
        }],
      }),
    ];

    const edges = generateSyntheticEdges(parsed, []);
    expect(edges).toContainEqual({ caller: '__runtime__', callee: 'User.__init__' });
    expect(edges).toContainEqual({ caller: '__runtime__', callee: 'User.__str__' });
    expect(edges.find(e => e.callee === 'User.save')).toBeUndefined();
  });

  test('universal rules: constructor gets __runtime__ caller', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/service.ts'),
        classes: [{
          name: 'Service',
          extends: null,
          implements: [],
          decorators: [],
          methods: [
            { name: 'constructor', params: [], return_type: '', decorators: [], access: 'public', async: false, static: false, calls: [], complexity: 1, lineCount: 5, nestingDepth: 0, instanceVarAccesses: [] },
          ],
          properties: [],
        }],
      }),
    ];

    const edges = generateSyntheticEdges(parsed, []);
    expect(edges).toContainEqual({ caller: '__runtime__', callee: 'Service.constructor' });
  });

  test('celery: @celery.task decorated function gets __celery__ caller', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('tasks/process.py', 'python'),
        functions: [
          { name: 'process_data', params: [], return_type: 'None', async: false, exported: true, decorators: ['@celery.task'], calls: [], complexity: 1, lineCount: 20, nestingDepth: 0 },
          { name: 'helper', params: [], return_type: 'None', async: false, exported: false, decorators: [], calls: [], complexity: 1, lineCount: 5, nestingDepth: 0 },
        ],
      }),
    ];

    const edges = generateSyntheticEdges(parsed, ['celery']);
    expect(edges).toContainEqual({ caller: '__celery__', callee: 'process_data' });
    expect(edges.find(e => e.callee === 'helper')).toBeUndefined();
  });

  test('celery: @shared_task decorated function gets __celery__ caller', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('tasks/send.py', 'python'),
        functions: [
          { name: 'send_email', params: [], return_type: 'None', async: false, exported: true, decorators: ['@shared_task'], calls: [], complexity: 1, lineCount: 15, nestingDepth: 0 },
        ],
      }),
    ];

    const edges = generateSyntheticEdges(parsed, ['celery']);
    expect(edges).toContainEqual({ caller: '__celery__', callee: 'send_email' });
  });

  test('pytest: @pytest.fixture gets __pytest__ caller', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('tests/conftest.py', 'python'),
        functions: [
          { name: 'db_session', params: [], return_type: 'Session', async: false, exported: true, decorators: ['@pytest.fixture'], calls: [], complexity: 1, lineCount: 10, nestingDepth: 0 },
        ],
      }),
    ];

    const edges = generateSyntheticEdges(parsed, ['pytest']);
    expect(edges).toContainEqual({ caller: '__pytest__', callee: 'db_session' });
  });

  test('pytest: test_ functions get __pytest__ caller', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('tests/test_api.py', 'python'),
        functions: [
          { name: 'test_login', params: [], return_type: 'None', async: false, exported: true, decorators: [], calls: [], complexity: 1, lineCount: 10, nestingDepth: 0 },
          { name: 'helper_func', params: [], return_type: 'None', async: false, exported: false, decorators: [], calls: [], complexity: 1, lineCount: 5, nestingDepth: 0 },
        ],
      }),
    ];

    const edges = generateSyntheticEdges(parsed, ['pytest']);
    expect(edges).toContainEqual({ caller: '__pytest__', callee: 'test_login' });
    expect(edges.find(e => e.callee === 'helper_func')).toBeUndefined();
  });

  test('pytest: conftest.py functions get __pytest__ caller', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('tests/conftest.py', 'python'),
        functions: [
          { name: 'app_fixture', params: [], return_type: 'Flask', async: false, exported: true, decorators: [], calls: [], complexity: 1, lineCount: 8, nestingDepth: 0 },
        ],
      }),
    ];

    const edges = generateSyntheticEdges(parsed, ['pytest']);
    expect(edges).toContainEqual({ caller: '__pytest__', callee: 'app_fixture' });
  });

  test('fastapi: @app.get decorated function gets __fastapi__ caller', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('api/routes.py', 'python'),
        functions: [
          { name: 'list_users', params: [], return_type: 'list', async: true, exported: true, decorators: ['@app.get("/users")'], calls: [], complexity: 1, lineCount: 15, nestingDepth: 0 },
        ],
      }),
    ];

    const edges = generateSyntheticEdges(parsed, ['fastapi']);
    expect(edges).toContainEqual({ caller: '__fastapi__', callee: 'list_users' });
  });

  test('fastapi: @router.post decorated function gets __fastapi__ caller', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('api/users.py', 'python'),
        functions: [
          { name: 'create_user', params: [], return_type: 'User', async: true, exported: true, decorators: ['@router.post("/users")'], calls: [], complexity: 1, lineCount: 20, nestingDepth: 0 },
        ],
      }),
    ];

    const edges = generateSyntheticEdges(parsed, ['fastapi']);
    expect(edges).toContainEqual({ caller: '__fastapi__', callee: 'create_user' });
  });

  test('nestjs: @Get decorated method gets __nestjs__ caller', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/users.controller.ts'),
        classes: [{
          name: 'UsersController',
          extends: null,
          implements: [],
          decorators: ['@Controller'],
          methods: [
            { name: 'findAll', params: [], return_type: 'User[]', decorators: ['@Get'], access: 'public', async: false, static: false, calls: [], complexity: 1, lineCount: 10, nestingDepth: 0, instanceVarAccesses: [] },
          ],
          properties: [],
        }],
      }),
    ];

    const edges = generateSyntheticEdges(parsed, ['nestjs']);
    expect(edges).toContainEqual({ caller: '__nestjs__', callee: 'UsersController.findAll' });
  });

  test('no edges for undetected framework', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('tasks/process.py', 'python'),
        functions: [
          { name: 'process_data', params: [], return_type: 'None', async: false, exported: true, decorators: ['@celery.task'], calls: [], complexity: 1, lineCount: 20, nestingDepth: 0 },
        ],
      }),
    ];

    // celery not in frameworks list
    const edges = generateSyntheticEdges(parsed, ['fastapi']);
    expect(edges.find(e => e.callee === 'process_data')).toBeUndefined();
  });

  test('nuxt: composables directory functions get __nuxt__ caller', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('composables/useAuth.ts'),
        functions: [
          { name: 'useAuth', params: [], return_type: 'AuthState', async: false, exported: true, decorators: [], calls: [], complexity: 1, lineCount: 30, nestingDepth: 0 },
        ],
      }),
    ];

    const edges = generateSyntheticEdges(parsed, ['nuxt']);
    expect(edges).toContainEqual({ caller: '__nuxt__', callee: 'useAuth' });
  });

  test('nuxt: server/api functions get __nuxt__ caller', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('server/api/users.get.ts'),
        functions: [
          { name: 'handler', params: [], return_type: 'Promise', async: true, exported: true, decorators: [], calls: [], complexity: 1, lineCount: 15, nestingDepth: 0 },
        ],
      }),
    ];

    const edges = generateSyntheticEdges(parsed, ['nuxt']);
    expect(edges).toContainEqual({ caller: '__nuxt__', callee: 'handler' });
  });

  test('vue: lifecycle methods get __vue__ caller', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/App.vue'),
        classes: [{
          name: 'App',
          extends: null,
          implements: [],
          decorators: [],
          methods: [
            { name: 'mounted', params: [], return_type: 'void', decorators: [], access: 'public', async: false, static: false, calls: [], complexity: 1, lineCount: 5, nestingDepth: 0, instanceVarAccesses: [] },
          ],
          properties: [],
        }],
      }),
    ];

    const edges = generateSyntheticEdges(parsed, ['vue']);
    expect(edges).toContainEqual({ caller: '__vue__', callee: 'App.mounted' });
  });

  test('react: hooks (use*) get __react__ caller', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/hooks/useAuth.ts'),
        functions: [
          { name: 'useAuth', params: [], return_type: 'AuthState', async: false, exported: true, decorators: [], calls: [], complexity: 1, lineCount: 20, nestingDepth: 0 },
        ],
      }),
    ];

    const edges = generateSyntheticEdges(parsed, ['react']);
    expect(edges).toContainEqual({ caller: '__react__', callee: 'useAuth' });
  });

  test('deduplicates edges', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('tests/conftest.py', 'python'),
        functions: [
          // Matches both pytest name_pattern (test_) and file_pattern (conftest.py)
          { name: 'test_helper', params: [], return_type: 'None', async: false, exported: true, decorators: ['@pytest.fixture'], calls: [], complexity: 1, lineCount: 5, nestingDepth: 0 },
        ],
      }),
    ];

    const edges = generateSyntheticEdges(parsed, ['pytest']);
    const matching = edges.filter(e => e.callee === 'test_helper' && e.caller === '__pytest__');
    expect(matching).toHaveLength(1);
  });

  test('multiple frameworks apply independently', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('app/tasks.py', 'python'),
        functions: [
          { name: 'process', params: [], return_type: 'None', async: false, exported: true, decorators: ['@celery.task'], calls: [], complexity: 1, lineCount: 10, nestingDepth: 0 },
          { name: 'list_items', params: [], return_type: 'list', async: true, exported: true, decorators: ['@app.get("/items")'], calls: [], complexity: 1, lineCount: 15, nestingDepth: 0 },
        ],
      }),
    ];

    const edges = generateSyntheticEdges(parsed, ['celery', 'fastapi']);
    expect(edges).toContainEqual({ caller: '__celery__', callee: 'process' });
    expect(edges).toContainEqual({ caller: '__fastapi__', callee: 'list_items' });
  });
});

describe('compileUserRules', () => {
  test('compiles user config into SyntheticCallerRule objects', () => {
    const rules = compileUserRules([
      {
        caller: '__my_framework__',
        decorator_patterns: ['^@custom\\.handler'],
        name_patterns: ['^on_'],
        file_patterns: ['**/handlers/**'],
      },
    ]);

    expect(rules).toHaveLength(1);
    expect(rules[0].caller).toBe('__my_framework__');
    expect(rules[0].framework).toBeNull();
    expect(rules[0].decoratorPatterns![0]).toBeInstanceOf(RegExp);
    expect(rules[0].namePatterns![0]).toBeInstanceOf(RegExp);
    expect(rules[0].filePatterns).toEqual(['**/handlers/**']);
  });

  test('returns empty array for undefined config', () => {
    expect(compileUserRules(undefined)).toEqual([]);
    expect(compileUserRules([])).toEqual([]);
  });

  test('user rules are applied by generateSyntheticEdges', () => {
    const parsed: ParsedFile[] = [
      makeParsed({
        file: makeFile('src/handlers/webhook.py', 'python'),
        functions: [
          { name: 'on_event', params: [], return_type: 'None', async: false, exported: true, decorators: [], calls: [], complexity: 1, lineCount: 10, nestingDepth: 0 },
        ],
      }),
    ];

    const userRules: SyntheticCallerRule[] = [{
      framework: null,
      caller: '__webhook__',
      namePatterns: [/^on_/],
    }];

    const edges = generateSyntheticEdges(parsed, [], userRules);
    expect(edges).toContainEqual({ caller: '__webhook__', callee: 'on_event' });
  });
});
