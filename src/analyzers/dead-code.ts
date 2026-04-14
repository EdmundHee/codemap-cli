/**
 * Dead code detection from the reverse call graph.
 *
 * A function is "dead" if:
 * 1. It has zero callers in the reverse call graph
 * 2. It is not in an entry point file
 * 3. It is not a lifecycle hook or framework handler
 * 4. It is not a class constructor
 */

import { ParsedFile } from '../parsers/parser.interface';
import { ReverseCallGraph } from './call-graph';

export interface DeadFunction {
  name: string;
  file: string;
  lineCount: number;
  isExported: boolean;
  type: 'function' | 'method';
  className?: string;
  confidence: 'high' | 'low';
}

export interface DeadCodeData {
  deadFunctions: DeadFunction[];
  totalDeadLines: number;
  deadCodePercentage: number;
  totalFunctions: number;
  highConfidenceCount: number;
}

/** Common lifecycle hooks and framework handlers that look dead but aren't */
const LIFECYCLE_HOOKS = new Set([
  'constructor', 'init', 'setup', 'teardown', 'destroy', 'dispose',
  // React
  'componentDidMount', 'componentWillUnmount', 'componentDidUpdate',
  'shouldComponentUpdate', 'getDerivedStateFromProps', 'getSnapshotBeforeUpdate',
  'render',
  // Angular
  'ngOnInit', 'ngOnDestroy', 'ngOnChanges', 'ngAfterViewInit', 'ngDoCheck',
  // Vue
  'created', 'mounted', 'unmounted', 'beforeMount', 'beforeUnmount',
  'beforeCreate', 'beforeDestroy', 'activated', 'deactivated',
  // Python
  '__init__', '__del__', '__enter__', '__exit__', '__str__', '__repr__',
  '__eq__', '__hash__', '__len__', '__iter__', '__next__', '__getitem__',
  '__setitem__', '__contains__', '__call__', '__bool__',
  // General
  'main', 'run', 'start', 'stop', 'handle', 'execute',
]);

/** Framework decorator patterns that indicate a function is an endpoint/handler */
const FRAMEWORK_DECORATOR_PATTERNS = [
  /^@(Get|Post|Put|Delete|Patch|Options|Head|All)/,   // NestJS
  /^@app\.(get|post|put|delete|patch|route)/,          // Flask/FastAPI
  /^@router\./,                                          // Express/FastAPI router
  /^@(Controller|Injectable|Module|Middleware)/,         // NestJS
  /^@(api_view|action|permission_classes)/,              // Django REST
  /^@(Cron|EventPattern|MessagePattern)/,                // NestJS microservices
  /^@(Subscribe|OnEvent)/,                               // Event handlers
];

function isLifecycleHook(name: string): boolean {
  return LIFECYCLE_HOOKS.has(name);
}

function hasFrameworkDecorator(decorators: string[]): boolean {
  return decorators.some(d =>
    FRAMEWORK_DECORATOR_PATTERNS.some(pattern => pattern.test(d))
  );
}

/**
 * Check if a function/method should be exempt from dead code detection.
 */
function isLifecycleOrFramework(
  name: string,
  decorators: string[] = [],
  isConstructor: boolean = false
): boolean {
  if (isLifecycleHook(name)) return true;
  if (hasFrameworkDecorator(decorators)) return true;
  if (isConstructor) return true;
  return false;
}

function findDeadFunctions(
  p: ParsedFile,
  isEntryFile: boolean,
  reverseCallGraph: ReverseCallGraph,
  allExportedNames: Set<string>
): { dead: DeadFunction[]; totalFunctions: number; totalLines: number } {
  const dead: DeadFunction[] = [];
  let totalFunctions = 0;
  let totalLines = 0;

  for (const func of p.functions) {
    totalFunctions++;
    if (isEntryFile || isLifecycleHook(func.name)) continue;
    const callers = reverseCallGraph[func.name];
    if (!callers || callers.length === 0) {
      const isReExported = !func.exported && allExportedNames.has(func.name);
      const confidence = (func.exported || isReExported) ? 'low' : 'high';
      dead.push({ name: func.name, file: p.file.relative, lineCount: func.lineCount, isExported: func.exported, type: 'function', confidence });
      totalLines += func.lineCount;
    }
  }

  for (const cls of p.classes) {
    for (const method of cls.methods) {
      totalFunctions++;
      if (isEntryFile) continue;
      if (isLifecycleOrFramework(method.name, method.decorators, method.name === 'constructor' || method.name === '__init__')) continue;
      const qualifiedName = `${cls.name}.${method.name}`;
      const callers = reverseCallGraph[qualifiedName];
      if (!callers || callers.length === 0) {
        const isPublic = method.access === 'public';
        const confidence = isPublic ? 'low' : 'high';
        dead.push({ name: qualifiedName, file: p.file.relative, lineCount: method.lineCount, isExported: isPublic, type: 'method', className: cls.name, confidence });
        totalLines += method.lineCount;
      }
    }
  }

  return { dead, totalFunctions, totalLines };
}

/**
 * Detect dead functions and methods.
 */
export function detectDeadCode(
  parsedFiles: ParsedFile[],
  reverseCallGraph: ReverseCallGraph,
  entryPoints: string[]
): DeadCodeData {
  const entryPointFiles = new Set(entryPoints);
  const dead: DeadFunction[] = [];
  let totalFunctions = 0;
  let totalLines = 0;

  // Build set of all exported names across all files (for re-export detection)
  const allExportedNames = new Set<string>();
  for (const p of parsedFiles) {
    for (const exp of p.exports) {
      allExportedNames.add(exp.name);
    }
  }

  for (const p of parsedFiles) {
    const result = findDeadFunctions(p, entryPointFiles.has(p.file.relative), reverseCallGraph, allExportedNames);
    dead.push(...result.dead);
    totalFunctions += result.totalFunctions;
    totalLines += result.totalLines;
  }

  const highConfidenceCount = dead.filter(d => d.confidence === 'high').length;

  return {
    deadFunctions: dead,
    totalDeadLines: totalLines,
    deadCodePercentage: totalFunctions > 0 ? Math.round((dead.length / totalFunctions) * 10000) / 100 : 0,
    totalFunctions,
    highConfidenceCount,
  };
}
