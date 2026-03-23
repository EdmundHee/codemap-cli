import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { UsageTracker, computeResponseBytes } from '../usage-tracker';
import type { UsageSnapshot, ToolMetrics } from '../usage-tracker';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Use OS tmpdir to avoid sandbox permission issues on cleanup
const TMP_ROOT = join(tmpdir(), '__codemap_usage_tests__');

/** Create a fresh temp project dir with .codemap/ inside */
function makeTmpProject(name: string): string {
  const dir = join(TMP_ROOT, name);
  const codemapDir = join(dir, '.codemap');
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(codemapDir, { recursive: true });
  return dir;
}

function statsPath(projectDir: string): string {
  return join(projectDir, '.codemap', 'usage-stats.json');
}

function readStats(projectDir: string): UsageSnapshot {
  return JSON.parse(readFileSync(statsPath(projectDir), 'utf-8'));
}

/** Simulate a complete tool call (start → small delay → end) */
function simulateCall(
  tracker: UsageTracker,
  toolName: string,
  params?: Record<string, unknown>,
  opts?: { isError?: boolean; responseBytes?: number }
): void {
  const token = tracker.recordStart(toolName, params);
  tracker.recordEnd(token, opts?.isError ?? false, opts?.responseBytes ?? 0);
}

// ---------------------------------------------------------------------------
// Cleanup & listener management
// ---------------------------------------------------------------------------

// Track all created trackers so we can clean up timers after each test
const activeTrackers: UsageTracker[] = [];

/** Create a tracker and register it for automatic cleanup */
function createTracker(roots?: string[]): UsageTracker {
  const t = new UsageTracker(roots);
  activeTrackers.push(t);
  return t;
}

// Raise limit since each UsageTracker instance registers process listeners
beforeAll(() => {
  process.setMaxListeners(100);
});

afterEach(() => {
  // Destroy all tracker timers to prevent Jest from hanging
  for (const t of activeTrackers) t.destroy();
  activeTrackers.length = 0;
});

afterAll(() => {
  try {
    if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
  process.setMaxListeners(10);
});

// ---------------------------------------------------------------------------
// 1. Basic call counting
// ---------------------------------------------------------------------------

describe('Basic call counting', () => {
  let tracker: UsageTracker;

  beforeEach(() => {
    tracker = createTracker(); // no persistence
  });

  test('starts with zero calls', () => {
    const snap = tracker.getSnapshot();
    expect(snap.totalCalls).toBe(0);
    expect(snap.totalErrors).toBe(0);
    expect(Object.keys(snap.tools)).toHaveLength(0);
  });

  test('increments call count for a single tool', () => {
    simulateCall(tracker, 'codemap_overview');
    simulateCall(tracker, 'codemap_overview');
    simulateCall(tracker, 'codemap_overview');

    const snap = tracker.getSnapshot();
    expect(snap.totalCalls).toBe(3);
    expect(snap.tools['codemap_overview'].callCount).toBe(3);
  });

  test('tracks multiple tools independently', () => {
    simulateCall(tracker, 'codemap_overview');
    simulateCall(tracker, 'codemap_module', { path: 'src/core' });
    simulateCall(tracker, 'codemap_module', { path: 'src/mcp' });
    simulateCall(tracker, 'codemap_query', { search: 'hello' });

    const snap = tracker.getSnapshot();
    expect(snap.totalCalls).toBe(4);
    expect(snap.tools['codemap_overview'].callCount).toBe(1);
    expect(snap.tools['codemap_module'].callCount).toBe(2);
    expect(snap.tools['codemap_query'].callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Error tracking
// ---------------------------------------------------------------------------

describe('Error tracking', () => {
  test('tracks errors separately from successes', () => {
    const tracker = createTracker();
    simulateCall(tracker, 'codemap_module', {}, { isError: false });
    simulateCall(tracker, 'codemap_module', {}, { isError: true });
    simulateCall(tracker, 'codemap_module', {}, { isError: false });

    const snap = tracker.getSnapshot();
    expect(snap.totalCalls).toBe(3);
    expect(snap.totalErrors).toBe(1);
    expect(snap.tools['codemap_module'].callCount).toBe(3);
    expect(snap.tools['codemap_module'].errorCount).toBe(1);
  });

  test('tracks errors across different tools', () => {
    const tracker = createTracker();
    simulateCall(tracker, 'tool_a', {}, { isError: true });
    simulateCall(tracker, 'tool_b', {}, { isError: true });
    simulateCall(tracker, 'tool_c', {}, { isError: false });

    const snap = tracker.getSnapshot();
    expect(snap.totalErrors).toBe(2);
    expect(snap.tools['tool_a'].errorCount).toBe(1);
    expect(snap.tools['tool_b'].errorCount).toBe(1);
    expect(snap.tools['tool_c'].errorCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Latency tracking
// ---------------------------------------------------------------------------

describe('Latency tracking', () => {
  test('records min, max, and avg latency', () => {
    const tracker = createTracker();

    // Manually control start times for deterministic latency
    const token1 = tracker.recordStart('tool_a');
    // Simulate ~10ms by adjusting startMs
    (token1 as any).startMs = Date.now() - 10;
    tracker.recordEnd(token1);

    const token2 = tracker.recordStart('tool_a');
    (token2 as any).startMs = Date.now() - 50;
    tracker.recordEnd(token2);

    const token3 = tracker.recordStart('tool_a');
    (token3 as any).startMs = Date.now() - 30;
    tracker.recordEnd(token3);

    const metrics = tracker.getSnapshot().tools['tool_a'];
    expect(metrics.callCount).toBe(3);
    // Min should be ~10, max ~50 (allow ±5ms for timing)
    expect(metrics.minLatencyMs).toBeGreaterThanOrEqual(8);
    expect(metrics.minLatencyMs).toBeLessThanOrEqual(15);
    expect(metrics.maxLatencyMs).toBeGreaterThanOrEqual(45);
    expect(metrics.maxLatencyMs).toBeLessThanOrEqual(55);
    expect(metrics.avgLatencyMs).toBeGreaterThanOrEqual(20);
    expect(metrics.avgLatencyMs).toBeLessThanOrEqual(40);
  });

  test('first/last called timestamps are set', () => {
    const tracker = createTracker();
    const before = new Date().toISOString();

    simulateCall(tracker, 'tool_x');

    const after = new Date().toISOString();
    const metrics = tracker.getSnapshot().tools['tool_x'];
    expect(metrics.firstCalledAt).not.toBeNull();
    expect(metrics.lastCalledAt).not.toBeNull();
    expect(metrics.firstCalledAt! >= before).toBe(true);
    expect(metrics.lastCalledAt! <= after).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Parameter frequency tracking
// ---------------------------------------------------------------------------

describe('Parameter frequency tracking', () => {
  test('tracks string parameter values', () => {
    const tracker = createTracker();
    simulateCall(tracker, 'codemap_module', { path: 'src/core' });
    simulateCall(tracker, 'codemap_module', { path: 'src/core' });
    simulateCall(tracker, 'codemap_module', { path: 'src/mcp' });

    const metrics = tracker.getSnapshot().tools['codemap_module'];
    expect(metrics.paramFrequency['path']['src/core']).toBe(2);
    expect(metrics.paramFrequency['path']['src/mcp']).toBe(1);
  });

  test('ignores non-string and long string params', () => {
    const tracker = createTracker();
    simulateCall(tracker, 'tool_a', {
      num: 42 as any,
      obj: { nested: true } as any,
      long: 'x'.repeat(300),
      short: 'ok',
    });

    const metrics = tracker.getSnapshot().tools['tool_a'];
    expect(metrics.paramFrequency['short']).toBeDefined();
    expect(metrics.paramFrequency['short']['ok']).toBe(1);
    // Non-string and long strings should not appear
    expect(metrics.paramFrequency['num']).toBeUndefined();
    expect(metrics.paramFrequency['obj']).toBeUndefined();
    expect(metrics.paramFrequency['long']).toBeUndefined();
  });

  test('handles undefined params gracefully', () => {
    const tracker = createTracker();
    simulateCall(tracker, 'tool_a'); // no params
    simulateCall(tracker, 'tool_a', undefined);

    const metrics = tracker.getSnapshot().tools['tool_a'];
    expect(metrics.callCount).toBe(2);
    expect(Object.keys(metrics.paramFrequency)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Response byte tracking
// ---------------------------------------------------------------------------

describe('Response byte tracking', () => {
  test('tracks response sizes', () => {
    const tracker = createTracker();
    simulateCall(tracker, 'tool_a', {}, { responseBytes: 1000 });
    simulateCall(tracker, 'tool_a', {}, { responseBytes: 3000 });

    const metrics = tracker.getSnapshot().tools['tool_a'];
    expect(metrics.totalResponseBytes).toBe(4000);
    expect(metrics.avgResponseBytes).toBe(2000);
    expect(metrics.minResponseBytes).toBe(1000);
    expect(metrics.maxResponseBytes).toBe(3000);
  });

  test('zero responseBytes does not update response stats', () => {
    const tracker = createTracker();
    simulateCall(tracker, 'tool_a', {}, { responseBytes: 0 });

    const metrics = tracker.getSnapshot().tools['tool_a'];
    expect(metrics.totalResponseBytes).toBe(0);
    // minResponseBytes should serialize as 0 (Infinity replaced)
    expect(metrics.minResponseBytes).toBe(0);
  });

  test('mixed calls with and without responseBytes', () => {
    const tracker = createTracker();
    simulateCall(tracker, 'tool_a', {}, { responseBytes: 500 });
    simulateCall(tracker, 'tool_a', {}, { responseBytes: 0 });
    simulateCall(tracker, 'tool_a', {}, { responseBytes: 1500 });

    const metrics = tracker.getSnapshot().tools['tool_a'];
    expect(metrics.totalResponseBytes).toBe(2000);
    expect(metrics.minResponseBytes).toBe(500);
    expect(metrics.maxResponseBytes).toBe(1500);
    // avg is totalResponseBytes / callCount (3 calls, not 2)
    expect(metrics.avgResponseBytes).toBe(Math.round(2000 / 3));
  });
});

// ---------------------------------------------------------------------------
// 6. computeResponseBytes helper
// ---------------------------------------------------------------------------

describe('computeResponseBytes', () => {
  test('computes byte size of a simple object', () => {
    const obj = { content: [{ type: 'text', text: 'hello' }] };
    const bytes = computeResponseBytes(obj);
    expect(bytes).toBe(Buffer.byteLength(JSON.stringify(obj), 'utf-8'));
    expect(bytes).toBeGreaterThan(0);
  });

  test('handles multi-byte UTF-8 characters', () => {
    const obj = { text: '日本語テスト' };
    const bytes = computeResponseBytes(obj);
    // JSON string is longer in bytes than characters due to UTF-8
    expect(bytes).toBeGreaterThan(JSON.stringify(obj).length - 10); // rough check
    expect(bytes).toBeGreaterThan(0);
  });

  test('returns 0 for circular references', () => {
    const obj: any = { a: 1 };
    obj.self = obj; // circular
    expect(computeResponseBytes(obj)).toBe(0);
  });

  test('returns 0 for undefined', () => {
    expect(computeResponseBytes(undefined)).toBe(0);
  });

  test('handles null and primitives', () => {
    expect(computeResponseBytes(null)).toBe(4); // "null"
    expect(computeResponseBytes(42)).toBe(2); // "42"
    expect(computeResponseBytes('hello')).toBe(7); // '"hello"'
  });
});

// ---------------------------------------------------------------------------
// 7. Session tracking
// ---------------------------------------------------------------------------

describe('Session tracking', () => {
  test('creates a session entry on construction', () => {
    const tracker = createTracker();
    const snap = tracker.getSnapshot();
    expect(snap.sessions).toHaveLength(1);
    expect(snap.sessions[0].startedAt).toBeDefined();
    expect(snap.sessions[0].endedAt).toBeNull();
    expect(snap.sessions[0].totalCalls).toBe(0);
  });

  test('updates current session counters on each call', () => {
    const tracker = createTracker();
    simulateCall(tracker, 'tool_a');
    simulateCall(tracker, 'tool_b');
    simulateCall(tracker, 'tool_a');

    const sess = tracker.getSnapshot().sessions[0];
    expect(sess.totalCalls).toBe(3);
    expect(sess.toolCalls['tool_a']).toBe(2);
    expect(sess.toolCalls['tool_b']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 8. Interval bucketing
// ---------------------------------------------------------------------------

describe('Interval bucketing', () => {
  test('places calls in the correct 5-hour bucket', () => {
    const tracker = createTracker();
    simulateCall(tracker, 'tool_a');

    const snap = tracker.getSnapshot();
    const keys = Object.keys(snap.intervals);
    expect(keys).toHaveLength(1);

    const bucket = snap.intervals[keys[0]];
    expect(bucket.totalCalls).toBe(1);
    expect(bucket.toolCalls['tool_a']).toBe(1);

    // Verify the key format: YYYY-MM-DD/HH:00-HH:00
    expect(keys[0]).toMatch(/^\d{4}-\d{2}-\d{2}\/\d{2}:00-\d{2}:00$/);
  });

  test('accumulates calls in the same interval', () => {
    const tracker = createTracker();
    simulateCall(tracker, 'tool_a');
    simulateCall(tracker, 'tool_a');
    simulateCall(tracker, 'tool_b', {}, { isError: true });

    const snap = tracker.getSnapshot();
    const keys = Object.keys(snap.intervals);
    expect(keys).toHaveLength(1);

    const bucket = snap.intervals[keys[0]];
    expect(bucket.totalCalls).toBe(3);
    expect(bucket.totalErrors).toBe(1);
    expect(bucket.toolCalls['tool_a']).toBe(2);
    expect(bucket.toolCalls['tool_b']).toBe(1);
    expect(bucket.toolErrors['tool_b']).toBe(1);
  });

  test('bucket label and interval timestamps are set', () => {
    const tracker = createTracker();
    simulateCall(tracker, 'tool_a');

    const snap = tracker.getSnapshot();
    const bucket = Object.values(snap.intervals)[0];
    expect(bucket.label).toBeDefined();
    expect(bucket.intervalStart).toBeDefined();
    expect(bucket.intervalEnd).toBeDefined();
    // intervalEnd should be after intervalStart
    expect(new Date(bucket.intervalEnd).getTime()).toBeGreaterThan(
      new Date(bucket.intervalStart).getTime()
    );
  });
});

// ---------------------------------------------------------------------------
// 9. Persistence — flush and load
// ---------------------------------------------------------------------------

describe('Persistence', () => {
  test('flushes stats to disk', () => {
    const dir = makeTmpProject('flush-test');
    const tracker = createTracker([dir]);

    simulateCall(tracker, 'tool_a', { path: 'src' }, { responseBytes: 512 });
    simulateCall(tracker, 'tool_a', {}, { isError: true, responseBytes: 256 });
    tracker.flush();

    expect(existsSync(statsPath(dir))).toBe(true);
    const saved = readStats(dir);
    expect(saved.totalCalls).toBe(2);
    expect(saved.totalErrors).toBe(1);
    expect(saved.tools['tool_a'].callCount).toBe(2);
    expect(saved.tools['tool_a'].totalResponseBytes).toBe(768);
  });

  test('loads stats from disk on construction', () => {
    const dir = makeTmpProject('load-test');

    // First tracker: write some data
    const t1 = createTracker([dir]);
    simulateCall(t1, 'tool_x', {}, { responseBytes: 100 });
    simulateCall(t1, 'tool_x');
    t1.flush();

    // Second tracker: should load previous data
    const t2 = createTracker([dir]);
    const snap = t2.getSnapshot();

    // Should have calls from t1 plus a new empty session from t2
    expect(snap.totalCalls).toBe(2);
    expect(snap.tools['tool_x'].callCount).toBe(2);
    // Sessions: t1's session + t2's new session
    expect(snap.sessions.length).toBeGreaterThanOrEqual(2);
  });

  test('accumulates across multiple restarts', () => {
    const dir = makeTmpProject('restart-test');

    // Session 1
    const t1 = createTracker([dir]);
    simulateCall(t1, 'tool_a');
    simulateCall(t1, 'tool_b');
    t1.flush();

    // Session 2
    const t2 = createTracker([dir]);
    simulateCall(t2, 'tool_a');
    simulateCall(t2, 'tool_c');
    t2.flush();

    // Session 3
    const t3 = createTracker([dir]);
    const snap = t3.getSnapshot();
    expect(snap.totalCalls).toBe(4);
    expect(snap.tools['tool_a'].callCount).toBe(2);
    expect(snap.tools['tool_b'].callCount).toBe(1);
    expect(snap.tools['tool_c'].callCount).toBe(1);
    expect(snap.sessions).toHaveLength(3);
  });

  test('handles corrupted stats file gracefully', () => {
    const dir = makeTmpProject('corrupt-test');
    writeFileSync(statsPath(dir), 'NOT VALID JSON!!!');

    // Should not throw, should start fresh
    const tracker = createTracker([dir]);
    const snap = tracker.getSnapshot();
    expect(snap.totalCalls).toBe(0);
    expect(snap.sessions).toHaveLength(1);
  });

  test('handles missing .codemap directory', () => {
    const dir = join(TMP_ROOT, 'no-codemap-dir');
    if (existsSync(dir)) rmSync(dir, { recursive: true });
    mkdirSync(dir, { recursive: true });
    // No .codemap/ subdirectory — should be created on flush

    const tracker = createTracker([dir]);
    simulateCall(tracker, 'tool_a');
    tracker.flush();

    expect(existsSync(statsPath(dir))).toBe(true);
  });

  test('caps sessions at 50', () => {
    const dir = makeTmpProject('cap-sessions');

    // Write a snapshot with 55 sessions
    const fakeSnap: UsageSnapshot = {
      version: 1,
      serverStartedAt: new Date().toISOString(),
      lastFlushedAt: new Date().toISOString(),
      totalCalls: 55,
      totalErrors: 0,
      tools: {},
      sessions: Array.from({ length: 55 }, (_, i) => ({
        startedAt: new Date(Date.now() - (55 - i) * 60000).toISOString(),
        endedAt: new Date(Date.now() - (55 - i) * 60000 + 1000).toISOString(),
        totalCalls: 1,
        toolCalls: { tool_a: 1 },
      })),
      intervals: {},
    };
    writeFileSync(statsPath(dir), JSON.stringify(fakeSnap));

    const tracker = createTracker([dir]);
    const snap = tracker.getSnapshot();
    // 50 kept from trim + 1 new session = 51
    expect(snap.sessions.length).toBeLessThanOrEqual(51);
  });

  test('caps intervals at 200', () => {
    const dir = makeTmpProject('cap-intervals');

    const intervals: Record<string, any> = {};
    for (let i = 0; i < 210; i++) {
      const date = new Date(2025, 0, 1 + Math.floor(i / 5));
      const hour = (i % 5) * 5;
      const endHour = hour + 5;
      const dateStr = date.toISOString().slice(0, 10);
      const key = `${dateStr}/${String(hour).padStart(2, '0')}:00-${String(endHour === 25 ? 0 : endHour).padStart(2, '0')}:00`;
      intervals[key] = {
        intervalStart: date.toISOString(),
        intervalEnd: date.toISOString(),
        label: key,
        totalCalls: 1,
        totalErrors: 0,
        toolCalls: { tool_a: 1 },
        toolErrors: {},
      };
    }

    const fakeSnap: UsageSnapshot = {
      version: 1,
      serverStartedAt: new Date().toISOString(),
      lastFlushedAt: new Date().toISOString(),
      totalCalls: 210,
      totalErrors: 0,
      tools: {},
      sessions: [],
      intervals,
    };
    writeFileSync(statsPath(dir), JSON.stringify(fakeSnap));

    const tracker = createTracker([dir]);
    const snap = tracker.getSnapshot();
    expect(Object.keys(snap.intervals).length).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// 10. Backward compatibility / migration
// ---------------------------------------------------------------------------

describe('Migration', () => {
  test('migrates old stats without response byte fields', () => {
    const dir = makeTmpProject('migrate-bytes');

    const oldSnap = {
      version: 1,
      serverStartedAt: new Date().toISOString(),
      lastFlushedAt: new Date().toISOString(),
      totalCalls: 5,
      totalErrors: 0,
      tools: {
        codemap_module: {
          callCount: 5,
          totalLatencyMs: 50,
          avgLatencyMs: 10,
          minLatencyMs: 5,
          maxLatencyMs: 20,
          errorCount: 0,
          lastCalledAt: new Date().toISOString(),
          firstCalledAt: new Date().toISOString(),
          paramFrequency: {},
          // No response byte fields!
        },
      },
      sessions: [],
      intervals: {},
    };
    writeFileSync(statsPath(dir), JSON.stringify(oldSnap));

    const tracker = createTracker([dir]);
    const snap = tracker.getSnapshot();
    const metrics = snap.tools['codemap_module'];
    expect(metrics.totalResponseBytes).toBe(0);
    expect(metrics.avgResponseBytes).toBe(0);
    expect(metrics.minResponseBytes).toBe(0);
    expect(metrics.maxResponseBytes).toBe(0);
  });

  test('migrates old stats without intervals field', () => {
    const dir = makeTmpProject('migrate-intervals');

    const oldSnap = {
      version: 1,
      serverStartedAt: new Date().toISOString(),
      lastFlushedAt: new Date().toISOString(),
      totalCalls: 1,
      totalErrors: 0,
      tools: {},
      sessions: [],
      // No intervals field!
    };
    writeFileSync(statsPath(dir), JSON.stringify(oldSnap));

    const tracker = createTracker([dir]);
    const snap = tracker.getSnapshot();
    expect(snap.intervals).toBeDefined();
    expect(typeof snap.intervals).toBe('object');
  });
});

// ---------------------------------------------------------------------------
// 11. Infinity serialization
// ---------------------------------------------------------------------------

describe('Infinity handling', () => {
  test('getSnapshot replaces Infinity with 0', () => {
    const tracker = createTracker();
    // Record start without end — ensureTool creates metrics with Infinity
    tracker.recordStart('tool_a');

    const snap = tracker.getSnapshot();
    const metrics = snap.tools['tool_a'];
    // minLatencyMs defaults to Infinity, should be 0 in snapshot
    expect(metrics.minLatencyMs).toBe(0);
    expect(metrics.minResponseBytes).toBe(0);
    expect(Number.isFinite(metrics.minLatencyMs)).toBe(true);
    expect(Number.isFinite(metrics.minResponseBytes)).toBe(true);
  });

  test('flush writes valid JSON without Infinity', () => {
    const dir = makeTmpProject('infinity-test');
    const tracker = createTracker([dir]);

    // Only recordStart, no recordEnd — leaves Infinity in metrics
    tracker.recordStart('tool_a');
    tracker.flush();

    const raw = readFileSync(statsPath(dir), 'utf-8');
    // Should not contain "Infinity" as a value
    expect(raw).not.toContain('Infinity');
    // Should be valid JSON
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 12. getSummary output
// ---------------------------------------------------------------------------

describe('getSummary', () => {
  test('returns markdown with no tools message when empty', () => {
    const tracker = createTracker();
    const summary = tracker.getSummary();
    expect(summary).toContain('# MCP Usage Statistics');
    expect(summary).toContain('_No tool calls recorded yet._');
  });

  test('includes tool utilization table with response columns', () => {
    const tracker = createTracker();
    simulateCall(tracker, 'codemap_module', { path: 'src' }, { responseBytes: 2048 });
    simulateCall(tracker, 'codemap_overview', {}, { responseBytes: 8192 });

    const summary = tracker.getSummary();
    expect(summary).toContain('## Tool Utilization');
    expect(summary).toContain('Avg Response');
    expect(summary).toContain('Total Response');
    expect(summary).toContain('codemap_module');
    expect(summary).toContain('codemap_overview');
  });

  test('includes utilization distribution', () => {
    const tracker = createTracker();
    simulateCall(tracker, 'tool_a');
    simulateCall(tracker, 'tool_a');
    simulateCall(tracker, 'tool_b');

    const summary = tracker.getSummary();
    expect(summary).toContain('## Utilization Distribution');
    expect(summary).toContain('tool_a');
    expect(summary).toContain('tool_b');
    expect(summary).toMatch(/\d+\.\d+%/); // percentage
  });

  test('includes parameter insights', () => {
    const tracker = createTracker();
    simulateCall(tracker, 'codemap_module', { path: 'src/core' });
    simulateCall(tracker, 'codemap_module', { path: 'src/core' });
    simulateCall(tracker, 'codemap_module', { path: 'src/mcp' });

    const summary = tracker.getSummary();
    expect(summary).toContain('## Most Queried Parameters');
    expect(summary).toContain('src/core');
    expect(summary).toContain('src/mcp');
  });

  test('includes interval breakdown', () => {
    const tracker = createTracker();
    simulateCall(tracker, 'tool_a');

    const summary = tracker.getSummary();
    expect(summary).toContain('## 5-Hour Interval Breakdown');
  });

  test('includes session history when multiple sessions exist', () => {
    const dir = makeTmpProject('summary-sessions');
    const t1 = createTracker([dir]);
    simulateCall(t1, 'tool_a');
    t1.flush();

    const t2 = createTracker([dir]);
    simulateCall(t2, 'tool_b');

    const summary = t2.getSummary();
    expect(summary).toContain('## Recent Sessions');
  });

  test('shows response byte data in table', () => {
    const tracker = createTracker();
    // ~2KB response
    simulateCall(tracker, 'tool_a', {}, { responseBytes: 2048 });

    const summary = tracker.getSummary();
    // Should contain human-readable byte formatting
    expect(summary).toMatch(/2\.0 KB|2 KB/);
  });
});

// ---------------------------------------------------------------------------
// 13. Debounced flush
// ---------------------------------------------------------------------------

describe('Debounced flush', () => {
  test('sets dirty flag on recordEnd', () => {
    const tracker = createTracker();
    simulateCall(tracker, 'tool_a');

    // Access internal dirty flag via snapshot change detection
    // If dirty, the next flush timer tick would write
    // We verify by checking that flush actually writes data
    const dir = makeTmpProject('debounce-dirty');
    const t = createTracker([dir]);
    simulateCall(t, 'tool_a');

    // Manually flush to verify dirty state produces output
    t.flush();
    const saved = readStats(dir);
    expect(saved.totalCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 14. No project roots (in-memory only)
// ---------------------------------------------------------------------------

describe('In-memory mode (no project roots)', () => {
  test('works without persistence path', () => {
    const tracker = createTracker();
    simulateCall(tracker, 'tool_a');
    simulateCall(tracker, 'tool_b');

    // flush should be a no-op (no persistPath)
    tracker.flush();

    const snap = tracker.getSnapshot();
    expect(snap.totalCalls).toBe(2);
  });

  test('empty project roots array', () => {
    const tracker = createTracker([]);
    simulateCall(tracker, 'tool_a');
    tracker.flush(); // should not throw
    expect(tracker.getSnapshot().totalCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 15. Edge cases
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  test('tool names with special characters', () => {
    const tracker = createTracker();
    simulateCall(tracker, 'my-tool_v2.0');

    const snap = tracker.getSnapshot();
    expect(snap.tools['my-tool_v2.0'].callCount).toBe(1);
  });

  test('very large number of calls', () => {
    const tracker = createTracker();
    for (let i = 0; i < 1000; i++) {
      simulateCall(tracker, 'tool_a', {}, { responseBytes: 100 });
    }

    const snap = tracker.getSnapshot();
    expect(snap.totalCalls).toBe(1000);
    expect(snap.tools['tool_a'].callCount).toBe(1000);
    expect(snap.tools['tool_a'].totalResponseBytes).toBe(100000);
  });

  test('snapshot is a deep copy (mutations do not affect tracker)', () => {
    const tracker = createTracker();
    simulateCall(tracker, 'tool_a');

    const snap1 = tracker.getSnapshot();
    snap1.totalCalls = 999;
    snap1.tools['tool_a'].callCount = 999;

    const snap2 = tracker.getSnapshot();
    expect(snap2.totalCalls).toBe(1);
    expect(snap2.tools['tool_a'].callCount).toBe(1);
  });

  test('concurrent-like rapid calls do not lose data', () => {
    const tracker = createTracker();

    // Start multiple tokens before ending any
    const t1 = tracker.recordStart('tool_a', { q: '1' });
    const t2 = tracker.recordStart('tool_b', { q: '2' });
    const t3 = tracker.recordStart('tool_a', { q: '3' });

    tracker.recordEnd(t2, false, 200);
    tracker.recordEnd(t1, false, 100);
    tracker.recordEnd(t3, true, 300);

    const snap = tracker.getSnapshot();
    expect(snap.totalCalls).toBe(3);
    expect(snap.totalErrors).toBe(1);
    expect(snap.tools['tool_a'].callCount).toBe(2);
    expect(snap.tools['tool_a'].errorCount).toBe(1);
    expect(snap.tools['tool_b'].callCount).toBe(1);
    expect(snap.tools['tool_a'].totalResponseBytes).toBe(400);
    expect(snap.tools['tool_b'].totalResponseBytes).toBe(200);
  });
});
