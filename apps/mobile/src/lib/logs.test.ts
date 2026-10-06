import agentFixture from '../../../desktop/Tests/StimKitTests/Fixtures/agent-actions-vectors.json';
import vectors from '../../../desktop/Tests/StimKitTests/Fixtures/log-entries-vectors.json';
import captured from '@/lib/fixtures/metro-errors.json';
import {
  actionsAt,
  agentActions,
  agentFilterOptions,
  matchesAgentFilter,
  appendRecords,
  copyText,
  DEFAULT_FILTER,
  expoContext,
  groupRecords,
  initialFilter,
  lastBundleMs,
  logFilter,
  needsContext,
  presentChips,
  shareText,
  showsEntry,
  stackLines,
  stackPreview,
  viewEntry,
  type AgentAction,
  type LogChip,
} from '@/lib/logs';
import { relativeTo, tildeHome } from '@/lib/paths';
import type { EnvironmentState, LogRecord } from '@/protocol/types';

const agentVectors = agentFixture as unknown as {
  append: {
    name: string;
    deviceId: string;
    max: number;
    batches: { records: LogRecord[]; ts: number[]; keys: number[] }[];
  }[];
  filters: { name: string; records: LogRecord[]; options: { label: string; count: number; ts: number[] }[] }[];
};

describe('logFilter', () => {
  it('sends no sources when every source is on, so Errors keeps the CLI default scope', () => {
    expect(logFilter('/w', { ...DEFAULT_FILTER, severity: 'errors' }, 100)).toEqual({
      workspace: '/w',
      tail: 100,
      errors: true,
    });
  });

  it('asks for one device source for the platform chips, and warn and up for Warnings', () => {
    expect(
      logFilter('/w', { chips: ['ios', 'metro', 'android'], severity: 'warnings', grep: ' Error ', slot: 'ipad' }, 100),
    ).toEqual({ workspace: '/w', tail: 100, sources: ['metro', 'device'], level: 'warn', grep: 'Error', slot: 'ipad' });
  });
});

describe('initialFilter', () => {
  it('opens on one source and slot from a device card', () => {
    expect(logFilter('/w', initialFilter({ source: 'agent', slot: 'default' }), 100)).toEqual({
      workspace: '/w',
      tail: 100,
      sources: ['agent'],
      slot: 'default',
    });
  });

  it('ignores a source it does not know and keeps errors only', () => {
    expect(logFilter('/w', initialFilter({ errors: '1', source: 'bogus' }), 100)).toEqual({
      workspace: '/w',
      tail: 100,
      errors: true,
    });
  });
});

it('routes native runtime logs through client output and excludes React Native client lines', () => {
  const filter = initialFilter({ source: 'macos' });
  expect(logFilter('/native', filter, 100)).toEqual({ workspace: '/native', tail: 100, sources: ['client'] });
  const entry = (platform: string) => ({
    key: '1:0',
    lead: { ts: 1, src: 'client', platform, level: 'info', msg: 'ready' } as LogRecord,
    related: [],
    context: [],
  });
  expect(showsEntry(filter, entry('macos'))).toBe(true);
  expect(showsEntry(filter, entry('ios'))).toBe(false);
  expect(logFilter('/native', initialFilter({ source: 'build' }), 100).sources).toEqual(['build']);
});

describe('showsEntry', () => {
  const entry = (lead: Partial<LogRecord>) => ({
    key: '1:0',
    lead: { ts: 1, src: 'device', level: 'info', msg: 'x', ...lead } as LogRecord,
    related: [],
    context: [],
  });

  it('keeps only the chosen platforms of device records, which the server cannot filter', () => {
    const state = { ...DEFAULT_FILTER, chips: ['ios', 'metro'] as LogChip[] };
    expect(showsEntry(state, entry({ platform: 'ios' }))).toBe(true);
    expect(showsEntry(state, entry({ platform: 'android' }))).toBe(false);
    expect(showsEntry(state, entry({ src: 'metro', platform: 'android' }))).toBe(true);
  });

  it('under Warnings, leaves out the errors the server sends with warn and up', () => {
    const state = { ...DEFAULT_FILTER, severity: 'warnings' as const };
    expect(showsEntry(state, entry({ level: 'warn' }))).toBe(true);
    expect(showsEntry(state, entry({ level: 'error' }))).toBe(false);
  });
});

describe('presentChips', () => {
  it('shows the sources the workspace runs, the ones its records came from, and the selected ones', () => {
    const env = { metro: { port: 8081, running: true, pid: 1 }, slots: [{ slot: 'ipad', ios: {} }] };
    expect(presentChips(env as unknown as EnvironmentState, new Set(['build']), ['agent'])).toEqual([
      'metro',
      'client',
      'ios',
      'build',
      'agent',
    ]);
  });
});

describe('lastBundleMs', () => {
  it('times the newest finished bundle by its start with the same request id', () => {
    const metro = (ts: number, event: string, requestId: string): LogRecord => ({
      ts,
      src: 'metro',
      level: 'debug',
      msg: event,
      event,
      requestId,
    });
    expect(
      lastBundleMs([
        metro(100, 'bundle_response_started', 'a'),
        metro(200, 'bundle_response_started', 'b'),
        metro(2000, 'bundle_response_finished', 'b'),
        metro(2500, 'bundle_response_finished', 'a'),
      ]),
    ).toBe(2400);
    expect(lastBundleMs([metro(2000, 'bundle_response_finished', 'b')])).toBeNull();
  });
});

describe('stackPreview', () => {
  const root = '/Users/me/app';
  it('bolds workspace frames, keeps one framework frame as its package, and counts the rest', () => {
    expect(
      stackPreview(
        [
          { fn: 'PairScreen', file: `${root}/src/screens/pair.tsx`, line: 88, column: 3 },
          { fn: 'renderWithHooks', file: `${root}/node_modules/react-native/Libraries/Renderer/x.js`, line: 1 },
          { fn: 'usePairing', file: `${root}/src/hooks/pairing.ts`, line: 41 },
          { fn: 'beginWork', file: `${root}/node_modules/react-native/Libraries/Renderer/x.js`, line: 2 },
          { fn: 'performWork', file: `${root}/node_modules/@babel/runtime/y.js`, line: 3 },
        ],
        root,
        null,
      ),
    ).toEqual({
      frames: [
        { fn: 'PairScreen', where: 'src/screens/pair.tsx:88', app: true },
        { fn: 'renderWithHooks', where: 'react-native', app: false },
        { fn: 'usePairing', where: 'src/hooks/pairing.ts:41', app: true },
      ],
      hidden: 2,
      hiddenFramework: true,
    });
  });

  it('names a web frame by its script, not its bundle URL', () => {
    const file = 'http://localhost:8094/index.ts.bundle?platform=web&dev=true';
    expect(stackPreview([{ fn: 'ChannelList', file, line: 48213 }], root, null)?.frames).toEqual([
      { fn: 'ChannelList', where: 'index.ts.bundle', app: false },
    ]);
  });
});

describe('viewEntry for an agent action', () => {
  it('lists the details of a failed action', () => {
    const failed: LogRecord = {
      ts: 1,
      src: 'agent',
      level: 'error',
      msg: 'Failed orientation: COMMAND_FAILED',
      details: { durationMs: 228, code: 'COMMAND_FAILED', diagnosticId: 'mui9yw8q-ecb1359b' },
    };
    expect(viewEntry({ key: '1:0', lead: failed, related: [], context: [] }, '/w', null)).toEqual({
      title: 'Failed orientation: COMMAND_FAILED',
      location: null,
      codeFrame: [],
      details: ['durationMs: 228', 'code: COMMAND_FAILED', 'diagnosticId: mui9yw8q-ecb1359b'],
    });
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

  it.each(agentVectors.append.map((c) => [c.name, c] as const))('%s', (_, { deviceId, max, batches }) => {
    let actions: AgentAction[] = [];
    for (const batch of batches) {
      actions = agentActions(actions, batch.records, deviceId, max);
      expect(actions.map((a) => a.record.ts)).toEqual(batch.ts);
      expect(actions.map((a) => a.key)).toEqual(batch.keys);
    }
  });

  it('shows in replay only the actions at or before the playhead, newest first', () => {
    const actions = agentActions(
      [],
      [10, 20, 30].map((ts) => action(ts, 'sim')),
      'sim',
      5,
    );
    expect(actionsAt(actions, 20).map((a) => a.record.ts)).toEqual([20, 10]);
    expect(actionsAt(actions, 5)).toEqual([]);
    expect(actionsAt(actions, null).map((a) => a.record.ts)).toEqual([30, 20, 10]);
  });
});

describe('agentFilterOptions', () => {
  it.each(agentVectors.filters.map((c) => [c.name, c] as const))('%s', (_, { records, options: expected }) => {
    const actions = records.map((record, key) => ({ key, record }));
    const options = agentFilterOptions(actions);
    expect(options.map((o) => ({ label: o.label, count: o.count }))).toEqual(
      expected.map((o) => ({ label: o.label, count: o.count })),
    );
    expect(options.map((o) => actions.filter((a) => matchesAgentFilter(a, o.filter)).map((a) => a.record.ts))).toEqual(
      expected.map((o) => o.ts),
    );
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

  it('under Errors only, takes the code frame the CLI attached to the error record', () => {
    const full = groupRecords(syntax)[1]!;
    const attached = errorsOnly.map((r) => (r === full.lead ? { ...r, context: full.context } : r));
    const [entry] = groupRecords(attached);
    expect(entry!.context).toEqual(full.context);
    expect(needsContext(entry!)).toBe(false);
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

describe('the log entry vectors Stim Desktop replays', () => {
  const { root, home } = vectors;

  it.each(vectors.groups.map((c) => [c.name, c] as const))('groups and shows %s', (_, c) => {
    const records = c.records as LogRecord[];
    const entries = groupRecords(records).map((entry) => {
      const { title, location, codeFrame, details } = viewEntry(entry, root, home);
      return {
        lead: records.indexOf(entry.lead),
        related: entry.related.map((r) => records.indexOf(r)),
        context: entry.context,
        view: { title, location, codeFrame, details },
      };
    });
    expect(entries).toEqual(c.entries);
  });

  it.each(vectors.previews.map((c) => [c.name, c] as const))('previews %s', (_, c) => {
    expect(stackPreview(c.stack, c.root, c.home)).toEqual(c.preview);
  });

  it.each(vectors.paths.map((c) => [c.text, c] as const))('shortens %s', (_, c) => {
    expect(tildeHome(relativeTo(c.text, c.root), c.home)).toBe(c.shown);
  });
});

test('uses exactly the archive selector while preserving severity, sources and pagination', () => {
  expect(
    logFilter(
      { archive: 'app--old' },
      { ...DEFAULT_FILTER, severity: 'errors', chips: ['build'], slot: 'default' },
      400,
    ),
  ).toEqual({ archive: 'app--old', errors: true, sources: ['build'], slot: 'default', tail: 400 });
  expect(logFilter({ workspace: '/app' }, DEFAULT_FILTER, 200)).toEqual({ workspace: '/app', tail: 200 });
});
