/**
 * Django Framework Enricher
 *
 * Extracts Django-specific semantic data from already-parsed Python files:
 * - Models (fields, relationships, Meta, managers, abstract/proxy)
 * - Views (function-based and class-based, with URL linking)
 * - URL patterns (path(), re_path(), include())
 * - Signals (receivers with sender detection)
 * - Middleware (class and function-based)
 * - Admin registrations (ModelAdmin with options)
 * - Forms (Form, ModelForm with Meta)
 * - Serializers (DRF serializers with field extraction)
 * - Management commands (from management/commands/)
 * - Template tags and filters (from templatetags/)
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
  SignalInfo,
  AdminRegistration,
  FormInfo,
  ManagementCommandInfo,
  TemplateTagInfo,
} from './enricher.interface';

// ─── Django Base Classes ───────────────────────────────────────────────────

const DJANGO_MODEL_BASES = new Set([
  'Model', 'models.Model', 'django.db.models.Model',
  'AbstractUser', 'AbstractBaseUser', 'PermissionsMixin',
  'TimeStampedModel', 'UUIDModel',
]);

const DJANGO_ABSTRACT_INDICATORS = ['abstract = True', 'abstract=True'];

const DJANGO_VIEW_BASES = new Set([
  'View', 'TemplateView', 'DetailView', 'ListView', 'CreateView',
  'UpdateView', 'DeleteView', 'FormView', 'RedirectView', 'ArchiveIndexView',
  'YearArchiveView', 'MonthArchiveView', 'DayArchiveView', 'DateDetailView',
  'GenericAPIView', 'APIView',
  'ViewSet', 'ModelViewSet', 'ReadOnlyModelViewSet', 'GenericViewSet',
  'ListAPIView', 'RetrieveAPIView', 'CreateAPIView', 'DestroyAPIView',
  'UpdateAPIView', 'ListCreateAPIView', 'RetrieveUpdateAPIView',
  'RetrieveDestroyAPIView', 'RetrieveUpdateDestroyAPIView',
]);

const DJANGO_MIDDLEWARE_BASES = new Set([
  'MiddlewareMixin', 'BaseMiddleware',
]);

const DJANGO_FORM_BASES = new Set([
  'Form', 'forms.Form', 'ModelForm', 'forms.ModelForm',
  'BaseForm', 'BaseModelForm',
]);

const DJANGO_SERIALIZER_BASES = new Set([
  'Serializer', 'ModelSerializer', 'HyperlinkedModelSerializer',
  'ListSerializer', 'BaseSerializer',
  'serializers.Serializer', 'serializers.ModelSerializer',
  'serializers.HyperlinkedModelSerializer',
]);

const DJANGO_ADMIN_BASES = new Set([
  'ModelAdmin', 'admin.ModelAdmin',
  'TabularInline', 'StackedInline', 'admin.TabularInline', 'admin.StackedInline',
]);

const DJANGO_FIELD_TYPES = new Set([
  'CharField', 'TextField', 'IntegerField', 'FloatField', 'DecimalField',
  'BooleanField', 'NullBooleanField', 'DateField', 'DateTimeField',
  'TimeField', 'DurationField', 'EmailField', 'URLField', 'UUIDField',
  'SlugField', 'FileField', 'ImageField', 'FilePathField', 'BinaryField',
  'BigIntegerField', 'SmallIntegerField', 'PositiveIntegerField',
  'PositiveSmallIntegerField', 'PositiveBigIntegerField', 'BigAutoField',
  'AutoField', 'SmallAutoField', 'IPAddressField', 'GenericIPAddressField',
  'JSONField', 'ArrayField', 'HStoreField',
]);

const DJANGO_RELATIONSHIP_FIELDS: Record<string, ModelFieldInfo['relationship']> = {
  'ForeignKey': 'foreign_key',
  'OneToOneField': 'one_to_one',
  'ManyToManyField': 'many_to_many',
  'GenericForeignKey': 'generic_relation',
  'GenericRelation': 'generic_relation',
};

const DJANGO_SIGNALS = new Set([
  'pre_save', 'post_save', 'pre_delete', 'post_delete',
  'm2m_changed', 'pre_init', 'post_init', 'pre_migrate', 'post_migrate',
  'request_started', 'request_finished', 'got_request_exception',
  'setting_changed', 'connection_created',
]);

const VIEW_DECORATORS = new Set([
  'login_required', 'permission_required', 'user_passes_test',
  'csrf_exempt', 'csrf_protect', 'require_http_methods',
  'require_GET', 'require_POST', 'require_safe',
  'api_view', 'action', 'throttle_classes', 'permission_classes',
  'authentication_classes', 'renderer_classes', 'parser_classes',
]);

// ─── Helper Functions ──────────────────────────────────────────────────────

function stripDecorator(d: string): string {
  // Remove @ prefix and extract just the name (before parentheses)
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

function extractListArgs(args: string): string[] {
  const match = args.match(/\[([^\]]*)\]/);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((s) => s.trim().replace(/['"]/g, ''))
    .filter(Boolean);
}

function isViewFunction(func: FunctionInfo, imports: ImportInfo[]): boolean {
  // Check if function has view-related decorators
  for (const d of (func as any).decorators || []) {
    const name = stripDecorator(d);
    if (VIEW_DECORATORS.has(name) || name === 'api_view') return true;
  }

  // Check if first param is 'request'
  if (func.params.length > 0 && func.params[0].name === 'request') {
    // Check return type or calls for HttpResponse patterns
    if (func.calls.some((c) =>
      c.includes('render') || c.includes('HttpResponse') ||
      c.includes('JsonResponse') || c.includes('redirect') ||
      c.includes('Response')
    )) {
      return true;
    }
  }

  return false;
}

function isViewClass(cls: ClassInfo): boolean {
  if (!cls.extends) return false;
  const base = cls.extends.split('.').pop() || cls.extends;
  return DJANGO_VIEW_BASES.has(base) || DJANGO_VIEW_BASES.has(cls.extends);
}

function isDjangoModel(cls: ClassInfo): boolean {
  if (!cls.extends) return false;
  const base = cls.extends.split('.').pop() || cls.extends;
  return DJANGO_MODEL_BASES.has(base) || DJANGO_MODEL_BASES.has(cls.extends);
}

function isDjangoForm(cls: ClassInfo): boolean {
  if (!cls.extends) return false;
  const base = cls.extends.split('.').pop() || cls.extends;
  return DJANGO_FORM_BASES.has(base) || DJANGO_FORM_BASES.has(cls.extends);
}

function isSerializer(cls: ClassInfo): boolean {
  if (!cls.extends) return false;
  const base = cls.extends.split('.').pop() || cls.extends;
  return DJANGO_SERIALIZER_BASES.has(base) || DJANGO_SERIALIZER_BASES.has(cls.extends);
}

function isAdminClass(cls: ClassInfo): boolean {
  if (!cls.extends) return false;
  const base = cls.extends.split('.').pop() || cls.extends;
  return DJANGO_ADMIN_BASES.has(base) || DJANGO_ADMIN_BASES.has(cls.extends);
}

function isMiddlewareClass(cls: ClassInfo): boolean {
  if (!cls.extends) return false;
  const base = cls.extends.split('.').pop() || cls.extends;
  if (DJANGO_MIDDLEWARE_BASES.has(base)) return true;

  // Also check for __call__ method pattern (ASGI/WSGI middleware)
  const hasCall = cls.methods.some((m) => m.name === '__call__');
  const hasInit = cls.methods.some((m) => m.name === '__init__');
  return hasCall && hasInit;
}

function extractModelFields(cls: ClassInfo): ModelFieldInfo[] {
  const fields: ModelFieldInfo[] = [];

  for (const prop of cls.properties) {
    const type = prop.type || '';
    const fieldType = type.split('(')[0].trim();
    const cleanFieldType = fieldType.split('.').pop() || fieldType;

    // Check if this is a Django field type
    if (DJANGO_FIELD_TYPES.has(cleanFieldType) || cleanFieldType in DJANGO_RELATIONSHIP_FIELDS) {
      const field: ModelFieldInfo = {
        name: prop.name,
        type: cleanFieldType,
        required: !type.includes('null=True') && !type.includes('blank=True') && !type.includes('default='),
      };

      // Extract relationship info
      if (cleanFieldType in DJANGO_RELATIONSHIP_FIELDS) {
        field.relationship = DJANGO_RELATIONSHIP_FIELDS[cleanFieldType];
        // Extract related model from first arg
        const relMatch = type.match(/\(\s*['"]?([A-Za-z_]+(?:\.[A-Za-z_]+)?)['"]?/);
        if (relMatch) {
          field.related_model = relMatch[1];
        }
      }

      // Extract common options
      const options: Record<string, any> = {};
      const maxLenMatch = type.match(/max_length\s*=\s*(\d+)/);
      if (maxLenMatch) options.max_length = parseInt(maxLenMatch[1]);
      if (type.includes('unique=True')) options.unique = true;
      if (type.includes('null=True')) options.null = true;
      if (type.includes('blank=True')) options.blank = true;
      if (type.includes('db_index=True')) options.db_index = true;
      const defaultMatch = type.match(/default\s*=\s*([^,)]+)/);
      if (defaultMatch) {
        field.default = defaultMatch[1].trim();
        options.default = field.default;
      }
      if (Object.keys(options).length > 0) field.options = options;

      fields.push(field);
    }
  }

  return fields;
}

function extractMetaOptions(cls: ClassInfo): Record<string, any> | undefined {
  // Look for Meta inner class info in properties or methods
  const meta: Record<string, any> = {};

  // Check properties for Meta-like data
  for (const prop of cls.properties) {
    if (prop.name === 'db_table') meta.db_table = prop.type;
    if (prop.name === 'ordering') meta.ordering = prop.type;
    if (prop.name === 'verbose_name') meta.verbose_name = prop.type;
    if (prop.name === 'verbose_name_plural') meta.verbose_name_plural = prop.type;
    if (prop.name === 'unique_together') meta.unique_together = prop.type;
    if (prop.name === 'abstract') meta.abstract = true;
    if (prop.name === 'proxy') meta.proxy = true;
  }

  return Object.keys(meta).length > 0 ? meta : undefined;
}

function getViewMethods(cls: ClassInfo): string[] {
  const httpMethods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];
  const viewMethods = ['list', 'create', 'retrieve', 'update', 'partial_update', 'destroy'];
  const allMethods = [...httpMethods, ...viewMethods];

  return cls.methods
    .filter((m) => allMethods.includes(m.name.toLowerCase()))
    .map((m) => m.name.toUpperCase());
}

function extractAdminOptions(cls: ClassInfo): AdminRegistration['options'] {
  const options: AdminRegistration['options'] = {};

  for (const prop of cls.properties) {
    switch (prop.name) {
      case 'list_display':
        options.list_display = extractListFromType(prop.type);
        break;
      case 'list_filter':
        options.list_filter = extractListFromType(prop.type);
        break;
      case 'search_fields':
        options.search_fields = extractListFromType(prop.type);
        break;
      case 'readonly_fields':
        options.readonly_fields = extractListFromType(prop.type);
        break;
      case 'fieldsets':
        options.fieldsets = true;
        break;
      case 'actions':
        options.actions = extractListFromType(prop.type);
        break;
    }
  }

  // Check for inline classes
  const inlines = cls.properties.find((p) => p.name === 'inlines');
  if (inlines) {
    options.inlines = extractListFromType(inlines.type);
  }

  return options;
}

function extractListFromType(typeStr: string): string[] {
  if (!typeStr) return [];
  // Try to extract items from a list-like type string
  const match = typeStr.match(/\[([^\]]*)\]/);
  if (match) {
    return match[1]
      .split(',')
      .map((s) => s.trim().replace(/['"]/g, ''))
      .filter(Boolean);
  }
  return [];
}

function extractFormFields(cls: ClassInfo): ModelFieldInfo[] {
  const fields: ModelFieldInfo[] = [];

  for (const prop of cls.properties) {
    const type = prop.type || '';
    // Check if it looks like a form field (CharField, IntegerField, etc.)
    if (type.includes('Field') || type.includes('forms.')) {
      fields.push({
        name: prop.name,
        type: type.split('(')[0].trim(),
        required: !type.includes('required=False'),
      });
    }
  }

  return fields;
}

// ─── URL Pattern Extraction ────────────────────────────────────────────────

interface URLPattern {
  path: string;
  handler: string;
  name?: string;
  methods?: string[];
  is_include?: boolean;
  namespace?: string;
}

function extractURLPatterns(parsed: ParsedFile): URLPattern[] {
  const patterns: URLPattern[] = [];
  const filePath = parsed.file.relative;

  // Only process files that are likely URL configs
  if (!filePath.includes('urls') && !filePath.includes('router') && !filePath.includes('routes')) {
    return patterns;
  }

  // Look for module-level calls to path(), re_path(), url(), include()
  const allCalls = [
    ...(parsed.moduleCalls || []),
    ...parsed.functions.flatMap((f) => f.calls),
  ];

  for (const call of allCalls) {
    // Match path('pattern', view, name='name')
    const pathMatch = call.match(/^(?:path|re_path|url)\s*\(\s*['"]([^'"]*)['"]\s*,\s*([^,)]+)(?:\s*,\s*name\s*=\s*['"]([^'"]+)['"])?\s*\)/);
    if (pathMatch) {
      const pattern: URLPattern = {
        path: pathMatch[1],
        handler: pathMatch[2].trim(),
      };
      if (pathMatch[3]) pattern.name = pathMatch[3];

      // Check if it's an include()
      if (pattern.handler.includes('include(')) {
        pattern.is_include = true;
        const nsMatch = pattern.handler.match(/namespace\s*=\s*['"]([^'"]+)['"]/);
        if (nsMatch) pattern.namespace = nsMatch[1];
      }

      patterns.push(pattern);
    }
  }

  // Also extract from function calls that look like path/re_path
  for (const func of parsed.functions) {
    for (const callExpr of func.calls) {
      if (callExpr === 'path' || callExpr === 're_path' || callExpr === 'url') {
        // The actual args are hard to get from call name alone
        // but we mark the function as URL-related
      }
    }
  }

  return patterns;
}

// ─── Signal Extraction ─────────────────────────────────────────────────────

function extractSignals(parsed: ParsedFile): SignalInfo[] {
  const signals: SignalInfo[] = [];

  for (const func of parsed.functions) {
    // Check decorators for @receiver(signal, sender=Model)
    for (const d of (func as any).decorators || []) {
      const name = stripDecorator(d);
      if (name === 'receiver') {
        const args = extractDecoratorArgs(d);
        // First arg is the signal
        const signalParts = args.split(',');
        const signalName = signalParts[0]?.trim().replace(/['"]/g, '');

        const signal: SignalInfo = {
          signal: signalName,
          receiver: func.name,
          file: parsed.file.relative,
          framework: 'django',
        };

        // Check for sender kwarg
        const senderMatch = args.match(/sender\s*=\s*([A-Za-z_]+)/);
        if (senderMatch) signal.sender = senderMatch[1];

        signals.push(signal);
      }
    }
  }

  return signals;
}

// ─── Template Tag Extraction ───────────────────────────────────────────────

function extractTemplateTags(parsed: ParsedFile): TemplateTagInfo[] {
  const tags: TemplateTagInfo[] = [];

  if (!parsed.file.relative.includes('templatetags/')) return tags;

  for (const func of parsed.functions) {
    for (const d of (func as any).decorators || []) {
      const name = stripDecorator(d);
      let kind: TemplateTagInfo['kind'] | undefined;

      if (name === 'register.simple_tag' || name === 'simple_tag') kind = 'simple_tag';
      else if (name === 'register.inclusion_tag' || name === 'inclusion_tag') kind = 'inclusion_tag';
      else if (name === 'register.filter' || name === 'filter') kind = 'filter';
      else if (name === 'register.tag' || name === 'tag') kind = 'block_tag';

      if (kind) {
        tags.push({
          name: func.name,
          file: parsed.file.relative,
          kind,
          handler: func.name,
        });
      }
    }
  }

  return tags;
}

// ─── Management Command Extraction ─────────────────────────────────────────

function extractManagementCommand(parsed: ParsedFile): ManagementCommandInfo | null {
  if (!parsed.file.relative.includes('management/commands/')) return null;

  // Find the Command class
  const commandClass = parsed.classes.find(
    (cls) => cls.extends === 'BaseCommand' || cls.extends === 'management.BaseCommand'
  );

  if (!commandClass) return null;

  // Extract command name from filename
  const fileName = parsed.file.relative.split('/').pop()?.replace('.py', '') || '';
  if (fileName.startsWith('_')) return null;

  const command: ManagementCommandInfo = {
    name: fileName,
    file: parsed.file.relative,
  };

  // Look for help text
  const helpProp = commandClass.properties.find((p) => p.name === 'help');
  if (helpProp) command.help = helpProp.type;

  // Look for add_arguments method to extract arguments
  const addArgs = commandClass.methods.find((m) => m.name === 'add_arguments');
  if (addArgs) {
    command.arguments = [];
    for (const call of addArgs.calls) {
      if (call.includes('add_argument')) {
        const argMatch = call.match(/add_argument\s*\(\s*['"]([^'"]+)['"]/);
        if (argMatch) {
          command.arguments.push({
            name: argMatch[1],
            type: 'string',
            required: !argMatch[1].startsWith('--'),
          });
        }
      }
    }
  }

  return command;
}

// ─── Django Enricher ───────────────────────────────────────────────────────

export class DjangoEnricher implements FrameworkEnricher {
  readonly name = 'Django Enricher';
  readonly framework = 'django';

  canEnrich(frameworks: string[]): boolean {
    return frameworks.includes('django');
  }

  async enrich(
    data: CodemapData,
    parsed: ParsedFile[],
    _config: CodemapConfig
  ): Promise<void> {
    const routes: RouteInfo[] = [];
    const models: Record<string, ModelInfo> = {};
    const middleware: Record<string, MiddlewareInfo> = {};
    const signals: SignalInfo[] = [];
    const admin: AdminRegistration[] = [];
    const forms: FormInfo[] = [];
    const managementCommands: ManagementCommandInfo[] = [];
    const templateTags: TemplateTagInfo[] = [];
    const serializers: Record<string, ModelInfo> = {};

    // Collect URL patterns for view-to-route linking
    const allURLPatterns: URLPattern[] = [];

    for (const p of parsed) {
      if (p.file.language !== 'python') continue;

      // ── Extract URL patterns ──
      const urlPatterns = extractURLPatterns(p);
      allURLPatterns.push(...urlPatterns);

      // ── Extract signals ──
      signals.push(...extractSignals(p));

      // ── Extract template tags ──
      templateTags.push(...extractTemplateTags(p));

      // ── Extract management commands ──
      const mgmtCmd = extractManagementCommand(p);
      if (mgmtCmd) managementCommands.push(mgmtCmd);

      // ── Process classes ──
      for (const cls of p.classes) {
        // Django Models
        if (isDjangoModel(cls)) {
          const fields = extractModelFields(cls);
          const meta = extractMetaOptions(cls);
          const isAbstract = meta?.abstract === true;
          const isProxy = meta?.proxy === true;

          const model: ModelInfo = {
            name: cls.name,
            file: p.file.relative,
            framework: 'django',
            kind: isAbstract ? 'django_abstract_model' : isProxy ? 'django_proxy_model' : 'django_model',
            extends: cls.extends || undefined,
            fields,
            meta,
            relationships: fields
              .filter((f) => f.related_model)
              .map((f) => f.related_model!),
            decorators: cls.decorators,
          };

          // Check for custom managers
          const managers = cls.properties
            .filter((p) => p.type?.includes('Manager') || p.type?.includes('QuerySet'))
            .map((p) => p.name);
          if (managers.length > 0) model.managers = managers;

          models[cls.name] = model;
        }

        // Django Views (Class-based)
        if (isViewClass(cls)) {
          const methods = getViewMethods(cls);
          const httpMethods = methods.length > 0 ? methods : ['GET'];

          const route: RouteInfo = {
            method: httpMethods,
            path: '', // Will be linked from URL patterns
            handler: cls.name,
            file: p.file.relative,
            decorators: cls.decorators,
            params: [],
            framework: 'django',
            route_type: 'view',
          };

          // Check for auth decorators
          const authDecorators = cls.decorators.filter((d) => {
            const name = stripDecorator(d);
            return name === 'login_required' || name === 'permission_required';
          });
          if (authDecorators.length > 0) {
            route.auth = authDecorators.map((d) => stripDecorator(d));
          }

          routes.push(route);
        }

        // Django Middleware
        if (isMiddlewareClass(cls)) {
          const mw: MiddlewareInfo = {
            name: cls.name,
            file: p.file.relative,
            framework: 'django',
            type: 'class_middleware',
            methods: cls.methods
              .filter((m) => m.name.startsWith('process_') || m.name === '__call__')
              .map((m) => m.name),
          };
          middleware[cls.name] = mw;
        }

        // Django Admin
        if (isAdminClass(cls)) {
          const options = extractAdminOptions(cls);
          admin.push({
            admin_class: cls.name,
            model: '', // Will be resolved from register() calls
            file: p.file.relative,
            options,
          });
        }

        // Django Forms
        if (isDjangoForm(cls)) {
          const fields = extractFormFields(cls);
          const base = cls.extends?.split('.').pop() || cls.extends || '';
          const isModelForm = base.includes('ModelForm');

          const form: FormInfo = {
            name: cls.name,
            file: p.file.relative,
            framework: 'django',
            kind: isModelForm ? 'model_form' : 'form',
            fields,
            validators: cls.methods
              .filter((m) => m.name.startsWith('clean_') || m.name === 'clean')
              .map((m) => m.name),
          };

          forms.push(form);
        }

        // DRF Serializers
        if (isSerializer(cls)) {
          const fields = extractFormFields(cls); // Similar field structure
          const base = cls.extends?.split('.').pop() || cls.extends || '';
          const isModelSerializer = base.includes('ModelSerializer');

          const serializer: ModelInfo = {
            name: cls.name,
            file: p.file.relative,
            framework: 'django',
            kind: 'django_model',
            extends: cls.extends || undefined,
            fields: fields,
            relationships: [],
            decorators: cls.decorators,
          };

          // Track as a special model-like entity
          if (isModelSerializer) {
            serializer.serializer_model = ''; // Would need Meta.model resolution
          }

          serializers[cls.name] = serializer;
        }
      }

      // ── Process functions (function-based views) ──
      for (const func of p.functions) {
        if (isViewFunction(func, p.imports)) {
          const route: RouteInfo = {
            method: 'GET', // Default, overridden by decorators
            path: '', // Will be linked from URL patterns
            handler: func.name,
            file: p.file.relative,
            decorators: (func as any).decorators || [],
            params: func.params
              .filter((param) => param.name !== 'request' && param.name !== 'self')
              .map((param) => ({
                name: param.name,
                type: param.type || 'any',
                required: !param.optional,
                location: 'path' as const,
              })),
            framework: 'django',
            route_type: 'view',
          };

          // Extract HTTP methods from decorators
          for (const d of (func as any).decorators || []) {
            const name = stripDecorator(d);
            if (name === 'api_view') {
              const args = extractDecoratorArgs(d);
              const methods = extractListArgs(args);
              if (methods.length > 0) route.method = methods;
            }
            if (name === 'require_http_methods') {
              const args = extractDecoratorArgs(d);
              const methods = extractListArgs(args);
              if (methods.length > 0) route.method = methods;
            }
            if (name === 'require_GET') route.method = 'GET';
            if (name === 'require_POST') route.method = 'POST';
          }

          // Check for auth decorators
          const authDecorators = ((func as any).decorators || []).filter((d: string) => {
            const name = stripDecorator(d);
            return name === 'login_required' || name === 'permission_required';
          });
          if (authDecorators.length > 0) {
            route.auth = authDecorators.map((d: string) => stripDecorator(d));
          }

          routes.push(route);
        }
      }
    }

    // ── Link URL patterns to views ──
    for (const pattern of allURLPatterns) {
      if (pattern.is_include) continue;

      // Find matching route by handler name
      const handlerName = pattern.handler.split('.').pop()?.trim() || pattern.handler.trim();
      const matchingRoute = routes.find(
        (r) => r.handler === handlerName || r.handler.endsWith(`.${handlerName}`)
      );

      if (matchingRoute) {
        matchingRoute.path = `/${pattern.path}`;
        if (pattern.name) matchingRoute.url_name = pattern.name;
        if (pattern.namespace) matchingRoute.namespace = pattern.namespace;
      }
    }

    // ── Link admin registrations to models ──
    // Look for admin.site.register(Model, ModelAdmin) calls
    for (const p of parsed) {
      const allCalls = [
        ...(p.moduleCalls || []),
        ...p.functions.flatMap((f) => f.calls),
      ];

      for (const call of allCalls) {
        if (call.includes('register') && call.includes('admin')) {
          // Try to extract model and admin class names
          const registerMatch = call.match(/register\s*\(\s*([A-Za-z_]+)\s*(?:,\s*([A-Za-z_]+))?\s*\)/);
          if (registerMatch) {
            const modelName = registerMatch[1];
            const adminClassName = registerMatch[2];

            // Mark model as admin-registered
            if (models[modelName]) {
              models[modelName].admin_registered = true;
            }

            // Link admin class to model
            if (adminClassName) {
              const adminEntry = admin.find((a) => a.admin_class === adminClassName);
              if (adminEntry) adminEntry.model = modelName;
            }
          }
        }
      }
    }

    // ── Populate CodemapData ──
    data.routes.push(...routes);
    Object.assign(data.models, models, serializers);
    Object.assign(data.middleware, middleware);

    // Store extended data
    (data as any).signals = [...((data as any).signals || []), ...signals];
    (data as any).admin = [...((data as any).admin || []), ...admin];
    (data as any).forms = [...((data as any).forms || []), ...forms];
    (data as any).management_commands = [
      ...((data as any).management_commands || []),
      ...managementCommands,
    ];
    (data as any).template_tags = [...((data as any).template_tags || []), ...templateTags];
  }
}
