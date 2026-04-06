/**
 * Express Framework Enricher
 *
 * Extracts Express-specific semantic data from already-parsed JavaScript/TypeScript files:
 * - Routes (app.get, router.post, etc.)
 * - Route parameters (:id, :userId, etc.)
 * - Middleware (app.use with function or path+function)
 * - Router mounting (app.use('/api', router))
 * - Error handlers (4-parameter middleware: err, req, res, next)
 */

import { readFileSync } from 'fs';
import { CodemapData } from '../output/json-generator';
import { ParsedFile } from '../parsers/parser.interface';
import { CodemapConfig } from '../core/config';
import {
  FrameworkEnricher,
  RouteInfo,
  RouteParam,
  MiddlewareInfo,
} from './enricher.interface';

// ─── Constants ─────────────────────────────────────────────────────────────

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'all', 'options', 'head']);

// Route registration: app.get('/path', handler) or router.post('/path', mw1, mw2, handler)
const ROUTE_PATTERN =
  /(?:app|router|[\w]+Router)\.(get|post|put|delete|patch|all|options|head)\s*\(\s*['"`]([^'"`]+)['"`]([^)]*)\)/gi;

// Middleware: app.use(...) — we capture everything inside the parens
const MIDDLEWARE_PATTERN =
  /(?:app|router|[\w]+Router)\.use\s*\(([^)]*)\)/gi;

// Router creation: const router = express.Router()
const ROUTER_PATTERN =
  /(?:const|let|var)\s+(\w+)\s*=\s*(?:express\.Router\(\)|Router\(\))/g;

// Route param in path: :paramName
const ROUTE_PARAM_PATTERN = /:(\w+)/g;

// Error handler: function with 4 params (err, req, res, next)
const ERROR_HANDLER_PATTERN =
  /function\s+(\w+)\s*\(\s*(\w+)\s*,\s*(\w+)\s*,\s*(\w+)\s*,\s*(\w+)\s*\)/g;

// Arrow/anonymous error handler in app.use: app.use(function(err, req, res, next) { ... })
// or app.use((err, req, res, next) => { ... })
const INLINE_ERROR_HANDLER_PATTERN =
  /\.use\s*\(\s*(?:function\s+(\w+))?\s*\(\s*(\w+)\s*,\s*(\w+)\s*,\s*(\w+)\s*,\s*(\w+)\s*\)/g;

// ─── Helper Functions ──────────────────────────────────────────────────────

function hasExpressImport(parsed: ParsedFile): boolean {
  for (const imp of parsed.imports) {
    if (imp.from === 'express') return true;
  }
  return false;
}

function extractParamsFromPath(path: string): RouteParam[] {
  const params: RouteParam[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(ROUTE_PARAM_PATTERN.source, 'g');
  while ((match = re.exec(path)) !== null) {
    params.push({
      name: match[1],
      type: 'string',
      required: true,
      location: 'path',
    });
  }
  return params;
}

function extractHandlerNames(argsStr: string): { handlers: string[]; middleware: string[] } {
  // Parse the remaining arguments after the path string
  // These are comma-separated function references or inline functions
  const cleaned = argsStr
    .replace(/^\s*,\s*/, '') // remove leading comma
    .trim();

  if (!cleaned) return { handlers: [], middleware: [] };

  // Split by comma but not inside parens/brackets
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of cleaned) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());

  // Extract simple identifiers (handler/middleware names)
  const names: string[] = [];
  for (const part of parts) {
    // Simple identifier: getUsers, auth, validate
    const identMatch = part.match(/^(\w+)$/);
    if (identMatch) {
      names.push(identMatch[1]);
      continue;
    }
    // Function call: someMiddleware() — extract the name
    const callMatch = part.match(/^(\w+)\s*\(/);
    if (callMatch) {
      names.push(callMatch[1]);
      continue;
    }
    // Arrow function or anonymous
    if (part.includes('=>') || part.startsWith('function')) {
      names.push('anonymous');
      continue;
    }
    // Property access: controller.method
    const propMatch = part.match(/^(\w+\.\w+)$/);
    if (propMatch) {
      names.push(propMatch[1]);
      continue;
    }
  }

  if (names.length === 0) return { handlers: [], middleware: [] };
  if (names.length === 1) return { handlers: [names[0]], middleware: [] };

  // Last name is the handler, rest are middleware
  return {
    handlers: [names[names.length - 1]],
    middleware: names.slice(0, -1),
  };
}

function extractMiddlewareName(argsStr: string): { name: string; path?: string } {
  const trimmed = argsStr.trim();

  // app.use('/path', router) — path prefix + handler
  const pathMatch = trimmed.match(/^['"`]([^'"`]+)['"`]\s*,\s*(.*)/s);
  if (pathMatch) {
    const rest = pathMatch[2].trim();
    const nameMatch = rest.match(/^(\w+)/);
    return {
      path: pathMatch[1],
      name: nameMatch ? nameMatch[1] : rest.replace(/\(.*/, '').trim() || 'anonymous',
    };
  }

  // app.use(cors()) — function call
  const callMatch = trimmed.match(/^(\w+)\s*\(/);
  if (callMatch) return { name: callMatch[1] };

  // app.use(express.json()) — namespaced call
  const nsCallMatch = trimmed.match(/^(\w+\.\w+)\s*\(/);
  if (nsCallMatch) return { name: nsCallMatch[1] };

  // app.use(middlewareFn) — simple identifier
  const identMatch = trimmed.match(/^(\w+)$/);
  if (identMatch) return { name: identMatch[1] };

  // app.use(function name(...) { ... })
  const funcMatch = trimmed.match(/^function\s+(\w+)/);
  if (funcMatch) return { name: funcMatch[1] };

  return { name: 'anonymous' };
}

// ─── Express Enricher ─────────────────────────────────────────────────────

export class ExpressEnricher implements FrameworkEnricher {
  readonly name = 'Express Enricher';
  readonly framework = 'express';

  canEnrich(frameworks: string[]): boolean {
    return frameworks.includes('express');
  }

  async enrich(
    data: CodemapData,
    parsed: ParsedFile[],
    _config: CodemapConfig
  ): Promise<void> {
    const routes: RouteInfo[] = [];
    const middleware: Record<string, MiddlewareInfo> = {};

    // Track router variable names and their mount prefixes
    const routerMounts = new Map<string, string>(); // routerVarName -> mount prefix

    for (const p of parsed) {
      if (!hasExpressImport(p)) continue;

      let content: string;
      try {
        content = readFileSync(p.file.absolute, 'utf-8');
      } catch {
        continue;
      }

      const filePath = p.file.relative;

      // ── Pass 1: Detect router variables ──
      const routerVars = new Set<string>();
      let routerMatch: RegExpExecArray | null;
      const routerRe = new RegExp(ROUTER_PATTERN.source, 'g');
      while ((routerMatch = routerRe.exec(content)) !== null) {
        routerVars.add(routerMatch[1]);
      }

      // ── Pass 2: Detect router mount prefixes from app.use('/prefix', routerVar) ──
      const mwRe1 = new RegExp(MIDDLEWARE_PATTERN.source, 'gi');
      let mwMatch1: RegExpExecArray | null;
      while ((mwMatch1 = mwRe1.exec(content)) !== null) {
        const args = mwMatch1[1];
        const pathAndRouter = args.match(/^['"`]([^'"`]+)['"`]\s*,\s*(\w+)/);
        if (pathAndRouter && routerVars.has(pathAndRouter[2])) {
          routerMounts.set(pathAndRouter[2], pathAndRouter[1]);
        }
      }

      // ── Pass 3: Extract routes ──
      const routeRe = new RegExp(ROUTE_PATTERN.source, 'gi');
      let routeMatch: RegExpExecArray | null;
      while ((routeMatch = routeRe.exec(content)) !== null) {
        const method = routeMatch[1].toUpperCase();
        const path = routeMatch[2];
        const restArgs = routeMatch[3] || '';

        const { handlers, middleware: routeMiddleware } = extractHandlerNames(restArgs);
        const handler = handlers.length > 0 ? handlers[0] : 'anonymous';
        const params = extractParamsFromPath(path);

        const route: RouteInfo = {
          method,
          path,
          handler,
          file: filePath,
          decorators: [],
          params,
          framework: 'express',
          route_type: 'api',
          middleware: routeMiddleware.length > 0 ? routeMiddleware : undefined,
        };

        routes.push(route);
      }

      // ── Pass 4: Extract middleware ──
      const mwRe2 = new RegExp(MIDDLEWARE_PATTERN.source, 'gi');
      let mwMatch2: RegExpExecArray | null;
      while ((mwMatch2 = mwRe2.exec(content)) !== null) {
        const args = mwMatch2[1];
        const extracted = extractMiddlewareName(args);

        // Skip if this is a router mount (already tracked above)
        if (extracted.path && routerVars.has(extracted.name)) continue;

        const isGlobal = !extracted.path;

        // Check for error handler (4-param function)
        // Note: the captured args may be truncated at the first ')' so we check
        // both the full pattern and the truncated form (without closing paren)
        let isErrorHandler = false;
        const errCheck = args.match(/function\s*\w*\s*\(\s*\w+\s*,\s*\w+\s*,\s*\w+\s*,\s*\w+/);
        if (errCheck) isErrorHandler = true;
        const arrowErrCheck = args.match(/\(\s*\w+\s*,\s*\w+\s*,\s*\w+\s*,\s*\w+\s*\)\s*=>/);
        if (arrowErrCheck) isErrorHandler = true;

        const mw: MiddlewareInfo = {
          name: extracted.name,
          file: filePath,
          framework: 'express',
          type: isErrorHandler ? 'function_middleware' : 'function_middleware',
          global: isGlobal,
        };

        if (isErrorHandler) {
          mw.methods = ['error_handler'];
        }

        middleware[extracted.name] = mw;
      }

      // ── Pass 5: Detect standalone error handlers ──
      const errRe = new RegExp(ERROR_HANDLER_PATTERN.source, 'g');
      let errMatch: RegExpExecArray | null;
      while ((errMatch = errRe.exec(content)) !== null) {
        const funcName = errMatch[1];
        // Check param names — conventional: err/error as first param
        const firstParam = errMatch[2].toLowerCase();
        if (firstParam === 'err' || firstParam === 'error') {
          if (!middleware[funcName]) {
            middleware[funcName] = {
              name: funcName,
              file: filePath,
              framework: 'express',
              type: 'function_middleware',
              methods: ['error_handler'],
              global: false,
            };
          }
        }
      }
    }

    // ── Populate CodemapData ──
    data.routes.push(...routes);
    Object.assign(data.middleware, middleware);
  }
}
