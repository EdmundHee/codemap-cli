import { DjangoEnricher } from '../django-enricher';
import { CodemapData } from '../../output/json-generator';
import { ParsedFile, ClassInfo, FunctionInfo, PropertyInfo } from '../../parsers/parser.interface';
import { ScannedFile } from '../../core/scanner';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeScannedFile(relative: string): ScannedFile {
  return { absolute: `/project/${relative}`, relative, language: 'python' };
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
    project: { name: 'test', root: '/test', languages: ['python'], frameworks: ['django'], entry_points: [] },
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

function makeClass(overrides: Partial<ClassInfo>): ClassInfo {
  return {
    name: 'TestClass',
    extends: null,
    implements: [],
    decorators: [],
    methods: [],
    properties: [],
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('DjangoEnricher', () => {
  const enricher = new DjangoEnricher();

  test('canEnrich returns true for django', () => {
    expect(enricher.canEnrich(['django'])).toBe(true);
    expect(enricher.canEnrich(['django', 'django-rest-framework'])).toBe(true);
  });

  test('canEnrich returns false for non-django', () => {
    expect(enricher.canEnrich(['fastapi'])).toBe(false);
    expect(enricher.canEnrich([])).toBe(false);
  });

  test('extracts Django models with fields', async () => {
    const data = makeEmptyCodemapData();
    const parsed: ParsedFile[] = [
      makeParsedFile({
        file: makeScannedFile('myapp/models.py'),
        classes: [
          makeClass({
            name: 'User',
            extends: 'models.Model',
            properties: [
              { name: 'name', type: 'CharField(max_length=100)', access: 'public' },
              { name: 'email', type: 'EmailField(unique=True)', access: 'public' },
              { name: 'profile', type: 'ForeignKey("Profile", on_delete=models.CASCADE)', access: 'public' },
            ],
          }),
        ],
      }),
    ];

    await enricher.enrich(data, parsed, { root: '/test' } as any);

    expect(data.models).toHaveProperty('User');
    expect(data.models['User'].kind).toBe('django_model');
    expect(data.models['User'].fields).toHaveLength(3);
    expect(data.models['User'].fields[0].name).toBe('name');
    expect(data.models['User'].fields[0].type).toBe('CharField');
    expect(data.models['User'].fields[0].options?.max_length).toBe(100);
    expect(data.models['User'].fields[2].relationship).toBe('foreign_key');
    expect(data.models['User'].fields[2].related_model).toBe('Profile');
    expect(data.models['User'].relationships).toContain('Profile');
  });

  test('detects class-based views', async () => {
    const data = makeEmptyCodemapData();
    const parsed: ParsedFile[] = [
      makeParsedFile({
        file: makeScannedFile('myapp/views.py'),
        classes: [
          makeClass({
            name: 'UserListView',
            extends: 'ListView',
            methods: [
              {
                name: 'get',
                params: [{ name: 'self', type: 'Self' }, { name: 'request', type: 'HttpRequest' }],
                return_type: 'HttpResponse',
                decorators: [],
                access: 'public',
                async: false,
                static: false,
                calls: [],
                complexity: 1,
                lineCount: 5,
                nestingDepth: 0,
                instanceVarAccesses: [],
              },
            ],
          }),
        ],
      }),
    ];

    await enricher.enrich(data, parsed, { root: '/test' } as any);

    expect(data.routes).toHaveLength(1);
    expect(data.routes[0].handler).toBe('UserListView');
    expect(data.routes[0].route_type).toBe('view');
    expect(data.routes[0].framework).toBe('django');
  });

  test('detects function-based views with decorators', async () => {
    const data = makeEmptyCodemapData();
    const parsed: ParsedFile[] = [
      makeParsedFile({
        file: makeScannedFile('myapp/views.py'),
        functions: [
          {
            name: 'user_list',
            params: [{ name: 'request', type: 'HttpRequest' }],
            return_type: 'HttpResponse',
            async: false,
            exported: true,
            calls: ['render'],
            complexity: 1,
            lineCount: 5,
            nestingDepth: 0,
            decorators: ['@login_required', '@api_view(["GET", "POST"])'],
          } as any,
        ],
      }),
    ];

    await enricher.enrich(data, parsed, { root: '/test' } as any);

    expect(data.routes).toHaveLength(1);
    expect(data.routes[0].handler).toBe('user_list');
    expect(data.routes[0].auth).toContain('login_required');
  });

  test('detects middleware classes', async () => {
    const data = makeEmptyCodemapData();
    const parsed: ParsedFile[] = [
      makeParsedFile({
        file: makeScannedFile('myapp/middleware.py'),
        classes: [
          makeClass({
            name: 'AuthMiddleware',
            extends: 'MiddlewareMixin',
            methods: [
              {
                name: 'process_request',
                params: [{ name: 'self', type: '' }, { name: 'request', type: '' }],
                return_type: '',
                decorators: [],
                access: 'public',
                async: false,
                static: false,
                calls: [],
                complexity: 1,
                lineCount: 5,
                nestingDepth: 0,
                instanceVarAccesses: [],
              },
            ],
          }),
        ],
      }),
    ];

    await enricher.enrich(data, parsed, { root: '/test' } as any);

    expect(data.middleware).toHaveProperty('AuthMiddleware');
    expect(data.middleware['AuthMiddleware'].type).toBe('class_middleware');
    expect(data.middleware['AuthMiddleware'].methods).toContain('process_request');
  });

  test('extracts signals from @receiver decorators', async () => {
    const data = makeEmptyCodemapData();
    const parsed: ParsedFile[] = [
      makeParsedFile({
        file: makeScannedFile('myapp/signals.py'),
        functions: [
          {
            name: 'create_profile',
            params: [{ name: 'sender', type: '' }, { name: 'instance', type: '' }],
            return_type: '',
            async: false,
            exported: true,
            calls: ['Profile.objects.create'],
            complexity: 1,
            lineCount: 3,
            nestingDepth: 0,
            decorators: ['@receiver(post_save, sender=User)'],
          } as any,
        ],
      }),
    ];

    await enricher.enrich(data, parsed, { root: '/test' } as any);

    const signals = (data as any).signals;
    expect(signals).toHaveLength(1);
    expect(signals[0].signal).toBe('post_save');
    expect(signals[0].receiver).toBe('create_profile');
    expect(signals[0].sender).toBe('User');
  });

  test('extracts management commands', async () => {
    const data = makeEmptyCodemapData();
    const parsed: ParsedFile[] = [
      makeParsedFile({
        file: makeScannedFile('myapp/management/commands/import_data.py'),
        classes: [
          makeClass({
            name: 'Command',
            extends: 'BaseCommand',
            properties: [
              { name: 'help', type: 'Import data from CSV files', access: 'public' },
            ],
            methods: [
              {
                name: 'handle',
                params: [],
                return_type: '',
                decorators: [],
                access: 'public',
                async: false,
                static: false,
                calls: [],
                complexity: 3,
                lineCount: 20,
                nestingDepth: 2,
                instanceVarAccesses: [],
              },
            ],
          }),
        ],
      }),
    ];

    await enricher.enrich(data, parsed, { root: '/test' } as any);

    const commands = (data as any).management_commands;
    expect(commands).toHaveLength(1);
    expect(commands[0].name).toBe('import_data');
    expect(commands[0].help).toBe('Import data from CSV files');
  });

  test('extracts template tags', async () => {
    const data = makeEmptyCodemapData();
    const parsed: ParsedFile[] = [
      makeParsedFile({
        file: makeScannedFile('myapp/templatetags/custom_tags.py'),
        functions: [
          {
            name: 'format_currency',
            params: [{ name: 'value', type: 'float' }],
            return_type: 'str',
            async: false,
            exported: true,
            calls: [],
            complexity: 1,
            lineCount: 3,
            nestingDepth: 0,
            decorators: ['@register.filter'],
          } as any,
        ],
      }),
    ];

    await enricher.enrich(data, parsed, { root: '/test' } as any);

    const tags = (data as any).template_tags;
    expect(tags).toHaveLength(1);
    expect(tags[0].name).toBe('format_currency');
    expect(tags[0].kind).toBe('filter');
  });

  test('extracts admin registrations', async () => {
    const data = makeEmptyCodemapData();
    const parsed: ParsedFile[] = [
      makeParsedFile({
        file: makeScannedFile('myapp/admin.py'),
        classes: [
          makeClass({
            name: 'UserAdmin',
            extends: 'admin.ModelAdmin',
            properties: [
              { name: 'list_display', type: "['name', 'email', 'is_active']", access: 'public' },
              { name: 'search_fields', type: "['name', 'email']", access: 'public' },
            ],
          }),
        ],
      }),
    ];

    await enricher.enrich(data, parsed, { root: '/test' } as any);

    const adminList = (data as any).admin;
    expect(adminList).toHaveLength(1);
    expect(adminList[0].admin_class).toBe('UserAdmin');
    expect(adminList[0].options.list_display).toContain('name');
    expect(adminList[0].options.search_fields).toContain('email');
  });

  test('extracts forms with validators', async () => {
    const data = makeEmptyCodemapData();
    const parsed: ParsedFile[] = [
      makeParsedFile({
        file: makeScannedFile('myapp/forms.py'),
        classes: [
          makeClass({
            name: 'UserForm',
            extends: 'forms.ModelForm',
            properties: [
              { name: 'bio', type: 'forms.CharField()', access: 'public' },
            ],
            methods: [
              {
                name: 'clean_bio',
                params: [{ name: 'self', type: '' }],
                return_type: '',
                decorators: [],
                access: 'public',
                async: false,
                static: false,
                calls: [],
                complexity: 1,
                lineCount: 3,
                nestingDepth: 0,
                instanceVarAccesses: [],
              },
              {
                name: 'clean',
                params: [{ name: 'self', type: '' }],
                return_type: '',
                decorators: [],
                access: 'public',
                async: false,
                static: false,
                calls: [],
                complexity: 2,
                lineCount: 5,
                nestingDepth: 1,
                instanceVarAccesses: [],
              },
            ],
          }),
        ],
      }),
    ];

    await enricher.enrich(data, parsed, { root: '/test' } as any);

    const forms = (data as any).forms;
    expect(forms).toHaveLength(1);
    expect(forms[0].name).toBe('UserForm');
    expect(forms[0].kind).toBe('model_form');
    expect(forms[0].validators).toContain('clean_bio');
    expect(forms[0].validators).toContain('clean');
  });
});
