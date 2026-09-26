import { agentActions, appendRecords, DEFAULT_FILTER, logFilter, stackLines } from '@/lib/logs';
import type { LogRecord } from '@/protocol/types';

describe('logFilter', () => {
  it('sends no sources when every source is on, so errors-only keeps the CLI default scope', () => {
    expect(logFilter('/w', { ...DEFAULT_FILTER, errors: true }, 100)).toEqual({
      workspace: '/w',
      tail: 100,
      errors: true,
    });
  });

  it('sends the chosen sources, level, slot and search', () => {
    expect(
      logFilter(
        '/w',
        { sources: ['client', 'metro'], level: 'warn', errors: false, grep: ' Error ', slot: 'ipad' },
        100,
      ),
    ).toEqual({ workspace: '/w', tail: 100, sources: ['metro', 'client'], level: 'warn', grep: 'Error', slot: 'ipad' });
  });
});

describe('appendRecords', () => {
  it('drops the oldest records past the cap', () => {
    const record = (ts: number): LogRecord => ({ ts, src: 'metro', level: 'info', msg: String(ts) });
    expect(appendRecords([record(1), record(2)], [record(3)], 2).map((r) => r.ts)).toEqual([2, 3]);
  });
});

describe('stackLines', () => {
  it('prints frames the way stim logs does', () => {
    expect(
      stackLines([{ fn: 'render', file: 'App.tsx', line: 4, column: 2 }, { fn: '_dispatch_client_callout' }, {}]),
    ).toEqual(['at render (App.tsx:4:2)', 'at _dispatch_client_callout']);
  });
});

describe('agentActions', () => {
  const action = (ts: number, deviceId: string): LogRecord => ({
    ts,
    src: 'agent',
    level: 'info',
    msg: `Tapped ${ts}`,
    deviceId,
  });

  it('keeps only the device own actions, newest first, up to five', () => {
    const sim = '2FA9C340-A259-4420-A617-316DC159FF84';
    const first = agentActions([], [action(1, sim), action(2, 'emulator-5554'), action(3, sim)], sim);
    expect(first.map((a) => a.record.ts)).toEqual([3, 1]);
    const next = agentActions(
      first,
      [4, 5, 6, 7].map((ts) => action(ts, sim)),
      sim,
    );
    expect(next.map((a) => a.record.ts)).toEqual([7, 6, 5, 4, 3]);
  });

  it('keeps two identical actions in the same millisecond as two rows with distinct, stable keys', () => {
    const sim = 'sim';
    const first = agentActions([], [action(1, sim), action(1, sim)], sim);
    expect(first.map((a) => a.record)).toEqual([action(1, sim), action(1, sim)]);
    expect(new Set(first.map((a) => a.key)).size).toBe(2);
    const next = agentActions(first, [action(1, sim)], sim);
    expect(next.slice(1)).toEqual(first);
    expect(new Set(next.map((a) => a.key)).size).toBe(3);
  });
});
