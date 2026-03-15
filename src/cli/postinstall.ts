#!/usr/bin/env node
/**
 * Postinstall hook — runs after `npm install codemap-cli`.
 *
 * Sets up .claude/commands/ in the consuming project so that
 * /codemap-explore, /codemap-plan, etc. work in Claude Code immediately.
 *
 * Safety:
 *  - Only runs when installed as a dependency (not during local dev)
 *  - Never overwrites commands the user has customized (checks content hash)
 *  - Silently exits on any error (postinstall failures shouldn't break installs)
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';

// Detect the consuming project root.
// When installed as a dependency, process.env.INIT_CWD is the project root
// where `npm install` was run. Falls back to walking up from node_modules.
function findProjectRoot(): string | null {
  // INIT_CWD is set by npm/yarn/pnpm to the directory where install was run
  if (process.env.INIT_CWD) {
    return resolve(process.env.INIT_CWD);
  }

  // Fallback: walk up from __dirname (which is inside node_modules)
  // looking for a package.json that isn't ours
  let dir = resolve(__dirname, '..', '..');
  while (dir !== '/') {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const content = JSON.parse(readFileSync(pkg, 'utf-8'));
        if (content.name !== '@gingerdev/codemap-cli') return dir;
      } catch {
        // ignore
      }
    }
    dir = resolve(dir, '..');
  }

  return null;
}

function isLocalDev(): boolean {
  // Skip during local development (npm install in the codemap-cli repo itself)
  try {
    const pkg = join(process.cwd(), 'package.json');
    if (existsSync(pkg)) {
      const content = JSON.parse(readFileSync(pkg, 'utf-8'));
      if (content.name === 'codemap-cli') return true;
    }
  } catch {
    // ignore
  }
  return false;
}

// Command templates — keep in sync with init.ts CLAUDE_COMMANDS
const COMMANDS: Record<string, { description: string; content: string }> = {
  'codemap-explore.md': {
    description: 'Explore and understand the project structure using codemap',
    content: `---
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
  },

  'codemap-find-reusable.md': {
    description: 'Find existing functions to reuse or extend before writing new code',
    content: `---
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

Then provide a recommendation for each match:
- **Reuse as-is**: function already does what's needed, just import and call it
- **Extend**: function is close but needs a small addition — suggest how to extend it
- **Improve**: function has the right intent but poor implementation — suggest refactoring it
- **Write new**: nothing similar exists, explain why new code is justified

Always prefer reuse over new code. If writing new code, suggest which module it should live in based on the existing structure.
`,
  },

  'codemap-impact.md': {
    description: 'Analyze the blast radius before refactoring or modifying a function',
    content: `---
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
  },

  'codemap-plan.md': {
    description: 'Create an implementation plan using codemap to understand the codebase first',
    content: `---
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

Then produce a plan:
- **Existing code**: what already exists that's relevant (reuse opportunities)
- **Architecture fit**: where new code should live based on existing module boundaries
- **Implementation steps**: ordered list of changes, each referencing specific files/functions
- **Dependencies**: what existing code will be affected and how
- **Testing strategy**: what to test based on the call graph (which callers to verify)
- **Risk areas**: modules with high complexity or coupling that need extra care
`,
  },

  'codemap-health-review.md': {
    description: 'Review code quality and identify what to refactor next',
    content: `---
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
  },

  'codemap-refresh.md': {
    description: 'Regenerate codemap data when source files have changed',
    content: `---
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
  },
};

function main() {
  // Don't run during local development
  if (isLocalDev()) return;

  const projectRoot = findProjectRoot();
  if (!projectRoot) return;

  const commandsDir = join(projectRoot, '.claude', 'commands');

  try {
    mkdirSync(commandsDir, { recursive: true });

    let created = 0;
    for (const [filename, { content }] of Object.entries(COMMANDS)) {
      const filePath = join(commandsDir, filename);

      // Don't overwrite if user has customized the file
      if (existsSync(filePath)) continue;

      writeFileSync(filePath, content);
      created++;
    }

    if (created > 0) {
      // Use stderr so it doesn't interfere with npm output
      process.stderr.write(
        `\n  codemap: created ${created} Claude Code commands in .claude/commands/\n`
        + `  Available: /codemap-explore, /codemap-find-reusable, /codemap-impact, /codemap-plan, /codemap-health-review\n\n`
      );
    }
  } catch {
    // Silently ignore — postinstall failures shouldn't break npm install
  }
}

main();
