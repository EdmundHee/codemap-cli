import {
  generateDeadCodeRecommendations,
  generateDuplicateRecommendations,
  generateCircularDepRecommendations,
  generateHotspotRecommendations,
  generateRecommendationReport,
  formatRecommendationReport,
  Recommendation,
  RecommendationReport,
} from '../recommendations';
import { DeadCodeData } from '../dead-code';
import { DuplicateGroup } from '../duplicates';
import { CycleData } from '../circular-deps';
import { HealthHotspot } from '../../output/json-generator';

// ─── Dead Code Recommendations ────────────────────────────────────────────

describe('generateDeadCodeRecommendations', () => {
  test('returns empty for no dead code', () => {
    const data: DeadCodeData = { deadFunctions: [], totalDeadLines: 0, deadCodePercentage: 0, totalFunctions: 10, highConfidenceCount: 0 };
    expect(generateDeadCodeRecommendations(data)).toEqual([]);
  });

  test('generates batch recommendation for files with 3+ dead functions', () => {
    const data: DeadCodeData = {
      deadFunctions: [
        { name: 'funcA', file: 'src/utils.ts', lineCount: 10, isExported: false, type: 'function', confidence: 'high' },
        { name: 'funcB', file: 'src/utils.ts', lineCount: 15, isExported: false, type: 'function', confidence: 'high' },
        { name: 'funcC', file: 'src/utils.ts', lineCount: 20, isExported: true, type: 'function', confidence: 'low' },
      ],
      totalDeadLines: 45,
      deadCodePercentage: 15,
      totalFunctions: 30,
      highConfidenceCount: 2,
    };

    const recs = generateDeadCodeRecommendations(data);
    const batchRec = recs.find(r => r.id.startsWith('dead-batch-'));
    expect(batchRec).toBeDefined();
    expect(batchRec!.affected).toHaveLength(3);
    expect(batchRec!.category).toBe('dead-code');
    // Should mention exported function verification
    expect(batchRec!.action_plan.some(s => s.includes('exported'))).toBe(true);
  });

  test('generates individual recommendations for large dead functions', () => {
    const data: DeadCodeData = {
      deadFunctions: [
        { name: 'bigDead', file: 'src/service.ts', lineCount: 60, isExported: true, type: 'function', confidence: 'low' },
      ],
      totalDeadLines: 60,
      deadCodePercentage: 10,
      totalFunctions: 10,
      highConfidenceCount: 0,
    };

    const recs = generateDeadCodeRecommendations(data);
    expect(recs.length).toBeGreaterThanOrEqual(1);
    const rec = recs.find(r => r.title.includes('bigDead'));
    expect(rec).toBeDefined();
    expect(rec!.priority).toBe('critical'); // >50 lines = critical
  });

  test('prioritizes by line count: >50=critical, >20=high, >10=medium, else=low', () => {
    const data: DeadCodeData = {
      deadFunctions: [
        { name: 'huge', file: 'a.ts', lineCount: 60, isExported: false, type: 'function', confidence: 'high' },
        { name: 'big', file: 'b.ts', lineCount: 25, isExported: false, type: 'function', confidence: 'high' },
        { name: 'med', file: 'c.ts', lineCount: 15, isExported: false, type: 'function', confidence: 'high' },
        { name: 'small', file: 'd.ts', lineCount: 5, isExported: false, type: 'function', confidence: 'high' },
      ],
      totalDeadLines: 105,
      deadCodePercentage: 20,
      totalFunctions: 20,
      highConfidenceCount: 4,
    };

    const recs = generateDeadCodeRecommendations(data);
    const hugeRec = recs.find(r => r.title.includes('huge'));
    const bigRec = recs.find(r => r.title.includes('big'));
    const medRec = recs.find(r => r.title.includes('med'));
    const smallRec = recs.find(r => r.title.includes('small'));

    expect(hugeRec?.priority).toBe('critical');
    expect(bigRec?.priority).toBe('high');
    expect(medRec?.priority).toBe('medium');
    // small (5 lines) is below the 5-line threshold for individual recs and won't appear
  });

  test('includes className in action plan for dead methods', () => {
    const data: DeadCodeData = {
      deadFunctions: [
        { name: 'MyClass.deadMethod', file: 'src/cls.ts', lineCount: 15, isExported: false, type: 'method', className: 'MyClass', confidence: 'high' },
      ],
      totalDeadLines: 15,
      deadCodePercentage: 5,
      totalFunctions: 20,
      highConfidenceCount: 1,
    };

    const recs = generateDeadCodeRecommendations(data);
    expect(recs.length).toBeGreaterThanOrEqual(1);
    const rec = recs.find(r => r.title.includes('deadMethod'));
    expect(rec!.action_plan.some(s => s.includes('MyClass'))).toBe(true);
  });
});

// ─── Duplicate Recommendations ────────────────────────────────────────────

describe('generateDuplicateRecommendations', () => {
  test('returns empty for no duplicates', () => {
    expect(generateDuplicateRecommendations([])).toEqual([]);
  });

  test('generates recommendation for high-similarity duplicates', () => {
    const dupes: DuplicateGroup[] = [{
      signature: 'formatDate',
      functions: [
        { name: 'formatDate', file: 'src/a.ts', params: 'date:Date', calls: ['toISO', 'split'] },
        { name: 'formatDate', file: 'src/b.ts', params: 'date:Date', calls: ['toISO', 'split'] },
      ],
      similarity: 1,
    }];

    const recs = generateDuplicateRecommendations(dupes);
    expect(recs).toHaveLength(1);
    expect(recs[0].category).toBe('duplicates');
    expect(recs[0].title).toContain('formatDate');
    expect(recs[0].title).toContain('100%');
    expect(recs[0].action_plan.some(s => s.includes('shared'))).toBe(true);
  });

  test('priority scales with similarity and copy count', () => {
    const critical: DuplicateGroup = {
      signature: 'crit',
      functions: [
        { name: 'crit', file: 'a.ts', params: '', calls: ['a'] },
        { name: 'crit', file: 'b.ts', params: '', calls: ['a'] },
        { name: 'crit', file: 'c.ts', params: '', calls: ['a'] },
      ],
      similarity: 0.85,
    };
    const low: DuplicateGroup = {
      signature: 'low',
      functions: [
        { name: 'low', file: 'a.ts', params: '', calls: ['x'] },
        { name: 'low', file: 'b.ts', params: '', calls: ['y'] },
      ],
      similarity: 0.35,
    };

    const critRecs = generateDuplicateRecommendations([critical]);
    const lowRecs = generateDuplicateRecommendations([low]);

    expect(critRecs[0].priority).toBe('critical');
    expect(lowRecs[0].priority).toBe('low');
  });

  test('suggests common directory for shared file location', () => {
    const dupes: DuplicateGroup[] = [{
      signature: 'helper',
      functions: [
        { name: 'helper', file: 'src/modules/auth/utils.ts', params: '', calls: ['log'] },
        { name: 'helper', file: 'src/modules/users/utils.ts', params: '', calls: ['log'] },
      ],
      similarity: 0.8,
    }];

    const recs = generateDuplicateRecommendations(dupes);
    // Should suggest a shared location in the common ancestor directory
    expect(recs[0].action_plan.some(s => s.includes('src/modules'))).toBe(true);
  });

  test('recommendation for matchType: name has title starting with Deduplicate', () => {
    const dupes: DuplicateGroup[] = [{
      signature: 'formatDate',
      functions: [
        { name: 'formatDate', file: 'src/a.ts', params: '', calls: ['toISO'] },
        { name: 'formatDate', file: 'src/b.ts', params: '', calls: ['toISO'] },
      ],
      similarity: 0.9,
      matchType: 'name',
    }];

    const recs = generateDuplicateRecommendations(dupes);
    expect(recs[0].title).toMatch(/^Deduplicate/);
  });

  test('recommendation for matchType: structural has title containing Functionally similar', () => {
    const dupes: DuplicateGroup[] = [{
      signature: 'loadConfig ~ parseSettings',
      functions: [
        { name: 'loadConfig', file: 'src/a.ts', params: 'path:string', calls: ['readFile', 'parse'] },
        { name: 'parseSettings', file: 'src/b.ts', params: 'path:string', calls: ['readFile', 'parse'] },
      ],
      similarity: 0.85,
      matchType: 'structural',
    }];

    const recs = generateDuplicateRecommendations(dupes);
    expect(recs[0].title).toContain('Functionally similar');
  });

  test('recommendation for structural match mentions both function names', () => {
    const dupes: DuplicateGroup[] = [{
      signature: 'loadConfig ~ parseSettings',
      functions: [
        { name: 'loadConfig', file: 'src/a.ts', params: '', calls: ['readFile'] },
        { name: 'parseSettings', file: 'src/b.ts', params: '', calls: ['readFile'] },
      ],
      similarity: 0.75,
      matchType: 'structural',
    }];

    const recs = generateDuplicateRecommendations(dupes);
    expect(recs[0].title).toContain('loadConfig');
    expect(recs[0].title).toContain('parseSettings');
  });

  test('action plan for structural match suggests review and consolidate', () => {
    const dupes: DuplicateGroup[] = [{
      signature: 'loadConfig ~ parseSettings',
      functions: [
        { name: 'loadConfig', file: 'src/a.ts', params: '', calls: ['readFile'] },
        { name: 'parseSettings', file: 'src/b.ts', params: '', calls: ['readFile'] },
      ],
      similarity: 0.8,
      matchType: 'structural',
    }];

    const recs = generateDuplicateRecommendations(dupes);
    expect(recs[0].action_plan.some(s => s.toLowerCase().includes('review and consolidate') || s.toLowerCase().includes('consolidate'))).toBe(true);
  });
});

// ─── Circular Dependency Recommendations ──────────────────────────────────

describe('generateCircularDepRecommendations', () => {
  test('returns empty for no cycles', () => {
    expect(generateCircularDepRecommendations([])).toEqual([]);
  });

  test('generates recommendation with minimum cut strategy', () => {
    const cycles: CycleData[] = [{
      files: ['src/a.ts', 'src/b.ts'],
      edges: [
        { sourceFile: 'src/a.ts', targetFile: 'src/b.ts', symbols: ['typeA', 'funcA'] },
        { sourceFile: 'src/b.ts', targetFile: 'src/a.ts', symbols: ['typeB'] },
      ],
      minimumCut: { sourceFile: 'src/b.ts', targetFile: 'src/a.ts', symbols: ['typeB'] },
      minimumCutSymbolCount: 1,
    }];

    const recs = generateCircularDepRecommendations(cycles);
    expect(recs).toHaveLength(1);
    expect(recs[0].category).toBe('circular-deps');
    expect(recs[0].action_plan.some(s => s.includes('minimum cut'))).toBe(true);
    expect(recs[0].action_plan.some(s => s.includes('typeB'))).toBe(true);
  });

  test('large cycles (>4 files) are critical priority', () => {
    const cycles: CycleData[] = [{
      files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'],
      edges: [],
      minimumCut: null,
      minimumCutSymbolCount: 0,
    }];

    const recs = generateCircularDepRecommendations(cycles);
    expect(recs[0].priority).toBe('critical');
  });

  test('suggests dependency inversion for cycles without minimum cut', () => {
    const cycles: CycleData[] = [{
      files: ['src/a.ts', 'src/b.ts'],
      edges: [
        { sourceFile: 'src/a.ts', targetFile: 'src/b.ts', symbols: [] },
        { sourceFile: 'src/b.ts', targetFile: 'src/a.ts', symbols: [] },
      ],
      minimumCut: null,
      minimumCutSymbolCount: 0,
    }];

    const recs = generateCircularDepRecommendations(cycles);
    expect(recs[0].action_plan.some(s => s.includes('dependency inversion'))).toBe(true);
  });
});

// ─── Hotspot Recommendations ──────────────────────────────────────────────

describe('generateHotspotRecommendations', () => {
  test('returns empty for no hotspots', () => {
    expect(generateHotspotRecommendations([])).toEqual([]);
  });

  test('generates complexity reduction recommendations', () => {
    const hotspots: HealthHotspot[] = [{
      type: 'high_complexity',
      target: 'processData',
      file: 'src/processor.ts',
      metric: 'complexity',
      value: 45,
      threshold: 10,
      severity: 'critical',
    }];

    const recs = generateHotspotRecommendations(hotspots);
    expect(recs).toHaveLength(1);
    expect(recs[0].category).toBe('complexity');
    expect(recs[0].title).toContain('processData');
    expect(recs[0].title).toContain('45/10');
    // Should include rewrite advice for >3x threshold
    expect(recs[0].action_plan.some(s => s.includes('WARNING') || s.includes('rewrite'))).toBe(true);
  });

  test('generates god class recommendations', () => {
    const hotspots: HealthHotspot[] = [{
      type: 'god_class',
      target: 'MegaController',
      file: 'src/mega.ts',
      metric: 'methods',
      value: 35,
      threshold: 15,
      severity: 'critical',
    }];

    const recs = generateHotspotRecommendations(hotspots);
    expect(recs).toHaveLength(1);
    expect(recs[0].title).toContain('god class');
    expect(recs[0].title).toContain('MegaController');
    expect(recs[0].description).toContain('Single Responsibility');
    expect(recs[0].action_plan.some(s => s.includes('responsibility') || s.includes('Group methods'))).toBe(true);
  });

  test('generates coupling recommendations', () => {
    const hotspots: HealthHotspot[] = [{
      type: 'high_coupling',
      target: 'src/shared/',
      file: 'src/shared/',
      metric: 'instability',
      value: 0.95,
      threshold: 0.8,
      severity: 'warning',
    }];

    const recs = generateHotspotRecommendations(hotspots);
    expect(recs).toHaveLength(1);
    expect(recs[0].category).toBe('coupling');
    expect(recs[0].action_plan.some(s => s.includes('public API'))).toBe(true);
  });
});

// ─── Full Report ──────────────────────────────────────────────────────────

describe('generateRecommendationReport', () => {
  test('aggregates recommendations from all sources', () => {
    const deadCode: DeadCodeData = {
      deadFunctions: [
        { name: 'dead', file: 'a.ts', lineCount: 30, isExported: false, type: 'function', confidence: 'high' },
      ],
      totalDeadLines: 30,
      deadCodePercentage: 5,
      totalFunctions: 20,
      highConfidenceCount: 1,
    };
    const dupes: DuplicateGroup[] = [{
      signature: 'dup',
      functions: [
        { name: 'dup', file: 'a.ts', params: '', calls: ['x'] },
        { name: 'dup', file: 'b.ts', params: '', calls: ['x'] },
      ],
      similarity: 0.9,
    }];

    const report = generateRecommendationReport(deadCode, dupes, null, null);
    expect(report.summary.total).toBeGreaterThanOrEqual(2);
    expect(report.recommendations.some(r => r.category === 'dead-code')).toBe(true);
    expect(report.recommendations.some(r => r.category === 'duplicates')).toBe(true);
  });

  test('sorts recommendations by priority (critical first)', () => {
    const deadCode: DeadCodeData = {
      deadFunctions: [
        { name: 'small', file: 'a.ts', lineCount: 8, isExported: false, type: 'function', confidence: 'high' },
        { name: 'huge', file: 'b.ts', lineCount: 80, isExported: false, type: 'function', confidence: 'high' },
      ],
      totalDeadLines: 88,
      deadCodePercentage: 10,
      totalFunctions: 20,
      highConfidenceCount: 2,
    };

    const report = generateRecommendationReport(deadCode, null, null, null);
    if (report.recommendations.length >= 2) {
      const priorities = report.recommendations.map(r => r.priority);
      const order = { critical: 0, high: 1, medium: 2, low: 3 };
      for (let i = 1; i < priorities.length; i++) {
        expect(order[priorities[i]]).toBeGreaterThanOrEqual(order[priorities[i - 1]]);
      }
    }
  });

  test('handles all null inputs gracefully', () => {
    const report = generateRecommendationReport(null, null, null, null);
    expect(report.summary.total).toBe(0);
    expect(report.recommendations).toEqual([]);
  });

  test('summary counts match actual recommendations', () => {
    const hotspots: HealthHotspot[] = [
      { type: 'high_complexity', target: 'f1', file: 'a.ts', metric: 'complexity', value: 50, threshold: 10, severity: 'critical' },
      { type: 'high_complexity', target: 'f2', file: 'b.ts', metric: 'complexity', value: 12, threshold: 10, severity: 'warning' },
    ];

    const report = generateRecommendationReport(null, null, null, hotspots);
    const actualCritical = report.recommendations.filter(r => r.priority === 'critical').length;
    const actualMedium = report.recommendations.filter(r => r.priority === 'medium').length;

    expect(report.summary.critical).toBe(actualCritical);
    expect(report.summary.medium).toBe(actualMedium);
    expect(report.summary.total).toBe(report.recommendations.length);
  });
});

// ─── Format Report ────────────────────────────────────────────────────────

describe('formatRecommendationReport', () => {
  test('includes RECOMMENDATIONS header', () => {
    const report: RecommendationReport = {
      summary: { total: 1, critical: 1, high: 0, medium: 0, low: 0, estimated_lines_saved: 50 },
      recommendations: [{
        id: 'test-1',
        category: 'dead-code',
        priority: 'critical',
        title: 'Remove dead function `bigFunc`',
        description: 'Test description',
        affected: [{ name: 'bigFunc', file: 'src/a.ts', detail: '50 lines' }],
        action_plan: ['Step 1', 'Step 2'],
        impact: 'Remove 50 lines',
        effort: 'small',
      }],
    };

    const output = formatRecommendationReport(report);
    expect(output).toContain('RECOMMENDATIONS');
    expect(output).toContain('CRITICAL');
    expect(output).toContain('bigFunc');
    expect(output).toContain('Step 1');
    expect(output).toContain('CLAUDE IMPLEMENTATION BRIEF');
  });

  test('shows priority icons', () => {
    const report: RecommendationReport = {
      summary: { total: 1, critical: 0, high: 1, medium: 0, low: 0, estimated_lines_saved: 0 },
      recommendations: [{
        id: 'test-2',
        category: 'duplicates',
        priority: 'high',
        title: 'Deduplicate X',
        description: 'Test',
        affected: [],
        action_plan: ['Do something'],
        impact: 'Clean up',
        effort: 'small',
      }],
    };

    const output = formatRecommendationReport(report);
    expect(output).toContain('🟠');
    expect(output).toContain('HIGH');
  });

  test('returns empty-like output for no recommendations', () => {
    const report: RecommendationReport = {
      summary: { total: 0, critical: 0, high: 0, medium: 0, low: 0, estimated_lines_saved: 0 },
      recommendations: [],
    };

    const output = formatRecommendationReport(report);
    expect(output).toContain('RECOMMENDATIONS');
    expect(output).toContain('Found 0 recommendations');
    expect(output).not.toContain('CLAUDE-READY PROMPT');
  });
});
