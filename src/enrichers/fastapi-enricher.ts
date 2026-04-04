/**
 * FastAPI Framework Enricher
 *
 * Extracts FastAPI-specific semantic data from already-parsed Python files:
 * - Routes (@app.get, @router.post, etc.)
 * - Pydantic models (BaseModel with field extraction)
 * - Pydantic Settings (BaseSettings)
 * - Dependency injection (Depends() chain resolution)
 * - Middleware (@app.middleware, BaseHTTPMiddleware)
 * - WebSocket endpoints (@app.websocket)
 * - Background tasks
 * - Exception handlers
 * - Event handlers (startup/shutdown, lifespan)
 * - Security schemes (OAuth2, APIKey, HTTPBearer)
 * - APIRouter grouping and prefix resolution
 */

import { CodemapData } from '../output/json-generator';
import { ParsedFile, ClassInfo, FunctionInfo } from '../parsers/parser.interface';
import { CodemapConfig } from '../core/config';
import {
  FrameworkEnricher,
  RouteInfo,
  RouteParam,
  ModelInfo,
  ModelFieldInfo,
  MiddlewareInfo,
  DependencyInfo,
} from './enricher.interface';

// ─── Constants ─────────────────────────────────────────────────────────────

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'trace']);

const ROUTE_DECORATOR_PATTERN = /^@(?:app|router|api_router|v\d+_router|[\w]+_router)\.(get|post|put|delete|patch|head|options|trace|websocket|api_route)\s*\(/i;

const PYDANTIC_BASES = new Set([
  'BaseModel', 'pydantic.BaseModel',
  'BaseSettings', 'pydantic.BaseSettings',
  'pydantic_settings.BaseSettings',
]);

const PYDANTIC_SETTINGS_BASES = new Set([
  'BaseSettings', 'pydantic.BaseSettings',
  'pydantic_settings.BaseSettings',
]);

const FASTAPI_MIDDLEWARE_BASES = new Set([
  'BaseHTTPMiddleware', 'starlette.middleware.base.BaseHTTPMiddleware',
]);

const FASTAPI_PARAM_TYPES: Record<string, RouteParam['location']> = {
  'Query': 'query',
  'Path': 'path',
  'Body': 'body',
  'Header': 'header',
  'Cookie': 'cookie',
  'Form': 'form',
  'File': 'body',
  'UploadFile': 'body',
  'Depends': 'query', // Special — resolved as dependency
};

const SECURITY_CLASSES = new Set([
  'OAuth2PasswordBearer', 'OAuth2PasswordRequestForm', 'OAuth2AuthorizationCodeBearer',
  'HTTPBearer', 'HTTPBasic', 'HTTPDigest', 'APIKeyHeader', 'APIKeyQuery', 'APIKeyCookie',
  'SecurityScopes',
]);

// ─── Helper Functions ──────────────────────────────────────────────────────

function stripDecorator(d: string): string {
  const clean = d.startsWith('@') ? d.slice(1) : d;
  const parenIdx = clean.indexOf('(');
  return parenIdx >= 0 ? clean.slice(0, parenIdx).trim() : clean.trim();
}

function extractDecoratorArgs(d: string): string {
  const match = d.match(/\(([^)]*)\)/);
  return match ? match[1].trim() : '';
}

function extractStringArg(args: string): string | undefined {
  const match = args.match(/['"]([^'"]+)['"]/);
  return match ? match[1] : undefined;
}

function extractDecoratorKwarg(d: string, key: string): string | undefined {
  const pattern = new RegExp(`${key}\\s*=\\s*['"]([^'"]+)['"]`);
  const match = d.match(pattern);
  return match ? match[1] : undefined;
}

function extractDecoratorKwargValue(d: string, key: string): string | undefined {
  const pattern = new RegExp(`${key}\\s*=\\s*([^,)]+)`);
  const match = d.match(pattern);
  return match ? match[1].trim() : undefined;
}

function extractListKwarg(d: string, key: string): string[] {
  const pattern = new RegExp(`${key}\\s*=\\s*\\[([^\\]]*)]`);
  const match = d.match(pattern);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((s) => s.trim().replace(/['"]/g, ''))
    .filter(Boolean);
}

function isRouteDecorator(d: string): boolean {
  return ROUTE_DECORATOR_PATTERN.test(d);
}

function extractRouteMethod(d: string): string | null {
  const match = d.match(ROUTE_DECORATOR_PATTERN);
  return match ? match[1].toLowerCase() : null;
}

function extractRoutePath(d: string): string {
  const args = extractDecoratorArgs(d);
  return extractStringArg(args) || '/';
}

function isPydanticModel(cls: ClassInfo): boolean {
  if (!cls.extends) return false;
  const base = cls.extends.split('.').pop() || cls.extends;
  return PYDANTIC_BASES.has(base) || PYDANTIC_BASES.has(cls.extends);
}

function isPydanticSettings(cls: ClassInfo): boolean {
  if (!cls.extends) return false;
  const base = cls.extends.split('.').pop() || cls.extends;
  return PYDANTIC_SETTINGS_BASES.has(base) || PYDANTIC_SETTINGS_BASES.has(cls.extends);
}

function isFastAPIMiddleware(cls: ClassInfo): boolean {
  if (!cls.extends) return false;
  const base = cls.extends.split('.').pop() || cls.extends;
  return FASTAPI_MIDDLEWARE_BASES.has(base) || FASTAPI_MIDDLEWARE_BASES.has(cls.extends);
}

function extractPydanticFields(cls: ClassInfo): ModelFieldInfo[] {
  const fields: ModelFieldInfo[] = [];

  for (const prop of cls.properties) {
    const field: ModelFieldInfo = {
      name: prop.name,
      type: prop.type || 'Any',
      required: true,
    };

    // Detect optional/default
    const type = prop.type || '';
    if (type.includes('Optional') || type.includes('None') || type.includes('= None')) {
      field.required = false;
    }
    if (type.includes('=')) {
      const defaultMatch = type.match(/=\s*(.+)$/);
      if (defaultMatch) {
        field.default = defaultMatch[1].trim();
        field.required = false;
      }
    }

    // Detect Field() validators
    if (type.includes('Field(')) {
      const validators: string[] = [];
      if (type.includes('min_length')) validators.push('min_length');
      if (type.includes('max_length')) validators.push('max_length');
      if (type.includes('ge=') || type.includes('gt=')) validators.push('minimum');
      if (type.includes('le=') || type.includes('lt=')) validators.push('maximum');
      if (type.includes('regex')) validators.push('regex');
      if (validators.length > 0) field.validators = validators;
    }

    // Detect nested model references
    if (/^[A-Z]/.test(type.split('[')[0].split('|')[0].trim())) {
      // Capitalize type likely references another model
      const cleanType = type.split('[')[0].split('|')[0].split('=')[0].trim();
      if (cleanType !== 'Optional' && cleanType !== 'List' && cleanType !== 'Dict' &&
          cleanType !== 'Set' && cleanType !== 'Tuple' && cleanType !== 'Any' &&
          cleanType !== 'Union' && cleanType !== 'str' && cleanType !== 'int' &&
          cleanType !== 'float' && cleanType !== 'bool' && cleanType !== 'bytes') {
        field.related_model = cleanType;
      }
    }

    fields.push(field);
  }

  return fields;
}

function extractPydanticConfig(cls: ClassInfo): Record<string, any> | undefined {
  const config: Record<string, any> = {};

  // Check for model_config or Config inner class
  for (const prop of cls.properties) {
    if (prop.name === 'model_config') {
      config.model_config = prop.type;
    }
  }

  // Check for common Config class properties
  for (const prop of cls.properties) {
    if (prop.name === 'from_attributes' || prop.name === 'orm_mode') {
      config.from_attributes = true;
    }
    if (prop.name === 'json_schema_extra') config.json_schema_extra = true;
    if (prop.name === 'env_prefix') config.env_prefix = prop.type;
    if (prop.name === 'env_file') config.env_file = prop.type;
  }

  return Object.keys(config).length > 0 ? config : undefined;
}

function extractRouteParams(func: FunctionInfo): RouteParam[] {
  const params: RouteParam[] = [];

  for (const param of func.params) {
    // Skip self, request, response, db
    if (['self', 'cls'].includes(param.name)) continue;

    const type = param.type || 'Any';
    let location: RouteParam['location'] = 'query';
    let isDependency = false;

    // Determine location from type annotation
    for (const [fastapiType, loc] of Object.entries(FASTAPI_PARAM_TYPES)) {
      if (type.includes(fastapiType)) {
        if (fastapiType === 'Depends') {
          isDependency = true;
        }
        location = loc;
        break;
      }
    }

    // Path parameters are in the route path (detected by {param} pattern)
    // We can't always detect this without the path, so default logic:
    // - If type is simple (int, str, UUID) and no Query/Body/etc, likely path param
    // This heuristic is improved when we have the actual route path

    if (!isDependency) {
      params.push({
        name: param.name,
        type: type,
        required: !param.optional && param.default === undefined,
        location,
        default: param.default,
      });
    }
  }

  return params;
}

function extractDependencies(func: FunctionInfo): string[] {
  const deps: string[] = [];

  for (const param of func.params) {
    const type = param.type || '';
    if (type.includes('Depends(')) {
      const match = type.match(/Depends\(\s*([^)]+)\s*\)/);
      if (match) {
        deps.push(match[1].trim());
      }
    }
  }

  return deps;
}

// ─── Router Prefix Tracking ───────────────────────────────────────────────

interface RouterInfo {
  name: string;
  prefix: string;
  tags: string[];
  file: string;
}

function extractRouters(parsed: ParsedFile[]): Map<string, RouterInfo> {
  const routers = new Map<string, RouterInfo>();

  for (const p of parsed) {
    if (p.file.language !== 'python') continue;

    // Look for APIRouter() instantiation in module-level assignments
    for (const func of p.functions) {
      // Check if function calls include APIRouter
      if (func.calls.some((c) => c.includes('APIRouter'))) {
        // This function likely creates a router
      }
    }

    // Check classes and module-level for router assignments
    for (const call of p.moduleCalls || []) {
      if (call.includes('APIRouter')) {
        const prefixMatch = call.match(/prefix\s*=\s*['"]([^'"]+)['"]/);
        const tagsMatch = call.match(/tags\s*=\s*\[([^\]]*)\]/);

        const router: RouterInfo = {
          name: 'router', // Default name
          prefix: prefixMatch?.[1] || '',
          tags: tagsMatch
            ? tagsMatch[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean)
            : [],
          file: p.file.relative,
        };

        routers.set(p.file.relative, router);
      }
    }
  }

  return routers;
}

// ─── FastAPI Enricher ──────────────────────────────────────────────────────

export class FastAPIEnricher implements FrameworkEnricher {
  readonly name = 'FastAPI Enricher';
  readonly framework = 'fastapi';

  canEnrich(frameworks: string[]): boolean {
    return frameworks.includes('fastapi');
  }

  async enrich(
    data: CodemapData,
    parsed: ParsedFile[],
    _config: CodemapConfig
  ): Promise<void> {
    const routes: RouteInfo[] = [];
    const models: Record<string, ModelInfo> = {};
    const middleware: Record<string, MiddlewareInfo> = {};
    const dependencies: DependencyInfo[] = [];
    const securitySchemes: string[] = [];

    // First pass: collect router prefixes
    const routers = extractRouters(parsed);

    for (const p of parsed) {
      if (p.file.language !== 'python') continue;

      const routerInfo = routers.get(p.file.relative);

      // ── Process functions (route handlers) ──
      for (const func of p.functions) {
        const funcDecorators: string[] = (func as any).decorators || [];

        let isRoute = false;
        let routeMethod = '';
        let routePath = '';
        let isWebSocket = false;
        let routeDecorator = '';

        // Check decorators for route patterns
        for (const d of funcDecorators) {
          if (isRouteDecorator(d)) {
            isRoute = true;
            routeDecorator = d;
            const method = extractRouteMethod(d);
            if (method === 'websocket') {
              isWebSocket = true;
              routeMethod = 'WEBSOCKET';
            } else if (method === 'api_route') {
              // api_route supports multiple methods
              const methods = extractListKwarg(d, 'methods');
              routeMethod = methods.length > 0 ? methods.join(',') : 'GET';
            } else {
              routeMethod = (method || 'GET').toUpperCase();
            }
            routePath = extractRoutePath(d);
            break;
          }
        }

        if (isRoute) {
          // Prepend router prefix if available
          const prefix = routerInfo?.prefix || '';
          const fullPath = prefix + routePath;

          const route: RouteInfo = {
            method: routeMethod.includes(',') ? routeMethod.split(',') : routeMethod,
            path: fullPath,
            handler: func.name,
            file: p.file.relative,
            decorators: funcDecorators,
            params: extractRouteParams(func),
            framework: 'fastapi',
            route_type: isWebSocket ? 'websocket' : 'api',
          };

          // Extract response_model
          const responseModel = extractDecoratorKwargValue(routeDecorator, 'response_model');
          if (responseModel) route.response_model = responseModel;

          // Extract status_code
          const statusCode = extractDecoratorKwargValue(routeDecorator, 'status_code');
          if (statusCode) {
            const parsed = parseInt(statusCode);
            if (!isNaN(parsed)) route.status_codes = [parsed];
          }

          // Extract tags
          const tags = extractListKwarg(routeDecorator, 'tags');
          if (tags.length > 0) {
            route.tags = tags;
          } else if (routerInfo?.tags.length) {
            route.tags = routerInfo.tags;
          }

          // Extract dependencies
          const deps = extractDependencies(func);
          if (deps.length > 0) route.dependencies = deps;

          // Check for auth-related dependencies
          const authDeps = deps.filter((d) =>
            d.toLowerCase().includes('auth') ||
            d.toLowerCase().includes('token') ||
            d.toLowerCase().includes('permission') ||
            d.toLowerCase().includes('current_user')
          );
          if (authDeps.length > 0) route.auth = authDeps;

          routes.push(route);
        }

        // Check for middleware decorator pattern
        for (const d of funcDecorators) {
          if (d.includes('middleware')) {
            const mw: MiddlewareInfo = {
              name: func.name,
              file: p.file.relative,
              framework: 'fastapi',
              type: 'function_middleware',
            };
            middleware[func.name] = mw;
          }
        }

        // Check for event handlers (startup/shutdown/lifespan)
        for (const d of funcDecorators) {
          const name = stripDecorator(d);
          if (name === 'on_event' || name === 'app.on_event') {
            const eventType = extractStringArg(extractDecoratorArgs(d));
            // Store as a special middleware-like entry
            const mw: MiddlewareInfo = {
              name: func.name,
              file: p.file.relative,
              framework: 'fastapi',
              type: 'function_middleware',
              methods: [eventType || 'lifecycle'],
            };
            middleware[`event:${func.name}`] = mw;
          }
        }

        // Check for exception handlers
        for (const d of funcDecorators) {
          if (d.includes('exception_handler')) {
            const mw: MiddlewareInfo = {
              name: func.name,
              file: p.file.relative,
              framework: 'fastapi',
              type: 'function_middleware',
              methods: ['exception_handler'],
            };
            middleware[`exception:${func.name}`] = mw;
          }
        }
      }

      // ── Process classes ──
      for (const cls of p.classes) {
        // Pydantic models
        if (isPydanticModel(cls)) {
          const fields = extractPydanticFields(cls);
          const config = extractPydanticConfig(cls);

          const model: ModelInfo = {
            name: cls.name,
            file: p.file.relative,
            framework: 'fastapi',
            kind: isPydanticSettings(cls) ? 'pydantic_settings' : 'pydantic_model',
            extends: cls.extends || undefined,
            fields,
            relationships: fields
              .filter((f) => f.related_model)
              .map((f) => f.related_model!),
            decorators: cls.decorators,
            config,
          };

          models[cls.name] = model;
        }

        // Middleware classes
        if (isFastAPIMiddleware(cls)) {
          const mw: MiddlewareInfo = {
            name: cls.name,
            file: p.file.relative,
            framework: 'fastapi',
            type: 'class_middleware',
            methods: cls.methods.map((m) => m.name),
          };
          middleware[cls.name] = mw;
        }

        // Security schemes
        if (SECURITY_CLASSES.has(cls.name) || SECURITY_CLASSES.has(cls.extends || '')) {
          securitySchemes.push(cls.name);
        }

        // Check for router class (CBV pattern with cbv decorator or similar)
        const hasRouteDecorators = cls.methods.some((m) =>
          m.decorators.some((d) => isRouteDecorator(d))
        );

        if (hasRouteDecorators) {
          for (const method of cls.methods) {
            for (const d of method.decorators) {
              if (isRouteDecorator(d)) {
                const httpMethod = extractRouteMethod(d);
                const path = extractRoutePath(d);
                const prefix = routerInfo?.prefix || '';

                routes.push({
                  method: (httpMethod || 'GET').toUpperCase(),
                  path: prefix + path,
                  handler: `${cls.name}.${method.name}`,
                  file: p.file.relative,
                  decorators: method.decorators,
                  params: [], // Methods need different param extraction
                  framework: 'fastapi',
                  route_type: httpMethod === 'websocket' ? 'websocket' : 'api',
                });
              }
            }
          }
        }
      }

      // ── Extract dependency providers ──
      for (const func of p.functions) {
        // A dependency provider is a function that's referenced in Depends()
        // We detect this by checking if any route's params reference this function
        const funcDeps = extractDependencies(func);
        if (funcDeps.length > 0 || func.calls.some((c) => c.includes('Depends'))) {
          // This function uses Depends(), might also be a dependency itself
        }
      }
    }

    // ── Build dependency graph ──
    // Scan all routes for Depends() references and build dependency tree
    const depProviders = new Set<string>();
    for (const route of routes) {
      if (route.dependencies) {
        for (const dep of route.dependencies) {
          depProviders.add(dep);
        }
      }
    }

    // Find dependency provider functions
    for (const p of parsed) {
      if (p.file.language !== 'python') continue;

      for (const func of p.functions) {
        if (depProviders.has(func.name)) {
          const subDeps = extractDependencies(func);
          const dep: DependencyInfo = {
            name: func.name,
            file: p.file.relative,
            framework: 'fastapi',
            return_type: func.return_type || 'Any',
            depends_on: subDeps,
            used_by: routes
              .filter((r) => r.dependencies?.includes(func.name))
              .map((r) => r.handler),
          };
          dependencies.push(dep);
        }
      }
    }

    // ── Detect security module-level variables ──
    for (const p of parsed) {
      if (p.file.language !== 'python') continue;
      for (const call of p.moduleCalls || []) {
        for (const secClass of SECURITY_CLASSES) {
          if (call.includes(secClass)) {
            securitySchemes.push(secClass);
          }
        }
      }
    }

    // ── Populate CodemapData ──
    data.routes.push(...routes);
    Object.assign(data.models, models);
    Object.assign(data.middleware, middleware);

    // Store extended data (use 'di_providers' to avoid collision with CodemapData.dependencies)
    (data as any).di_providers = [...((data as any).di_providers || []), ...dependencies];
    if (securitySchemes.length > 0) {
      (data as any).security_schemes = [...new Set(securitySchemes)];
    }
  }
}
