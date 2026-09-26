import captured from '@/lib/fixtures/metro-errors.json';
import {
  agentActions,
  appendRecords,
  copyText,
  DEFAULT_FILTER,
  expoContext,
  groupRecords,
  logFilter,
  needsContext,
  shareText,
  stackLines,
  viewEntry,
} from '@/lib/logs';
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

describe('groupRecords and viewEntry, on records captured from an Expo app', () => {
  const { workspace } = captured;
  const syntax = captured.syntaxError as LogRecord[];
  const errorsOnly = syntax.filter((r) => r.level === 'error' || r.level === 'fatal');
  const lead = syntax.find((r) => r.msg.includes('SyntaxError'))!;

  it('collapses Bundling failed, the error line and its code frame and stack lines into one entry', () => {
    const entries = groupRecords(syntax);
    expect(entries.map((e) => e.lead.event)).toEqual([
      'bundle_response_started',
      'expo_stdout',
      'bundle_response_finished',
    ]);
    const failure = entries[1]!;
    expect(failure.lead).toBe(lead);
    expect(failure.related.map((r) => r.msg)).toEqual(['iOS Bundling failed 128ms index.js (1 module)']);
    expect(failure.context).toHaveLength(12);
  });

  it('keeps the failed bundle response of the same failure in its entry', () => {
    const response: LogRecord = {
      ts: lead.ts,
      src: 'metro',
      level: 'error',
      event: 'bundle_response_failed',
      platform: 'ios',
      requestId: '3ffec5f3-b4de-4eb6-8f3e-69c5854ab469',
      statusCode: 500,
      msg: 'ios bundle response failed',
    };
    const [marker, error] = errorsOnly;
    const entries = groupRecords([marker!, response, error!]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.lead).toBe(error);
    expect(entries[0]!.related).toEqual([marker, response]);
  });

  it('gives each platform failure its own bundle response when iOS and Android fail together', () => {
    const [marker, error] = errorsOnly;
    const response = (platform: string): LogRecord => ({
      ts: lead.ts,
      src: 'metro',
      level: 'error',
      event: 'bundle_response_failed',
      platform,
      requestId: platform,
      statusCode: 500,
      msg: `${platform} bundle response failed`,
    });
    const android = { ...marker!, ts: lead.ts + 5, msg: 'Android Bundling failed 131ms index.js (1 module)' };
    const androidError = { ...error!, ts: lead.ts + 5 };
    const entries = groupRecords([marker!, error!, response('android'), response('ios'), android, androidError]);
    expect(entries.map((e) => e.related.map((r) => r.msg))).toEqual([
      ['iOS Bundling failed 128ms index.js (1 module)', 'ios bundle response failed'],
      ['android bundle response failed', 'Android Bundling failed 131ms index.js (1 module)'],
    ]);
  });

  it('keeps an entry key while its records stream in', () => {
    const key = groupRecords(syntax)[1]!.key;
    for (let n = 2; n <= syntax.length; n += 1) {
      expect(groupRecords(syntax.slice(0, n))[1]!.key).toBe(key);
    }
  });

  it('under Errors only, finds the code frame in the Metro records the filter left out', () => {
    const [entry] = groupRecords(errorsOnly);
    expect(needsContext(entry!)).toBe(true);
    const context = expoContext(syntax, entry!.lead).map((r) => r.msg);
    expect(context).toEqual(groupRecords(syntax)[1]!.context);
  });

  it('leads with the message, then the location relative to the workspace, then the code frame', () => {
    const view = viewEntry(groupRecords(syntax)[1]!, workspace, '/Users/janicduplessis');
    expect(view.title).toBe('SyntaxError: Unexpected token, expected "}"');
    expect(view.location).toBe('App.js:12:31');
    expect(view.codeFrame).toEqual([
      '  10 |     <View style={styles.container}>',
      '  11 |       <Text>Open up App.js to start working on your app!</Text>',
      '> 12 |       <Text>{formatTotal(null) ]}</Text>',
      '     |                                ^',
      '  13 |       <StatusBar style="auto" />',
      '  14 |     </View>',
      '  15 |   );',
    ]);
    expect(view.details[0]).toBe('iOS Bundling failed 128ms index.js (1 module)');
    expect(view.details[1]).toBe('    at constructor (node_modules/@babel/parser/lib/index.js:369:19)');
  });

  it('copies the message and location, and shares the whole entry', () => {
    const entry = groupRecords(syntax)[1]!;
    const view = viewEntry(entry, workspace, null);
    expect(copyText(view)).toBe('SyntaxError: Unexpected token, expected "}"\nApp.js:12:31');
    const shared = shareText(view, entry, workspace);
    expect(shared.startsWith(`${copyText(view)}\n\n  10 |`)).toBe(true);
    expect(shared).toContain('iOS Bundling failed 128ms index.js (1 module)');
    expect(shared).toContain(workspace);
  });

  it('shows a runtime error as its type and message', () => {
    const entries = groupRecords(captured.runtimeError as LogRecord[]);
    expect(entries).toHaveLength(2);
    const view = viewEntry(entries[1]!, workspace, null);
    expect(view.title).toBe("TypeError: Cannot read property 'total' of null");
    expect(view.location).toBeNull();
    expect(copyText(view)).toBe(view.title);
  });
});
