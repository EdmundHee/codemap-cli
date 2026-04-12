<!-- codemap:start -->
## Codemap — MANDATORY USAGE RULES

This project has a **codemap MCP server** with pre-indexed code structure, call graphs, and relationships.
The following rules are **NOT optional** — follow them for every task.

### Before Writing New Code
- ALWAYS call `codemap_query` to search for existing functions that do something similar
- ALWAYS call `codemap_module` on the target directory to understand what's already there
- If you find similar functions, reuse or extend them — do NOT create duplicates
- For larger features, use `/codemap-find-reusable` to systematically search for reuse opportunities

### Before Modifying Existing Code
- ALWAYS call `codemap_callers` on any function you plan to change — know the blast radius
- ALWAYS call `codemap_calls` to understand what the function depends on
- Or use `codemap_explore` to see the full call-graph neighborhood in one call (callers + callees at configurable depth)
- If there are >5 callers, explain the impact before proceeding
- Use `codemap_dependencies` to trace file-level imports/dependents

### Before Planning
- Call `codemap_overview` to orient yourself in the project structure
- Call `codemap_module` on directories relevant to the task
- Call `codemap_query` to find existing code related to the feature
- Use `/codemap-plan` for complex multi-step implementations

### After Code Generation (completing a task)
- Call `codemap_health` to verify the health score didn't degrade
- Call `codemap_analyze` to check for introduced duplicates or dead code
- If health score dropped, explain what caused the regression
- Run `/codemap-refresh` to keep the codemap in sync with your changes

### Tool Priority
Use `codemap_*` tools **INSTEAD OF** grep/Glob/Read for:
- Finding function/class definitions → `codemap_query` (returns clustered results — hubs first, helpers folded)
- Understanding what calls what → `codemap_callers` / `codemap_calls`
- Exploring call-graph neighborhood → `codemap_explore` (BFS traversal: callers + callees in one call)
- Exploring project structure → `codemap_overview` / `codemap_module`
- Checking code quality → `codemap_health` / `codemap_analyze`
- Checking file dependencies → `codemap_dependencies`
- Finding DRY violations → `codemap_structures` with type "duplicates"
- Finding circular imports → `codemap_structures` with type "circular_deps"

### Workflows (for multi-step tasks)
- `/codemap-explore` — understand the project structure and architecture
- `/codemap-find-reusable` — search for existing code to reuse before writing new functions
- `/codemap-impact` — analyze blast radius before refactoring or modifying code
- `/codemap-plan` — create an implementation plan grounded in actual code structure
- `/codemap-analyze` — run full analysis: dead code, duplicates, circular deps
- `/codemap-health-review` — review code quality and identify what to refactor next
- `/codemap-refresh` — regenerate codemap when source files have changed
- `/codemap-usage` — view MCP tool usage statistics with 5-hour interval breakdown
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
