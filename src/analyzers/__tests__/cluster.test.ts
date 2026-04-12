import { clusterSearchResults, buildFunctionClusters, scoreHubness } from '../cluster';
import { CallGraph } from '../call-graph';

// ─── clusterSearchResults ──────────────────────────────────────────────────

describe('clusterSearchResults', () => {
  test('returns single-item clusters for 3 or fewer results', () => {
    const results = [
      { type: 'function', name: 'parseDate', file: 'utils.ts' },
      { type: 'function', name: 'parseTime', file: 'utils.ts' },
    ];
    const callGraph: CallGraph = Object.create(null);
    callGraph['parseDate'] = [];
    callGraph['parseTime'] = [];

    const clusters = clusterSearchResults(results, callGraph);
    // With <=3 results, each is returned as its own cluster (no grouping)
    // Actually clusterSearchResults delegates to the full algorithm for >3
    // but with <=3 results the query-engine wrapper returns early.
    // The cluster function itself still works for any count.
    expect(clusters.length).toBe(2);
    expect(clusters[0].hub.name).toBe('parseDate');
    expect(clusters[1].hub.name).toBe('parseTime');
  });

  test('folds child functions under their parent hub', () => {
    const results = [
      { type: 'function', name: 'processAuth', file: 'auth.ts' },
      { type: 'function', name: 'validateToken', file: 'auth.ts' },
      { type: 'function', name: 'decodeJWT', file: 'auth.ts' },
      { type: 'function', name: 'getUser', file: 'auth.ts' },
    ];
    const callGraph: CallGraph = Object.create(null);
    callGraph['processAuth'] = ['validateToken', 'getUser'];
    callGraph['validateToken'] = ['decodeJWT'];
    callGraph['decodeJWT'] = [];
    callGraph['getUser'] = [];

    const clusters = clusterSearchResults(results, callGraph);

    // processAuth is the root — it calls validateToken and getUser
    // validateToken calls decodeJWT
    // So processAuth should be the hub, and all others are children
    expect(clusters.length).toBe(1);
    expect(clusters[0].hub.name).toBe('processAuth');
    expect(clusters[0].children.length).toBe(3);
    expect(clusters[0].size).toBe(4);
  });

  test('creates separate clusters for unrelated function groups', () => {
    const results = [
      { type: 'function', name: 'parseConfig', file: 'config.ts' },
      { type: 'function', name: 'parseYaml', file: 'config.ts' },
      { type: 'function', name: 'sendEmail', file: 'mail.ts' },
      { type: 'function', name: 'formatBody', file: 'mail.ts' },
    ];
    const callGraph: CallGraph = Object.create(null);
    callGraph['parseConfig'] = ['parseYaml'];
    callGraph['parseYaml'] = [];
    callGraph['sendEmail'] = ['formatBody'];
    callGraph['formatBody'] = [];

    const clusters = clusterSearchResults(results, callGraph);

    // Two independent clusters
    expect(clusters.length).toBe(2);
    const hubs = clusters.map((c) => c.hub.name).sort();
    expect(hubs).toEqual(['parseConfig', 'sendEmail']);
  });

  test('handles results with no call relationships as individual clusters', () => {
    const results = [
      { type: 'function', name: 'alpha', file: 'a.ts' },
      { type: 'function', name: 'beta', file: 'b.ts' },
      { type: 'function', name: 'gamma', file: 'c.ts' },
      { type: 'function', name: 'delta', file: 'd.ts' },
    ];
    const callGraph: CallGraph = Object.create(null);
    callGraph['alpha'] = [];
    callGraph['beta'] = [];
    callGraph['gamma'] = [];
    callGraph['delta'] = [];

    const clusters = clusterSearchResults(results, callGraph);

    // No call relationships → each is its own cluster
    expect(clusters.length).toBe(4);
    for (const c of clusters) {
      expect(c.children.length).toBe(0);
      expect(c.size).toBe(1);
    }
  });
});

// ─── scoreHubness ──────────────────────────────────────────────────────────

describe('scoreHubness', () => {
  test('exported functions score higher than unexported', () => {
    const callGraph: CallGraph = Object.create(null);
    callGraph['exportedFn'] = ['helper'];
    callGraph['helper'] = [];

    const functions: Record<string, any> = {
      exportedFn: { exported: true, file: 'a.ts' },
      helper: { exported: false, file: 'a.ts' },
    };

    const exportedScore = scoreHubness('exportedFn', callGraph, functions, {});
    const helperScore = scoreHubness('helper', callGraph, functions, {});

    expect(exportedScore).toBeGreaterThan(helperScore);
  });

  test('functions with more callers score higher', () => {
    const callGraph: CallGraph = Object.create(null);
    callGraph['a'] = ['popular'];
    callGraph['b'] = ['popular'];
    callGraph['c'] = ['popular'];
    callGraph['popular'] = [];
    callGraph['lonely'] = [];

    const functions: Record<string, any> = {
      popular: { file: 'a.ts' },
      lonely: { file: 'a.ts' },
    };

    const popularScore = scoreHubness('popular', callGraph, functions, {});
    const lonelyScore = scoreHubness('lonely', callGraph, functions, {});

    expect(popularScore).toBeGreaterThan(lonelyScore);
  });

  test('internal names are penalized', () => {
    const callGraph: CallGraph = Object.create(null);
    callGraph['_internal'] = [];
    callGraph['publicFn'] = [];

    const functions: Record<string, any> = {
      _internal: { file: 'a.ts' },
      publicFn: { file: 'a.ts' },
    };

    const internalScore = scoreHubness('_internal', callGraph, functions, {});
    const publicScore = scoreHubness('publicFn', callGraph, functions, {});

    expect(publicScore).toBeGreaterThan(internalScore);
  });
});

// ─── buildFunctionClusters ─────────────────────────────────────────────────

describe('buildFunctionClusters', () => {
  test('groups connected functions into one cluster', () => {
    const callGraph: CallGraph = Object.create(null);
    callGraph['main'] = ['helper1', 'helper2'];
    callGraph['helper1'] = ['util'];
    callGraph['helper2'] = [];
    callGraph['util'] = [];

    const clusters = buildFunctionClusters(callGraph, {}, {});

    expect(clusters.length).toBe(1);
    expect(clusters[0].members).toContain('main');
    expect(clusters[0].members).toContain('helper1');
    expect(clusters[0].members).toContain('util');
    expect(clusters[0].size).toBe(4);
  });

  test('separates disconnected components', () => {
    const callGraph: CallGraph = Object.create(null);
    callGraph['a'] = ['b'];
    callGraph['b'] = [];
    callGraph['x'] = ['y'];
    callGraph['y'] = [];

    const clusters = buildFunctionClusters(callGraph, {}, {});

    expect(clusters.length).toBe(2);
    expect(clusters[0].size).toBe(2);
    expect(clusters[1].size).toBe(2);
  });

  test('identifies the most connected function as hub', () => {
    const callGraph: CallGraph = Object.create(null);
    callGraph['orchestrator'] = ['worker1', 'worker2', 'worker3'];
    callGraph['worker1'] = [];
    callGraph['worker2'] = [];
    callGraph['worker3'] = [];

    const functions: Record<string, any> = {
      orchestrator: { exported: true, file: 'a.ts' },
      worker1: { file: 'a.ts' },
      worker2: { file: 'a.ts' },
      worker3: { file: 'a.ts' },
    };

    const clusters = buildFunctionClusters(callGraph, functions, {});

    expect(clusters.length).toBe(1);
    expect(clusters[0].hub).toBe('orchestrator');
  });
});
