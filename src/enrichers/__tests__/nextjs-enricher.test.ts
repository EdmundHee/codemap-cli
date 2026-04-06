import { NextjsEnricher } from '../nextjs-enricher';
import { CodemapData } from '../../output/json-generator';
import { ParsedFile } from '../../parsers/parser.interface';
import { ScannedFile } from '../../core/scanner';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeScannedFile(relative: string, language: 'typescript' | 'javascript' = 'typescript'): ScannedFile {
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
    project: { name: 'test', root: '/test', languages: ['typescript'], frameworks: ['next'], entry_points: [] },
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

describe('NextjsEnricher', () => {
  const enricher = new NextjsEnricher();

  // Test 1: canEnrich
  it('canEnrich returns true for next, false for others', () => {
    expect(enricher.canEnrich(['next'])).toBe(true);
    expect(enricher.canEnrich(['next', 'react'])).toBe(true);
    expect(enricher.canEnrich(['react'])).toBe(false);
    expect(enricher.canEnrich([])).toBe(false);
  });

  // Test 2: Pages Router file → route
  it('converts Pages Router file to route', async () => {
    const data = makeEmptyCodemapData();
    const parsed = [makeParsedFile({
      file: makeScannedFile('pages/users/[id].tsx'),
    })];
    await enricher.enrich(data, parsed, { root: '/test' } as any);
    const route = data.routes.find(r => r.path === '/users/:id');
    expect(route).toBeDefined();
    expect(route!.framework).toBe('next');
    expect(route!.route_type).toBe('page');
    expect(route!.method).toBe('GET');
    expect(route!.params).toHaveLength(1);
    expect(route!.params[0].name).toBe('id');
  });

  // Test 3: Pages Router index
  it('converts Pages Router index to root path', async () => {
    const data = makeEmptyCodemapData();
    const parsed = [makeParsedFile({
      file: makeScannedFile('pages/index.tsx'),
    })];
    await enricher.enrich(data, parsed, { root: '/test' } as any);
    const route = data.routes.find(r => r.path === '/');
    expect(route).toBeDefined();
    expect(route!.route_type).toBe('page');
  });

  // Test 4: Pages Router API route
  it('converts Pages Router API route', async () => {
    const data = makeEmptyCodemapData();
    const parsed = [makeParsedFile({
      file: makeScannedFile('pages/api/users.ts'),
    })];
    await enricher.enrich(data, parsed, { root: '/test' } as any);
    const route = data.routes.find(r => r.path === '/api/users');
    expect(route).toBeDefined();
    expect(route!.route_type).toBe('api');
    expect(route!.method).toBe('ALL');
  });

  // Test 5: App Router page
  it('converts App Router page to route', async () => {
    const data = makeEmptyCodemapData();
    const parsed = [makeParsedFile({
      file: makeScannedFile('app/dashboard/page.tsx'),
    })];
    await enricher.enrich(data, parsed, { root: '/test' } as any);
    const route = data.routes.find(r => r.path === '/dashboard');
    expect(route).toBeDefined();
    expect(route!.route_type).toBe('page');
    expect(route!.method).toBe('GET');
  });

  // Test 6: App Router API route with method detection
  it('converts App Router API route with exported methods', async () => {
    const data = makeEmptyCodemapData();
    const parsed = [makeParsedFile({
      file: makeScannedFile('app/api/users/route.ts'),
      exports: [
        { name: 'GET', kind: 'function' },
        { name: 'POST', kind: 'function' },
      ],
    })];
    await enricher.enrich(data, parsed, { root: '/test' } as any);
    const routes = data.routes.filter(r => r.path === '/api/users');
    expect(routes).toHaveLength(2);
    expect(routes.map(r => r.method)).toContain('GET');
    expect(routes.map(r => r.method)).toContain('POST');
    expect(routes[0].route_type).toBe('api');
  });

  // Test 7: Route groups stripped
  it('strips route groups from path', async () => {
    const data = makeEmptyCodemapData();
    const parsed = [makeParsedFile({
      file: makeScannedFile('app/(auth)/login/page.tsx'),
    })];
    await enricher.enrich(data, parsed, { root: '/test' } as any);
    const route = data.routes.find(r => r.path === '/login');
    expect(route).toBeDefined();
    expect(route!.route_type).toBe('page');
  });

  // Test 8: Dynamic segments in App Router
  it('converts App Router dynamic segments', async () => {
    const data = makeEmptyCodemapData();
    const parsed = [makeParsedFile({
      file: makeScannedFile('app/blog/[slug]/page.tsx'),
    })];
    await enricher.enrich(data, parsed, { root: '/test' } as any);
    const route = data.routes.find(r => r.path === '/blog/:slug');
    expect(route).toBeDefined();
    expect(route!.params).toHaveLength(1);
    expect(route!.params[0].name).toBe('slug');
  });

  // Test 9: Catch-all and optional catch-all
  it('handles catch-all and optional catch-all segments', async () => {
    const data = makeEmptyCodemapData();
    const parsed = [
      makeParsedFile({ file: makeScannedFile('pages/docs/[...slug].tsx') }),
      makeParsedFile({ file: makeScannedFile('pages/blog/[[...slug]].tsx') }),
    ];
    await enricher.enrich(data, parsed, { root: '/test' } as any);

    const catchAll = data.routes.find(r => r.path === '/docs/:slug(.*)');
    expect(catchAll).toBeDefined();
    expect(catchAll!.params).toHaveLength(1);
    expect(catchAll!.params[0].name).toBe('slug');

    const optionalCatchAll = data.routes.find(r => r.path === '/blog/:slug(.*)?');
    expect(optionalCatchAll).toBeDefined();
  });

  // Test 10: Middleware detection
  it('detects middleware.ts as middleware', async () => {
    const data = makeEmptyCodemapData();
    const parsed = [makeParsedFile({
      file: makeScannedFile('middleware.ts'),
      functions: [{ name: 'middleware', params: [], return_type: 'NextResponse', async: false, exported: true, calls: [], complexity: 1, lineCount: 5, nestingDepth: 0 }],
    })];
    await enricher.enrich(data, parsed, { root: '/test' } as any);
    expect(Object.keys(data.middleware).length).toBeGreaterThanOrEqual(1);
    expect(data.middleware['middleware']).toBeDefined();
    expect(data.middleware['middleware'].type).toBe('http_middleware');
    expect(data.middleware['middleware'].framework).toBe('next');
  });

  // Test 11: src/ prefix middleware
  it('detects src/middleware.ts as middleware', async () => {
    const data = makeEmptyCodemapData();
    const parsed = [makeParsedFile({
      file: makeScannedFile('src/middleware.ts'),
      functions: [{ name: 'middleware', params: [], return_type: 'NextResponse', async: false, exported: true, calls: [], complexity: 1, lineCount: 5, nestingDepth: 0 }],
    })];
    await enricher.enrich(data, parsed, { root: '/test' } as any);
    expect(data.middleware['middleware']).toBeDefined();
  });

  // Test 12: Layout detection
  it('detects layout.tsx files', async () => {
    const data = makeEmptyCodemapData();
    const parsed = [makeParsedFile({
      file: makeScannedFile('app/layout.tsx'),
    })];
    await enricher.enrich(data, parsed, { root: '/test' } as any);
    expect(Object.keys(data.middleware).length).toBeGreaterThanOrEqual(1);
    // Layout stored as middleware entry
    expect(data.middleware['root-layout']).toBeDefined();
    expect(data.middleware['root-layout'].file).toBe('app/layout.tsx');
  });

  // Test 13: Nested layout detection
  it('detects nested layout files', async () => {
    const data = makeEmptyCodemapData();
    const parsed = [
      makeParsedFile({ file: makeScannedFile('app/layout.tsx') }),
      makeParsedFile({ file: makeScannedFile('app/dashboard/layout.tsx') }),
    ];
    await enricher.enrich(data, parsed, { root: '/test' } as any);
    expect(data.middleware['root-layout']).toBeDefined();
    expect(data.middleware['layout:/dashboard']).toBeDefined();
  });

  // Test 14: 'use client' detection (graceful when file doesn't exist)
  it('handles use client directive gracefully in mock', async () => {
    const data = makeEmptyCodemapData();
    const parsed = [makeParsedFile({
      file: makeScannedFile('app/client-page/page.tsx'),
    })];
    await enricher.enrich(data, parsed, { root: '/test' } as any);
    const route = data.routes.find(r => r.path === '/client-page');
    expect(route).toBeDefined();
    expect(route!.framework).toBe('next');
  });

  // Test 15: Both routers coexist
  it('handles both routers without duplication', async () => {
    const data = makeEmptyCodemapData();
    const parsed = [
      makeParsedFile({ file: makeScannedFile('pages/about.tsx') }),
      makeParsedFile({ file: makeScannedFile('app/contact/page.tsx') }),
    ];
    await enricher.enrich(data, parsed, { root: '/test' } as any);
    expect(data.routes.length).toBe(2);
    expect(data.routes.map(r => r.path)).toContain('/about');
    expect(data.routes.map(r => r.path)).toContain('/contact');
  });

  // Test 16: Skips _app and _document special files
  it('skips Pages Router special files (_app, _document)', async () => {
    const data = makeEmptyCodemapData();
    const parsed = [
      makeParsedFile({ file: makeScannedFile('pages/_app.tsx') }),
      makeParsedFile({ file: makeScannedFile('pages/_document.tsx') }),
      makeParsedFile({ file: makeScannedFile('pages/index.tsx') }),
    ];
    await enricher.enrich(data, parsed, { root: '/test' } as any);
    expect(data.routes.length).toBe(1);
    expect(data.routes[0].path).toBe('/');
  });

  // Test 17: src/ prefix support for Pages Router
  it('handles src/ prefix for Pages Router', async () => {
    const data = makeEmptyCodemapData();
    const parsed = [makeParsedFile({
      file: makeScannedFile('src/pages/about.tsx'),
    })];
    await enricher.enrich(data, parsed, { root: '/test' } as any);
    const route = data.routes.find(r => r.path === '/about');
    expect(route).toBeDefined();
  });

  // Test 18: src/ prefix support for App Router
  it('handles src/ prefix for App Router', async () => {
    const data = makeEmptyCodemapData();
    const parsed = [makeParsedFile({
      file: makeScannedFile('src/app/dashboard/page.tsx'),
    })];
    await enricher.enrich(data, parsed, { root: '/test' } as any);
    const route = data.routes.find(r => r.path === '/dashboard');
    expect(route).toBeDefined();
  });

  // Test 19: Non-matching files are ignored
  it('ignores files outside pages/ and app/ directories', async () => {
    const data = makeEmptyCodemapData();
    const parsed = [
      makeParsedFile({ file: makeScannedFile('src/components/Button.tsx') }),
      makeParsedFile({ file: makeScannedFile('src/utils/helpers.ts') }),
      makeParsedFile({ file: makeScannedFile('lib/auth.ts') }),
    ];
    await enricher.enrich(data, parsed, { root: '/test' } as any);
    expect(data.routes.length).toBe(0);
    expect(Object.keys(data.middleware).length).toBe(0);
  });

  // Test 20: App Router route handler fallback to ALL
  it('falls back to ALL method when no exports detected', async () => {
    const data = makeEmptyCodemapData();
    const parsed = [makeParsedFile({
      file: makeScannedFile('app/api/health/route.ts'),
      exports: [],
      functions: [],
    })];
    await enricher.enrich(data, parsed, { root: '/test' } as any);
    const route = data.routes.find(r => r.path === '/api/health');
    expect(route).toBeDefined();
    expect(route!.method).toBe('ALL');
  });
});
