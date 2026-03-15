import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { Logger } from '../../utils/logger';
import { CodemapData } from '../../output/json-generator';
import { computeTrend, loadHistory } from '../../analyzers/history';

export const healthCommand = new Command('health')
  .description('Show project health score, metrics, and hotspots. Use --gate for CI quality gates.')
  .option('-p, --path <path>', 'Project root path', '.')
  .option('--gate', 'Exit with code 1 if health score is below threshold', false)
  .option('--threshold <n>', 'Minimum score for --gate (default: 70)', '70')
  .option('--no-degrade', 'Fail if score dropped from last run')
  .option('--summary', 'One-line summary only', false)
  .option('--json', 'Output raw JSON', false)
  .action(async (options) => {
    const logger = new Logger();
    const root = resolve(options.path);
    const outputDir = join(root, '.codemap');
    const jsonPath = join(outputDir, 'codemap.json');

    if (!existsSync(jsonPath)) {
      logger.error('No codemap found. Run `codemap generate` first.');
      process.exit(1);
    }

    let data: CodemapData;
    try {
      data = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    } catch (error) {
      logger.error(`Failed to read codemap: ${(error as Error).message}`);
      process.exit(1);
    }

    if (!data.health) {
      logger.error('No health data. Regenerate with latest version: `codemap generate`');
      process.exit(1);
    }

    const health = data.health;

    // JSON output mode
    if (options.json) {
      console.log(JSON.stringify(health, null, 2));
      return;
    }

    // Summary mode
    if (options.summary) {
      const m = health.metrics;
      console.log(
        `Health: ${health.score}/100 | ` +
        `${m.total_functions} functions, ` +
        `avg complexity ${m.avg_function_complexity}, ` +
        `${m.functions_over_complexity_threshold} over threshold, ` +
        `${m.dead_function_count} dead`
      );

      // Show trend if available
      const trend = computeTrend(outputDir);
      if (trend) {
        const arrow = trend.delta > 0 ? '↑' : trend.delta < 0 ? '↓' : '→';
        console.log(`Trend: ${arrow}${Math.abs(trend.delta)} (${trend.direction})`);
      }
      return;
    }

    // Full output
    console.log(`\n  Project Health: ${health.score}/100\n`);

    const m = health.metrics;
    console.log('  Metrics:');
    console.log(`    Functions/methods:       ${m.total_functions} (${m.total_classes} classes)`);
    console.log(`    Avg complexity:          ${m.avg_function_complexity}`);
    if (m.max_function_complexity) {
      console.log(`    Max complexity:          ${m.max_function_complexity.value} (${m.max_function_complexity.name})`);
    }
    console.log(`    Over complexity limit:   ${m.functions_over_complexity_threshold}`);
    console.log(`    Over line limit:         ${m.functions_over_line_threshold}`);
    console.log(`    God classes:             ${m.classes_over_method_limit}`);
    console.log(`    Dead functions:          ${m.dead_function_count} (${m.dead_function_percentage}%)`);

    // Hotspots
    if (health.hotspots.length > 0) {
      console.log('\n  Hotspots:');
      for (const h of health.hotspots.slice(0, 10)) {
        const icon = h.severity === 'critical' ? '!!' : ' !';
        console.log(`    ${icon} ${h.target} — ${h.metric}: ${h.value} (threshold: ${h.threshold}) — ${h.file}`);
      }
      if (health.hotspots.length > 10) {
        console.log(`    ... and ${health.hotspots.length - 10} more`);
      }
    }

    // Module metrics
    if (data.module_metrics && data.module_metrics.length > 0) {
      console.log('\n  Module Coupling (top 5 most unstable):');
      for (const mod of data.module_metrics.slice(0, 5)) {
        console.log(`    ${mod.path}/ — Ca=${mod.afferentCoupling} Ce=${mod.efferentCoupling} I=${mod.instability}`);
      }
    }

    // Trend
    const trend = computeTrend(outputDir);
    if (trend) {
      const arrow = trend.delta > 0 ? '↑' : trend.delta < 0 ? '↓' : '→';
      console.log(`\n  Trend: ${trend.current}/100 ${arrow}${Math.abs(trend.delta)} from ${trend.previous} (${trend.direction})`);
      if (trend.topMovers.length > 0) {
        for (const m of trend.topMovers.slice(0, 3)) {
          const dir = m.direction === 'worse' ? '↑' : '↓';
          console.log(`    ${m.metric}: ${m.previous} → ${m.current} (${dir})`);
        }
      }
    }

    console.log('');

    // Gate mode
    if (options.gate) {
      const threshold = parseInt(options.threshold, 10);

      if (health.score < threshold) {
        logger.error(`Health score ${health.score} is below threshold ${threshold}`);
        process.exit(1);
      }

      if (options.degrade === false && trend && trend.delta < 0) {
        logger.error(`Health score degraded: ${trend.previous} → ${trend.current} (${trend.delta})`);
        process.exit(1);
      }

      logger.success(`Health gate passed: ${health.score}/${threshold}`);
    }
  });
