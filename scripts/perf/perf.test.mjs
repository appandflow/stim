import { describe, expect, it } from 'vitest';
import {
  compareRuns,
  groupByMachine,
  loadRefusal,
  machineId,
  median,
  parseTrace,
  scrubOutput,
  summarizeRuns,
  summarizeTrace,
} from './lib.mjs';

const run = (wallTimes, load = 5, extra = {}) => ({
  id: 'r',
  startedAt: '2026-10-23T04:00:00Z',
  machine: { id: 'mac-1' },
  repo: { sha: 'a'.repeat(40) },
  scenarios: {
    'ios-rerun': {
      runs: wallTimes.map((wallMs, index) => ({ rep: index + 1, wallMs, exit: 0, loadBefore: load, loadAfter: load })),
    },
  },
  ...extra,
});

describe('trace summary', () => {
  it('reads a trace the CLI left without its closing bracket and totals phases, spans and children', () => {
    const text = [
      '[',
      '{"ph":"M","name":"process_name","pid":1,"args":{"name":"cli 1"}},',
      '{"name":"stim ios","cat":"command","ph":"X","ts":1,"dur":9000000,"tid":1,"pid":1,"args":{"exit":0}},',
      '{"name":"cache-lookup","cat":"phase","ph":"X","ts":1,"dur":2000000,"tid":1000,"pid":1},',
      '{"name":"install","cat":"phase","ph":"X","ts":1,"dur":3000000,"tid":1000,"pid":1},',
      '{"name":"install","cat":"phase","ph":"X","ts":1,"dur":1000000,"tid":1000,"pid":1},',
      '{"name":"fingerprint","cat":"span","ph":"X","ts":1,"dur":1500000,"tid":2,"pid":1},',
      '{"name":"git","cat":"exec","ph":"X","ts":1,"dur":100000,"tid":2,"pid":1},',
      '{"name":"adb","cat":"exec","ph":"X","ts":1,"dur":300000,"tid":3,"pid":1},',
      '',
    ].join('\n');
    expect(summarizeTrace(parseTrace(text))).toEqual({
      commandMs: 9000,
      phases: { 'cache-lookup': 2000, install: 4000 },
      spans: { fingerprint: 1500 },
      exec: { count: 2, ms: 400 },
    });
  });
});

const at = (startedAt, machine) => ({ startedAt, machine: { id: machine } });

describe('run summary', () => {
  it('uses the median of the successful repetitions and counts the failed ones', () => {
    expect(
      summarizeRuns([
        { wallMs: 100, exit: 0 },
        { wallMs: 9000, exit: 0 },
        { wallMs: 120, exit: 0 },
        { wallMs: 50, exit: 1 },
      ]),
    ).toMatchObject({ n: 4, failures: 1, medianMs: 120, minMs: 100, maxMs: 9000 });
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('comparison', () => {
  it('flags a median that grew by more than ten percent and ignores one outlier repetition', () => {
    const previous = run([10_000, 10_100, 10_200]);
    const latest = run([11_500, 11_600, 30_000]);
    const { rows } = compareRuns(latest, previous);
    expect(rows[0]).toMatchObject({ scenario: 'ios-rerun', status: 'REGRESSION' });
    expect(rows[0].deltaPct).toBeCloseTo(0.1485, 3);
    expect(compareRuns(run([10_900, 11_000, 11_050]), previous).rows[0].status).toBe('ok');
    expect(compareRuns(run([8_000, 8_100, 8_200]), previous).rows[0].status).toBe('faster');
  });

  it('does not flag a large percentage that is only a few milliseconds', () => {
    expect(compareRuns(run([100, 100, 100]), run([50, 50, 50])).rows[0].status).toBe('ok');
  });

  it('refuses to compare runs taken under very different load, and warns about a busy machine', () => {
    const refused = compareRuns(run([20_000], 120), run([10_000], 5));
    expect(refused.refused).toBe(true);
    expect(refused.rows[0].status).toBe('not compared');
    expect(refused.notes[0]).toMatch(/load differs too much/);
    const similar = compareRuns(run([12_000], 110), run([10_000], 100));
    expect(similar.refused).toBe(false);
    expect(similar.notes.join()).toMatch(/load 110.0/);
    expect(loadRefusal(8, 3)).toBeNull();
    expect(loadRefusal(null, 3)).toBeNull();
  });

  it('notes a different app commit and reports a scenario that no longer succeeds', () => {
    const latest = run([1], 5, { repo: { sha: 'b'.repeat(40) } });
    latest.scenarios['ios-rerun'].runs[0].exit = 1;
    const result = compareRuns(latest, run([10_000]));
    expect(result.rows[0].status).toBe('failed');
    expect(result.notes.join()).toMatch(/app source differs/);
  });

  it('compares the two newest runs of each machine, whatever their version', () => {
    const groups = groupByMachine([at('2026-10-02', 'a'), at('2026-10-01', 'a'), at('2026-10-03', 'b')]);
    expect(groups.get('a').map((each) => each.startedAt)).toEqual(['2026-10-01', '2026-10-02']);
    expect(groups.get('b')).toHaveLength(1);
  });
});

describe('published data', () => {
  it('names a machine without its host name and strips home and temporary paths from failures', () => {
    expect(machineId('Mac15,3', 'janics-macbook')).toMatch(/^mac15-3-[0-9a-f]{6}$/);
    expect(machineId('Mac15,3', 'janics-macbook')).not.toContain('janic');
    expect(scrubOutput('failed in /Users/me/app and /var/tmp/x/y', { home: '/Users/me', tmp: '/var/tmp/x' })).toBe(
      'failed in ~/app and <tmp>/y',
    );
  });
});
