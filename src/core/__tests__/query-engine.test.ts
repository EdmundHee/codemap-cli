import {
  getOverview,
  getModule,
  search,
  getCallers,
  getCalls,
  getFunction,
  getClass,
  getFile,
  getType,
  getRoutes,
  getModels,
  getMiddleware,
  getFrameworkData,
} from '../query-engine';
import { CodemapData } from '../../output/json-generator';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeCodemapData(overrides: Partial<CodemapData> = {}): CodemapData {
  return {
    version: '1.0.0',
    generated_at: new Date().toISOString(),
    project: { name: 'test', root: '/test', languages: ['typescript'], frameworks: [], entry_points: ['src/index.ts'] },
    files: {
      'src/index.ts': { imports: [], exports: [{ name: 'main', kind: 'function' }], hash: 'h1' } as any,
      'src/utils/helper.ts': { imports: [], exports: [{ name: 'helper', kind: 'function' }], hash: 'h2' } as any,
      'src/models/user.ts': { imports: [], exports: [{ name: 'User', kind: 'class' }], hash: 'h3' } as any,
    },
    classes: {
      'UserService': { file: 'src/models/user.ts', extends: null, implements: [], decorators: [], methods: [{ name: 'getUser', params: [{ name: 'id', type: 'string' }], return_type: 'User', calls: ['db.query'], complexity: 2 }, { name: 'deleteUser', params: [{ name: 'id', type: 'string' }], return_type: 'void', calls: ['db.delete'], complexity: 1 }], properties: [] } as any,
    },
    functions: {
      'main': { file: 'src/index.ts', params: [], return_type: 'void', calls: ['UserService.getUser'], exported: true, complexity: 1 } as any,
      'helper': { file: 'src/utils/helper.ts', params: [{ name: 'x', type: 'number' }], return_type: 'number', calls: [], exported: true, complexity: 1 } as any,
    },
    types: {
      'UserDTO': { file: 'src/models/user.ts', kind: 'interface', extends: [], properties: [{ name: 'id', type: 'string' }], exported: true } as any,
    },
    call_graph: {
      'main': ['UserService.getUser'],
      'UserService.getUser': ['db.query'],
      'UserService.deleteUser': ['db.delete'],
      'helper': [],
    },
    import_graph: {
      'src/index.ts': ['src/models/user.ts'],
      'src/models/user.ts': ['src/utils/helper.ts'],
    },
    config_dependencies: { env_vars: {} },
    dependencies: { packages: {}, source: '' },
    routes: [],
    models: {},
    middleware: {},
    health: { score: 80, computed_at: '', metrics: {} as any, hotspots: [] },
    module_metrics: [],
    ...overrides,
  };
}

// ─── getOverview ──────────────────────────────────────────────────────────

describe('getOverview', () => {
  test('returns project summary with correct totals', () => {
    const data = makeCodemapData();
    const overview = getOverview(data);

    expect(overview.project).toBe('test');
    expect(overview.totals.files).toBe(3);
    expect(overview.totals.classes).toBe(1);
    expect(overview.totals.functions).toBe(2);
    expect(overview.totals.types).toBe(1);
  });

  test('groups files by module directory', () => {
    const data = makeCodemapData();
    const overview = getOverview(data);

    expect(overview.modules['src']).toBeDefined();
    expect(overview.modules['src/utils']).toBeDefined();
    expect(overview.modules['src/models']).toBeDefined();
  });

  test('includes framework_data when routes/models exist', () => {
    const data = makeCodemapData({
      routes: [{ path: '/users', method: 'GET', handler: 'getUsers', file: 'src/routes.ts', framework: 'fastapi' }] as any,
      models: { User: { kind: 'pydantic_model', file: 'src/models.py', framework: 'fastapi' } } as any,
    });

    const overview = getOverview(data);
    expect(overview.framework_data).toBeDefined();
    expect(overview.framework_data.routes).toBe(1);
    expect(overview.framework_data.models).toBe(1);
  });
});

// ─── getModule ────────────────────────────────────────────────────────────

describe('getModule', () => {
  test('returns module contents for a valid directory', () => {
    const data = makeCodemapData();
    const mod = getModule(data, 'src/models');

    expect(mod).not.toBeNull();
    expect(mod.directory).toBe('src/models');
    expect(mod.files).toContain('src/models/user.ts');
    expect(mod.classes.length).toBeGreaterThanOrEqual(1);
  });

  test('returns null for non-existent directory', () => {
    const data = makeCodemapData();
    expect(getModule(data, 'src/nonexistent')).toBeNull();
  });

  test('includes sub-directory files', () => {
    const data = makeCodemapData();
    const mod = getModule(data, 'src');
    expect(mod).not.toBeNull();
    // Should include all files under src/
    expect(mod.files.length).toBe(3);
  });
});

// ─── search ───────────────────────────────────────────────────────────────

describe('search', () => {
  test('finds functions by name', () => {
    const data = makeCodemapData();
    const results = search(data, 'helper');

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some(r => r.type === 'function' && r.name === 'helper')).toBe(true);
  });

  test('finds classes by name', () => {
    const data = makeCodemapData();
    const results = search(data, 'UserService');

    expect(results.some(r => r.type === 'class' && r.name === 'UserService')).toBe(true);
  });

  test('finds methods by name', () => {
    const data = makeCodemapData();
    const results = search(data, 'getUser');

    expect(results.some(r => r.type === 'method' && r.name.includes('getUser'))).toBe(true);
  });

  test('finds files by path', () => {
    const data = makeCodemapData();
    const results = search(data, 'helper.ts');

    expect(results.some(r => r.type === 'file' && r.name.includes('helper.ts'))).toBe(true);
  });

  test('finds types by name', () => {
    const data = makeCodemapData();
    const results = search(data, 'UserDTO');

    expect(results.some(r => r.type === 'type' && r.name === 'UserDTO')).toBe(true);
  });

  test('is case-insensitive', () => {
    const data = makeCodemapData();
    const results = search(data, 'userservice');

    expect(results.some(r => r.name === 'UserService')).toBe(true);
  });

  test('returns empty for unmatched term', () => {
    const data = makeCodemapData();
    expect(search(data, 'zzz_nonexistent_zzz')).toEqual([]);
  });

  test('searches routes when available', () => {
    const data = makeCodemapData({
      routes: [{ path: '/api/users', method: 'GET', handler: 'listUsers', file: 'src/routes.ts', framework: 'fastapi' }] as any,
    });

    const results = search(data, 'users');
    expect(results.some(r => r.data?.handler === 'listUsers')).toBe(true);
  });

  test('searches models when available', () => {
    const data = makeCodemapData({
      models: { BlogPost: { kind: 'django_model', file: 'blog/models.py', framework: 'django' } } as any,
    });

    const results = search(data, 'BlogPost');
    expect(results.some(r => r.name.includes('BlogPost'))).toBe(true);
  });
});

// ─── getCallers / getCalls ────────────────────────────────────────────────

describe('getCallers', () => {
  test('returns callers of a function', () => {
    const data = makeCodemapData();
    const result = getCallers(data, 'UserService.getUser');

    expect(result.function).toBe('UserService.getUser');
    expect(result.callers).toContain('main');
  });

  test('returns empty callers for uncalled functions', () => {
    const data = makeCodemapData();
    const result = getCallers(data, 'helper');

    expect(result.callers).toEqual([]);
  });
});

describe('getCalls', () => {
  test('returns calls made by a function', () => {
    const data = makeCodemapData();
    const result = getCalls(data, 'main');

    expect(result.calls).toContain('UserService.getUser');
  });

  test('returns empty for functions not in call graph', () => {
    const data = makeCodemapData();
    const result = getCalls(data, 'nonexistent');

    expect(result.calls).toEqual([]);
  });
});

// ─── getFunction ──────────────────────────────────────────────────────────

describe('getFunction', () => {
  test('finds standalone function by name', () => {
    const data = makeCodemapData();
    const result = getFunction(data, 'helper');

    expect(result).not.toBeNull();
    expect(result!.type).toBe('function');
    expect(result!.name).toBe('helper');
  });

  test('finds class method by qualified name', () => {
    const data = makeCodemapData();
    const result = getFunction(data, 'UserService.getUser');

    expect(result).not.toBeNull();
    expect(result!.type).toBe('method');
  });

  test('finds method by unqualified name', () => {
    const data = makeCodemapData();
    const result = getFunction(data, 'deleteUser');

    expect(result).not.toBeNull();
    expect(result!.name).toContain('deleteUser');
  });

  test('returns null for non-existent function', () => {
    const data = makeCodemapData();
    expect(getFunction(data, 'doesNotExist')).toBeNull();
  });
});

// ─── getClass ─────────────────────────────────────────────────────────────

describe('getClass', () => {
  test('finds class by name', () => {
    const data = makeCodemapData();
    const result = getClass(data, 'UserService');

    expect(result).not.toBeNull();
    expect(result!.type).toBe('class');
    expect(result!.name).toBe('UserService');
  });

  test('returns null for non-existent class', () => {
    const data = makeCodemapData();
    expect(getClass(data, 'FakeClass')).toBeNull();
  });
});

// ─── getFile ──────────────────────────────────────────────────────────────

describe('getFile', () => {
  test('finds file by exact path', () => {
    const data = makeCodemapData();
    const result = getFile(data, 'src/index.ts');

    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(false);
    expect((result as any).type).toBe('file');
  });

  test('finds files by partial path match', () => {
    const data = makeCodemapData();
    const result = getFile(data, 'user');

    // Should match src/models/user.ts
    expect(result).not.toBeNull();
  });

  test('returns null for unmatched path', () => {
    const data = makeCodemapData();
    expect(getFile(data, 'zzz_nothing_zzz')).toBeNull();
  });

  test('returns multiple results for ambiguous partial match', () => {
    const data = makeCodemapData({
      files: {
        'src/utils/a.ts': { imports: [], exports: [], hash: 'h1' } as any,
        'src/utils/b.ts': { imports: [], exports: [], hash: 'h2' } as any,
      },
    });

    const result = getFile(data, 'utils');
    expect(Array.isArray(result)).toBe(true);
    expect((result as any[]).length).toBe(2);
  });
});

// ─── getType ──────────────────────────────────────────────────────────────

describe('getType', () => {
  test('finds type by name', () => {
    const data = makeCodemapData();
    const result = getType(data, 'UserDTO');

    expect(result).not.toBeNull();
    expect(result!.type).toBe('type');
    expect(result!.name).toBe('UserDTO');
  });

  test('returns null for non-existent type', () => {
    const data = makeCodemapData();
    expect(getType(data, 'FakeType')).toBeNull();
  });
});

// ─── Framework queries ────────────────────────────────────────────────────

describe('getRoutes', () => {
  const dataWithRoutes = makeCodemapData({
    routes: [
      { path: '/api/users', method: 'GET', handler: 'listUsers', file: 'routes.ts', framework: 'fastapi' },
      { path: '/api/users', method: 'POST', handler: 'createUser', file: 'routes.ts', framework: 'fastapi' },
      { path: '/admin', method: 'GET', handler: 'adminPanel', file: 'admin.ts', framework: 'django' },
    ] as any,
  });

  test('returns all routes without filter', () => {
    expect(getRoutes(dataWithRoutes)).toHaveLength(3);
  });

  test('filters by HTTP method', () => {
    const results = getRoutes(dataWithRoutes, { method: 'GET' });
    expect(results).toHaveLength(2);
  });

  test('filters by path', () => {
    const results = getRoutes(dataWithRoutes, { path: 'admin' });
    expect(results).toHaveLength(1);
    expect(results[0].handler).toBe('adminPanel');
  });

  test('filters by framework', () => {
    const results = getRoutes(dataWithRoutes, { framework: 'django' });
    expect(results).toHaveLength(1);
  });
});

describe('getModels', () => {
  const dataWithModels = makeCodemapData({
    models: {
      User: { kind: 'django_model', file: 'models.py', framework: 'django', fields: [] },
      Config: { kind: 'pydantic_model', file: 'config.py', framework: 'fastapi', fields: [] },
    } as any,
  });

  test('returns all models without filter', () => {
    expect(getModels(dataWithModels)).toHaveLength(2);
  });

  test('filters by framework', () => {
    const results = getModels(dataWithModels, { framework: 'django' });
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('User');
  });

  test('filters by kind', () => {
    const results = getModels(dataWithModels, { kind: 'pydantic_model' });
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Config');
  });
});

describe('getMiddleware', () => {
  const dataWithMw = makeCodemapData({
    middleware: {
      AuthMiddleware: { type: 'class_middleware', framework: 'django', methods: ['process_request'] },
      CORSMiddleware: { type: 'function_middleware', framework: 'fastapi', methods: [] },
    } as any,
  });

  test('returns all middleware without filter', () => {
    expect(getMiddleware(dataWithMw)).toHaveLength(2);
  });

  test('filters by framework', () => {
    const results = getMiddleware(dataWithMw, { framework: 'fastapi' });
    expect(results).toHaveLength(1);
    expect(results[0].key).toBe('CORSMiddleware');
  });
});

describe('getFrameworkData', () => {
  test('returns comprehensive framework summary', () => {
    const data = makeCodemapData({
      routes: [{ path: '/api', method: 'GET', handler: 'index', file: 'a.ts', framework: 'django' }] as any,
      models: { User: { kind: 'django_model', file: 'b.ts', framework: 'django' } } as any,
    });
    (data as any).signals = [{ signal: 'post_save', receiver: 'fn', framework: 'django' }];
    (data as any).admin = [{ admin_class: 'UserAdmin' }];

    const result = getFrameworkData(data, 'django');
    expect(result.framework).toBe('django');
    expect(result.routes).toHaveLength(1);
    expect(result.models).toHaveLength(1);
    expect(result.signals).toHaveLength(1);
    expect(result.admin).toHaveLength(1);
  });

  test('returns empty arrays for non-matching framework', () => {
    const data = makeCodemapData();
    const result = getFrameworkData(data, 'nonexistent');
    expect(result.routes).toEqual([]);
    expect(result.models).toEqual([]);
    expect(result.middleware).toEqual([]);
  });
});
