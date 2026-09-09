import { readdirSync, readFileSync } from 'node:fs';
import {
  formatDuration,
  formatElapsed,
  formatLongDuration,
  isOutputLabel,
  launchErrorReport,
  OUTPUT_LABELS,
  phaseLine,
  shortHash,
  shortUdid,
} from '../command-output.ts';
import { parseLogcatLine } from '../collector/android.ts';
import { parseLogStreamLine } from '../collector/ios.ts';

test('formatDuration uses one format for every command', () => {
  expect(formatDuration(0)).toBe('0ms');
  expect(formatDuration(410)).toBe('410ms');
  expect(formatDuration(1000)).toBe('1s');
  expect(formatDuration(3100)).toBe('3.1s');
  expect(formatDuration(18000)).toBe('18s');
  expect(formatDuration(119600)).toBe('2m00s');
  expect(formatDuration(161000)).toBe('2m41s');
  expect(formatDuration(605000)).toBe('10m05s');
  expect(formatDuration(undefined)).toBe('unknown');
  expect(formatDuration(-1)).toBe('unknown');
});

test('formatElapsed keeps seconds at every scale, so a 30s progress line never repeats itself', () => {
  expect(formatElapsed(0)).toBe('0s');
  expect(formatElapsed(42_000)).toBe('42s');
  expect(formatElapsed(60_000)).toBe('1m00s');
  expect(formatElapsed(90_000)).toBe('1m30s');
  expect(formatElapsed(119_600)).toBe('2m00s');
  expect(formatElapsed(319_000)).toBe('5m19s');
  expect(formatElapsed(605_000)).toBe('10m05s');
  expect(formatElapsed(-5)).toBe('0s');
  expect(formatElapsed(undefined)).toBe('0s');
});

test('formatLongDuration adds hours and pads the smaller unit at every scale', () => {
  expect(formatLongDuration(0)).toBe('0s');
  expect(formatLongDuration(31_000)).toBe('31s');
  expect(formatLongDuration(245_000)).toBe('4m05s');
  expect(formatLongDuration(252_000)).toBe('4m12s');
  expect(formatLongDuration(2_460_000)).toBe('41m');
  expect(formatLongDuration(3_900_000)).toBe('1h05m');
  expect(formatLongDuration(7_980_000)).toBe('2h13m');
  expect(formatLongDuration(7_200_000)).toBe('2h');
  expect(formatLongDuration(-1)).toBe('unknown');
  expect(formatLongDuration(undefined)).toBe('unknown');
});

test('phaseLine uses one indented column', () => {
  expect(phaseLine('device', 'x')).toBe('  device      x');
  expect(phaseLine('fingerprint', 'x')).toBe('  fingerprint x');
});

test('shortHash keeps short values and abbreviates long values', () => {
  expect(shortHash('12345678')).toBe('12345678');
  expect(shortHash('123456789')).toBe('123456..');
  expect(shortHash(null)).toBe('');
});

test('shortUdid keeps short values and abbreviates simulator ids', () => {
  expect(shortUdid('A1F3')).toBe('A1F3');
  expect(shortUdid('A1F3-0000')).toBe('A1F3..');
  expect(shortUdid(null)).toBe('');
});

test('the label set is closed, sorted, and free of duplicates', () => {
  expect(OUTPUT_LABELS).toEqual(OUTPUT_LABELS.toSorted());
  expect(new Set(OUTPUT_LABELS).size).toBe(OUTPUT_LABELS.length);
  expect(isOutputLabel('install')).toBe(true);
  expect(isOutputLabel('launch err')).toBe(false);
  expect(isOutputLabel('js swap')).toBe(false);
  expect(isOutputLabel('wired')).toBe(false);
});

test('every label the run, lifecycle, and doctor commands print comes from that one set', () => {
  for (const command of ['ios', 'android', 'worktree', 'start', 'stop', 'doctor']) {
    const files = [`${command}.ts`];
    if (command === 'ios' || command === 'android') {
      files.push(
        ...readdirSync(new URL(`../commands/${command}/`, import.meta.url))
          .filter((file) => file.endsWith('.ts'))
          .map((file) => `${command}/${file}`),
        'native-runtime.ts',
        'dev-client.ts',
      );
    }
    const src = files.map((file) => readFileSync(new URL(`../commands/${file}`, import.meta.url), 'utf-8')).join('\n');
    const labels = new Set<string>();
    for (const match of src.matchAll(/\bphase(?:Line)?\(\s*'((?:[^'\\]|\\.)*)'/g)) labels.add(match[1]!);
    expect(labels.size).toBeGreaterThan(1);
    for (const label of labels) {
      expect({ command, label, known: isOutputLabel(label) }).toEqual({ command, label, known: true });
    }
  }
});

test("a verified launch counts the device log and still prints the app's own errors", () => {
  const records = [
    { src: 'device', proc: 'Trailhead', msg: 'Failed to send CA Event for app launch measurements' },
    { src: 'device', proc: 'Trailhead', msg: 'TCP Conn 0x106f86d00 Failed : error 0:61 [61]' },
    { src: 'device', proc: 'Trailhead', msg: 'NSBundle (null) initWithPath failed' },
    { src: 'client', msg: 'a redbox' },
    { src: 'metro', msg: 'a bundler error' },
  ];
  const report = launchErrorReport(records);
  expect(report.summary).toBe('3 error-level records in the device log during launch (logs --errors --source device)');
  expect(report.lines).toEqual(['a redbox', 'a bundler error']);
});

test('the count never depends on the process a record names', () => {
  const named = launchErrorReport([{ src: 'device', proc: 'Trailhead', msg: 'x' }]);
  const unnamed = launchErrorReport([{ src: 'device', msg: 'x' }]);
  expect(named.summary).toBe(unnamed.summary);
  expect(named.summary).toBe('1 error-level record in the device log during launch (logs --errors --source device)');
  expect(named.lines).toEqual([]);
});

test('device JavaScript failures remain visible without a client or Metro copy', () => {
  const android = parseLogcatLine('09-08 15:00:00.000 E/ReactNativeJS( 123): startup failed');
  const ios = parseLogStreamLine(
    JSON.stringify({
      eventType: 'logEvent',
      messageType: 'Error',
      eventMessage: 'startup failed',
      subsystem: 'com.facebook.react.log',
      category: 'javascript',
    }),
  );
  expect(launchErrorReport([{ ...android, platform: 'android' }]).lines).toEqual(['startup failed']);
  expect(launchErrorReport([{ ...ios, platform: 'ios' }]).lines).toEqual(['startup failed']);
});

test('no device record means no count line at all', () => {
  const quiet = launchErrorReport([{ src: 'client', msg: 'x' }]);
  expect(quiet.summary).toBe(null);
  expect(quiet.lines).toEqual(['x']);
});

test('launch previews cap a JavaScript stack split across Android log records without hiding the next error', () => {
  const messages = [
    'Error: first failure',
    ...Array.from({ length: 9 }, (_, i) => `    at frame${i} (app.ts:${i + 1}:2)`),
    'Error: second failure',
    '    at retry (retry.ts:4:2)',
  ];
  const records = messages.map((msg) => ({ src: 'device', platform: 'android', proc: 'ReactNativeJS(123)', msg }));
  const report = launchErrorReport(records);
  expect(report.lines).toEqual([
    'Error: first failure',
    'Error stack:',
    ...messages.slice(1, 6).map((line) => `  ${line.trim()}`),
    '  ... 4 more frames',
    'Error: second failure',
    'Error stack:',
    '  at retry (retry.ts:4:2)',
    'Full captured stacks: stim logs --source all (add --json for raw records)',
  ]);
  expect(report.summary).toContain('12 error-level records');
  expect(records.map((record) => record.msg)).toEqual(messages);
});

test('launch previews unescape and bound serialized React component stacks while labeling bundle coordinates honestly', () => {
  const frames = Array.from(
    { length: 7 },
    (_, i) =>
      `    at Component${i} (http://localhost:8082/index.bundle//&platform=ios&dev=true&transform.engine=hermes:${100 + i}:20)`,
  );
  const msg = `{ [Error: startup failed]\n  componentStack: '${frames.join('\\n')}',\n  isComponentError: true }`;
  const report = launchErrorReport([{ src: 'client', msg }]);
  expect(report.lines).toEqual([
    '{ [Error: startup failed]',
    'Component stack:',
    '  at Component0 (index.bundle:100:20 [unsymbolicated])',
    '  at Component1 (index.bundle:101:20 [unsymbolicated])',
    '  at Component2 (index.bundle:102:20 [unsymbolicated])',
    '  ... 4 more frames',
    '  isComponentError: true }',
    'Full captured stacks: stim logs --source all (add --json for raw records)',
  ]);
});

test('launch previews preserve structured error and component stacks separately without mutating raw evidence', () => {
  const records = [
    {
      src: 'client',
      msg: 'Error: render failed',
      stack: Array.from({ length: 8 }, (_, i) => ({ file: 'app.tsx', line: i + 1, column: 3, fn: `fn${i}` })),
      componentStack: '\n    at Screen (screen.tsx:10:3)\n    at Root (root.tsx:4:2)',
    },
  ];
  const original = JSON.stringify(records);
  const lines = launchErrorReport(records).lines;
  expect(lines).toContain('  at fn0 (app.tsx:1:3)');
  expect(lines).toContain('  at fn4 (app.tsx:5:3)');
  expect(lines).not.toContain('  at fn5 (app.tsx:6:3)');
  expect(lines).toContain('  ... 3 more frames');
  expect(lines.slice(-4)).toEqual([
    'Component stack:',
    '  at Screen (screen.tsx:10:3)',
    '  at Root (root.tsx:4:2)',
    'Full captured stacks: stim logs --source all (add --json for raw records)',
  ]);
  expect(JSON.stringify(records)).toBe(original);
});

test('launch previews do not interpret escaped newlines in ordinary error messages or discard malformed stack text', () => {
  const msg = 'Error: expected literal \\n in input';
  const malformed = "componentStack: 'unterminated text";
  expect(
    launchErrorReport([
      { src: 'metro', msg },
      { src: 'metro', msg: malformed },
    ]).lines,
  ).toEqual([msg, malformed]);
});

test('launch previews still bound a component stack whose serialized log record was truncated', () => {
  const frames = Array.from(
    { length: 12 },
    (_, i) => `    at Component${i} (http://localhost:8082/index.bundle?platform=android&dev=true:${100 + i}:20)`,
  );
  const msg = `componentStack: '\\n${frames.join('\\n')}\\n    at Last (http://localhost:8082/index.bundle?plat`;
  const lines = launchErrorReport([{ src: 'client', msg }]).lines;
  expect(lines).toEqual([
    'Component stack:',
    '  at Component0 (index.bundle:100:20 [unsymbolicated])',
    '  at Component1 (index.bundle:101:20 [unsymbolicated])',
    '  at Component2 (index.bundle:102:20 [unsymbolicated])',
    '  ... 10 more frames',
    '[captured stack text is incomplete]',
    'Full captured stacks: stim logs --source all (add --json for raw records)',
  ]);
});

test('launch previews retain Expo and Hermes frame order and reset depth between sources', () => {
  const records = [
    { src: 'metro', msg: 'Error: failed\nCode: app.tsx\n> 4 | throw error\nCall Stack\n  Screen (app.tsx:4:3)' },
    { src: 'client', msg: 'render@app.tsx:4:3\nparent@root.tsx:5:4' },
  ];
  expect(launchErrorReport(records).lines).toEqual([
    'Error: failed',
    'Code: app.tsx',
    '> 4 | throw error',
    'Error stack:',
    '  Screen (app.tsx:4:3)',
    'Error stack:',
    '  render@app.tsx:4:3',
    '  parent@root.tsx:5:4',
    'Full captured stacks: stim logs --source all (add --json for raw records)',
  ]);
});
