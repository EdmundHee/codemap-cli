/**
 * Nuxt Framework Enricher
 *
 * Extracts Nuxt-specific semantic data from already-parsed Vue/TS/JS files:
 * - Pages & file-based routing (pages/ directory → route extraction)
 * - Auto-imported composables (composables/ directory)
 * - Server API routes (server/api/ directory)
 * - Route middleware (middleware/ directory)
 * - Server middleware (server/middleware/ directory)
 * - Layouts (layouts/ directory)
 * - Plugins (plugins/ directory with mode detection)
 * - Components (components/ directory with auto-import)
 * - Stores (Pinia stores from stores/ or composables/)
 * - App config (app.config.ts, nuxt.config.ts)
 */

import { CodemapData } from '../output/json-generator';
import { ParsedFile, ClassInfo, FunctionInfo, ImportInfo } from '../parsers/parser.interface';
import { CodemapConfig } from '../core/config';
import {
  FrameworkEnricher,
  RouteInfo,
  RouteParam,
  ModelInfo,
  ModelFieldInfo,
  MiddlewareInfo,
  PluginInfo,
  LayoutInfo,
  ComponentInfo,
} from './enricher.interface';

// ─── Nuxt Convention Paths ─────────────────────────────────────────────────

const NUXT_DIRS = {
  pages: /^(?:src\/)?pages\//,
  components: /^(?:src\/)?components\//,
  composables: /^(?:src\/)?composables\//,
  middleware: /^(?:src\/)?middleware\//,
  layouts: /^(?:src\/)?layouts\//,
  plugins: /^(?:src\/)?plugins\//,
  serverApi: /^(?:src\/)?server\/api\//,
  serverMiddleware: /^(?:src\/)?server\/middleware\//,
  serverRoutes: /^(?:src\/)?server\/routes\//,
  serverPlugins: /^(?:src\/)?server\/plugins\//,
  stores: /^(?:src\/)?stores?\//,
  utils: /^(?:src\/)?utils\//,
};

// ─── Helper Functions ──────────────────────────────────────────────────────

/**
 * Convert a file path in pages/ directory to a Nuxt route path.
 * Handles dynamic segments ([id]), catch-all ([[...slug]]),
 * optional catch-all ([[...slug]]), and index files.
 */
function filePathToRoute(filePath: string): string {
  // Strip pages/ prefix and .vue extension
  let route = filePath
    .replace(/^(?:src\/)?pages\//, '')
    .replace(/\.vue$/, '')
    .replace(/\.tsx?$/, '');

  // Handle index files
  route = route.replace(/\/index$/, '');
  if (route === 'index') route = '';

  // Convert Nuxt dynamic segments to route params:
  // [...slug] → :slug(.*)*  (catch-all)
  // [[...slug]] → :slug(.*)* (optional catch-all)
  // [id] → :id
  // [[id]] → :id? (optional param)
  route = route
    .replace(/\[\[\.\.\.([^\]]+)\]\]/g, ':$1(.*)*') // optional catch-all
    .replace(/\[\.\.\.([^\]]+)\]/g, ':$1(.*)') // catch-all
    .replace(/\[\[([^\]]+)\]\]/g, ':$1?') // optional param
    .replace(/\[([^\]]+)\]/g, ':$1'); // required param

  return '/' + route;
}

/**
 * Convert a file path in server/api/ to an API route.
 */
function serverPathToRoute(filePath: string): string {
  let route = filePath
    .replace(/^(?:src\/)?server\/(?:api|routes)\//, '')
    .replace(/\.(?:ts|js|mjs)$/, '');

  // Handle index files
  route = route.replace(/\/index$/, '');
  if (route === 'index') route = '';

  // Dynamic segments same as pages
  route = route
    .replace(/\[\[\.\.\.([^\]]+)\]\]/g, ':$1(.*)*')
    .replace(/\[\.\.\.([^\]]+)\]/g, ':$1(.*)')
    .replace(/\[\[([^\]]+)\]\]/g, ':$1?')
    .replace(/\[([^\]]+)\]/g, ':$1');

  return '/api/' + route;
}

/**
 * Extract the component name from a file path.
 * components/UserCard.vue → UserCard
 * components/base/Button.vue → BaseButton (prefix with directory name)
 */
function componentNameFromPath(filePath: string): string {
  const stripped = filePath
    .replace(/^(?:src\/)?components\//, '')
    .replace(/\.vue$/, '')
    .replace(/\.tsx?$/, '');

  // Convert path segments to PascalCase component name
  return stripped
    .split('/')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/**
 * Extract composable name from file path.
 * composables/useAuth.ts → useAuth
 */
function composableNameFromPath(filePath: string): string {
  return filePath
    .replace(/^(?:src\/)?composables\//, '')
    .replace(/\.(?:ts|js|mjs)$/, '')
    .split('/')
    .pop() || '';
}

/**
 * Determine plugin mode from filename.
 * myPlugin.client.ts → client
 * myPlugin.server.ts → server
 * myPlugin.ts → universal
 */
function pluginMode(filePath: string): PluginInfo['mode'] {
  if (filePath.includes('.client.')) return 'client';
  if (filePath.includes('.server.')) return 'server';
  return 'universal';
}

/**
 * Extract plugin name from path.
 */
function pluginNameFromPath(filePath: string): string {
  return filePath
    .replace(/^(?:src\/)?plugins\//, '')
    .replace(/\.(client|server)/, '')
    .replace(/\.(?:ts|js|mjs)$/, '')
    .split('/')
    .pop() || '';
}

/**
 * Extract layout name from path.
 */
function layoutNameFromPath(filePath: string): string {
  return filePath
    .replace(/^(?:src\/)?layouts\//, '')
    .replace(/\.vue$/, '')
    .replace(/\.tsx?$/, '')
    .split('/')
    .pop() || '';
}

/**
 * Check if a parsed file contains definePageMeta() and extract layout/middleware.
 */
function extractPageMeta(parsed: ParsedFile): { layout?: string; middleware?: string[] } {
  const meta: { layout?: string; middleware?: string[] } = {};

  // Check functions for definePageMeta calls
  for (const func of parsed.functions) {
    if (func.calls.includes('definePageMeta')) {
      // Try to extract from function name or calls
    }
  }

  // Check module-level calls
  for (const call of parsed.moduleCalls || []) {
    if (call.includes('definePageMeta')) {
      const layoutMatch = call.match(/layout\s*:\s*['"]([^'"]+)['"]/);
      if (layoutMatch) meta.layout = layoutMatch[1];

      const mwMatch = call.match(/middleware\s*:\s*\[([^\]]*)\]/);
      if (mwMatch) {
        meta.middleware = mwMatch[1]
          .split(',')
          .map((s) => s.trim().replace(/['"]/g, ''))
          .filter(Boolean);
      }

      // Single middleware string
      const mwSingleMatch = call.match(/middleware\s*:\s*['"]([^'"]+)['"]/);
      if (mwSingleMatch && !meta.middleware) {
        meta.middleware = [mwSingleMatch[1]];
      }
    }
  }

  return meta;
}

/**
 * Extract HTTP method handlers from a server API file.
 * Nuxt server routes export defineEventHandler or method-specific handlers.
 */
function extractServerMethods(parsed: ParsedFile): string[] {
  const methods: string[] = [];

  for (const func of parsed.functions) {
    const name = func.name.toLowerCase();
    if (name === 'default' || name === 'handler') {
      // Default export → handles all methods
      methods.push('ALL');
    }
  }

  // Check for method-specific exports
  for (const exp of parsed.exports) {
    const name = exp.name.toLowerCase();
    if (['get', 'post', 'put', 'delete', 'patch', 'head', 'options'].includes(name)) {
      methods.push(name.toUpperCase());
    }
  }

  // Check for defineEventHandler in calls
  for (const func of parsed.functions) {
    if (func.calls.includes('defineEventHandler') || func.calls.includes('eventHandler')) {
      if (methods.length === 0) methods.push('ALL');
    }
  }

  // Check module-level calls
  for (const call of parsed.moduleCalls || []) {
    if (call.includes('defineEventHandler') || call.includes('eventHandler')) {
      if (methods.length === 0) methods.push('ALL');
    }
  }

  return methods.length > 0 ? methods : ['ALL'];
}

/**
 * Extract template component references from Vue parsed data.
 * These are stored in function calls as Vue template component usages.
 */
function extractTemplateComponents(parsed: ParsedFile): string[] {
  const components: string[] = [];

  // Component usages in Vue files appear as function calls from template analysis
  for (const func of parsed.functions) {
    for (const call of func.calls) {
      // PascalCase names that start with uppercase are likely component references
      if (/^[A-Z][a-zA-Z]+$/.test(call) && !call.includes('.')) {
        components.push(call);
      }
    }
  }

  // Also check module-level calls
  for (const call of parsed.moduleCalls || []) {
    if (/^[A-Z][a-zA-Z]+$/.test(call) && !call.includes('.')) {
      components.push(call);
    }
  }

  return [...new Set(components)];
}

/**
 * Check if a composable file defines a Pinia store.
 */
function isPiniaStore(parsed: ParsedFile): boolean {
  // Check imports for pinia
  const hasPiniaImport = parsed.imports.some(
    (imp) => imp.from === 'pinia' || imp.from === '#imports'
  );

  // Check for defineStore calls
  const hasDefineStore = parsed.functions.some((f) => f.calls.includes('defineStore'))
    || (parsed.moduleCalls || []).some((c) => c.includes('defineStore'));

  return hasPiniaImport && hasDefineStore;
}

/**
 * Extract store state, getters, and actions from a Pinia store.
 */
function extractStoreInfo(parsed: ParsedFile): { state: Record<string, string>; methods: string[] } {
  const state: Record<string, string> = {};
  const methods: string[] = [];

  // For composition API stores (setup stores), the exported function's
  // internal structure tells us about state and methods
  for (const func of parsed.functions) {
    if (func.exported || func.name.startsWith('use')) {
      // Refs and reactives become state
      for (const call of func.calls) {
        if (call === 'ref' || call === 'reactive' || call === 'computed') {
          // These create state/computed properties
        }
      }
    }
  }

  return { state, methods };
}

/**
 * Extract provides from a plugin file.
 */
function extractPluginProvides(parsed: ParsedFile): string[] {
  const provides: string[] = [];

  // Look for provide() or nuxtApp.provide() calls
  for (const func of parsed.functions) {
    for (const call of func.calls) {
      if (call.includes('provide')) {
        // Try to extract the key
        const match = call.match(/provide\s*\(\s*['"]([^'"]+)['"]/);
        if (match) provides.push(match[1]);
      }
    }
  }

  return provides;
}

// ─── Nuxt Enricher ─────────────────────────────────────────────────────────

export class NuxtEnricher implements FrameworkEnricher {
  readonly name = 'Nuxt Enricher';
  readonly framework = 'nuxt';

  canEnrich(frameworks: string[]): boolean {
    return frameworks.includes('nuxt');
  }

  async enrich(
    data: CodemapData,
    parsed: ParsedFile[],
    _config: CodemapConfig
  ): Promise<void> {
    const routes: RouteInfo[] = [];
    const models: Record<string, ModelInfo> = {};
    const middlewareMap: Record<string, MiddlewareInfo> = {};
    const plugins: PluginInfo[] = [];
    const layouts: LayoutInfo[] = [];
    const components: ComponentInfo[] = [];

    // Track layout usage for linking
    const layoutUsage: Record<string, string[]> = {};
    // Track component usage for linking
    const componentUsage: Record<string, string[]> = {};

    for (const p of parsed) {
      const filePath = p.file.relative;

      // ── Pages (file-based routing) ──
      if (NUXT_DIRS.pages.test(filePath)) {
        const routePath = filePathToRoute(filePath);
        const pageMeta = extractPageMeta(p);
        const templateComponents = extractTemplateComponents(p);

        const route: RouteInfo = {
          method: 'GET',
          path: routePath,
          handler: filePath,
          file: filePath,
          decorators: [],
          params: [],
          framework: 'nuxt',
          route_type: 'page',
          layout: pageMeta.layout || 'default',
          middleware: pageMeta.middleware,
          components: templateComponents,
        };

        // Extract route params from path
        const paramMatches = routePath.matchAll(/:([^(/]+)/g);
        for (const match of paramMatches) {
          const paramName = match[1].replace('?', '');
          route.params.push({
            name: paramName,
            type: 'string',
            required: !match[1].endsWith('?'),
            location: 'path',
          });
        }

        routes.push(route);

        // Track layout usage
        const layout = pageMeta.layout || 'default';
        if (!layoutUsage[layout]) layoutUsage[layout] = [];
        layoutUsage[layout].push(filePath);

        // Track component usage
        for (const comp of templateComponents) {
          if (!componentUsage[comp]) componentUsage[comp] = [];
          componentUsage[comp].push(filePath);
        }
      }

      // ── Server API routes ──
      if (NUXT_DIRS.serverApi.test(filePath) || NUXT_DIRS.serverRoutes.test(filePath)) {
        const routePath = serverPathToRoute(filePath);
        const methods = extractServerMethods(p);

        for (const method of methods) {
          routes.push({
            method,
            path: routePath,
            handler: filePath,
            file: filePath,
            decorators: [],
            params: [],
            framework: 'nuxt',
            route_type: 'api',
          });
        }
      }

      // ── Composables ──
      if (NUXT_DIRS.composables.test(filePath)) {
        const composableName = composableNameFromPath(filePath);
        const isStore = isPiniaStore(p);

        if (isStore) {
          // Pinia store
          const storeInfo = extractStoreInfo(p);
          models[composableName] = {
            name: composableName,
            file: filePath,
            framework: 'nuxt',
            kind: 'store',
            fields: Object.entries(storeInfo.state).map(([name, type]) => ({
              name,
              type,
              required: true,
            })),
            relationships: [],
            state: storeInfo.state,
            methods: storeInfo.methods,
          };
        } else {
          // Regular composable
          const exportedFuncs = p.functions.filter((f) => f.exported || f.name.startsWith('use'));

          for (const func of exportedFuncs) {
            models[func.name] = {
              name: func.name,
              file: filePath,
              framework: 'nuxt',
              kind: 'composable',
              fields: func.params.map((param) => ({
                name: param.name,
                type: param.type || 'any',
                required: !param.optional,
              })),
              relationships: [],
              methods: func.calls.filter((c) => !c.includes('.')),
            };
          }
        }
      }

      // ── Stores (dedicated store directory) ──
      if (NUXT_DIRS.stores.test(filePath) && !NUXT_DIRS.composables.test(filePath)) {
        if (isPiniaStore(p)) {
          const storeName = filePath.split('/').pop()?.replace(/\.(?:ts|js)$/, '') || '';
          const storeInfo = extractStoreInfo(p);
          models[storeName] = {
            name: storeName,
            file: filePath,
            framework: 'nuxt',
            kind: 'store',
            fields: Object.entries(storeInfo.state).map(([name, type]) => ({
              name,
              type,
              required: true,
            })),
            relationships: [],
            state: storeInfo.state,
            methods: storeInfo.methods,
          };
        }
      }

      // ── Route Middleware ──
      if (NUXT_DIRS.middleware.test(filePath)) {
        const mwName = filePath
          .replace(/^(?:src\/)?middleware\//, '')
          .replace(/\.(?:ts|js|mjs)$/, '')
          .replace(/\.global$/, '');

        const isGlobal = filePath.includes('.global.');

        middlewareMap[mwName] = {
          name: mwName,
          file: filePath,
          framework: 'nuxt',
          type: 'route_middleware',
          global: isGlobal,
        };
      }

      // ── Server Middleware ──
      if (NUXT_DIRS.serverMiddleware.test(filePath)) {
        const mwName = filePath
          .replace(/^(?:src\/)?server\/middleware\//, '')
          .replace(/\.(?:ts|js|mjs)$/, '');

        middlewareMap[`server:${mwName}`] = {
          name: mwName,
          file: filePath,
          framework: 'nuxt',
          type: 'server_middleware',
        };
      }

      // ── Layouts ──
      if (NUXT_DIRS.layouts.test(filePath)) {
        const layoutName = layoutNameFromPath(filePath);
        layouts.push({
          name: layoutName,
          file: filePath,
          used_by: layoutUsage[layoutName] || [],
        });
      }

      // ── Plugins ──
      if (NUXT_DIRS.plugins.test(filePath)) {
        const pluginName = pluginNameFromPath(filePath);
        const mode = pluginMode(filePath);
        const provides = extractPluginProvides(p);

        plugins.push({
          name: pluginName,
          file: filePath,
          framework: 'nuxt',
          mode,
          provides: provides.length > 0 ? provides : undefined,
        });
      }

      // ── Components ──
      if (NUXT_DIRS.components.test(filePath)) {
        const compName = componentNameFromPath(filePath);

        // Extract props and emits
        const props: ComponentInfo['props'] = [];
        const emits: string[] = [];

        // Check for defineProps
        for (const func of p.functions) {
          if (func.name === '__props' || func.calls.includes('defineProps')) {
            // Props are typically in the function params or types
            for (const param of func.params) {
              props.push({
                name: param.name,
                type: param.type || 'any',
                required: !param.optional,
              });
            }
          }
        }

        // Check types for props interface
        for (const type of p.types) {
          if (type.name === 'Props' || type.name.endsWith('Props')) {
            for (const prop of type.properties) {
              props.push({
                name: prop.name,
                type: prop.type || 'any',
                required: !prop.optional,
              });
            }
          }
        }

        // Check for defineEmits
        for (const func of p.functions) {
          if (func.name === '__emit' || func.calls.includes('defineEmits')) {
            // Emit names are typically in the function params
          }
        }

        components.push({
          name: compName,
          file: filePath,
          auto_imported: true,
          props: props.length > 0 ? props : undefined,
          emits: emits.length > 0 ? emits : undefined,
          used_by: componentUsage[compName] || [],
        });
      }
    }

    // ── Second pass: resolve layout and component usage ──
    for (const layout of layouts) {
      layout.used_by = layoutUsage[layout.name] || [];
    }
    for (const component of components) {
      component.used_by = componentUsage[component.name] || [];
    }

    // ── TypeScript interfaces and types as models ──
    for (const p of parsed) {
      const filePath = p.file.relative;

      // Only process types from types/ or specific directories
      if (filePath.includes('types/') || filePath.includes('interfaces/')) {
        for (const type of p.types) {
          if (type.exported) {
            models[type.name] = {
              name: type.name,
              file: filePath,
              framework: 'nuxt',
              kind: type.kind === 'interface' ? 'interface' : 'type_alias',
              fields: type.properties.map((prop) => ({
                name: prop.name,
                type: prop.type || 'any',
                required: !prop.optional,
              })),
              relationships: [],
            };
          }
        }
      }
    }

    // ── Populate CodemapData ──
    data.routes.push(...routes);
    Object.assign(data.models, models);
    Object.assign(data.middleware, middlewareMap);

    // Store extended Nuxt-specific data
    (data as any).plugins = [...((data as any).plugins || []), ...plugins];
    (data as any).layouts = [...((data as any).layouts || []), ...layouts];
    (data as any).components = [...((data as any).components || []), ...components];
  }
}
