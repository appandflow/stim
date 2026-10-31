import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { redactArgv, redactCommandLine, trace } from '../state/trace.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stim-trace-'));
});
afterEach(() => {
  delete process.env.STIM_TRACE;
  delete process.env.STIM_TRACE_OWNER;
  rmSync(dir, { recursive: true, force: true });
});

interface TraceEvent {
  name: string;
  cat?: string;
  ph: string;
  ts: number;
  dur: number;
  tid: number;
  pid: number;
  args?: Record<string, unknown>;
}

const events = (file: string): TraceEvent[] => {
  const parsed: TraceEvent[] = JSON.parse(`${readFileSync(file, 'utf8').trimEnd().replace(/,$/, '')}]`);
  return parsed;
};

test('STIM_TRACE writes a Chrome trace that parses once closed, with spans, phases and marks', async () => {
  const file = join(dir, 'trace.json');
  process.env.STIM_TRACE = file;
  const phases = trace.phases('build');
  phases.enter('prepare');
  phases.enter('prepare');
  phases.enter('compile');
  await trace.spanAsync('outer', async () => trace.span('inner', () => 'done'), { platform: 'ios' });
  await expect(
    trace.spanAsync('boom', async () => {
      throw new Error('nope');
    }),
  ).rejects.toThrow('nope');
  trace.mark('memo hit', { platform: 'ios' });
  phases.end({ ok: true });

  const all = events(file);
  const complete = all.filter((event) => event.ph === 'X');
  expect(complete.map((event) => event.name).toSorted()).toEqual(['boom', 'compile', 'inner', 'outer', 'prepare']);
  expect(complete.filter((event) => event.cat === 'phase').map((event) => event.name)).toEqual(['prepare', 'compile']);
  for (const event of complete) {
    expect(event.pid).toBe(process.pid);
    expect(event.ts).toBeGreaterThan(1e15);
    expect(event.dur).toBeGreaterThanOrEqual(0);
  }
  const named = (name: string): TraceEvent => {
    const found = complete.find((event) => event.name === name);
    if (!found) throw new Error(`no span named ${name}`);
    return found;
  };
  expect(named('outer').args).toEqual({ platform: 'ios' });
  expect(named('boom').args).toEqual({ error: true });
  expect(named('compile').args).toEqual({ ok: true });
  expect(named('compile').ts).toBeGreaterThanOrEqual(named('prepare').ts + named('prepare').dur);
  expect(all.filter((event) => event.ph === 'i').map((event) => event.name)).toEqual(['memo hit']);
  expect(named('inner').tid).not.toBe(named('outer').tid);
});

test('a command truncates a trace left by an earlier run, but not one its parent command owns', () => {
  const file = join(dir, 'trace.json');
  const stale = '[\n{"name":"stale","ph":"X","ts":1,"dur":1,"pid":1,"tid":1},\n';
  writeFileSync(file, stale);
  process.env.STIM_TRACE = file;
  trace.command('stim ios');
  const names = () => events(file).map((event) => event.name);
  expect(names()).not.toContain('stale');
  expect(process.env.STIM_TRACE_OWNER).toBe(file);
  writeFileSync(file, stale);
  trace.command('stim nested');
  expect(names()).toContain('stale');
});

test('redactArgv hides secret flag values, credentials in URLs and exact values, and keeps the rest', () => {
  expect(
    redactArgv(
      [
        'sign',
        '--ks-pass',
        'pass:hunter2',
        '--token=abc123',
        '--ticket',
        'tkt',
        'API_KEY=zzz',
        'https://user:pw@example.com/x',
        '--out',
        'build/app.apk',
        'Bearer abcdefghijkl',
        'ghp_abcdefghijklmnop',
        'literal-secret-value',
        '--env=EXPO_TOKEN=abc',
        'https://host/p?mode=1&token=abc&x=2',
        'https://opaquetoken@host/p',
        'eas build --token abc --platform ios',
        'X-Api-Key: k123',
        'Authorization: Bearer abcdefghijkl',
        'Cookie: sid=abc; other=1',
        '--pwd=hunter2',
      ],
      ['literal-secret-value'],
    ),
  ).toEqual([
    'sign',
    '--ks-pass',
    '[redacted]',
    '--token=[redacted]',
    '--ticket',
    '[redacted]',
    'API_KEY=[redacted]',
    'https://[redacted]@example.com/x',
    '--out',
    'build/app.apk',
    'Bearer [redacted]',
    '[redacted]',
    '***',
    '--env=EXPO_TOKEN=[redacted]',
    'https://host/p?mode=1&token=[redacted]&x=2',
    'https://[redacted]@host/p',
    'eas build --token [redacted] --platform ios',
    'X-Api-Key: [redacted]',
    'Authorization: [redacted]',
    'Cookie: [redacted]',
    '--pwd=[redacted]',
  ]);
});

test('redactArgv ignores the credential flags of a program it does not list', () => {
  expect(redactArgv(['-u', 'user:pw'])).toEqual(['-u', 'user:pw']);
  expect(redactArgv(['-u', 'user:pw'], [], 'docker')).toEqual(['-u', 'user:pw']);
});

test('redactCommandLine hides secret flags and assignments in a shell command', () => {
  expect(redactCommandLine("TOKEN=abc eas build --token 'a b' --platform ios --api-key=k")).toBe(
    'TOKEN=[redacted] eas build --token [redacted] --platform ios --api-key=[redacted]',
  );
});
