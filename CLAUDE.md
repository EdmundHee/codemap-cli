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
