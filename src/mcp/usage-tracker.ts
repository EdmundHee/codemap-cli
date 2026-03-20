/**
 * MCP Usage Tracker
 *
 * Tracks invocation counts, latency, errors, and parameter patterns
 * for every MCP tool call. Persists metrics to .codemap/usage-stats.json
 * so stats survive server restarts and can be analyzed over time.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// --- Types ---

export interface ToolMetrics {
  callCount: number;
  totalLatencyMs: number;
  avgLatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  errorCount: number;
  lastCalledAt: string | null;
  firstCalledAt: string | null;
  /** Track which parameter values are used most often (top-level string params only) */
  paramFrequency: Record<string, Record<string, number>>;
}

export interface UsageSnapshot {
  version: 1;
  serverStartedAt: string;
  lastFlushedAt: string;
  totalCalls: number;
  totalErrors: number;
  tools: Record<string, ToolMetrics>;
  /** Per-session history: one entry per server lifecycle */
  sessions: SessionEntry[];
  /** Usage bucketed into 5-hour intervals, keyed by "YYYY-MM-DD/HH:00-HH:00" */
  intervals: Record<string, IntervalBucket>;
}

export interface SessionEntry {
  startedAt: string;
  endedAt: string | null;
  totalCalls: number;
  toolCalls: Record<string, number>;
}

/**
 * A 5-hour interval bucket.
 * Key format: "2026-03-20/10:00-15:00"
 * Windows: 00:00-05:00, 05:00-10:00, 10:00-15:00, 15:00-20:00, 20:00-00:00
 */
export interface IntervalBucket {
  /** ISO date string for the start of this interval */
  intervalStart: string;
  /** ISO date string for the end of this interval */
  intervalEnd: string;
  /** Human-readable label e.g. "2026-03-20 10:00–15:00" */
  label: string;
  totalCalls: number;
  totalErrors: number;
  /** Per-tool call counts within this interval */
  toolCalls: Record<string, number>;
  /** Per-tool error counts within this interval */
  toolErrors: Record<string, number>;
}

// --- Default factories ---

function newToolMetrics(): ToolMetrics {
  return {
    callCount: 0,
    totalLatencyMs: 0,
    avgLatencyMs: 0,
    minLatencyMs: Infinity,
    maxLatencyMs: 0,
    errorCount: 0,
    lastCalledAt: null,
    firstCalledAt: null,
    paramFrequency: {},
  };
}

function newSnapshot(): UsageSnapshot {
  return {
    version: 1,
    serverStartedAt: new Date().toISOString(),
    lastFlushedAt: new Date().toISOString(),
    totalCalls: 0,
    totalErrors: 0,
    tools: {},
    sessions: [],
    intervals: {},
  };
}

/** 5-hour interval boundaries (hours) */
const INTERVAL_BOUNDARIES = [0, 5, 10, 15, 20, 24] as const;

/**
 * Get the interval key and bucket metadata for a given Date.
 * Returns e.g. { key: "2026-03-20/10:00-15:00", label: "2026-03-20 10:00–15:00", start, end }
 */
function getIntervalKey(date: Date): { key: string; label: string; intervalStart: string; intervalEnd: string } {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const dateStr = `${year}-${month}-${day}`;
  const hour = date.getHours();

  let startHour = 0;
  let endHour = 5;
  for (let i = 0; i < INTERVAL_BOUNDARIES.length - 1; i++) {
    if (hour >= INTERVAL_BOUNDARIES[i] && hour < INTERVAL_BOUNDARIES[i + 1]) {
      startHour = INTERVAL_BOUNDARIES[i];
      endHour = INTERVAL_BOUNDARIES[i + 1];
      break;
    }
  }

  const startStr = String(startHour).padStart(2, '0') + ':00';
  const endStr = endHour === 24 ? '00:00' : String(endHour).padStart(2, '0') + ':00';
  const key = `${dateStr}/${startStr}-${endStr}`;
  const label = `${dateStr} ${startStr}–${endStr}`;

  // Compute ISO timestamps for interval boundaries
  const intervalStartDate = new Date(date);
  intervalStartDate.setHours(startHour, 0, 0, 0);

  const intervalEndDate = new Date(date);
  if (endHour === 24) {
    intervalEndDate.setDate(intervalEndDate.getDate() + 1);
    intervalEndDate.setHours(0, 0, 0, 0);
  } else {
    intervalEndDate.setHours(endHour, 0, 0, 0);
  }

  return {
    key,
    label,
    intervalStart: intervalStartDate.toISOString(),
    intervalEnd: intervalEndDate.toISOString(),
  };
}

// --- UsageTracker class ---

export class UsageTracker {
  private snapshot: UsageSnapshot;
  private persistPath: string | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private dirty = false;
  private currentSession: SessionEntry;

  constructor(projectRoots?: string[]) {
    // Try to load existing stats, or start fresh
    this.snapshot = newSnapshot();
    this.currentSession = {
      startedAt: new Date().toISOString(),
      endedAt: null,
      totalCalls: 0,
      toolCalls: {},
    };

    if (projectRoots && projectRoots.length > 0) {
      // Use the first project's .codemap dir for persistence
      const codemapDir = join(projectRoots[0], '.codemap');
      this.persistPath = join(codemapDir, 'usage-stats.json');
      this.loadFromDisk();
    }

    // Append current session
    this.snapshot.sessions.push(this.currentSession);
    this.snapshot.serverStartedAt = this.currentSession.startedAt;

    // Auto-flush every 30 seconds if there are changes
    this.flushTimer = setInterval(() => {
      if (this.dirty) this.flush();
    }, 30_000);

    // Flush on exit
    process.on('beforeExit', () => this.shutdown());
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  /**
   * Record a tool invocation. Call this at the START, then call
   * `recordEnd` with the returned token when done.
   */
  recordStart(toolName: string, params?: Record<string, unknown>): InvocationToken {
    const start = Date.now();
    const metrics = this.ensureTool(toolName);

    // Track parameter frequency (only top-level string values)
    if (params) {
      for (const [key, val] of Object.entries(params)) {
        if (typeof val === 'string' && val.length < 200) {
          metrics.paramFrequency[key] ??= {};
          metrics.paramFrequency[key][val] = (metrics.paramFrequency[key][val] || 0) + 1;
        }
      }
    }

    return { toolName, startMs: start };
  }

  /**
   * Record the end of a tool invocation.
   */
  recordEnd(token: InvocationToken, isError = false): void {
    const elapsed = Date.now() - token.startMs;
    const metrics = this.ensureTool(token.toolName);
    const now = new Date().toISOString();

    metrics.callCount++;
    metrics.totalLatencyMs += elapsed;
    metrics.avgLatencyMs = Math.round(metrics.totalLatencyMs / metrics.callCount);
    metrics.minLatencyMs = Math.min(metrics.minLatencyMs, elapsed);
    metrics.maxLatencyMs = Math.max(metrics.maxLatencyMs, elapsed);
    metrics.lastCalledAt = now;
    if (!metrics.firstCalledAt) metrics.firstCalledAt = now;

    if (isError) {
      metrics.errorCount++;
      this.snapshot.totalErrors++;
    }

    this.snapshot.totalCalls++;

    // Update session counters
    this.currentSession.totalCalls++;
    this.currentSession.toolCalls[token.toolName] =
      (this.currentSession.toolCalls[token.toolName] || 0) + 1;

    // Update 5-hour interval bucket
    const interval = getIntervalKey(new Date());
    if (!this.snapshot.intervals[interval.key]) {
      this.snapshot.intervals[interval.key] = {
        intervalStart: interval.intervalStart,
        intervalEnd: interval.intervalEnd,
        label: interval.label,
        totalCalls: 0,
        totalErrors: 0,
        toolCalls: {},
        toolErrors: {},
      };
    }
    const bucket = this.snapshot.intervals[interval.key];
    bucket.totalCalls++;
    bucket.toolCalls[token.toolName] = (bucket.toolCalls[token.toolName] || 0) + 1;
    if (isError) {
      bucket.totalErrors++;
      bucket.toolErrors[token.toolName] = (bucket.toolErrors[token.toolName] || 0) + 1;
    }

    this.dirty = true;
  }

  /**
   * Get the current usage snapshot (for the codemap_usage tool).
   */
  getSnapshot(): UsageSnapshot {
    // Fix up Infinity for serialization
    const snapshot = JSON.parse(JSON.stringify(this.snapshot));
    for (const tool of Object.values(snapshot.tools) as ToolMetrics[]) {
      if (tool.minLatencyMs === null || !isFinite(tool.minLatencyMs)) {
        tool.minLatencyMs = 0;
      }
    }
    return snapshot;
  }

  /**
   * Get a formatted summary suitable for markdown display.
   */
  getSummary(): string {
    const s = this.snapshot;
    const lines: string[] = [];

    lines.push('# MCP Usage Statistics\n');
    lines.push(`**Server started:** ${s.serverStartedAt}`);
    lines.push(`**Total calls:** ${s.totalCalls}`);
    lines.push(`**Total errors:** ${s.totalErrors}`);
    lines.push(`**Sessions tracked:** ${s.sessions.length}\n`);

    // Tool breakdown table
    const tools = Object.entries(s.tools).sort(
      ([, a], [, b]) => b.callCount - a.callCount
    );

    if (tools.length === 0) {
      lines.push('_No tool calls recorded yet._');
      return lines.join('\n');
    }

    lines.push('## Tool Utilization\n');
    lines.push('| Tool | Calls | Errors | Avg Latency | Min | Max | Last Used |');
    lines.push('|------|------:|-------:|------------:|----:|----:|-----------|');

    for (const [name, m] of tools) {
      const min = isFinite(m.minLatencyMs) ? `${m.minLatencyMs}ms` : '-';
      lines.push(
        `| ${name} | ${m.callCount} | ${m.errorCount} | ${m.avgLatencyMs}ms | ${min} | ${m.maxLatencyMs}ms | ${m.lastCalledAt ? new Date(m.lastCalledAt).toLocaleString() : '-'} |`
      );
    }

    // Utilization percentages
    if (s.totalCalls > 0) {
      lines.push('\n## Utilization Distribution\n');
      for (const [name, m] of tools) {
        const pct = ((m.callCount / s.totalCalls) * 100).toFixed(1);
        const bar = '█'.repeat(Math.round(Number(pct) / 5)) + '░'.repeat(20 - Math.round(Number(pct) / 5));
        lines.push(`- **${name}**: ${bar} ${pct}% (${m.callCount} calls)`);
      }
    }

    // Top parameters
    const paramInsights: string[] = [];
    for (const [toolName, m] of tools) {
      for (const [paramName, freqs] of Object.entries(m.paramFrequency)) {
        const sorted = Object.entries(freqs).sort(([, a], [, b]) => b - a).slice(0, 5);
        if (sorted.length > 0) {
          paramInsights.push(`- **${toolName}.${paramName}**: ${sorted.map(([v, c]) => `\`${v}\` (${c})`).join(', ')}`);
        }
      }
    }

    if (paramInsights.length > 0) {
      lines.push('\n## Most Queried Parameters\n');
      lines.push(...paramInsights);
    }

    // 5-hour interval breakdown (last 20 intervals)
    const intervalEntries = Object.entries(s.intervals)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-20);

    if (intervalEntries.length > 0) {
      lines.push('\n## 5-Hour Interval Breakdown\n');
      lines.push('| Interval | Total | Errors | Tools Breakdown |');
      lines.push('|----------|------:|-------:|-----------------|');

      for (const [, bucket] of intervalEntries) {
        const toolBreakdown = Object.entries(bucket.toolCalls)
          .sort(([, a], [, b]) => b - a)
          .map(([name, count]) => {
            const errors = bucket.toolErrors[name] || 0;
            return errors > 0 ? `${name}: ${count} (${errors} err)` : `${name}: ${count}`;
          })
          .join(', ');
        lines.push(
          `| ${bucket.label} | ${bucket.totalCalls} | ${bucket.totalErrors} | ${toolBreakdown} |`
        );
      }

      // Show per-tool heatmap across intervals
      const allToolNames = new Set<string>();
      for (const [, bucket] of intervalEntries) {
        for (const tool of Object.keys(bucket.toolCalls)) allToolNames.add(tool);
      }

      if (allToolNames.size > 0 && intervalEntries.length > 1) {
        lines.push('\n## Tool Activity Heatmap (per interval)\n');

        // Header row: interval labels shortened
        const shortLabels = intervalEntries.map(([, b]) => {
          const parts = b.label.split(' ');
          return parts.length > 1 ? parts[1] : parts[0];
        });
        lines.push('| Tool | ' + shortLabels.join(' | ') + ' |');
        lines.push('|------|' + shortLabels.map(() => '-----:').join('|') + '|');

        for (const tool of [...allToolNames].sort()) {
          const cells = intervalEntries.map(([, bucket]) => {
            const count = bucket.toolCalls[tool] || 0;
            return count > 0 ? String(count) : '·';
          });
          lines.push(`| ${tool} | ${cells.join(' | ')} |`);
        }
      }
    }

    // Session history (last 10)
    const recentSessions = s.sessions.slice(-10).reverse();
    if (recentSessions.length > 1) {
      lines.push('\n## Recent Sessions\n');
      lines.push('| Started | Calls | Top Tool |');
      lines.push('|---------|------:|----------|');
      for (const sess of recentSessions) {
        const topTool = Object.entries(sess.toolCalls).sort(([, a], [, b]) => b - a)[0];
        lines.push(
          `| ${new Date(sess.startedAt).toLocaleString()} | ${sess.totalCalls} | ${topTool ? `${topTool[0]} (${topTool[1]})` : '-'} |`
        );
      }
    }

    return lines.join('\n');
  }

  // --- Internal ---

  private ensureTool(toolName: string): ToolMetrics {
    if (!this.snapshot.tools[toolName]) {
      this.snapshot.tools[toolName] = newToolMetrics();
    }
    return this.snapshot.tools[toolName];
  }

  private loadFromDisk(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.persistPath, 'utf-8'));
      if (raw.version === 1) {
        this.snapshot = raw;
        // Migrate: ensure intervals exists (added in v1.1)
        if (!this.snapshot.intervals) this.snapshot.intervals = {};
        // Keep max 50 sessions to avoid unbounded growth
        if (this.snapshot.sessions.length > 50) {
          this.snapshot.sessions = this.snapshot.sessions.slice(-50);
        }
        // Keep max 200 interval buckets (~40 days at 5 intervals/day)
        const intervalKeys = Object.keys(this.snapshot.intervals).sort();
        if (intervalKeys.length > 200) {
          const toRemove = intervalKeys.slice(0, intervalKeys.length - 200);
          for (const key of toRemove) delete this.snapshot.intervals[key];
        }
      }
    } catch {
      // Corrupted file — start fresh
    }
  }

  flush(): void {
    if (!this.persistPath) return;
    try {
      const dir = this.persistPath.replace(/\/[^/]+$/, '');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      this.snapshot.lastFlushedAt = new Date().toISOString();
      this.currentSession.endedAt = new Date().toISOString();
      writeFileSync(this.persistPath, JSON.stringify(this.snapshot, null, 2));
      this.dirty = false;
    } catch {
      // Silently ignore write failures (read-only filesystem, etc.)
    }
  }

  private shutdown(): void {
    this.currentSession.endedAt = new Date().toISOString();
    this.flush();
    if (this.flushTimer) clearInterval(this.flushTimer);
  }
}

export interface InvocationToken {
  toolName: string;
  startMs: number;
}
