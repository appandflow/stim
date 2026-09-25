import { appendRecords, DEFAULT_FILTER, logFilter, stackLines } from '@/lib/logs';
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
