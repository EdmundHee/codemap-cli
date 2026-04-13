/**
 * Token-split search index with relevance scoring.
 *
 * Instead of naive substring matching, splits camelCase/snake_case/PascalCase
 * identifiers into tokens and scores matches by:
 *   1. How many query tokens match name tokens (exact > prefix)
 *   2. Structural importance (exported, caller count, class vs function)
 *   3. Penalties for test files and private names
 *
 * This enables multi-word queries: "call graph" finds buildCallGraph,
 * buildReverseCallGraph — something substring matching can't do.
 */

export interface ScoredResult<T> {
  item: T;
  score: number;
}

/**
 * Split an identifier into lowercase tokens.
 *
 * Handles camelCase, PascalCase, snake_case, dot notation, kebab-case,
 * and consecutive uppercase (e.g. "parseURL" → ["parse", "url"]).
 */
export function tokenize(name: string): string[] {
  return name
    // Insert space before uppercase letters following lowercase: "buildCall" → "build Call"
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    // Insert space between consecutive uppercase and following lowercase: "URLParser" → "URL Parser"
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    // Replace separators with spaces
    .replace(/[._\-/]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/**
 * Score how well query tokens match name tokens.
 * Returns 0-2 scale: 0 = no match, 2 = all tokens matched exactly.
 */
export function scoreTokenMatch(queryTokens: string[], nameTokens: string[]): number {
  if (queryTokens.length === 0 || nameTokens.length === 0) return 0;

  let totalScore = 0;
  for (const qt of queryTokens) {
    // Exact match is worth 2, prefix match is worth 1
    if (nameTokens.some((nt) => nt === qt)) {
      totalScore += 2;
    } else if (nameTokens.some((nt) => nt.startsWith(qt) || qt.startsWith(nt))) {
      totalScore += 1;
    }
  }

  return totalScore / queryTokens.length;
}

/**
 * Compute relevance score combining name match quality with structural importance.
 */
export function computeRelevance(
  nameScore: number,
  entity: {
    name: string;
    file?: string;
    type: string;
    exported?: boolean;
    callerCount?: number;
  }
): number {
  let score = nameScore * 10;

  // Boost exported symbols (entry points)
  if (entity.exported) score += 3;

  // Boost widely-used functions
  if (entity.callerCount) score += Math.min(entity.callerCount, 5);

  // Boost classes slightly (usually more important than individual functions)
  if (entity.type === 'class') score += 1;

  // Penalize private/internal names
  if (entity.name.startsWith('_')) score -= 3;

  // Penalize test files
  if (entity.file?.includes('__tests__') || entity.file?.includes('.test.') || entity.file?.includes('.spec.')) {
    score -= 5;
  }

  return score;
}

/**
 * Ranked search: tokenize query and names, score matches, return sorted.
 *
 * Falls back to substring matching when no token matches found,
 * so file path searches like "query-engine" still work.
 */
export function rankedSearch<T extends { name: string; file?: string }>(
  items: T[],
  term: string,
  getMetadata: (item: T) => { type: string; exported?: boolean; callerCount?: number }
): ScoredResult<T>[] {
  if (!term || term.trim().length === 0) return [];

  const queryTokens = tokenize(term);
  const lowerTerm = term.toLowerCase();

  const scored: ScoredResult<T>[] = [];

  for (const item of items) {
    const nameTokens = tokenize(item.name);
    const tokenScore = scoreTokenMatch(queryTokens, nameTokens);

    if (tokenScore > 0) {
      const meta = getMetadata(item);
      const relevance = computeRelevance(tokenScore, {
        name: item.name,
        file: item.file,
        ...meta,
      });
      scored.push({ item, score: relevance });
    } else if (item.name.toLowerCase().includes(lowerTerm)) {
      // Substring fallback — lower base score
      const meta = getMetadata(item);
      const relevance = computeRelevance(0.5, {
        name: item.name,
        file: item.file,
        ...meta,
      });
      scored.push({ item, score: relevance });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}
