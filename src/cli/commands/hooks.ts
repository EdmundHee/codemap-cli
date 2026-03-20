import { Command } from 'commander';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { Logger } from '../../utils/logger';

/**
 * Claude Code hook definitions for codemap auto-refresh.
 *
 * Available hooks:
 *   - PostToolUse (Edit|Write): regenerate codemap after code changes
 *   - SessionStart: check freshness and regenerate if stale on session start
 */

interface HookEntry {
  type: 'command';
  command: string;
}

interface HookMatcher {
  matcher?: string;
  hooks: HookEntry[];
}

interface ClaudeSettings {
  hooks?: Record<string, HookMatcher[]>;
  [key: string]: unknown;
}

/** The hooks we inject */
const CODEMAP_HOOKS: ClaudeSettings['hooks'] = {
  PostToolUse: [
    {
      matcher: 'Edit|Write',
      hooks: [
        {
          type: 'command',
          command: 'codemap check --quiet || codemap generate --quiet',
        },
      ],
    },
  ],
};

const CODEMAP_HOOK_MARKER = '__codemap_auto_refresh';

/**
 * Read existing .claude/settings.json or return empty object.
 */
function loadSettings(settingsPath: string): ClaudeSettings {
  if (!existsSync(settingsPath)) return {};
  try {
    return JSON.parse(readFileSync(settingsPath, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Merge codemap hooks into existing settings without clobbering
 * user-defined hooks on the same events.
 */
function mergeHooks(settings: ClaudeSettings): ClaudeSettings {
  const merged = { ...settings };
  merged.hooks = merged.hooks || {};

  for (const [event, newMatchers] of Object.entries(CODEMAP_HOOKS!)) {
    const existing = merged.hooks[event] || [];

    // Remove any previously-injected codemap hook (idempotent update)
    const cleaned = existing.filter(
      (m) =>
        !m.hooks?.some((h) =>
          h.command?.includes('codemap check') || h.command?.includes('codemap generate')
        )
    );

    // Append our hooks
    merged.hooks[event] = [...cleaned, ...newMatchers];
  }

  return merged;
}

/**
 * Remove codemap hooks from settings.
 */
function removeHooks(settings: ClaudeSettings): ClaudeSettings {
  const merged = { ...settings };
  if (!merged.hooks) return merged;

  for (const event of Object.keys(merged.hooks)) {
    merged.hooks[event] = merged.hooks[event].filter(
      (m) =>
        !m.hooks?.some((h) =>
          h.command?.includes('codemap check') || h.command?.includes('codemap generate')
        )
    );
    // Clean up empty event arrays
    if (merged.hooks[event].length === 0) {
      delete merged.hooks[event];
    }
  }

  // Clean up empty hooks object
  if (Object.keys(merged.hooks).length === 0) {
    delete merged.hooks;
  }

  return merged;
}

/**
 * Check if codemap hooks are already installed.
 */
function hasCodemapHooks(settings: ClaudeSettings): boolean {
  if (!settings.hooks) return false;
  for (const matchers of Object.values(settings.hooks)) {
    for (const m of matchers) {
      if (
        m.hooks?.some((h) =>
          h.command?.includes('codemap check') || h.command?.includes('codemap generate')
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

export function setupHooks(root: string, logger: Logger): void {
  const claudeDir = join(root, '.claude');
  const settingsPath = join(claudeDir, 'settings.json');

  mkdirSync(claudeDir, { recursive: true });

  const settings = loadSettings(settingsPath);
  const alreadyInstalled = hasCodemapHooks(settings);

  const merged = mergeHooks(settings);
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n');

  if (alreadyInstalled) {
    logger.success('Updated codemap hooks in .claude/settings.json');
  } else {
    logger.success('Installed codemap hooks in .claude/settings.json');
  }

  logger.info('Hook: PostToolUse (Edit|Write) → auto-regenerate codemap after code changes');
}

export const hooksCommand = new Command('hooks')
  .description('Set up Claude Code hooks for automatic codemap regeneration')
  .option('-p, --path <path>', 'Project root directory', '.')
  .option('--remove', 'Remove codemap hooks instead of installing them', false)
  .option('--status', 'Check if hooks are installed', false)
  .action(async (options) => {
    const logger = new Logger();
    const root = resolve(options.path);
    const settingsPath = join(root, '.claude', 'settings.json');

    if (options.status) {
      const settings = loadSettings(settingsPath);
      if (hasCodemapHooks(settings)) {
        logger.success('Codemap hooks are installed');
        const hooks = settings.hooks || {};
        for (const [event, matchers] of Object.entries(hooks)) {
          for (const m of matchers) {
            if (
              m.hooks?.some((h) =>
                h.command?.includes('codemap check') || h.command?.includes('codemap generate')
              )
            ) {
              logger.info(`  ${event}${m.matcher ? ` (${m.matcher})` : ''} → codemap auto-refresh`);
            }
          }
        }
      } else {
        logger.warn('Codemap hooks are not installed. Run `codemap hooks` to set them up.');
      }
      return;
    }

    if (options.remove) {
      const settings = loadSettings(settingsPath);
      if (!hasCodemapHooks(settings)) {
        logger.info('No codemap hooks found — nothing to remove.');
        return;
      }
      const cleaned = removeHooks(settings);
      mkdirSync(join(root, '.claude'), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify(cleaned, null, 2) + '\n');
      logger.success('Removed codemap hooks from .claude/settings.json');
      return;
    }

    setupHooks(root, logger);
  });
