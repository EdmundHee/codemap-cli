/**
 * Next.js Framework Enricher
 *
 * Extracts Next.js-specific semantic data from already-parsed TS/JS/TSX/JSX files:
 * - Pages Router file-based routing (pages/ directory)
 * - App Router file-based routing (app/ directory)
 * - API routes (pages/api/ and app/route.ts handlers)
 * - Middleware (middleware.ts at root or src level)
 * - Layouts (app/layout.tsx files at any depth)
 * - Server and Client component directives
 */

import * as fs from 'fs';
import { CodemapData } from '../output/json-generator';
import { ParsedFile } from '../parsers/parser.interface';
import { CodemapConfig } from '../core/config';
import {
  FrameworkEnricher,
  RouteInfo,
  RouteParam,
  MiddlewareInfo,
} from './enricher.interface';

// ─── Next.js Convention Paths ─────────────────────────────────────────────

const PAGES_ROUTER = /^(?:src\/)?pages\//;
const APP_ROUTER = /^(?:src\/)?app\//;
const MIDDLEWARE_FILE = /^(?:src\/)?middleware\.(ts|js|tsx|jsx)$/;

const FILE_EXTENSIONS = /\.(tsx|ts|jsx|js)$/;

/** HTTP methods that can be exported from App Router route handlers */
const APP_ROUTER_HTTP_METHODS = new Set([
  'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS',
]);

// ─── Helper Functions ──────────────────────────────────────────────────────

/**
 * Convert Next.js dynamic route segments to Express-style params.
 * - `[id]` → `:id`
 * - `[...slug]` → `:slug(.*)`
 * - `[[...slug]]` → `:slug(.*)?`
 * - `(group)` → stripped (route groups)
 */
function convertSegments(route: string): string {
  return route
    .replace(/\[\[\.\.\.([^\]]+)\]\]/g, ':$1(.*)?')   // optional catch-all
    .replace(/\[\.\.\.([^\]]+)\]/g, ':$1(.*)')          // catch-all
    .replace(/\[([^\]]+)\]/g, ':$1')                    // dynamic segment
    .replace(/(?:^|\/)\([^)]+\)/g, '');                    // strip route groups
}

/**
 * Convert a Pages Router file path to a route path.
 */
function pagesFilePathToRoute(filePath: string): string {
  let route = filePath
    .replace(/^(?:src\/)?pages\//, '')
    .replace(FILE_EXTENSIONS, '');

  // Handle index files
  route = route.replace(/\/index$/, '');
  if (route === 'index') route = '';

  route = convertSegments(route);

  return '/' + route;
}

/**
 * Convert an App Router file path to a route path.
 * Strips page.tsx/route.ts leaf files and route group segments.
 */
function appFilePathToRoute(filePath: string): string {
  let route = filePath
    .replace(/^(?:src\/)?app\//, '')
    .replace(FILE_EXTENSIONS, '');

  // Strip leaf file names (page, route, layout, loading, error, etc.)
  route = route.replace(/\/(page|route|layout|loading|error|not-found|template|default)$/, '');
  if (/^(page|route|layout|loading|error|not-found|template|default)$/.test(route)) route = '';

  route = convertSegments(route);

  // Build final path and clean up any double slashes or trailing slashes
  let result = '/' + route;
  result = result.replace(/\/+/g, '/').replace(/\/$/, '');

  return result || '/';
}

/**
 * Extract route params from a converted route path.
 */
function extractRouteParams(routePath: string): RouteParam[] {
  const params: RouteParam[] = [];
  const paramMatches = routePath.matchAll(/:([^(/]+)/g);
  for (const match of paramMatches) {
    const paramName = match[1].replace('?', '');
    params.push({
      name: paramName,
      type: 'string',
      required: !match[0].endsWith('?'),
      location: 'path',
    });
  }
  return params;
}

/**
 * Check if an App Router file is a route handler (route.ts).
 */
function isRouteHandler(filePath: string): boolean {
  return /\/route\.(ts|js|tsx|jsx)$/.test(filePath);
}

/**
 * Check if an App Router file is a page (page.tsx).
 */
function isPageFile(filePath: string): boolean {
  return /\/page\.(ts|js|tsx|jsx)$/.test(filePath) || /^(?:src\/)?app\/page\.(ts|js|tsx|jsx)$/.test(filePath);
}

/**
 * Check if an App Router file is a layout (layout.tsx).
 */
function isLayoutFile(filePath: string): boolean {
  return /\/layout\.(ts|js|tsx|jsx)$/.test(filePath) || /^(?:src\/)?app\/layout\.(ts|js|tsx|jsx)$/.test(filePath);
}

/**
 * Detect HTTP methods from App Router route handler exports.
 */
function detectHttpMethods(parsed: ParsedFile): string[] {
  const methods: string[] = [];

  for (const exp of parsed.exports) {
    const name = exp.name.toUpperCase();
    if (APP_ROUTER_HTTP_METHODS.has(name)) {
      methods.push(name);
    }
  }

  // Also check exported functions
  for (const func of parsed.functions) {
    if (func.exported) {
      const name = func.name.toUpperCase();
      if (APP_ROUTER_HTTP_METHODS.has(name)) {
        if (!methods.includes(name)) {
          methods.push(name);
        }
      }
    }
  }

  return methods.length > 0 ? methods : ['ALL'];
}

/**
 * Try to read file content and detect 'use client' or 'use server' directives.
 * Returns null if the file cannot be read (e.g., during tests with mock data).
 */
function detectDirective(absolutePath: string): 'client' | 'server' | null {
  try {
    const content = fs.readFileSync(absolutePath, 'utf-8');
    const firstLines = content.slice(0, 200);
    if (/['"]use client['"]/.test(firstLines)) return 'client';
    if (/['"]use server['"]/.test(firstLines)) return 'server';
  } catch {
    // File doesn't exist (mock tests) — gracefully skip
  }
  return null;
}

// ─── Extraction Helpers ──────────────────────────────────────────────────

/**
 * Extract a route from a Pages Router file.
 */
function extractPagesRoute(parsed: ParsedFile): RouteInfo {
  const filePath = parsed.file.relative;
  const routePath = pagesFilePathToRoute(filePath);
  const isApi = /^(?:src\/)?pages\/api\//.test(filePath);

  const route: RouteInfo = {
    method: isApi ? 'ALL' : 'GET',
    path: routePath,
    handler: isApi ? 'handler' : 'page',
    file: filePath,
    decorators: [],
    params: extractRouteParams(routePath),
    framework: 'next',
    route_type: isApi ? 'api' : 'page',
    middleware: [],
  };

  return route;
}

/**
 * Extract a route from an App Router page file.
 */
function extractAppPageRoute(parsed: ParsedFile): RouteInfo {
  const filePath = parsed.file.relative;
  const routePath = appFilePathToRoute(filePath);
  const directive = detectDirective(parsed.file.absolute);

  const route: RouteInfo = {
    method: 'GET',
    path: routePath,
    handler: 'page',
    file: filePath,
    decorators: directive ? [`use ${directive}`] : [],
    params: extractRouteParams(routePath),
    framework: 'next',
    route_type: 'page',
    middleware: [],
  };

  return route;
}

/**
 * Extract route(s) from an App Router route handler file.
 */
function extractAppRouteHandler(parsed: ParsedFile): RouteInfo[] {
  const filePath = parsed.file.relative;
  const routePath = appFilePathToRoute(filePath);
  const methods = detectHttpMethods(parsed);

  return methods.map((method) => ({
    method,
    path: routePath,
    handler: method === 'ALL' ? 'route' : method,
    file: filePath,
    decorators: [],
    params: extractRouteParams(routePath),
    framework: 'next' as const,
    route_type: 'api' as const,
    middleware: [] as string[],
  }));
}

/**
 * Extract middleware info from middleware.ts file.
 */
function extractMiddleware(parsed: ParsedFile): MiddlewareInfo {
  const filePath = parsed.file.relative;
  const methods: string[] = [];

  for (const func of parsed.functions) {
    methods.push(func.name);
  }

  return {
    name: 'middleware',
    file: filePath,
    framework: 'next',
    type: 'http_middleware',
    methods: methods.length > 0 ? methods : ['middleware'],
  };
}

// ─── Next.js Enricher ─────────────────────────────────────────────────────

export class NextjsEnricher implements FrameworkEnricher {
  readonly name = 'Next.js Enricher';
  readonly framework = 'next';

  canEnrich(frameworks: string[]): boolean {
    return frameworks.includes('next');
  }

  async enrich(
    data: CodemapData,
    parsed: ParsedFile[],
    _config: CodemapConfig
  ): Promise<void> {
    const routes: RouteInfo[] = [];
    const middlewareMap: Record<string, MiddlewareInfo> = {};
    const layoutFiles: string[] = [];

    for (const p of parsed) {
      const filePath = p.file.relative;

      // ── Middleware detection ──
      if (MIDDLEWARE_FILE.test(filePath)) {
        const mw = extractMiddleware(p);
        middlewareMap[mw.name] = mw;
        continue;
      }

      // ── Pages Router ──
      if (PAGES_ROUTER.test(filePath)) {
        // Skip _app, _document, _error special files
        const baseName = filePath.split('/').pop()?.replace(FILE_EXTENSIONS, '') || '';
        if (baseName.startsWith('_')) continue;

        routes.push(extractPagesRoute(p));
        continue;
      }

      // ── App Router ──
      if (APP_ROUTER.test(filePath)) {
        if (isRouteHandler(filePath)) {
          routes.push(...extractAppRouteHandler(p));
        } else if (isPageFile(filePath)) {
          routes.push(extractAppPageRoute(p));
        } else if (isLayoutFile(filePath)) {
          layoutFiles.push(filePath);
        }
        // Other App Router files (loading, error, template, etc.) are not routes
        continue;
      }
    }

    // ── Store layouts as middleware entries for visibility ──
    for (const layoutFile of layoutFiles) {
      const routePath = appFilePathToRoute(layoutFile);
      const layoutName = routePath === '/' ? 'root-layout' : `layout:${routePath}`;
      middlewareMap[layoutName] = {
        name: layoutName,
        file: layoutFile,
        framework: 'next',
        type: 'http_middleware',
        methods: ['layout'],
      };
    }

    // ── Populate CodemapData ──
    data.routes.push(...routes);
    Object.assign(data.middleware, middlewareMap);
  }
}
