import { Command } from 'commander';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { Logger } from '../../utils/logger';
import { DEFAULT_CONFIG, detectIncludeDirs } from '../../core/config';
import { setupHooks } from './hooks';

const CLAUDE_MD_SECTION_START = '<!-- codemap:start -->';
const CLAUDE_MD_SECTION_END = '<!-- codemap:end -->';

const CLAUDE_MD_CONTENT = `${CLAUDE_MD_SECTION_START}
## Codemap — MANDATORY USAGE RULES

This project has a **codemap MCP server** with pre-indexed code structure, call graphs, and relationships.
The following rules are **NOT optional** — follow them for every task.

### Before Writing New Code
- ALWAYS call \`codemap_query\` to search for existing functions that do something similar
- ALWAYS call \`codemap_module\` on the target directory to understand what's already there
- If you find similar functions, reuse or extend them — do NOT create duplicates
- For larger features, use \`/codemap-find-reusable\` to systematically search for reuse opportunities

### Before Modifying Existing Code
- ALWAYS call \`codemap_callers\` on any function you plan to change — know the blast radius
- ALWAYS call \`codemap_calls\` to understand what the function depends on
- If there are >5 callers, explain the impact before proceeding
- Use \`codemap_dependencies\` to trace file-level imports/dependents

### Before Planning
- Call \`codemap_overview\` to orient yourself in the project structure
- Call \`codemap_module\` on directories relevant to the task
- Call \`codemap_query\` to find existing code related to the feature
- Use \`/codemap-plan\` for complex multi-step implementations

### After Code Generation (completing a task)
- Call \`codemap_health\` to verify the health score didn't degrade
- Call \`codemap_analyze\` to check for introduced duplicates or dead code
- If health score dropped, explain what caused the regression
- Run \`/codemap-refresh\` to keep the codemap in sync with your changes

### Tool Priority
Use \`codemap_*\` tools **INSTEAD OF** grep/Glob/Read for:
- Finding function/class definitions → \`codemap_query\`
- Understanding what calls what → \`codemap_callers\` / \`codemap_calls\`
- Exploring project structure → \`codemap_overview\` / \`codemap_module\`
- Checking code quality → \`codemap_health\` / \`codemap_analyze\`
- Checking file dependencies → \`codemap_dependencies\`
- Finding DRY violations → \`codemap_structures\` with type "duplicates"
- Finding circular imports → \`codemap_structures\` with type "circular_deps"

### Workflows (for multi-step tasks)
- \`/codemap-explore\` — understand the project structure and architecture
- \`/codemap-find-reusable\` — search for existing code to reuse before writing new functions
- \`/codemap-impact\` — analyze blast radius before refactoring or modifying code
- \`/codemap-plan\` — create an implementation plan grounded in actual code structure
- \`/codemap-analyze\` — run full analysis: dead code, duplicates, circular deps
- \`/codemap-health-review\` — review code quality and identify what to refactor next
- \`/codemap-refresh\` — regenerate codemap when source files have changed
- \`/codemap-usage\` — view MCP tool usage statistics with 5-hour interval breakdown
${CLAUDE_MD_SECTION_END}`;

// --- Claude Code command templates ---

const CLAUDE_COMMANDS: Record<string, string> = {
  'codemap-explore.md': `---
description: Explore and understand the project structure using codemap
---

Explore and understand this project's codebase structure.

Steps:
1. Call \`codemap_overview\` to get the full project map — all modules, classes, functions, frameworks, and languages
2. Identify the most important directories based on file count and what the user is interested in
3. For the top 2-3 relevant modules, call \`codemap_module\` on each to get detailed class/function listings
4. Summarize: project structure, key entry points, main abstractions, and how the modules connect

If the user specified a focus area: $ARGUMENTS
— prioritize modules related to that area and drill deeper into those.

Present results as a concise architectural overview, not a raw data dump.
`,

  'codemap-find-reusable.md': `---
description: Find existing functions to reuse or extend before writing new code
---

Before writing new code for: $ARGUMENTS

Search the codebase for existing functions, classes, or utilities that already do something similar — so we can reuse, extend, or improve them instead of duplicating logic.

Steps:
1. Break down the requested functionality into key concepts and action words
2. For each concept, call \`codemap_query\` to search for existing functions/classes with related names
3. For promising matches, call \`codemap_calls\` to understand their internal dependencies
4. For promising matches, call \`codemap_callers\` to see how widely they're already used (more callers = more mature/tested)
5. Check \`codemap_module\` on the directories where matches live to see if there are related utilities nearby
6. Call \`codemap_analyze\` with checks=["duplicates"] to find functions with similar call patterns — these are strong reuse candidates even if names don't match

Then provide a recommendation for each match:
- **Reuse as-is**: function already does what's needed, just import and call it
- **Extend**: function is close but needs a small addition — suggest how to extend it
- **Improve**: function has the right intent but poor implementation — suggest refactoring it
- **Write new**: nothing similar exists, explain why new code is justified

Always prefer reuse over new code. If writing new code, suggest which module it should live in based on the existing structure.
`,

  'codemap-impact.md': `---
description: Analyze the blast radius before refactoring or modifying a function
---

Analyze the impact of changing: $ARGUMENTS

Before modifying this code, we need to understand the full blast radius — what will break, what needs updating, and how risky the change is.

Steps:
1. Call \`codemap_query\` to find the exact function/class and confirm its location and signature
2. Call \`codemap_callers\` to find every call site — these are all the places that could break
3. Call \`codemap_calls\` to find all dependencies — these are what the function relies on
4. For each caller's directory, call \`codemap_module\` to understand the surrounding context
5. Call \`codemap_health\` scoped to the affected modules to check existing code quality

Produce an impact report:
- **Target**: what's being changed, where it lives, current signature
- **Direct callers**: list every function that calls this, grouped by module
- **Transitive impact**: callers-of-callers if the signature is changing
- **Dependencies**: what this function calls (need to verify these still work after change)
- **Risk level**: Low (1-2 callers, same module) / Medium (3-10 callers, multiple modules) / High (10+ callers or public API)
- **Suggested approach**: how to safely make the change (feature flag, deprecation, etc.)
`,

  'codemap-plan.md': `---
description: Create an implementation plan using codemap to understand the codebase first
---

Create an implementation plan for: $ARGUMENTS

Before planning, gather structural knowledge about the codebase so the plan is grounded in how the code actually works — not guesses.

Steps:
1. Call \`codemap_overview\` to understand the full project structure, modules, and patterns
2. Call \`codemap_query\` to search for any existing code related to the feature/change
3. For relevant matches, call \`codemap_callers\` and \`codemap_calls\` to understand how they fit into the architecture
4. Call \`codemap_module\` on the directories where changes will likely be needed
5. Call \`codemap_health\` to identify any existing quality issues in affected areas
6. Call \`codemap_analyze\` scoped to affected modules to flag duplicates, dead code, or circular deps you should address

Then produce a plan:
- **Existing code**: what already exists that's relevant (reuse opportunities)
- **Architecture fit**: where new code should live based on existing module boundaries
- **Implementation steps**: ordered list of changes, each referencing specific files/functions
- **Dependencies**: what existing code will be affected and how
- **Testing strategy**: what to test based on the call graph (which callers to verify)
- **Risk areas**: modules with high complexity or coupling that need extra care
- **Cleanup opportunities**: any dead code to remove or duplicates to consolidate while you're in the area
`,

  'codemap-analyze.md': `---
description: Run full code analysis — dead code, duplicates, circular deps — and get recommendations
---

Run a comprehensive code analysis and produce actionable recommendations.

Steps:
1. Call \`codemap_analyze\` to get dead code, duplicate functions, and circular dependencies
2. Call \`codemap_health\` to get the current health score and hotspots
3. If a scope was specified ($ARGUMENTS), call \`codemap_analyze\` with scope set to that module/area

Present results as a prioritized action list:
- **Duplicates to consolidate**: functions that do the same thing in different files — merge them
- **Dead code to delete**: unreachable functions safe to remove immediately
- **Circular deps to break**: import cycles with minimum-cut suggestions
- **Complexity hotspots**: functions to simplify or split
- **Overall health**: score, trend, and top improvement opportunities
`,

  'codemap-health-review.md': `---
description: Review code quality and identify what to refactor next
---

Review the codebase health and identify the highest-priority improvements.

Steps:
1. Call \`codemap_health\` for the full project health score and metrics
2. Call \`codemap_structures\` with type "hotspots" to find the most complex functions
3. Call \`codemap_structures\` with type "dead_code" to find unreachable functions safe to delete
4. Call \`codemap_structures\` with type "cohesion" to find god classes that should be split
5. If a specific area was mentioned ($ARGUMENTS), scope the analysis to that module

Produce a prioritized action list:
- **Quick wins**: dead code to delete (zero risk, immediate cleanup)
- **High impact**: complex hotspots with many callers (simplifying these improves the most code paths)
- **Structural**: god classes or high-coupling modules that need architectural attention
- **Overall assessment**: health score interpretation and trend direction
`,

  'codemap-refresh.md': `---
description: Regenerate codemap data when source files have changed
allowed-tools: Bash
---

Check if the codemap is stale and regenerate if needed.

Steps:
1. Run \`codemap check --quiet\` to see if source files changed since last generation
   - Exit code 0 = fresh (no changes needed)
   - Exit code 1 = stale (files changed, needs regeneration)
   - Exit code 2 = missing (no codemap exists yet)
2. If stale or missing, run \`codemap generate\` to rebuild the codemap
3. After generation, run \`codemap health --summary\` to show the updated health score
4. If the user specified a scope ($ARGUMENTS), also run \`codemap_health\` scoped to that module to show details

Report what changed: how many files were re-parsed, the new health score, and whether the score improved or degraded compared to the previous run.
`,

  'codemap-usage.md': `---
description: View MCP tool usage statistics with 5-hour interval breakdown
---

Show codemap MCP usage statistics to understand how the tools are being utilized.

Steps:
1. Call \`codemap_usage\` with format "summary" to get the full usage report
2. Highlight the key insights:
   - Which tools are used most and least
   - The 5-hour interval breakdown showing usage patterns over time
   - Any tools with high error rates that may need attention
   - Most frequently queried parameters (shows which parts of the codebase get the most AI attention)
3. If the user specified a focus ($ARGUMENTS), filter or emphasize that aspect:
   - "json" → call \`codemap_usage\` with format "json" instead
   - A tool name → highlight stats for that specific tool
   - "today" or a date → focus on intervals for that day

Present the data clearly — don't just dump the raw output. Summarize trends and actionable insights.
`,
};

function updateClaudeMd(root: string, logger: Logger): void {
  const claudeMdPath = join(root, 'CLAUDE.md');

  if (existsSync(claudeMdPath)) {
    const existing = readFileSync(claudeMdPath, 'utf-8');

    // Check if codemap section already exists
    if (existing.includes(CLAUDE_MD_SECTION_START)) {
      // Replace existing section
      const regex = new RegExp(
        `${escapeRegex(CLAUDE_MD_SECTION_START)}[\\s\\S]*?${escapeRegex(CLAUDE_MD_SECTION_END)}`,
        'g'
      );
      const updated = existing.replace(regex, CLAUDE_MD_CONTENT);
      writeFileSync(claudeMdPath, updated);
      logger.success('Updated codemap section in CLAUDE.md');
    } else {
      // Append section
      const separator = existing.endsWith('\n') ? '\n' : '\n\n';
      writeFileSync(claudeMdPath, existing + separator + CLAUDE_MD_CONTENT + '\n');
      logger.success('Added codemap section to CLAUDE.md');
    }
  } else {
    // Create new CLAUDE.md
    writeFileSync(claudeMdPath, CLAUDE_MD_CONTENT + '\n');
    logger.success('Created CLAUDE.md with codemap instructions');
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function generateClaudeCommands(root: string, logger: Logger): void {
  const commandsDir = join(root, '.claude', 'commands');

  try {
    mkdirSync(commandsDir, { recursive: true });

    let created = 0;
    let updated = 0;
    for (const [filename, content] of Object.entries(CLAUDE_COMMANDS)) {
      const filePath = join(commandsDir, filename);
      if (existsSync(filePath)) {
        const existing = readFileSync(filePath, 'utf-8');
        if (existing === content) continue;
        updated++;
      } else {
        created++;
      }
      writeFileSync(filePath, content);
    }

    if (created > 0 || updated > 0) {
      const parts: string[] = [];
      if (created > 0) parts.push(`created ${created}`);
      if (updated > 0) parts.push(`updated ${updated}`);
      logger.success(`Claude commands: ${parts.join(', ')} in .claude/commands/`);
    } else {
      logger.info('Claude commands already up to date');
    }
  } catch (error) {
    logger.warn(`Could not create Claude commands: ${(error as Error).message}`);
  }
}

export const initCommand = new Command('init')
  .description('Create a .codemaprc config file in the current directory')
  .option('-p, --path <path>', 'Directory to create config in', '.')
  .option('--force', 'Overwrite existing config', false)
  .option('--no-claude-md', 'Skip creating/updating CLAUDE.md')
  .option('--no-hooks', 'Skip setting up Claude Code hooks')
  .action(async (options) => {
    const logger = new Logger();
    const root = resolve(options.path);
    const configPath = join(root, '.codemaprc');

    if (existsSync(configPath) && !options.force) {
      logger.warn('.codemaprc already exists. Use --force to overwrite.');
      return;
    }

    try {
      // Auto-detect include directories based on actual project structure
      const detectedDirs = detectIncludeDirs(root);

      // Write both include and exclude so users can see and customize both.
      // When .codemaprc has an exclude list, loadConfig uses it as-is.
      // Only falls back to defaults when no exclude field is present.
      const config: Record<string, any> = {
        include: detectedDirs,
        exclude: [...DEFAULT_CONFIG.exclude],
      };

      writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
      logger.success(`Created ${configPath}`);
      logger.info(`Auto-detected include dirs: ${detectedDirs.join(', ')}`);
      logger.info(`Default excludes written — customize as needed`);

      // Create/update CLAUDE.md and Claude Code commands
      if (options.claudeMd !== false) {
        updateClaudeMd(root, logger);
        generateClaudeCommands(root, logger);
      }

      // Set up Claude Code hooks for auto-refresh
      if (options.hooks !== false) {
        setupHooks(root, logger);
      }
    } catch (error) {
      logger.error(`Failed to create config: ${(error as Error).message}`);
      process.exit(1);
    }
  });
