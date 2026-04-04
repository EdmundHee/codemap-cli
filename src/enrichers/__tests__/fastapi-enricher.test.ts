import { FastAPIEnricher } from '../fastapi-enricher';
import { CodemapData } from '../../output/json-generator';
import { ParsedFile, ClassInfo } from '../../parsers/parser.interface';
import { ScannedFile } from '../../core/scanner';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeScannedFile(relative: string): ScannedFile {
  return { absolute: `/project/${relative}`, relative, language: 'python' };
}

function makeParsedFile(overrides: Partial<ParsedFile> & { file: ScannedFile }): ParsedFile {
  return {
    hash: 'abc123',
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

function makeEmptyCodemapData(): CodemapData {
  return {
    version: '1.0.0',
    generated_at: new Date().toISOString(),
    project: { name: 'test', root: '/test', languages: ['python'], frameworks: ['fastapi'], entry_points: [] },
    files: {},
    classes: {},
    functions: {},
    types: {},
    call_graph: {},
    import_graph: {},
    config_dependencies: { env_vars: {} },
    dependencies: { packages: {}, source: '' },
    routes: [],
    models: {},
    middleware: {},
    health: { score: 100, computed_at: '', metrics: {} as any, hotspots: [] },
    module_metrics: [],
  };
}

function makeClass(overrides: Partial<ClassInfo>): ClassInfo {
  return {
    name: 'TestClass',
    extends: null,
    implements: [],
    decorators: [],
    methods: [],
    properties: [],
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('FastAPIEnricher', () => {
  const enricher = new FastAPIEnricher();

  test('canEnrich returns true for fastapi', () => {
    expect(enricher.canEnrich(['fastapi'])).toBe(true);
    expect(enricher.canEnrich(['fastapi', 'pydantic'])).toBe(true);
  });

  test('canEnrich returns false for non-fastapi', () => {
    expect(enricher.canEnrich(['django'])).toBe(false);
    expect(enricher.canEnrich([])).toBe(false);
  });

  test('extracts route from @app.get decorator', async () => {
    const data = makeEmptyCodemapData();
    const parsed: ParsedFile[] = [
      makeParsedFile({
        file: makeScannedFile('app/routes.py'),
        functions: [
          {
            name: 'get_users',
            params: [
              { name: 'skip', type: 'int = 0' },
              { name: 'limit', type: 'int = 10' },
            ],
            return_type: 'List[User]',
            async: true,
            exported: true,
            calls: ['db.query'],
            complexity: 2,
            lineCount: 5,
            nestingDepth: 1,
            decorators: ['@app.get("/api/users", response_model=List[User], tags=["users"])'],
          } as any,
        ],
      }),
    ];

    await enricher.enrich(data, parsed, { root: '/test' } as any);

    expect(data.routes).toHaveLength(1);
    expect(data.routes[0].method).toBe('GET');
    expect(data.routes[0].path).toBe('/api/users');
    expect(data.routes[0].handler).toBe('get_users');
    expect(data.routes[0].response_model).toBe('List[User]');
    expect(data.routes[0].tags).toContain('users');
    expect(data.routes[0].framework).toBe('fastapi');
  });

  test('extracts route from @router.post decorator', async () => {
    const data = makeEmptyCodemapData();
    const parsed: ParsedFile[] = [
      makeParsedFile({
        file: makeScannedFile('app/routes.py'),
        functions: [
          {
            name: 'create_user',
            params: [
              { name: 'user', type: 'UserCreate' },
              { name: 'db', type: 'Depends(get_db)' },
            ],
            return_type: 'User',
            async: true,
            exported: true,
            calls: [],
            complexity: 1,
            lineCount: 3,
            nestingDepth: 0,
            decorators: ['@router.post("/users", status_code=201)'],
          } as any,
        ],
      }),
    ];

    await enricher.enrich(data, parsed, { root: '/test' } as any);

    expect(data.routes).toHaveLength(1);
    expect(data.routes[0].method).toBe('POST');
    expect(data.routes[0].path).toBe('/users');
    expect(data.routes[0].status_codes).toEqual([201]);
    expect(data.routes[0].dependencies).toContain('get_db');
  });

  test('extracts Pydantic models with fields', async () => {
    const data = makeEmptyCodemapData();
    const parsed: ParsedFile[] = [
      makeParsedFile({
        file: makeScannedFile('app/schemas.py'),
        classes: [
          makeClass({
            name: 'UserCreate',
            extends: 'BaseModel',
            properties: [
              { name: 'name', type: 'str', access: 'public' },
              { name: 'email', type: 'str', access: 'public' },
              { name: 'age', type: 'Optional[int] = None', access: 'public' },
              { name: 'role', type: 'UserRole', access: 'public' },
            ],
          }),
        ],
      }),
    ];

    await enricher.enrich(data, parsed, { root: '/test' } as any);

    expect(data.models).toHaveProperty('UserCreate');
    const model = data.models['UserCreate'];
    expect(model.kind).toBe('pydantic_model');
    expect(model.fields).toHaveLength(4);
    expect(model.fields[0].name).toBe('name');
    expect(model.fields[0].required).toBe(true);
    expect(model.fields[2].required).toBe(false); // Optional
    expect(model.fields[3].related_model).toBe('UserRole');
    expect(model.relationships).toContain('UserRole');
  });

  test('extracts Pydantic Settings', async () => {
    const data = makeEmptyCodemapData();
    const parsed: ParsedFile[] = [
      makeParsedFile({
        file: makeScannedFile('app/config.py'),
        classes: [
          makeClass({
            name: 'Settings',
            extends: 'BaseSettings',
            properties: [
              { name: 'database_url', type: 'str', access: 'public' },
              { name: 'debug', type: 'bool = False', access: 'public' },
            ],
          }),
        ],
      }),
    ];

    await enricher.enrich(data, parsed, { root: '/test' } as any);

    expect(data.models).toHaveProperty('Settings');
    expect(data.models['Settings'].kind).toBe('pydantic_settings');
  });

  test('extracts middleware classes', async () => {
    const data = makeEmptyCodemapData();
    const parsed: ParsedFile[] = [
      makeParsedFile({
        file: makeScannedFile('app/middleware.py'),
        classes: [
          makeClass({
            name: 'LoggingMiddleware',
            extends: 'BaseHTTPMiddleware',
            methods: [
              {
                name: 'dispatch',
                params: [{ name: 'self', type: '' }, { name: 'request', type: 'Request' }],
                return_type: 'Response',
                decorators: [],
                access: 'public',
                async: true,
                static: false,
                calls: ['call_next'],
                complexity: 2,
                lineCount: 10,
                nestingDepth: 1,
                instanceVarAccesses: [],
              },
            ],
          }),
        ],
      }),
    ];

    await enricher.enrich(data, parsed, { root: '/test' } as any);

    expect(data.middleware).toHaveProperty('LoggingMiddleware');
    expect(data.middleware['LoggingMiddleware'].type).toBe('class_middleware');
  });

  test('extracts WebSocket endpoints', async () => {
    const data = makeEmptyCodemapData();
    const parsed: ParsedFile[] = [
      makeParsedFile({
        file: makeScannedFile('app/ws.py'),
        functions: [
          {
            name: 'websocket_endpoint',
            params: [{ name: 'websocket', type: 'WebSocket' }],
            return_type: '',
            async: true,
            exported: true,
            calls: ['websocket.accept'],
            complexity: 3,
            lineCount: 15,
            nestingDepth: 2,
            decorators: ['@app.websocket("/ws")'],
          } as any,
        ],
      }),
    ];

    await enricher.enrich(data, parsed, { root: '/test' } as any);

    expect(data.routes).toHaveLength(1);
    expect(data.routes[0].route_type).toBe('websocket');
    expect(data.routes[0].method).toBe('WEBSOCKET');
    expect(data.routes[0].path).toBe('/ws');
  });

  test('extracts function middleware decorators', async () => {
    const data = makeEmptyCodemapData();
    const parsed: ParsedFile[] = [
      makeParsedFile({
        file: makeScannedFile('app/main.py'),
        functions: [
          {
            name: 'add_cors_headers',
            params: [{ name: 'request', type: 'Request' }, { name: 'call_next', type: '' }],
            return_type: 'Response',
            async: true,
            exported: true,
            calls: ['call_next'],
            complexity: 1,
            lineCount: 5,
            nestingDepth: 0,
            decorators: ['@app.middleware("http")'],
          } as any,
        ],
      }),
    ];

    await enricher.enrich(data, parsed, { root: '/test' } as any);

    expect(data.middleware).toHaveProperty('add_cors_headers');
    expect(data.middleware['add_cors_headers'].type).toBe('function_middleware');
  });

  test('builds dependency injection graph', async () => {
    const data = makeEmptyCodemapData();
    const parsed: ParsedFile[] = [
      makeParsedFile({
        file: makeScannedFile('app/deps.py'),
        functions: [
          {
            name: 'get_db',
            params: [],
            return_type: 'Session',
            async: false,
            exported: true,
            calls: ['SessionLocal'],
            complexity: 1,
            lineCount: 3,
            nestingDepth: 0,
            decorators: [],
          } as any,
        ],
      }),
      makeParsedFile({
        file: makeScannedFile('app/routes.py'),
        functions: [
          {
            name: 'get_user',
            params: [
              { name: 'user_id', type: 'int' },
              { name: 'db', type: 'Depends(get_db)' },
            ],
            return_type: 'User',
            async: true,
            exported: true,
            calls: [],
            complexity: 1,
            lineCount: 3,
            nestingDepth: 0,
            decorators: ['@router.get("/users/{user_id}")'],
          } as any,
        ],
      }),
    ];

    await enricher.enrich(data, parsed, { root: '/test' } as any);

    const deps = (data as any).di_providers;
    expect(deps).toHaveLength(1);
    expect(deps[0].name).toBe('get_db');
    expect(deps[0].return_type).toBe('Session');
    expect(deps[0].used_by).toContain('get_user');
  });
});
