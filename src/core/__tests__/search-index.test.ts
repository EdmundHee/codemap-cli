import { tokenize, scoreTokenMatch, computeRelevance, rankedSearch } from '../search-index';

describe('tokenize', () => {
  test('splits camelCase', () => {
    expect(tokenize('buildCallGraph')).toEqual(['build', 'call', 'graph']);
  });

  test('splits PascalCase', () => {
    expect(tokenize('PythonParser')).toEqual(['python', 'parser']);
  });

  test('splits snake_case', () => {
    expect(tokenize('parse_yaml_config')).toEqual(['parse', 'yaml', 'config']);
  });

  test('splits dot notation', () => {
    expect(tokenize('PythonParser.parseFile')).toEqual(['python', 'parser', 'parse', 'file']);
  });

  test('splits consecutive uppercase (acronyms)', () => {
    expect(tokenize('parseURLPath')).toEqual(['parse', 'url', 'path']);
  });

  test('handles kebab-case', () => {
    expect(tokenize('call-graph')).toEqual(['call', 'graph']);
  });

  test('filters single-char tokens', () => {
    expect(tokenize('a.parseFile')).toEqual(['parse', 'file']);
  });

  test('handles file paths with slashes', () => {
    expect(tokenize('src/core/query-engine.ts')).toEqual(['src', 'core', 'query', 'engine', 'ts']);
  });
});

describe('scoreTokenMatch', () => {
  test('exact matches score 2.0', () => {
    const score = scoreTokenMatch(['call', 'graph'], ['build', 'call', 'graph']);
    expect(score).toBe(2.0); // 2 exact / 2 query tokens = 2/1 * 2
  });

  test('no matches score 0', () => {
    const score = scoreTokenMatch(['auth', 'login'], ['build', 'call', 'graph']);
    expect(score).toBe(0);
  });

  test('prefix matches score 1 per token', () => {
    // "call" prefix matches "callers"
    const score = scoreTokenMatch(['call'], ['get', 'callers']);
    expect(score).toBe(1.0);
  });

  test('partial matches score proportionally', () => {
    // "call" exact matches in nameTokens, "graph" does not match
    const score = scoreTokenMatch(['call', 'graph'], ['format', 'call', 'data']);
    expect(score).toBe(1.0); // 1 exact out of 2 = 2/2
  });

  test('empty query returns 0', () => {
    expect(scoreTokenMatch([], ['build'])).toBe(0);
  });

  test('empty name returns 0', () => {
    expect(scoreTokenMatch(['build'], [])).toBe(0);
  });
});

describe('computeRelevance', () => {
  test('base score from name match', () => {
    const score = computeRelevance(2.0, { name: 'test', type: 'function' });
    expect(score).toBe(20); // 2.0 * 10
  });

  test('boosts exported functions', () => {
    const base = computeRelevance(1.0, { name: 'fn', type: 'function' });
    const exported = computeRelevance(1.0, { name: 'fn', type: 'function', exported: true });
    expect(exported).toBe(base + 3);
  });

  test('boosts by caller count (capped at 5)', () => {
    const base = computeRelevance(1.0, { name: 'fn', type: 'function' });
    const popular = computeRelevance(1.0, { name: 'fn', type: 'function', callerCount: 10 });
    expect(popular).toBe(base + 5);
  });

  test('boosts classes', () => {
    const fn = computeRelevance(1.0, { name: 'Foo', type: 'function' });
    const cls = computeRelevance(1.0, { name: 'Foo', type: 'class' });
    expect(cls).toBe(fn + 1);
  });

  test('penalizes private names', () => {
    const pub = computeRelevance(1.0, { name: 'helper', type: 'function' });
    const priv = computeRelevance(1.0, { name: '_helper', type: 'function' });
    expect(priv).toBe(pub - 3);
  });

  test('penalizes test files', () => {
    const prod = computeRelevance(1.0, { name: 'fn', type: 'function', file: 'src/foo.ts' });
    const test = computeRelevance(1.0, { name: 'fn', type: 'function', file: 'src/__tests__/foo.test.ts' });
    expect(test).toBe(prod - 5);
  });
});

describe('rankedSearch', () => {
  const items = [
    { name: 'buildCallGraph', file: 'src/analyzers/call-graph.ts', exported: true, callerCount: 3 },
    { name: 'buildReverseCallGraph', file: 'src/analyzers/call-graph.ts', exported: true, callerCount: 1 },
    { name: 'formatCallData', file: 'src/formatters.ts', exported: false, callerCount: 0 },
    { name: 'getCallers', file: 'src/query.ts', exported: true, callerCount: 2 },
    { name: 'sendEmail', file: 'src/mail.ts', exported: true, callerCount: 1 },
  ];

  const getMeta = (item: typeof items[0]) => ({
    type: 'function' as const,
    exported: item.exported,
    callerCount: item.callerCount,
  });

  test('multi-word query "call graph" finds relevant functions', () => {
    const results = rankedSearch(items, 'call graph', getMeta);

    // Should find buildCallGraph and buildReverseCallGraph (both match "call" + "graph")
    expect(results.length).toBeGreaterThanOrEqual(2);
    const names = results.map((r) => r.item.name);
    expect(names).toContain('buildCallGraph');
    expect(names).toContain('buildReverseCallGraph');

    // sendEmail should NOT match
    expect(names).not.toContain('sendEmail');
  });

  test('results are sorted by score descending', () => {
    const results = rankedSearch(items, 'call', getMeta);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }
  });

  test('substring fallback matches partial names', () => {
    // "formatters" does NOT match any name as a substring (formatCallData != formatters)
    // But "format" would match formatCallData via token matching
    const results = rankedSearch(items, 'format', getMeta);
    expect(results.length).toBe(1);
    expect(results[0].item.name).toBe('formatCallData');
  });

  test('substring fallback works for partial name match', () => {
    const results = rankedSearch(items, 'CallGraph', getMeta);
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  test('empty query returns empty results', () => {
    const results = rankedSearch(items, '', getMeta);
    expect(results.length).toBe(0);
  });
});
