# codemap

A static analysis CLI that generates relationship maps of your codebase — classes, functions, imports, call graphs, type dependencies — and exposes them via MCP so AI coding assistants can understand your project without re-scanning it every session.

## Why

Every time an AI assistant works on your code, it spends tokens exploring the codebase: grepping for functions, reading files, following imports, building mental models from scratch. On large projects this means 10–20 tool calls just to understand how one feature connects.

codemap does this once, up front. It parses your entire codebase, builds a structured JSON map of all relationships, and serves it on demand via MCP. Instead of:

```
grep "createOrder" → 8 files → read file 1 → see import → read file 2 → grep again...
```

The assistant does:

```
codemap_query("createOrder") → defined in orders/service.ts, calls [validatePayment, calculateTotal],
                                called by [OrderController.create, checkout.handler]
```

One call instead of ten.

## Terminology

| Term | Meaning |
|------|---------|
| **Codemap** | The generated JSON + Markdown output describing your project's structure and relationships |
| **Call graph** | A map of which functions call which other functions |
| **Reverse call graph** | The inverse — which functions are called by which callers (useful for dead code detection and impact analysis) |
| **Import graph** | File-level dependency tree showing which files import from which other files |
| **Module** | A directory within your project, treated as a logical unit in the codemap output |
| **MCP** | Model Context Protocol — a standard for AI tools to discover and use external capabilities |
| **Framework detection** | Automatic identification of frameworks (Express, FastAPI, etc.) from config files and dependencies |

## Installation

```bash
# Clone and build
git clone https://github.com/EdmundHee/codemap-cli.git
cd codemap-cli
npm install
npm run build

# Make available globally
npm link
```

Requires Node.js >= 18.

## Quick Start

```bash
# Generate a codemap for your project
cd /path/to/your/project
codemap init          # creates .codemaprc
codemap generate      # parses codebase, writes .codemap/

# Query from CLI
codemap query --search "createOrder"
codemap query --function "validatePayment"
codemap query --callers "UserService.create"
codemap query --class "OrderController"

# Connect to Claude Code via MCP
claude mcp add codemap -- codemap-mcp /path/to/your/project
```

## Commands

### `codemap init`

Creates a `.codemaprc` configuration file with auto-detected include directories and default excludes.

```bash
codemap init                  # create config in current directory
codemap init --path ./myapp   # create config in a specific directory
codemap init --force          # overwrite existing config
```

### `codemap generate`

Parses the codebase and generates the codemap output.

```bash
codemap generate              # generate in current directory
codemap generate --path ./app # generate for a specific project
```

Output is written to `.codemap/`:

```
.codemap/
├── codemap.json       # Full structured data (classes, functions, call graphs, etc.)
├── codemap.md         # Compact root summary (~1500-2000 lines for large projects)
├── modules/           # Per-directory detailed markdown files
│   ├── src__core.md
│   ├── src__api.md
│   └── ...
└── .hashes            # Content hashes for change detection
```

### `codemap query`

Search and inspect the generated codemap.

```bash
codemap query --function <name>     # Query a function by name
codemap query --class <name>        # Query a class
codemap query --file <path>         # Query a file (partial match supported)
codemap query --module <dir>        # Query a directory/module
codemap query --type <name>         # Query a type/interface
codemap query --search <term>       # Search across everything
codemap query --callers <name>      # Show what calls a function
codemap query --calls <name>        # Show what a function calls
codemap query --json                # Output as JSON
```

## Configuration

The `.codemaprc` file controls what gets scanned and how. Created by `codemap init`.

```json
{
  "include": ["."],
  "exclude": [
    "node_modules",
    "__pycache__",
    "dist",
    "build",
    "lib",
    ".git",
    ".codemap",
    "*.test.*",
    "*.spec.*",
    "*.min.*",
    "coverage",
    "vendor",
    ".next",
    ".nuxt",
    "venv",
    ".venv",
    "env",
    ".env",
    ".tox",
    "eggs",
    "*.egg-info",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    "site-packages",
    "migrations"
  ],
  "projects": [
    "/path/to/project-a",
    { "name": "my-api", "root": "/path/to/project-b" }
  ]
}
```

| Field | Description |
|-------|-------------|
| `include` | Directories to scan. `["."]` scans everything from root. |
| `exclude` | Patterns to exclude. Supports directory names and glob patterns. |
| `projects` | (MCP only) List of project paths for multi-project MCP server. |
| `framework` | Override framework detection (default: auto-detect). |
| `output` | Output directory (default: `.codemap`). |
| `detail` | `"full"` for complete signatures, `"names-only"` for compact output. |
| `features` | Toggle specific analysis: `call_graph`, `import_graph`, `routes`, `models`, `types`, `data_flow`, `config_deps`, `middleware`. |

## MCP Server (Claude Code Integration)

The MCP server exposes codemap data as tools that Claude Code can call automatically.

### Setup

```bash
# Single project
claude mcp add codemap -- codemap-mcp /path/to/your/project

# Multiple projects via CLI args
claude mcp add codemap -- codemap-mcp ~/Work/project-a ~/Work/project-b

# Multiple projects via .codemaprc (reads "projects" field)
claude mcp add codemap -- codemap-mcp
```

For the config-based approach, add a `projects` array to `~/.codemaprc` or your project's `.codemaprc`.

### Available MCP Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `codemap_projects` | List all registered projects and their status | none |
| `codemap_overview` | Project summary: modules, frameworks, languages, file counts, dependencies | `project?` |
| `codemap_module` | Detailed info for a specific directory | `directory`, `project?` |
| `codemap_query` | Search by function, class, type, or file name (exact + fuzzy) | `name`, `project?` |
| `codemap_callers` | Find what calls a given function | `name`, `project?` |
| `codemap_calls` | Find what a given function calls | `name`, `project?` |

The `project` parameter is optional when only one project is registered. With multiple projects, Claude Code will select the right one based on context.

## Language Support

| Language | Parser | File Extensions | Features |
|----------|--------|-----------------|----------|
| TypeScript | ts-morph | `.ts`, `.tsx` | Classes, functions, imports, exports, types, interfaces, enums, decorators, call expressions, env vars |
| JavaScript | ts-morph | `.js`, `.jsx`, `.mjs`, `.cjs` | Same as TypeScript |
| Python | web-tree-sitter (WASM) | `.py` | Classes with inheritance, functions, imports (`import`/`from`), decorators, type hints, `__all__` exports, env vars (`os.environ`, `os.getenv`) |
| Vue | Vue parser + ts-morph | `.vue` | Extracts `<script setup>` or `<script>` blocks for full TS analysis. Captures `<template>` component references (PascalCase and kebab-case) in call graph. |

### Python-Specific Features

- Method access levels from naming conventions (`_protected`, `__private`, `public`)
- `__all__` export list detection
- Supports `import x`, `from x import y`, and `from . import z` patterns
- Async function detection

### Vue-Specific Features

- Prefers `<script setup>` over `<script>` when both exist
- Template component references (`<UserCard>`, `<base-modal>`) appear in call graph
- Shares TypeScript parser instance for efficiency

## Framework Detection

codemap auto-detects frameworks from your config files and dependencies:

| Framework | Detection Method |
|-----------|-----------------|
| Express | `express` in package.json (without NestJS) |
| NestJS | `@nestjs/core` in package.json |
| FastAPI | `fastapi` in requirements.txt / pyproject.toml |
| Django | `django` in requirements.txt or `manage.py` exists |
| Flask | `flask` in requirements.txt / pyproject.toml |
| Prisma | `prisma/schema.prisma` exists |
| Sequelize | `sequelize` in package.json |
| Mongoose | `mongoose` in package.json |
| TypeORM | `typeorm` in package.json |
| SQLAlchemy | `sqlalchemy` in requirements.txt / pyproject.toml |

## Noise Reduction

codemap filters out noise that would bloat the output and waste tokens:

- **Built-in calls filtered**: JS/TS builtins (`map`, `filter`, `push`, `JSON.stringify`, etc.) and Python builtins (`isinstance`, `len`, `str`, `range`, etc.) are removed from call graphs
- **Test assertions filtered**: `assertEqual`, `pytest.raises`, etc.
- **Chain expressions collapsed**: `foo.bar().baz().qux()` → `foo.bar`
- **Type signatures truncated**: Verbose `Annotated[bool, Doc("200 lines...")]` → `bool` (120 char limit)
- **`self.`/`this.` stripped**: Normalized for cleaner call graphs

## Dependency Tracking

codemap extracts dependency versions from manifest files without scanning library source code:

- **Node.js**: `package.json` (dependencies, devDependencies, peerDependencies)
- **Python**: `requirements.txt`, `requirements-dev.txt`, `pyproject.toml`

## Output Structure

### JSON (`codemap.json`)

The full structured output containing:

```
project         → name, languages, frameworks, entry points
files           → per-file: language, hash, exports, imports
classes         → per-class: file, extends, implements, decorators, methods, properties
functions       → per-function: file, params, return type, calls, called_by
types           → per-type: file, kind, extends, properties
call_graph      → caller → [callees]
import_graph    → file → [imported files]
dependencies    → package versions from manifests
config_deps     → env var usage across files
```

### Markdown (`codemap.md`)

A compact, directory-level root summary designed for AI context windows. Includes module counts, class/function listings grouped by directory, dependencies, and env var usage. Typically 1500–2000 lines for large projects.

### Module files (`modules/*.md`)

Per-directory detailed files with full function signatures, call/called_by relationships, and import graphs. Used by the MCP `codemap_module` tool for on-demand deep dives.

## Architecture

```
src/
├── cli/                  # CLI entry point and commands
│   ├── index.ts          # Commander setup
│   └── commands/         # generate, init, query, analyze, diff
├── core/                 # Core logic
│   ├── config.ts         # .codemaprc loading and defaults
│   ├── scanner.ts        # File discovery (fast-glob)
│   ├── orchestrator.ts   # Main pipeline: scan → parse → analyze → output
│   └── query-engine.ts   # Shared query logic (CLI + MCP)
├── parsers/              # Language-specific AST parsers
│   ├── parser.interface.ts
│   ├── typescript/       # ts-morph based
│   ├── python/           # web-tree-sitter WASM based
│   └── vue/              # Script extraction + TS delegation
├── analyzers/            # Relationship builders
│   ├── call-graph.ts     # Function → calls mapping
│   └── import-graph.ts   # File → imports mapping
├── frameworks/           # Auto-detection
│   └── detector.ts
├── output/               # Generators
│   ├── json-generator.ts # Full JSON output
│   └── md-generator.ts   # Compact MD + per-directory modules
├── mcp/                  # MCP server
│   └── server.ts         # Multi-project MCP with stdio transport
└── utils/
    ├── call-filter.ts    # Noise reduction (built-in filtering, type truncation)
    ├── logger.ts
    ├── hash.ts
    └── file-utils.ts
```

## Roadmap

- [ ] `codemap diff` — detect changes since last generation
- [ ] `codemap analyze` — dead code detection, duplicate functions, unused exports
- [ ] Route extraction for Express, FastAPI, Django, Flask
- [ ] Model/schema extraction for Prisma, SQLAlchemy, Mongoose
- [ ] Middleware chain mapping
- [ ] Incremental generation (only re-parse changed files)
- [ ] Watch mode for auto-regeneration

## License

MIT
