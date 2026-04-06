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

const NON_MODEL_TYPES = new Set([
  'Optional', 'List', 'Dict', 'Set', 'Tuple', 'Any',
  'Union', 'str', 'int', 'float', 'bool', 'bytes',
]);

function detectOptionalAndDefault(field: ModelFieldInfo, type: string): void {
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
}

function detectFieldValidators(field: ModelFieldInfo, type: string): void {
  if (!type.includes('Field(')) return;
  const validators: string[] = [];
  if (type.includes('min_length')) validators.push('min_length');
  if (type.includes('max_length')) validators.push('max_length');
  if (type.includes('ge=') || type.includes('gt=')) validators.push('minimum');
  if (type.includes('le=') || type.includes('lt=')) validators.push('maximum');
  if (type.includes('regex')) validators.push('regex');
  if (validators.length > 0) field.validators = validators;
}

function detectRelatedModel(field: ModelFieldInfo, type: string): void {
  if (!/^[A-Z]/.test(type.split('[')[0].split('|')[0].trim())) return;
  const cleanType = type.split('[')[0].split('|')[0].split('=')[0].trim();
  if (!NON_MODEL_TYPES.has(cleanType)) {
    field.related_model = cleanType;
  }
}

function extractPydanticFields(cls: ClassInfo): ModelFieldInfo[] {
  const fields: ModelFieldInfo[] = [];

  for (const prop of cls.properties) {
    const field: ModelFieldInfo = {
      name: prop.name,
      type: prop.type || 'Any',
      required: true,
    };

    const type = prop.type || '';
    detectOptionalAndDefault(field, type);
    detectFieldValidators(field, type);
    detectRelatedModel(field, type);

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

// ─── Phase Extraction Helpers ─────────────────────────────────────────────

interface ParsedRouteDecorator {
  decorator: string;
  method: string;
  path: string;
  isWebSocket: boolean;
}

/**
 * Scan function decorators for a FastAPI route decorator and extract its method/path.
 * Returns null if no route decorator found.
 */
function parseRouteDecorator(funcDecorators: string[]): ParsedRouteDecorator | null {
  for (const d of funcDecorators) {
    if (isRouteDecorator(d)) {
      const method = extractRouteMethod(d);
      let routeMethod: string;
      let isWebSocket = false;

      if (method === 'websocket') {
        isWebSocket = true;
        routeMethod = 'WEBSOCKET';
      } else if (method === 'api_route') {
        const methods = extractListKwarg(d, 'methods');
        routeMethod = methods.length > 0 ? methods.join(',') : 'GET';
      } else {
        routeMethod = (method || 'GET').toUpperCase();
      }

      return { decorator: d, method: routeMethod, path: extractRoutePath(d), isWebSocket };
    }
  }
  return null;
}

/**
 * Enrich a RouteInfo with metadata extracted from the route decorator
 * (response_model, status_code, tags, dependencies, auth).
 */
function enrichRouteMetadata(
  route: RouteInfo,
  routeDecorator: string,
  func: FunctionInfo,
  routerInfo: RouterInfo | undefined
): void {
  const responseModel = extractDecoratorKwargValue(routeDecorator, 'response_model');
  if (responseModel) route.response_model = responseModel;

  const statusCode = extractDecoratorKwargValue(routeDecorator, 'status_code');
  if (statusCode) {
    const parsed = parseInt(statusCode);
    if (!isNaN(parsed)) route.status_codes = [parsed];
  }

  const tags = extractListKwarg(routeDecorator, 'tags');
  if (tags.length > 0) {
    route.tags = tags;
  } else if (routerInfo?.tags.length) {
    route.tags = routerInfo.tags;
  }

  const deps = extractDependencies(func);
  if (deps.length > 0) route.dependencies = deps;

  const authDeps = deps.filter((d) =>
    d.toLowerCase().includes('auth') ||
    d.toLowerCase().includes('token') ||
    d.toLowerCase().includes('permission') ||
    d.toLowerCase().includes('current_user')
  );
  if (authDeps.length > 0) route.auth = authDeps;
}

function extractRoutesFromFunction(
  func: FunctionInfo,
  filePath: string,
  routerInfo: RouterInfo | undefined
): { route?: RouteInfo; middleware: Record<string, MiddlewareInfo> } {
  const funcDecorators: string[] = (func as any).decorators || [];
  const middlewareResult: Record<string, MiddlewareInfo> = {};

  const parsed = parseRouteDecorator(funcDecorators);
  if (!parsed) {
    return { route: undefined, middleware: middlewareResult };
  }

  const prefix = routerInfo?.prefix || '';
  const fullPath = prefix + parsed.path;

  const route: RouteInfo = {
    method: parsed.method.includes(',') ? parsed.method.split(',') : parsed.method,
    path: fullPath,
    handler: func.name,
    file: filePath,
    decorators: funcDecorators,
    params: extractRouteParams(func),
    framework: 'fastapi',
    route_type: parsed.isWebSocket ? 'websocket' : 'api',
  };

  enrichRouteMetadata(route, parsed.decorator, func, routerInfo);

  return { route, middleware: middlewareResult };
}

function extractMiddlewareFromFunction(
  func: FunctionInfo,
  filePath: string
): Record<string, MiddlewareInfo> {
  const result: Record<string, MiddlewareInfo> = {};
  const funcDecorators: string[] = (func as any).decorators || [];

  // Check for middleware decorator pattern
  for (const d of funcDecorators) {
    if (d.includes('middleware')) {
      const mw: MiddlewareInfo = {
        name: func.name,
        file: filePath,
        framework: 'fastapi',
        type: 'function_middleware',
      };
      result[func.name] = mw;
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
        file: filePath,
        framework: 'fastapi',
        type: 'function_middleware',
        methods: [eventType || 'lifecycle'],
      };
      result[`event:${func.name}`] = mw;
    }
  }

  // Check for exception handlers
  for (const d of funcDecorators) {
    if (d.includes('exception_handler')) {
      const mw: MiddlewareInfo = {
        name: func.name,
        file: filePath,
        framework: 'fastapi',
        type: 'function_middleware',
        methods: ['exception_handler'],
      };
      result[`exception:${func.name}`] = mw;
    }
  }

  return result;
}

function extractClassEntities(
  cls: ClassInfo,
  filePath: string,
  routerInfo: RouterInfo | undefined
): {
  routes: RouteInfo[];
  model?: ModelInfo;
  middleware?: MiddlewareInfo;
  securitySchemes: string[];
} {
  const routes: RouteInfo[] = [];
  const securitySchemes: string[] = [];
  let model: ModelInfo | undefined;
  let mw: MiddlewareInfo | undefined;

  // Pydantic models
  if (isPydanticModel(cls)) {
    const fields = extractPydanticFields(cls);
    const config = extractPydanticConfig(cls);

    model = {
      name: cls.name,
      file: filePath,
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
  }

  // Middleware classes
  if (isFastAPIMiddleware(cls)) {
    mw = {
      name: cls.name,
      file: filePath,
      framework: 'fastapi',
      type: 'class_middleware',
      methods: cls.methods.map((m) => m.name),
    };
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
            file: filePath,
            decorators: method.decorators,
            params: [], // Methods need different param extraction
            framework: 'fastapi',
            route_type: httpMethod === 'websocket' ? 'websocket' : 'api',
          });
        }
      }
    }
  }

  return { routes, model, middleware: mw, securitySchemes };
}

function buildDependencyGraph(
  routes: RouteInfo[],
  parsed: ParsedFile[]
): DependencyInfo[] {
  const dependencies: DependencyInfo[] = [];

  // First pass: collect dependency names from routes
  const depProviders = new Set<string>();
  for (const route of routes) {
    if (route.dependencies) {
      for (const dep of route.dependencies) {
        depProviders.add(dep);
      }
    }
  }

  // Second pass: find provider functions
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

  return dependencies;
}

function extractModuleLevelSecurity(parsed: ParsedFile[]): string[] {
  const securitySchemes: string[] = [];

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

  return securitySchemes;
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
    const securitySchemes: string[] = [];

    // First pass: collect router prefixes
    const routers = extractRouters(parsed);

    for (const p of parsed) {
      if (p.file.language !== 'python') continue;

      const routerInfo = routers.get(p.file.relative);

      // ── Process functions (route handlers) ──
      for (const func of p.functions) {
        const { route, middleware: routeMw } = extractRoutesFromFunction(func, p.file.relative, routerInfo);
        if (route) routes.push(route);
        Object.assign(middleware, routeMw);

        const funcMw = extractMiddlewareFromFunction(func, p.file.relative);
        Object.assign(middleware, funcMw);
      }

      // ── Process classes ──
      for (const cls of p.classes) {
        const result = extractClassEntities(cls, p.file.relative, routerInfo);
        routes.push(...result.routes);
        if (result.model) models[result.model.name] = result.model;
        if (result.middleware) middleware[result.middleware.name] = result.middleware;
        securitySchemes.push(...result.securitySchemes);
      }
    }

    // ── Build dependency graph ──
    const dependencies = buildDependencyGraph(routes, parsed);

    // ── Detect security module-level variables ──
    securitySchemes.push(...extractModuleLevelSecurity(parsed));

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
