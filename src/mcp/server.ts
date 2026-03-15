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

function registerTools(server: McpServer, projects: ProjectEntry[], projectParam: any) {
  // --- Tool: codemap_projects ---
  server.tool(
    'codemap_projects',
    'List all registered codemap projects and their status. Use this to discover available projects in multi-project setups.',
    {},
    async () => {
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
    }
  );

  // --- Tool: codemap_overview ---
  server.tool(
    'codemap_overview',
    'Get a high-level overview of a project: modules, frameworks, languages, file counts, and dependencies. Use this FIRST to understand project structure before exploring with grep or read.',
    { project: projectParam },
    async ({ project: projectName }) => {
      const resolved = resolveProject(projects, projectName);
      if ('error' in resolved) return errorResult(resolved.error);
      return mdResult(formatOverview(getOverview(resolved.data)));
    }
  );

  // --- Tool: codemap_module ---
  server.tool(
    'codemap_module',
    'Get all classes, functions, types, and imports for a directory. Use INSTEAD of reading individual files when you need to understand a module.',
    {
      directory: z.string().describe('Directory path to query (e.g. "src/core", "backend/api")'),
      project: projectParam,
    },
    async ({ directory, project: projectName }) => {
      const resolved = resolveProject(projects, projectName);
      if ('error' in resolved) return errorResult(resolved.error);
      const result = getModule(resolved.data, directory);
      if (!result) return errorResult(`Module "${directory}" not found.`);
      return mdResult(formatModule(result));
    }
  );

  // --- Tool: codemap_query ---
  server.tool(
    'codemap_query',
    'Search for a function, class, method, type, or file by name across the entire codebase. Use INSTEAD of grep when looking for definitions or declarations.',
    {
      name: z.string().describe('Name to search for (partial matching supported)'),
      project: projectParam,
    },
    async ({ name, project: projectName }) => {
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
    }
  );

  // --- Tool: codemap_callers ---
  server.tool(
    'codemap_callers',
    'Find all callers of a function — use for impact analysis before modifying code. Returns the complete call graph in one query instead of multiple grep searches.',
    {
      name: z.string().describe('Function or method name (e.g. "createOrder", "UserService.validate")'),
      project: projectParam,
    },
    async ({ name, project: projectName }) => {
      const resolved = resolveProject(projects, projectName);
      if ('error' in resolved) return errorResult(resolved.error);
      return mdResult(formatCallers(getCallers(resolved.data, name)));
    }
  );

  // --- Tool: codemap_calls ---
  server.tool(
    'codemap_calls',
    'Find all functions called by a given function — use for dependency tracing before refactoring. Returns the complete call graph in one query.',
    {
      name: z.string().describe('Function or method name (e.g. "createOrder", "UserService.validate")'),
      project: projectParam,
    },
    async ({ name, project: projectName }) => {
      const resolved = resolveProject(projects, projectName);
      if ('error' in resolved) return errorResult(resolved.error);
      return mdResult(formatCalls(getCalls(resolved.data, name)));
    }
  );

  // --- Tool: codemap_health ---
  server.tool(
    'codemap_health',
    'Get project health score, code metrics (complexity, coupling, dead code), and hotspots. Returns structured data: health score 0-100, per-function complexity, per-module coupling (Ca/Ce/Instability), god class detection, and dead code percentage. Use this to assess code quality and identify areas needing refactoring.',
    {
      scope: z
        .string()
        .optional()
        .describe('Optional scope to filter: module path (e.g. "src/core") or "project" for full report'),
      project: projectParam,
    },
    async ({ scope, project: projectName }) => {
      const resolved = resolveProject(projects, projectName);
      if ('error' in resolved) return errorResult(resolved.error);
      const { data } = resolved;
      if (!data.health) return errorResult('No health data. Regenerate codemap with latest version: `codemap generate`');
      return mdResult(formatHealth(data.health, data.module_metrics || [], scope));
    }
  );

  // --- Tool: codemap_health_diff ---
  server.tool(
    'codemap_health_diff',
    'Compare health between current and previous run. Returns score delta, which metrics improved or degraded, and trend direction. Use after making changes to see if code quality improved or regressed.',
    {
      project: projectParam,
    },
    async ({ project: projectName }) => {
      const resolved = resolveProject(projects, projectName);
      if ('error' in resolved) return errorResult(resolved.error);
      const outputDir = join(resolved.project.root, '.codemap');
      const trend = computeTrend(outputDir);
      if (!trend) return mdResult('No history available. Run `codemap generate` at least twice to see trends.');
      return mdResult(formatHealthDiff(trend));
    }
  );

  // --- Tool: codemap_structures ---
  server.tool(
    'codemap_structures',
    'Get raw structural analysis data for refactoring decisions. Types: "cohesion" (LCOM clusters for class splitting), "hotspots" (complex functions with callee data), "dead_code" (unreachable functions). Returns computed data, not suggestions — you decide what to refactor.',
    {
      type: z.enum(['cohesion', 'hotspots', 'dead_code']).describe('Analysis type'),
      target: z.string().optional().describe('Optional: specific class or function name to focus on'),
      project: projectParam,
    },
    async ({ type, target, project: projectName }) => {
      const resolved = resolveProject(projects, projectName);
      if ('error' in resolved) return errorResult(resolved.error);
      const { data } = resolved;
      return mdResult(formatStructures(data, type, target));
    }
  );
}

// --- Main ---

async function main() {
  const projects = resolveProjects();

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

  // Register all tools
  registerTools(server, projects, projectParam);

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`Codemap MCP server error: ${error.message}\n`);
  process.exit(1);
});
