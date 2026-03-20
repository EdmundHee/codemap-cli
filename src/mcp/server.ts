#!/usr/bin/env node
/**
 * Codemap MCP Server (Multi-Project)
 *
 * Exposes codemap data as MCP tools so Claude Code (and other MCP clients)
 * can query project structure, call graphs, and relationships on demand.
 *
 * Project resolution (in priority order):
 *   1. CLI args:        codemap-mcp /path/a /path/b
 *   2. .codemaprc:      { "projects": ["/path/a", "/path/b"] }
 *                       Reads from cwd/.codemaprc or ~/.codemaprc
 *   3. Default:         uses cwd (single project)
 *
 * Usage:
 *   claude mcp add codemap -- codemap-mcp ~/Work/project-a ~/Work/project-b
 *   claude mcp add codemap -- codemap-mcp .
 *   claude mcp add codemap -- codemap-mcp  (reads projects from .codemaprc)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, existsSync } from 'fs';
import { join, resolve, basename } from 'path';
import { CodemapData } from '../output/json-generator';
import {
  getOverview,
  getModule,
  search,
  getCallers,
  getCalls,
  getFunction,
  getClass,
  getFile,
  getType,
  QueryResult,
} from '../core/query-engine';
import {
  formatOverview,
  formatModule,
  formatQueryResult,
  formatSearchResults,
  formatCallers,
  formatCalls,
  formatProjects,
  formatHealth,
  formatStructures,
  formatHealthDiff,
} from './formatters';
import { computeTrend } from '../analyzers/history';
import { UsageTracker } from './usage-tracker';

// --- Multi-project registry ---

interface ProjectEntry {
  name: string;
  root: string;
}

/**
 * Resolve the project list. Priority:
 *   1. CLI args: codemap-mcp /path/a /path/b
 *   2. .codemaprc "projects" field (cwd/.codemaprc → ~/.codemaprc)
 *   3. Default: cwd as single project
 */
function resolveProjects(): ProjectEntry[] {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));

  // 1. CLI path arguments
  if (args.length > 0) {
    return args.map((p) => {
      const root = resolve(p);
      return { name: basename(root), root };
    });
  }

  // 2. Check .codemaprc for "projects" field
  const rcProjects = loadProjectsFromRc();
  if (rcProjects.length > 0) return rcProjects;

  // 3. Default: cwd
  return [defaultProject()];
}

/**
 * Look for a "projects" array in .codemaprc.
 * Checks cwd first, then home directory (~/.codemaprc).
 *
 * Supports:
 *   { "projects": ["/path/a", "/path/b"] }
 *   { "projects": [{ "name": "my-app", "root": "/path/a" }] }
 */
function loadProjectsFromRc(): ProjectEntry[] {
  const candidates = [
    join(process.cwd(), '.codemaprc'),
    join(require('os').homedir(), '.codemaprc'),
  ];

  for (const rcPath of candidates) {
    if (!existsSync(rcPath)) continue;
    try {
      const config = JSON.parse(readFileSync(rcPath, 'utf-8'));
      if (!Array.isArray(config.projects) || config.projects.length === 0) continue;

      return config.projects.map((p: string | { name?: string; root: string }) => {
        if (typeof p === 'string') {
          const root = resolve(p);
          return { name: basename(root), root };
        }
        const root = resolve(p.root);
        return { name: p.name || basename(root), root };
      });
    } catch {
      continue;
    }
  }

  return [];
}

function defaultProject(): ProjectEntry {
  const root = resolve(process.env.CODEMAP_ROOT || process.cwd());
  return { name: basename(root), root };
}

// --- Data loading with cache ---

const dataCache = new Map<string, { data: CodemapData; mtime: number }>();

function loadProjectData(project: ProjectEntry): CodemapData | null {
  const codemapPath = join(project.root, '.codemap', 'codemap.json');
  if (!existsSync(codemapPath)) return null;

  try {
    const stat = require('fs').statSync(codemapPath);
    const cached = dataCache.get(project.root);

    // Use cache if file hasn't changed
    if (cached && cached.mtime === stat.mtimeMs) {
      return cached.data;
    }

    const data = JSON.parse(readFileSync(codemapPath, 'utf-8'));
    dataCache.set(project.root, { data, mtime: stat.mtimeMs });
    return data;
  } catch {
    return null;
  }
}

/**
 * Resolve which project to query.
 * If only one project, always use it.
 * If multiple, require `project` param or return error hint.
 */
function resolveProject(
  projects: ProjectEntry[],
  projectName?: string
): { project: ProjectEntry; data: CodemapData } | { error: string } {
  if (projects.length === 1) {
    const project = projects[0];
    const data = loadProjectData(project);
    if (!data) return { error: `No codemap found for "${project.name}". Run \`codemap generate\` in ${project.root}` };
    return { project, data };
  }

  if (!projectName) {
    const names = projects.map((p) => p.name).join(', ');
    return { error: `Multiple projects available: [${names}]. Specify which one with the "project" parameter.` };
  }

  const match = projects.find(
    (p) => p.name === projectName || p.root.endsWith(projectName)
  );
  if (!match) {
    const names = projects.map((p) => p.name).join(', ');
    return { error: `Project "${projectName}" not found. Available: [${names}]` };
  }

  const data = loadProjectData(match);
  if (!data) return { error: `No codemap found for "${match.name}". Run \`codemap generate\` in ${match.root}` };
  return { project: match, data };
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

function mdResult(markdown: string) {
  return { content: [{ type: 'text' as const, text: markdown }] };
}

// --- Tool registration ---

function registerTools(server: McpServer, projects: ProjectEntry[], projectParam: any, tracker: UsageTracker) {

  /**
   * Wrap a tool handler with usage tracking.
   * Records start/end timing, error counts, and parameter frequency.
   */
  function tracked<P extends Record<string, unknown>>(
    toolName: string,
    handler: (params: P) => Promise<any>
  ): (params: P) => Promise<any> {
    return async (params: P) => {
      const token = tracker.recordStart(toolName, params as Record<string, unknown>);
      try {
        const result = await handler(params);
        const isError = result?.isError === true;
        tracker.recordEnd(token, isError);
        return result;
      } catch (err) {
        tracker.recordEnd(token, true);
        throw err;
      }
    };
  }

  // --- Tool: codemap_projects ---
  server.tool(
    'codemap_projects',
    'List all registered codemap projects and their status (file counts, languages, frameworks). '
    + 'Use when you need to know which projects are available, check if codemap data exists, '
    + 'or discover project names for multi-project queries.',
    {},
    tracked('codemap_projects', async () => {
      const list = projects.map((p) => {
        const data = loadProjectData(p);
        return {
          name: p.name,
          root: p.root,
          has_codemap: !!data,
          ...(data
            ? {
                files: Object.keys(data.files).length,
                classes: Object.keys(data.classes).length,
                functions: Object.keys(data.functions).length,
                frameworks: data.project.frameworks,
                languages: data.project.languages,
                generated_at: data.generated_at,
              }
            : {}),
        };
      });
      return mdResult(formatProjects(list));
    })
  );

  // --- Tool: codemap_overview ---
  server.tool(
    'codemap_overview',
    'Get a high-level overview of the entire project: every module/directory with its classes and functions, '
    + 'frameworks, languages, dependencies, and entry points. Use this FIRST when you need to understand '
    + 'the project structure, explore the codebase, find where code lives, or orient yourself in an '
    + 'unfamiliar repo. Returns the full project map in one call — much faster than reading files or '
    + 'running ls/find/glob across directories.',
    { project: projectParam },
    tracked('codemap_overview', async ({ project: projectName }) => {
      const resolved = resolveProject(projects, projectName);
      if ('error' in resolved) return errorResult(resolved.error);
      return mdResult(formatOverview(getOverview(resolved.data)));
    })
  );

  // --- Tool: codemap_module ---
  server.tool(
    'codemap_module',
    'Get all classes, functions, types, imports, and exports for a specific directory/module. '
    + 'Use INSTEAD of reading individual files when you need to understand what a module contains, '
    + 'what it exports, or what functions and classes are defined there. Returns every entity with '
    + 'signatures, parameters, and relationships in one call — replaces multiple file reads.',
    {
      directory: z.string().describe('Directory path to query (e.g. "src/core", "backend/api", "lib/utils")'),
      project: projectParam,
    },
    tracked('codemap_module', async ({ directory, project: projectName }) => {
      const resolved = resolveProject(projects, projectName);
      if ('error' in resolved) return errorResult(resolved.error);
      const result = getModule(resolved.data, directory);
      if (!result) return errorResult(`Module "${directory}" not found.`);
      return mdResult(formatModule(result));
    })
  );

  // --- Tool: codemap_query ---
  server.tool(
    'codemap_query',
    'Search for any function, class, method, type, interface, or file by name across the entire codebase. '
    + 'Use INSTEAD of grep/Grep/Glob when looking for where something is defined, finding a function '
    + 'definition, locating a class, or checking if something already exists. Supports exact and fuzzy '
    + 'matching. Returns the full signature, file location, parameters, return type, and call '
    + 'relationships — much richer than grep output. Also use this to find existing reusable code '
    + 'before writing new functions.',
    {
      name: z.string().describe('Name to search for — supports partial/fuzzy matching (e.g. "createOrder", "User", "parse", "validate")'),
      project: projectParam,
    },
    tracked('codemap_query', async ({ name, project: projectName }) => {
      const resolved = resolveProject(projects, projectName);
      if ('error' in resolved) return errorResult(resolved.error);
      const { data } = resolved;

      // Try exact lookups first
      const funcResult = getFunction(data, name);
      if (funcResult) return mdResult(formatQueryResult(funcResult));

      const clsResult = getClass(data, name);
      if (clsResult) return mdResult(formatQueryResult(clsResult));

      const typeResult = getType(data, name);
      if (typeResult) return mdResult(formatQueryResult(typeResult));

      const fileResult = getFile(data, name);
      if (fileResult) {
        if (Array.isArray(fileResult)) {
          return mdResult(formatSearchResults(fileResult));
        }
        return mdResult(formatQueryResult(fileResult));
      }

      // Fall back to fuzzy search
      const results = search(data, name);
      if (results.length === 0) return mdResult(`No results for "${name}".`);
      return mdResult(formatSearchResults(results.map((r) => ({ type: r.type, name: r.name, file: r.file }))));
    })
  );

  // --- Tool: codemap_callers ---
  server.tool(
    'codemap_callers',
    'Find all callers of a function or method — who calls this, where is it used, what references it. '
    + 'Use for impact analysis before modifying, renaming, or deleting code. Answers: "what will break '
    + 'if I change this?", "how widely is this used?", "is it safe to refactor?". Returns the complete '
    + 'reverse call graph in one query — faster and more complete than grep/Grep for finding usages.',
    {
      name: z.string().describe('Function or method name (e.g. "createOrder", "UserService.validate", "parseConfig")'),
      project: projectParam,
    },
    tracked('codemap_callers', async ({ name, project: projectName }) => {
      const resolved = resolveProject(projects, projectName);
      if ('error' in resolved) return errorResult(resolved.error);
      return mdResult(formatCallers(getCallers(resolved.data, name)));
    })
  );

  // --- Tool: codemap_calls ---
  server.tool(
    'codemap_calls',
    'Find all functions called by a given function — what does it depend on, what does it use internally. '
    + 'Use for dependency tracing before refactoring, understanding how a function works without reading '
    + 'its source, or checking what a function relies on. Answers: "what does this function do?", '
    + '"what are its dependencies?", "what would I need to mock in tests?". Returns the complete '
    + 'forward call graph in one query.',
    {
      name: z.string().describe('Function or method name (e.g. "createOrder", "UserService.validate", "buildReport")'),
      project: projectParam,
    },
    tracked('codemap_calls', async ({ name, project: projectName }) => {
      const resolved = resolveProject(projects, projectName);
      if ('error' in resolved) return errorResult(resolved.error);
      return mdResult(formatCalls(getCalls(resolved.data, name)));
    })
  );

  // --- Tool: codemap_health ---
  server.tool(
    'codemap_health',
    'Get project health score (0-100) with detailed code quality metrics: complexity hotspots, '
    + 'module coupling (afferent/efferent/instability), dead code percentage, god class detection, '
    + 'and maintainability issues. Use when asked about code quality, technical debt, what needs '
    + 'refactoring, or which parts of the codebase are problematic. Can scope to a specific module.',
    {
      scope: z
        .string()
        .optional()
        .describe('Optional scope to filter: module path (e.g. "src/core") or "project" for full report'),
      project: projectParam,
    },
    tracked('codemap_health', async ({ scope, project: projectName }) => {
      const resolved = resolveProject(projects, projectName);
      if ('error' in resolved) return errorResult(resolved.error);
      const { data } = resolved;
      if (!data.health) return errorResult('No health data. Regenerate codemap with latest version: `codemap generate`');
      return mdResult(formatHealth(data.health, data.module_metrics || [], scope));
    })
  );

  // --- Tool: codemap_health_diff ---
  server.tool(
    'codemap_health_diff',
    'Compare health between current and previous codemap generation. Shows score delta, which metrics '
    + 'improved or degraded, and trend direction. Use after making changes to verify code quality '
    + 'improved, or in CI to detect regressions. Answers: "did my changes improve or hurt quality?".',
    {
      project: projectParam,
    },
    tracked('codemap_health_diff', async ({ project: projectName }) => {
      const resolved = resolveProject(projects, projectName);
      if ('error' in resolved) return errorResult(resolved.error);
      const outputDir = join(resolved.project.root, '.codemap');
      const trend = computeTrend(outputDir);
      if (!trend) return mdResult('No history available. Run `codemap generate` at least twice to see trends.');
      return mdResult(formatHealthDiff(trend));
    })
  );

  // --- Tool: codemap_structures ---
  server.tool(
    'codemap_structures',
    'Get raw structural analysis data for refactoring decisions. Three analysis types: '
    + '"cohesion" — LCOM4 clusters showing which methods/fields group together (use to decide '
    + 'how to split a god class); "hotspots" — most complex functions ranked by cyclomatic '
    + 'complexity with their callees (use to find what to simplify); "dead_code" — unreachable '
    + 'functions that are never called (use to find safe deletion candidates). Returns computed '
    + 'data, not opinions — you decide what to act on.',
    {
      type: z.enum(['cohesion', 'hotspots', 'dead_code']).describe('Analysis type'),
      target: z.string().optional().describe('Optional: specific class or function name to focus on'),
      project: projectParam,
    },
    tracked('codemap_structures', async ({ type, target, project: projectName }) => {
      const resolved = resolveProject(projects, projectName);
      if ('error' in resolved) return errorResult(resolved.error);
      const { data } = resolved;
      return mdResult(formatStructures(data, type, target));
    })
  );

  // --- Tool: codemap_usage ---
  server.tool(
    'codemap_usage',
    'View MCP tool usage statistics: call counts, latency, error rates, and utilization '
    + 'distribution across all codemap tools. Shows which tools are used most, performance '
    + 'metrics, most queried parameters, and session history. Use to understand how the '
    + 'codemap MCP server is being utilized.',
    {
      format: z.enum(['summary', 'json']).optional().describe('Output format: "summary" for markdown report (default), "json" for raw data'),
    },
    tracked('codemap_usage', async ({ format }) => {
      if (format === 'json') {
        return mdResult('```json\n' + JSON.stringify(tracker.getSnapshot(), null, 2) + '\n```');
      }
      return mdResult(tracker.getSummary());
    })
  );
}

// --- Main ---

async function main() {
  const projects = resolveProjects();

  // Initialize usage tracker (persists to first project's .codemap/ dir)
  const tracker = new UsageTracker(projects.map((p) => p.root));

  const server = new McpServer({
    name: 'codemap',
    version: '0.1.0',
  });

  // Common project param — optional when single project, required hint when multiple
  const projectParam = z
    .string()
    .optional()
    .describe(
      projects.length > 1
        ? `Project name to query. Available: ${projects.map((p) => p.name).join(', ')}`
        : 'Project name (optional — defaults to the only registered project)'
    );

  // Register all tools (with usage tracking)
  registerTools(server, projects, projectParam, tracker);

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`Codemap MCP server error: ${error.message}\n`);
  process.exit(1);
});
