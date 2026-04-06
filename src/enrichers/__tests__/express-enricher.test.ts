import { ExpressEnricher } from '../express-enricher';
import { CodemapData } from '../../output/json-generator';
import { ParsedFile } from '../../parsers/parser.interface';
import { ScannedFile } from '../../core/scanner';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeEmptyCodemapData(): CodemapData {
  return {
    version: '1.0.0',
    generated_at: new Date().toISOString(),
    project: {
      name: 'test',
      root: '/test',
      languages: ['javascript'],
      frameworks: ['express'],
      entry_points: [],
    },
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

describe('ExpressEnricher', () => {
  let enricher: ExpressEnricher;
  let tempDir: string;

  beforeAll(() => {
    enricher = new ExpressEnricher();
    tempDir = join(tmpdir(), 'express-enricher-test-' + Date.now());
    mkdirSync(tempDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createExpressFile(
    name: string,
    content: string,
    imports: any[] = []
  ): ParsedFile {
    const filePath = join(tempDir, name);
    writeFileSync(filePath, content);
    return {
      file: {
        absolute: filePath,
        relative: name,
        language: 'javascript' as any,
      },
      hash: 'test',
      classes: [],
      functions: [],
      imports: imports.length
        ? imports
        : [
            {
              from: 'express',
              symbols: ['express'],
              isDefault: true,
              isNamespace: false,
            },
          ],
      exports: [],
      types: [],
      envVars: [],
    };
  }

  // ── canEnrich ──

  it('canEnrich returns true for express, false for others', () => {
    expect(enricher.canEnrich(['express'])).toBe(true);
    expect(enricher.canEnrich(['express', 'react'])).toBe(true);
    expect(enricher.canEnrich(['react'])).toBe(false);
    expect(enricher.canEnrich([])).toBe(false);
  });

  // ── Basic route extraction ──

  it('extracts app.get route', async () => {
    const file = createExpressFile(
      'app.js',
      `
const express = require('express');
const app = express();
app.get('/users', getUsers);
`
    );
    const data = makeEmptyCodemapData();
    await enricher.enrich(data, [file], { root: tempDir } as any);

    expect(data.routes.length).toBeGreaterThanOrEqual(1);
    const route = data.routes.find((r) => r.path === '/users');
    expect(route).toBeDefined();
    expect(route!.method).toBe('GET');
    expect(route!.handler).toBe('getUsers');
    expect(route!.framework).toBe('express');
  });

  // ── Multiple HTTP methods ──

  it('extracts routes with different HTTP methods', async () => {
    const file = createExpressFile(
      'crud.js',
      `
const app = express();
app.get('/items', listItems);
app.post('/items', createItem);
app.put('/items/:id', updateItem);
app.delete('/items/:id', deleteItem);
app.patch('/items/:id', patchItem);
`
    );
    const data = makeEmptyCodemapData();
    await enricher.enrich(data, [file], { root: tempDir } as any);

    expect(data.routes.length).toBe(5);
    const methods = data.routes.map((r) => r.method);
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
    expect(methods).toContain('PUT');
    expect(methods).toContain('DELETE');
    expect(methods).toContain('PATCH');
  });

  // ── Route with middleware chain ──

  it('extracts route with middleware chain', async () => {
    const file = createExpressFile(
      'routes.js',
      `
const router = express.Router();
router.post('/items', auth, validate, createItem);
`
    );
    const data = makeEmptyCodemapData();
    await enricher.enrich(data, [file], { root: tempDir } as any);

    const route = data.routes.find((r) => r.path === '/items');
    expect(route).toBeDefined();
    expect(route!.method).toBe('POST');
    expect(route!.handler).toBe('createItem');
    expect(route!.middleware).toContain('auth');
    expect(route!.middleware).toContain('validate');
  });

  // ── Global middleware ──

  it('extracts global middleware via app.use', async () => {
    const file = createExpressFile(
      'middleware.js',
      `
const app = express();
app.use(cors());
app.use(express.json());
`
    );
    const data = makeEmptyCodemapData();
    await enricher.enrich(data, [file], { root: tempDir } as any);

    expect(Object.keys(data.middleware).length).toBeGreaterThanOrEqual(1);
    const corsMiddleware = data.middleware['cors'];
    expect(corsMiddleware).toBeDefined();
    expect(corsMiddleware.global).toBe(true);
    expect(corsMiddleware.framework).toBe('express');
  });

  // ── Router mount prefix ──

  it('tracks router mount prefixes', async () => {
    const file = createExpressFile(
      'mount.js',
      `
const app = express();
const apiRouter = express.Router();
apiRouter.get('/users', listUsers);
app.use('/api', apiRouter);
`
    );
    const data = makeEmptyCodemapData();
    await enricher.enrich(data, [file], { root: tempDir } as any);

    expect(data.routes.length).toBeGreaterThanOrEqual(1);
    const route = data.routes.find((r) => r.path === '/users');
    expect(route).toBeDefined();
    expect(route!.handler).toBe('listUsers');
  });

  // ── Error handler detection ──

  it('identifies error handler middleware', async () => {
    const file = createExpressFile(
      'error.js',
      `
const app = express();
app.use(function errorHandler(err, req, res, next) {
  res.status(500).send('Error');
});
`
    );
    const data = makeEmptyCodemapData();
    await enricher.enrich(data, [file], { root: tempDir } as any);

    expect(Object.keys(data.middleware).length).toBeGreaterThanOrEqual(1);
    const handler = data.middleware['errorHandler'];
    expect(handler).toBeDefined();
    expect(handler.methods).toContain('error_handler');
  });

  // ── Route parameter extraction ──

  it('extracts route parameters from path', async () => {
    const file = createExpressFile(
      'params.js',
      `
const app = express();
app.get('/users/:id/posts/:postId', getUserPosts);
`
    );
    const data = makeEmptyCodemapData();
    await enricher.enrich(data, [file], { root: tempDir } as any);

    const route = data.routes.find((r) => r.path.includes(':id'));
    expect(route).toBeDefined();
    expect(route!.params.length).toBeGreaterThanOrEqual(2);
    expect(route!.params.map((p: any) => p.name)).toContain('id');
    expect(route!.params.map((p: any) => p.name)).toContain('postId');
    expect(route!.params[0].location).toBe('path');
    expect(route!.params[0].required).toBe(true);
  });

  // ── Skips files without express import ──

  it('skips files without express import', async () => {
    const file = createExpressFile(
      'other.js',
      `
const app = express();
app.get('/test', handler);
`,
      [{ from: 'lodash', symbols: ['_'], isDefault: true, isNamespace: false }]
    );
    const data = makeEmptyCodemapData();
    await enricher.enrich(data, [file], { root: tempDir } as any);

    expect(data.routes.length).toBe(0);
  });

  // ── Path-prefixed middleware ──

  it('extracts path-prefixed middleware', async () => {
    const file = createExpressFile(
      'prefixed.js',
      `
const app = express();
app.use('/admin', authMiddleware);
`
    );
    const data = makeEmptyCodemapData();
    await enricher.enrich(data, [file], { root: tempDir } as any);

    const mw = data.middleware['authMiddleware'];
    expect(mw).toBeDefined();
    expect(mw.global).toBe(false);
  });

  // ── Router variable detection ──

  it('detects router variables from express.Router()', async () => {
    const file = createExpressFile(
      'router-var.js',
      `
const express = require('express');
const userRouter = express.Router();
userRouter.get('/profile', getProfile);
userRouter.post('/profile', updateProfile);
`
    );
    const data = makeEmptyCodemapData();
    await enricher.enrich(data, [file], { root: tempDir } as any);

    expect(data.routes.length).toBe(2);
  });
});
