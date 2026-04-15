import { Command } from 'commander';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { CodemapData } from '../../output/json-generator';

/**
 * Compact project context for Claude Code session start.
 * Outputs ~20-30 lines of markdown with overview, health, and recent usage.
 */
export const contextCommand = new Command('context')
  .description('Show compact project context (overview + health + recent usage)')
  .option('-p, --path <path>', 'Project root path', '.')
  .option('--quiet', 'Suppress non-essential output', false)
  .action(async (options) => {
    const root = resolve(options.path);
    const outputDir = join(root, '.codemap');
    const jsonPath = join(outputDir, 'codemap.json');

    if (!existsSync(jsonPath)) {
      if (!options.quiet) {
        console.error('No codemap found. Run `codemap generate` first.');
      }
      return;
    }

    let data: CodemapData;
    try {
      data = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    } catch {
      return;
    }

    const lines: string[] = [];
    const project = data.project;
    const health = data.health;

    // Header
    lines.push(`# codemap: ${project.name}`);

    // Overview line
    const fileCount = Object.keys(data.files || {}).length;
    const classCount = Object.keys(data.classes || {}).length;
    const funcCount = Object.keys(data.functions || {}).length;
    const healthStr = health ? `Health: ${health.score}/100` : 'Health: N/A';
    lines.push(`${healthStr} | ${fileCount} files, ${classCount} classes, ${funcCount} functions`);

    // Frameworks and entry points
    const frameworks = project.frameworks?.length > 0 ? project.frameworks.join(', ') : 'none';
    const entries = (project.entry_points || []).slice(0, 3).join(', ');
    const entrySuffix = (project.entry_points || []).length > 3 ? `, +${project.entry_points.length - 3} more` : '';
    lines.push(`Frameworks: ${frameworks} | Entry: ${entries}${entrySuffix}`);

    // Recent usage (last 7 days)
    const usagePath = join(outputDir, 'usage-stats.json');
    if (existsSync(usagePath)) {
      try {
        const usage = JSON.parse(readFileSync(usagePath, 'utf-8'));
        const intervals = usage.intervals || {};
        const dailyMap = new Map<string, { calls: number; tools: Record<string, number> }>();

        for (const bucket of Object.values(intervals) as any[]) {
          const date = bucket.label?.split(' ')[0];
          if (!date) continue;
          if (!dailyMap.has(date)) dailyMap.set(date, { calls: 0, tools: {} });
          const day = dailyMap.get(date)!;
          day.calls += bucket.totalCalls || 0;
          for (const [tool, count] of Object.entries(bucket.toolCalls || {})) {
            day.tools[tool] = (day.tools[tool] || 0) + (count as number);
          }
        }

        const sortedDays = [...dailyMap.entries()]
          .sort(([a], [b]) => b.localeCompare(a))
          .slice(0, 7);

        if (sortedDays.length > 0) {
          lines.push('');
          lines.push('## Recent Usage (last 7 days)');
          lines.push('| Date | Calls | Top Tools |');
          lines.push('|------|------:|-----------|');
          for (const [date, day] of sortedDays) {
            const topTools = Object.entries(day.tools)
              .sort(([, a], [, b]) => (b as number) - (a as number))
              .slice(0, 3)
              .map(([name, count]) => `${name.replace('codemap_', '')}(${count})`)
              .join(', ');
            lines.push(`| ${date} | ${day.calls} | ${topTools} |`);
          }
        }
      } catch {
        // Skip usage if file is corrupt
      }
    }

    // Top hotspots
    if (health?.hotspots && health.hotspots.length > 0) {
      const topHotspots = health.hotspots
        .filter((h: any) => h.type === 'high_complexity')
        .slice(0, 3);
      if (topHotspots.length > 0) {
        lines.push('');
        lines.push('## Hotspots');
        for (const hotspot of topHotspots) {
          lines.push(`- ${hotspot.target} (complexity ${hotspot.value}) -- ${hotspot.file}`);
        }
      }
    }

    console.log(lines.join('\n'));
  });
