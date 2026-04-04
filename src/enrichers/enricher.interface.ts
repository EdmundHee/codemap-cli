/**
 * Framework enricher interface and shared types.
 *
 * Enrichers run after the core parsing pipeline to extract framework-specific
 * semantic data (routes, models, middleware, signals, etc.) from already-parsed
 * files. They populate the `routes`, `models`, and `middleware` fields of
 * CodemapData that the core pipeline leaves empty.
 */

import { CodemapData } from '../output/json-generator';
import { ParsedFile } from '../parsers/parser.interface';
import { CodemapConfig } from '../core/config';

// ─── Route Types ───────────────────────────────────────────────────────────

export interface RouteParam {
  name: string;
  type: string;
  required: boolean;
  location: 'path' | 'query' | 'body' | 'header' | 'cookie' | 'form';
  default?: string;
}

export interface RouteInfo {
  /** HTTP method(s): GET, POST, PUT, DELETE, PATCH, etc. */
  method: string | string[];
  /** URL path pattern, e.g. /api/users/{id} */
  path: string;
  /** Handler function or method name */
  handler: string;
  /** File where the handler is defined */
  file: string;
  /** Decorators applied to the handler */
  decorators: string[];
  /** Extracted parameters */
  params: RouteParam[];
  /** Response model/type name */
  response_model?: string;
  /** Response status code(s) */
  status_codes?: number[];
  /** Authentication/authorization requirements */
  auth?: string[];
  /** Middleware applied to this route */
  middleware?: string[];
  /** Framework source: django, fastapi, nuxt */
  framework: string;
  /** Route type for framework-specific categorization */
  route_type?: 'view' | 'api' | 'page' | 'websocket' | 'ssr' | 'static';
  /** For Nuxt: layout applied to this page */
  layout?: string;
  /** For Nuxt: components used in this page's template */
  components?: string[];
  /** For Django: URL name for reverse() lookup */
  url_name?: string;
  /** For Django: namespace for URL include() */
  namespace?: string;
  /** For FastAPI: dependency injection chain */
  dependencies?: string[];
  /** For FastAPI: tags for OpenAPI grouping */
  tags?: string[];
}

// ─── Model Types ───────────────────────────────────────────────────────────

export interface ModelFieldInfo {
  name: string;
  type: string;
  required: boolean;
  default?: string;
  /** For Django: field options like max_length, unique, etc. */
  options?: Record<string, any>;
  /** For Django: related model name for FK/M2M */
  related_model?: string;
  /** For Django: relationship type */
  relationship?: 'foreign_key' | 'one_to_one' | 'many_to_many' | 'generic_relation';
  /** Validators applied */
  validators?: string[];
}

export interface ModelInfo {
  /** Model/schema class name */
  name: string;
  /** File where defined */
  file: string;
  /** Framework: django, fastapi, nuxt */
  framework: string;
  /** What kind of model this is */
  kind:
    | 'django_model'
    | 'django_abstract_model'
    | 'django_proxy_model'
    | 'pydantic_model'
    | 'pydantic_settings'
    | 'sqlalchemy_model'
    | 'interface'
    | 'type_alias'
    | 'composable'
    | 'store';
  /** Parent class or model */
  extends?: string;
  /** Extracted fields */
  fields: ModelFieldInfo[];
  /** For Django: Meta options (db_table, ordering, etc.) */
  meta?: Record<string, any>;
  /** For Django: custom managers */
  managers?: string[];
  /** Models this one references (FK targets, nested schemas) */
  relationships: string[];
  /** Decorators applied to the class */
  decorators?: string[];
  /** For Django: registered in admin.py */
  admin_registered?: boolean;
  /** For Django serializers: model this serializer maps to */
  serializer_model?: string;
  /** For Pydantic: model_config or Config class options */
  config?: Record<string, any>;
  /** For Nuxt composables: state variables */
  state?: Record<string, string>;
  /** For Nuxt composables: exported methods */
  methods?: string[];
}

// ─── Middleware Types ───────────────────────────────────────────────────────

export interface MiddlewareInfo {
  /** Middleware name (class or function) */
  name: string;
  /** File where defined */
  file: string;
  /** Framework: django, fastapi, nuxt */
  framework: string;
  /** Type categorization */
  type:
    | 'class_middleware'
    | 'function_middleware'
    | 'decorator_middleware'
    | 'route_middleware'
    | 'http_middleware'
    | 'server_middleware';
  /** Lifecycle methods for class-based middleware */
  methods?: string[];
  /** For Django: order in MIDDLEWARE list */
  order?: number;
  /** For Nuxt: whether this is global or route-specific */
  global?: boolean;
}

// ─── Signal/Event Types ────────────────────────────────────────────────────

export interface SignalInfo {
  /** Signal name: pre_save, post_save, etc. */
  signal: string;
  /** Receiver function name */
  receiver: string;
  /** File where receiver is defined */
  file: string;
  /** Framework: django */
  framework: string;
  /** Sender model/class (if specified) */
  sender?: string;
}

// ─── Dependency Injection Types ────────────────────────────────────────────

export interface DependencyInfo {
  /** Dependency provider function name */
  name: string;
  /** File where defined */
  file: string;
  /** Framework: fastapi */
  framework: string;
  /** Return type of the dependency */
  return_type: string;
  /** Sub-dependencies this one depends on */
  depends_on: string[];
  /** Routes that use this dependency */
  used_by: string[];
  /** Scope: request, session, application */
  scope?: string;
}

// ─── Admin Types ───────────────────────────────────────────────────────────

export interface AdminRegistration {
  /** ModelAdmin class name */
  admin_class: string;
  /** Model being administered */
  model: string;
  /** File where registered */
  file: string;
  /** Custom admin options found */
  options: {
    list_display?: string[];
    list_filter?: string[];
    search_fields?: string[];
    inlines?: string[];
    readonly_fields?: string[];
    fieldsets?: boolean;
    actions?: string[];
  };
}

// ─── Form Types ────────────────────────────────────────────────────────────

export interface FormInfo {
  /** Form class name */
  name: string;
  /** File where defined */
  file: string;
  /** Framework: django */
  framework: string;
  /** Form kind */
  kind: 'form' | 'model_form' | 'formset' | 'inline_formset';
  /** For ModelForm: model it maps to */
  model?: string;
  /** Explicit fields */
  fields: ModelFieldInfo[];
  /** Meta.fields or Meta.exclude */
  meta_fields?: string[] | '__all__';
  /** Meta.exclude */
  meta_exclude?: string[];
  /** Custom validation methods (clean_*) */
  validators?: string[];
}

// ─── Management Command Types ──────────────────────────────────────────────

export interface ManagementCommandInfo {
  /** Command name (from filename) */
  name: string;
  /** File where defined */
  file: string;
  /** Help text from class attribute */
  help?: string;
  /** Arguments defined in add_arguments */
  arguments?: Array<{ name: string; type: string; required: boolean }>;
}

// ─── Template Tag Types ────────────────────────────────────────────────────

export interface TemplateTagInfo {
  /** Tag/filter name */
  name: string;
  /** File where defined */
  file: string;
  /** Tag kind */
  kind: 'simple_tag' | 'inclusion_tag' | 'filter' | 'assignment_tag' | 'block_tag';
  /** Function implementing the tag */
  handler: string;
}

// ─── Nuxt Plugin Types ─────────────────────────────────────────────────────

export interface PluginInfo {
  /** Plugin name (from filename) */
  name: string;
  /** File where defined */
  file: string;
  /** Framework: nuxt */
  framework: string;
  /** Execution mode */
  mode?: 'client' | 'server' | 'universal';
  /** Provides injected into NuxtApp */
  provides?: string[];
}

// ─── Nuxt Layout Types ─────────────────────────────────────────────────────

export interface LayoutInfo {
  /** Layout name (from filename) */
  name: string;
  /** File where defined */
  file: string;
  /** Pages that use this layout */
  used_by: string[];
}

// ─── Nuxt Component Types ──────────────────────────────────────────────────

export interface ComponentInfo {
  /** Component name (PascalCase) */
  name: string;
  /** File where defined */
  file: string;
  /** Whether auto-imported by Nuxt */
  auto_imported: boolean;
  /** Props (from defineProps) */
  props?: Array<{ name: string; type: string; required: boolean }>;
  /** Emits (from defineEmits) */
  emits?: string[];
  /** Pages/components that use this component */
  used_by: string[];
}

// ─── Enriched Data Aggregate ───────────────────────────────────────────────

export interface EnrichedFrameworkData {
  routes: RouteInfo[];
  models: Record<string, ModelInfo>;
  middleware: Record<string, MiddlewareInfo>;
  signals?: SignalInfo[];
  dependencies?: DependencyInfo[];
  admin?: AdminRegistration[];
  forms?: FormInfo[];
  management_commands?: ManagementCommandInfo[];
  template_tags?: TemplateTagInfo[];
  plugins?: PluginInfo[];
  layouts?: LayoutInfo[];
  components?: ComponentInfo[];
}

// ─── Enricher Interface ────────────────────────────────────────────────────

export interface FrameworkEnricher {
  /** Human-readable enricher name */
  readonly name: string;

  /** Framework identifier (django, fastapi, nuxt) */
  readonly framework: string;

  /**
   * Check if this enricher should run for the given project.
   * @param frameworks List of detected framework names
   */
  canEnrich(frameworks: string[]): boolean;

  /**
   * Extract framework-specific data from parsed files and enrich CodemapData.
   * Modifies `data.routes`, `data.models`, `data.middleware` in place.
   * May also populate extended framework data on `data` via type assertion.
   */
  enrich(
    data: CodemapData,
    parsed: ParsedFile[],
    config: CodemapConfig
  ): Promise<void>;
}
