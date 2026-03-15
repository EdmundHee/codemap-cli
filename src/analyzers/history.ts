/**
 * Health history storage and trend analysis.
 *
 * Stores health snapshots in .codemap/health-history.json
 * and computes trends between runs.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { HealthData } from '../output/json-generator';

export interface HealthSnapshot {
  timestamp: string;
  score: number;
  file_count: number;
  metrics: {
    total_functions: number;
    avg_complexity: number;
    functions_over_threshold: number;
    circular_dependencies: number;
    dead_functions: number;
    boundary_violations: number;
  };
}

export interface HealthTrend {
  current: number;
  previous: number;
  delta: number;
  direction: 'improving' | 'stable' | 'degrading';
  degradingSince: string | null;
  topMovers: Array<{
    metric: string;
    previous: number;
    current: number;
    delta: number;
    direction: 'better' | 'worse';
  }>;
  historyLength: number;
}

const MAX_HISTORY = 100;

/**
 * Load existing health history from disk.
 */
export function loadHistory(outputDir: string): HealthSnapshot[] {
  const historyPath = join(outputDir, 'health-history.json');
  if (!existsSync(historyPath)) return [];

  try {
    return JSON.parse(readFileSync(historyPath, 'utf-8'));
  } catch {
    return [];
  }
}

/**
 * Append a new health snapshot to history.
 */
export function appendHistory(
  outputDir: string,
  health: HealthData,
  fileCount: number,
  circularDeps: number,
  boundaryViolations: number
): void {
  const history = loadHistory(outputDir);

  const snapshot: HealthSnapshot = {
    timestamp: new Date().toISOString(),
    score: health.score,
    file_count: fileCount,
    metrics: {
      total_functions: health.metrics.total_functions,
      avg_complexity: health.metrics.avg_function_complexity,
      functions_over_threshold: health.metrics.functions_over_complexity_threshold,
      circular_dependencies: circularDeps,
      dead_functions: health.metrics.dead_function_count,
      boundary_violations: boundaryViolations,
    },
  };

  history.push(snapshot);

  // Cap at MAX_HISTORY entries
  const trimmed = history.slice(-MAX_HISTORY);

  const historyPath = join(outputDir, 'health-history.json');
  writeFileSync(historyPath, JSON.stringify(trimmed, null, 2));
}

/**
 * Compute trend between latest two snapshots.
 */
export function computeTrend(outputDir: string): HealthTrend | null {
  const history = loadHistory(outputDir);
  if (history.length < 2) return null;

  const current = history[history.length - 1];
  const previous = history[history.length - 2];

  const delta = current.score - previous.score;
  let direction: 'improving' | 'stable' | 'degrading';
  if (delta > 2) direction = 'improving';
  else if (delta < -2) direction = 'degrading';
  else direction = 'stable';

  // Find when degradation started (if currently degrading)
  let degradingSince: string | null = null;
  if (direction === 'degrading') {
    for (let i = history.length - 2; i >= 0; i--) {
      if (i === 0 || history[i].score >= history[i - 1].score) {
        degradingSince = history[i].timestamp;
        break;
      }
    }
  }

  // Compute top movers (metric changes)
  const metricKeys: Array<keyof HealthSnapshot['metrics']> = [
    'total_functions', 'avg_complexity', 'functions_over_threshold',
    'circular_dependencies', 'dead_functions', 'boundary_violations',
  ];

  const topMovers = metricKeys
    .map(key => {
      const prev = previous.metrics[key];
      const curr = current.metrics[key];
      const metricDelta = curr - prev;
      // For most metrics, increase = worse; for total_functions it's neutral
      const isWorse = key === 'total_functions' ? false : metricDelta > 0;
      return {
        metric: key,
        previous: prev,
        current: curr,
        delta: metricDelta,
        direction: (metricDelta === 0 ? 'better' : isWorse ? 'worse' : 'better') as 'better' | 'worse',
      };
    })
    .filter(m => m.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return {
    current: current.score,
    previous: previous.score,
    delta,
    direction,
    degradingSince,
    topMovers,
    historyLength: history.length,
  };
}
