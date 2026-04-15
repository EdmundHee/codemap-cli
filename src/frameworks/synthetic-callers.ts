/**
 * Synthetic framework callers for dead code analysis.
 *
 * Injects call graph edges that represent framework-level invocations.
 * For example, a @celery.task-decorated function gets "__celery__ -> func"
 * in the call graph, so dead code detection correctly sees it as called.
 */

import { ParsedFile } from '../parsers/parser.interface';

export interface SyntheticCallerRule {
  /** Framework this rule belongs to (null = always active) */
  framework: string | null;
  /** Synthetic caller name injected into call graph */
  caller: string;
  /** Match functions by decorator regex patterns */
  decoratorPatterns?: RegExp[];
  /** Match functions by name regex patterns */
  namePatterns?: RegExp[];
  /** Match functions by file glob patterns */
  filePatterns?: string[];
}

export interface SyntheticEdge {
  caller: string;
  callee: string;
}

// ── Built-in rules ──────────────────────────────────────────────────────

const BUILTIN_RULES: SyntheticCallerRule[] = [
  // ── Universal (always active) ──
  {
    framework: null,
    caller: '__runtime__',
    namePatterns: [
      /^__(init|del|str|repr|eq|hash|len|iter|next|getitem|setitem|contains|call|bool|enter|exit|new|lt|gt|le|ge|ne|add|sub|mul|truediv|floordiv|mod|pow|and|or|xor|invert|pos|neg|abs|index|format)__$/,
      /^constructor$/,
    ],
  },

  // ── Celery ──
  {
    framework: 'celery',
    caller: '__celery__',
    decoratorPatterns: [
      /^@celery\.task/,
      /^@shared_task/,
      /^@app\.task/,
    ],
  },

  // ── Pytest ──
  {
    framework: 'pytest',
    caller: '__pytest__',
    decoratorPatterns: [
      /^@pytest\.fixture/,
      /^@pytest\.mark/,
    ],
    namePatterns: [/^test_/],
    filePatterns: ['**/conftest.py'],
  },

  // ── FastAPI ──
  {
    framework: 'fastapi',
    caller: '__fastapi__',
    decoratorPatterns: [
      /^@app\.(get|post|put|delete|patch|options|head|websocket)/,
      /^@router\./,
      /^@.*_router\./,
    ],
    namePatterns: [/^(lifespan|on_startup|on_shutdown)$/],
  },

  // ── Django ──
  {
    framework: 'django',
    caller: '__django__',
    decoratorPatterns: [
      /^@receiver/,
      /^@admin\.register/,
      /^@login_required/,
      /^@csrf_exempt/,
      /^@require_http_methods/,
      /^@permission_required/,
      /^@(api_view|action|permission_classes)/,
    ],
    namePatterns: [/^(get_queryset|get_context_data|get_object|form_valid|form_invalid|dispatch|get_serializer_class)$/],
  },

  // ── Django REST Framework ──
  {
    framework: 'django-rest-framework',
    caller: '__django__',
    decoratorPatterns: [
      /^@api_view/,
      /^@action/,
      /^@permission_classes/,
    ],
    namePatterns: [/^(list|create|retrieve|update|partial_update|destroy|perform_create|perform_update|perform_destroy|get_queryset|get_serializer_class)$/],
  },

  // ── Flask ──
  {
    framework: 'flask',
    caller: '__flask__',
    decoratorPatterns: [
      /^@app\.(route|get|post|put|delete|patch)/,
      /^@.*\.route/,
      /^@login_required/,
    ],
  },

  // ── NestJS ──
  {
    framework: 'nestjs',
    caller: '__nestjs__',
    decoratorPatterns: [
      /^@(Get|Post|Put|Delete|Patch|Options|Head|All)/,
      /^@(Controller|Injectable|Module|Middleware)/,
      /^@(Cron|EventPattern|MessagePattern)/,
      /^@(Subscribe|OnEvent)/,
    ],
  },

  // ── React ──
  {
    framework: 'react',
    caller: '__react__',
    namePatterns: [
      /^(componentDidMount|componentWillUnmount|componentDidUpdate|shouldComponentUpdate|getDerivedStateFromProps|getSnapshotBeforeUpdate|render)$/,
      /^use[A-Z]/,
    ],
  },

  // ── Vue ──
  {
    framework: 'vue',
    caller: '__vue__',
    namePatterns: [
      /^(created|mounted|unmounted|beforeMount|beforeUnmount|beforeCreate|beforeDestroy|activated|deactivated|setup)$/,
    ],
    filePatterns: ['**/composables/use*.ts', '**/composables/use*.js'],
  },

  // ── Angular ──
  {
    framework: 'angular',
    caller: '__angular__',
    namePatterns: [
      /^(ngOnInit|ngOnDestroy|ngOnChanges|ngAfterViewInit|ngAfterContentInit|ngDoCheck)$/,
    ],
  },

  // ── Nuxt ──
  {
    framework: 'nuxt',
    caller: '__nuxt__',
    filePatterns: [
      '**/composables/**',
      '**/server/api/**',
      '**/server/routes/**',
      '**/server/middleware/**',
      '**/middleware/**',
    ],
  },

  // ── Next.js ──
  {
    framework: 'next',
    caller: '__nextjs__',
    filePatterns: [
      '**/pages/**',
      '**/app/**/page.tsx',
      '**/app/**/page.ts',
      '**/app/**/layout.tsx',
      '**/app/**/layout.ts',
      '**/app/**/loading.tsx',
      '**/app/**/error.tsx',
    ],
    namePatterns: [
      /^(getServerSideProps|getStaticProps|getStaticPaths|generateMetadata|generateStaticParams)$/,
    ],
  },

  // ── LangGraph ──
  {
    framework: 'langgraph',
    caller: '__langgraph__',
    decoratorPatterns: [/^@node/, /^@edge/, /^@conditional_edge/],
  },

  // ── Express ──
  {
    framework: 'express',
    caller: '__express__',
    decoratorPatterns: [
      /^@(Get|Post|Put|Delete|Patch|Route)/,
    ],
  },
];

/**
 * Collect active rules based on detected frameworks and optional user rules.
 */
function collectActiveRules(
  frameworks: string[],
  userRules?: SyntheticCallerRule[]
): SyntheticCallerRule[] {
  const frameworkSet = new Set(frameworks);
  const active: SyntheticCallerRule[] = [];

  for (const rule of BUILTIN_RULES) {
    if (rule.framework === null || frameworkSet.has(rule.framework)) {
      active.push(rule);
    }
  }

  if (userRules) {
    active.push(...userRules);
  }

  return active;
}

/**
 * Simple glob matching: supports **​/ (zero or more directories), ** (any path),
 * and * (any chars in one segment). Converts glob to regex.
 */
function simpleGlobMatch(filePath: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape regex chars except * and ?
    .replace(/\*\*\//g, '(.*/)?')            // **/ = zero or more directories
    .replace(/\*\*/g, '.*')                   // ** alone = anything including /
    .replace(/\*/g, '[^/]*');                 // * = anything except /
  return new RegExp(`^${regexStr}$`).test(filePath);
}

/**
 * Check if a function/method matches any active rule.
 */
function matchesRule(
  rule: SyntheticCallerRule,
  name: string,
  decorators: string[],
  filePath: string
): boolean {
  if (rule.decoratorPatterns) {
    for (const dec of decorators) {
      for (const pattern of rule.decoratorPatterns) {
        if (pattern.test(dec)) return true;
      }
    }
  }

  if (rule.namePatterns) {
    for (const pattern of rule.namePatterns) {
      if (pattern.test(name)) return true;
    }
  }

  if (rule.filePatterns) {
    for (const pattern of rule.filePatterns) {
      if (simpleGlobMatch(filePath, pattern)) return true;
    }
  }

  return false;
}

/**
 * Generate synthetic call graph edges from parsed files and detected frameworks.
 *
 * For each function/method that matches a framework rule, produces an edge
 * like { caller: "__celery__", callee: "process_data" } that will be
 * injected into the call graph before dead code analysis.
 */
export function generateSyntheticEdges(
  parsedFiles: ParsedFile[],
  frameworks: string[],
  userRules?: SyntheticCallerRule[]
): SyntheticEdge[] {
  const rules = collectActiveRules(frameworks, userRules);
  if (rules.length === 0) return [];

  const edges: SyntheticEdge[] = [];
  const seen = new Set<string>();

  for (const parsed of parsedFiles) {
    const filePath = parsed.file.relative;

    // Check standalone functions
    for (const func of parsed.functions) {
      const decorators = func.decorators ?? [];
      for (const rule of rules) {
        if (matchesRule(rule, func.name, decorators, filePath)) {
          const key = `${rule.caller}:${func.name}`;
          if (!seen.has(key)) {
            seen.add(key);
            edges.push({ caller: rule.caller, callee: func.name });
          }
        }
      }
    }

    // Check class methods
    for (const cls of parsed.classes) {
      for (const method of cls.methods) {
        const qualifiedName = `${cls.name}.${method.name}`;
        for (const rule of rules) {
          if (matchesRule(rule, method.name, method.decorators, filePath)) {
            const key = `${rule.caller}:${qualifiedName}`;
            if (!seen.has(key)) {
              seen.add(key);
              edges.push({ caller: rule.caller, callee: qualifiedName });
            }
          }
        }
      }
    }
  }

  return edges;
}

/**
 * Convert user config synthetic caller definitions to SyntheticCallerRule objects.
 */
export function compileUserRules(
  userConfig?: Array<{
    caller: string;
    decorator_patterns?: string[];
    name_patterns?: string[];
    file_patterns?: string[];
  }>
): SyntheticCallerRule[] {
  if (!userConfig || userConfig.length === 0) return [];

  return userConfig.map((cfg) => ({
    framework: null,
    caller: cfg.caller,
    decoratorPatterns: cfg.decorator_patterns?.map((p) => new RegExp(p)),
    namePatterns: cfg.name_patterns?.map((p) => new RegExp(p)),
    filePatterns: cfg.file_patterns,
  }));
}
