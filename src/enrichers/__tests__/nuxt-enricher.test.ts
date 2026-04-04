import { NuxtEnricher } from '../nuxt-enricher';
import { CodemapData } from '../../output/json-generator';
import { ParsedFile, ClassInfo, FunctionInfo } from '../../parsers/parser.interface';
import { ScannedFile } from '../../core/scanner';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeScannedFile(relative: string, language: 'vue' | 'typescript' | 'javascript' = 'vue'): ScannedFile {
  return { absolute: `/project/${relative}`, relative, language };
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
    project: { name: 'test', root: '/test', languages: ['typescript', 'vue'], frameworks: ['nuxt'], entry_points: [] },
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

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('NuxtEnricher', () => {
  const enricher = new NuxtEnricher();

  test('canEnrich returns true for nuxt', () => {
    expect(enricher.canEnrich(['nuxt'])).toBe(true);
    expect(enricher.canEnrich(['nuxt', 'vue', 'pinia'])).toBe(true);
  });

  test('canEnrich returns false for non-nuxt', () => {
    expect(enricher.canEnrich(['vue'])).toBe(false);
    expect(enricher.canEnrich([])).toBe(false);
  });

  test('extracts page routes from pages/ directory', async () => {
    const data = makeEmptyCodemapData();
    const parsed: ParsedFile[] = [
      makeParsedFile({
        file: makeScannedFile('pages/index.vue'),
        functions: [],
        moduleCalls: [],
      }),
      makeParsedFile({
        file: makeScannedFile('pages/about.vue'),
        functions: [],
        moduleCalls: [],
      }),
      makeParsedFile({
        file: makeScannedFile('pages/users/[id].vue'),
        functions: [],
        moduleCalls: [],
      }),
    ];

    await enricher.enrich(data, parsed, { root: '/test' } as any);

    expect(data.routes).toHaveLength(3);

    const indexRoute = data.routes.find((r) => r.path === '/');
    expect(indexRoute).toBeDefined();
    expect(indexRoute!.route_type).toBe('page');
    expect(indexRoute!.framework).toBe('nuxt');

    const aboutRoute = data.routes.find((r) => r.path === '/about');
    expect(aboutRoute).toBeDefined();

    const userRoute = data.routes.find((r) => r.path === '/users/:id');
    expect(userRoute).toBeDefined();
    expect(userRoute!.params).toHaveLength(1);
    expect(userRoute!.params[0].name).toBe('id');
    expect(userRoute!.params[0].required).toBe(true);
  });

  test('handles nested and catch-all routes', async () => {
    const data = makeEmptyCodemapData();
    const parsed: ParsedFile[] = [
      makeParsedFile({
        file: makeScannedFile('pages/blog/[...slug].vue'),
        functions: [],
        moduleCalls: [],
      }),
      makeParsedFile({
        file: makeScannedFile('pages/docs/[[...slug]].vue'),
        functions: [],
        moduleCalls: [],
      }),
    ];

    await enricher.enrich(data, parsed, { root: '/test' } as any);

    expect(data.routes).toHaveLength(2);
    const blogRoute = data.routes.find((r) => r.path.includes('blog'));
    expect(blogRoute!.path).toBe('/blog/:slug(.*)');

    const docsRoute = data.routes.find((r) => r.path.includes('docs'));
    expect(docsRoute!.path).toBe('/docs/:slug(.*)*');
  });

  test('extracts page meta (layout, middleware)', async () => {
    const data = makeEmptyCodemapData();
    const parsed: ParsedFile[] = [
      makeParsedFile({
        file: makeScannedFile('pages/dashboard.vue'),
        functions: [],
        moduleCalls: ['definePageMeta({ layout: "admin", middleware: ["auth"] })'],
      }),
    ];

    await enricher.enrich(data, parsed, { root: '/test' } as any);

    expect(data.routes).toHaveLength(1);
    expect(data.routes[0].layout).toBe('admin');
    expect(data.routes[0].middleware).toContain('auth');
  });

  test('extracts server API routes', async () => {
    const data = makeEmptyCodemapData();
    const parsed: ParsedFile[] = [
      makeParsedFile({
        file: makeScannedFile('server/api/users/index.ts', 'typescript'),
        functions: [
          {
            name: 'handler',
            params: [{ name: 'event', type: 'H3Event' }],
            return_type: '',
            async: true,
            exported: true,
            calls: ['defineEventHandler'],
            complexity: 1,
            lineCount: 5,
            nestingDepth: 0,
          },
        ],
        exports: [{ name: 'default', kind: 'default' }],
        moduleCalls: ['defineEventHandler'],
      }),
      makeParsedFile({
        file: makeScannedFile('server/api/users/[id].ts', 'typescript'),
        functions: [],
        exports: [
          { name: 'get', kind: 'function' },
          { name: 'delete', kind: 'function' },
        ],
        moduleCalls: ['defineEventHandler'],
      }),
    ];

    await enricher.enrich(data, parsed, { root: '/test' } as any);

    const apiRoutes = data.routes.filter((r) => r.route_type === 'api');
    expect(apiRoutes.length).toBeGreaterThanOrEqual(2);

    const usersRoute = apiRoutes.find((r) => r.path === '/api/users');
    expect(usersRoute).toBeDefined();

    const userDetailRoutes = apiRoutes.filter((r) => r.path === '/api/users/:id');
    expect(userDetailRoutes.length).toBeGreaterThanOrEqual(1);
  });

  test('extracts composables', async () => {
    const data = makeEmptyCodemapData();
    const parsed: ParsedFile[] = [
      makeParsedFile({
        file: makeScannedFile('composables/useAuth.ts', 'typescript'),
        functions: [
          {
            name: 'useAuth',
            params: [],
            return_type: '{ user: Ref<User>, login: () => Promise<void> }',
            async: false,
            exported: true,
            calls: ['ref', 'computed', 'useFetch'],
            complexity: 3,
            lineCount: 25,
            nestingDepth: 1,
          },
        ],
        imports: [{ from: '#imports', symbols: ['ref', 'computed'], isDefault: false, isNamespace: false }],
      }),
    ];

    await enricher.enrich(data, parsed, { root: '/test' } as any);

    expect(data.models).toHaveProperty('useAuth');
    expect(data.models['useAuth'].kind).toBe('composable');
    expect(data.models['useAuth'].framework).toBe('nuxt');
  });

  test('extracts route middleware', async () => {
    const data = makeEmptyCodemapData();
    const parsed: ParsedFile[] = [
      makeParsedFile({
        file: makeScannedFile('middleware/auth.ts', 'typescript'),
        functions: [
          {
            name: 'default',
            params: [{ name: 'to', type: '' }, { name: 'from', type: '' }],
            return_type: '',
            async: false,
            exported: true,
            calls: ['navigateTo'],
            complexity: 2,
            lineCount: 10,
            nestingDepth: 1,
          },
        ],
      }),
      makeParsedFile({
        file: makeScannedFile('middleware/logger.global.ts', 'typescript'),
        functions: [
          {
            name: 'default',
            params: [{ name: 'to', type: '' }],
            return_type: '',
            async: false,
            exported: true,
            calls: ['console.log'],
            complexity: 1,
            lineCount: 3,
            nestingDepth: 0,
          },
        ],
      }),
    ];

    await enricher.enrich(data, parsed, { root: '/test' } as any);

    expect(data.middleware).toHaveProperty('auth');
    expect(data.middleware['auth'].type).toBe('route_middleware');
    expect(data.middleware['auth'].global).toBeFalsy();

    expect(data.middleware).toHaveProperty('logger');
    expect(data.middleware['logger'].global).toBe(true);
  });

  test('extracts layouts', async () => {
    const data = makeEmptyCodemapData();
    const parsed: ParsedFile[] = [
      makeParsedFile({
        file: makeScannedFile('layouts/default.vue'),
        functions: [],
      }),
      makeParsedFile({
        file: makeScannedFile('layouts/admin.vue'),
        functions: [],
      }),
    ];

    await enricher.enrich(data, parsed, { root: '/test' } as any);

    const layouts = (data as any).layouts;
    expect(layouts).toHaveLength(2);
    expect(layouts.map((l: any) => l.name)).toContain('default');
    expect(layouts.map((l: any) => l.name)).toContain('admin');
  });

  test('extracts plugins with mode detection', async () => {
    const data = makeEmptyCodemapData();
    const parsed: ParsedFile[] = [
      makeParsedFile({
        file: makeScannedFile('plugins/analytics.client.ts', 'typescript'),
        functions: [
          {
            name: 'default',
            params: [],
            return_type: '',
            async: false,
            exported: true,
            calls: [],
            complexity: 1,
            lineCount: 5,
            nestingDepth: 0,
          },
        ],
      }),
      makeParsedFile({
        file: makeScannedFile('plugins/api.ts', 'typescript'),
        functions: [
          {
            name: 'default',
            params: [],
            return_type: '',
            async: false,
            exported: true,
            calls: ["provide('$api', api)"],
            complexity: 1,
            lineCount: 8,
            nestingDepth: 0,
          },
        ],
      }),
    ];

    await enricher.enrich(data, parsed, { root: '/test' } as any);

    const plugins = (data as any).plugins;
    expect(plugins).toHaveLength(2);

    const clientPlugin = plugins.find((p: any) => p.name === 'analytics');
    expect(clientPlugin!.mode).toBe('client');

    const universalPlugin = plugins.find((p: any) => p.name === 'api');
    expect(universalPlugin!.mode).toBe('universal');
  });

  test('extracts components from components/ directory', async () => {
    const data = makeEmptyCodemapData();
    const parsed: ParsedFile[] = [
      makeParsedFile({
        file: makeScannedFile('components/UserCard.vue'),
        functions: [],
        types: [
          {
            name: 'Props',
            kind: 'interface',
            extends: [],
            properties: [
              { name: 'user', type: 'User' },
              { name: 'showAvatar', type: 'boolean', optional: true },
            ],
            exported: false,
          },
        ],
      }),
    ];

    await enricher.enrich(data, parsed, { root: '/test' } as any);

    const components = (data as any).components;
    expect(components).toHaveLength(1);
    expect(components[0].name).toBe('UserCard');
    expect(components[0].auto_imported).toBe(true);
    expect(components[0].props).toHaveLength(2);
    expect(components[0].props[0].name).toBe('user');
  });

  test('extracts server middleware', async () => {
    const data = makeEmptyCodemapData();
    const parsed: ParsedFile[] = [
      makeParsedFile({
        file: makeScannedFile('server/middleware/auth.ts', 'typescript'),
        functions: [
          {
            name: 'default',
            params: [{ name: 'event', type: 'H3Event' }],
            return_type: '',
            async: true,
            exported: true,
            calls: [],
            complexity: 2,
            lineCount: 10,
            nestingDepth: 1,
          },
        ],
      }),
    ];

    await enricher.enrich(data, parsed, { root: '/test' } as any);

    expect(data.middleware).toHaveProperty('server:auth');
    expect(data.middleware['server:auth'].type).toBe('server_middleware');
  });

  test('extracts Pinia stores', async () => {
    const data = makeEmptyCodemapData();
    const parsed: ParsedFile[] = [
      makeParsedFile({
        file: makeScannedFile('composables/useCounterStore.ts', 'typescript'),
        functions: [
          {
            name: 'useCounterStore',
            params: [],
            return_type: '',
            async: false,
            exported: true,
            calls: ['defineStore', 'ref', 'computed'],
            complexity: 1,
            lineCount: 15,
            nestingDepth: 0,
          },
        ],
        imports: [
          { from: 'pinia', symbols: ['defineStore'], isDefault: false, isNamespace: false },
        ],
        moduleCalls: ['defineStore'],
      }),
    ];

    await enricher.enrich(data, parsed, { root: '/test' } as any);

    expect(data.models).toHaveProperty('useCounterStore');
    expect(data.models['useCounterStore'].kind).toBe('store');
  });
});
