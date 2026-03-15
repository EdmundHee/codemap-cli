<!-- codemap:start -->
## Codemap

This project uses **codemap** for static analysis. A codemap MCP server is available
that provides pre-indexed project structure, call graphs, and relationships.

**Always prefer codemap MCP tools over grep/read for code exploration:**

- `codemap_overview` — project summary: modules, frameworks, languages, file counts
- `codemap_module` — all classes, functions, imports for a specific directory
- `codemap_query` — search by name (exact + fuzzy) across the entire codebase
- `codemap_callers` — find all callers of a function (impact analysis)
- `codemap_calls` — find all functions called by a function (dependency tracing)
- `codemap_projects` — list all registered projects (multi-project setups)

These return structured context in a single call instead of multiple file reads.
Use `codemap_overview` first to understand the project, then drill into specific
modules or functions as needed.
<!-- codemap:end -->

## Development

```bash
npm install          # install dependencies
npm run build        # compile TypeScript to dist/
npm run dev          # run CLI via ts-node (no build needed)
npm test             # run tests with Jest
npm run lint         # lint with ESLint
```

## Usage

### CLI Commands

```bash
codemap init                        # create .codemaprc in current directory
codemap generate                    # parse codebase and write .codemap/ output
codemap query --search <term>       # search functions, classes, files, types
codemap query --callers <name>      # find all callers of a function
codemap query --calls <name>        # find all functions called by a function
codemap analyze --all               # run all analysis (dead code, duplicates, circular deps)
codemap analyze --dead-code         # detect unused functions and methods
codemap analyze --duplicates        # detect duplicate/redundant functions
codemap analyze --circular          # detect circular dependencies
codemap health                      # show project health score (0-100) with hotspots
codemap health --gate --threshold 80  # CI quality gate (exit 1 if below score)
codemap diff                        # show changes since last generation
codemap check                       # check if codemap is stale (exit 0=fresh, 1=stale)
```

### MCP Server

```bash
codemap-mcp /path/to/project                    # single project
codemap-mcp ~/project-a ~/project-b             # multiple projects
claude mcp add codemap -- codemap-mcp /path     # register with Claude Code
```

## Architecture

Entry points: `src/cli/index.ts` (CLI), `src/mcp/server.ts` (MCP server).

The pipeline flows: scanner → parsers → call-graph/import-graph → json-generator → md-generator.

Key directories:
- `src/cli/commands/` — one file per CLI command (generate, analyze, health, query, etc.)
- `src/parsers/` — language-specific AST parsers (TypeScript via ts-morph, Python via tree-sitter WASM, Vue via script extraction)
- `src/analyzers/` — structural analysis (call-graph, dead-code, duplicates, circular-deps, coupling)
- `src/core/query-engine.ts` — shared query logic used by both CLI and MCP
- `src/mcp/formatters.ts` — markdown formatters for MCP tool output
- `src/utils/call-filter.ts` — noise reduction: filters builtins, normalizes calls, truncates types

## Call Graph Internals

The call graph (`src/analyzers/call-graph.ts`) has three resolution strategies in `buildReverseCallGraph`:

1. **Intra-class**: `this.method()` is parsed as `"method"` (after stripping `this.`), resolved to `"ClassName.method"` when the caller is in the same class.
2. **Instance variable**: `logger.success()` is parsed as `"logger.success"`, resolved to `"Logger.success"` by matching the method name against known class methods.
3. **Module-level closures**: Calls from array initializers, object literals, and other top-level expressions are captured via `moduleCalls` (extracted by the TS parser) and attributed to synthetic `__module__<filepath>` entries.
