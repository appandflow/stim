import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('with STIM_TRACE unset every call runs its function and nothing is written', async () => {
  expect(trace.enabled()).toBe(false);
  expect(trace.span('a', () => 1)).toBe(1);
  expect(await trace.spanAsync('b', async () => 2)).toBe(2);
  trace.phases('p').enter('x');
  trace.mark('m');
  expect(existsSync(join(dir, 'trace.json'))).toBe(false);
});

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

test('a process that inherits the variable appends to the file instead of truncating it', () => {
  const file = join(dir, 'trace.json');
  writeFileSync(file, '[\n{"name":"parent","ph":"X","ts":1,"dur":1,"pid":1,"tid":1},\n');
  process.env.STIM_TRACE = file;
  process.env.STIM_TRACE_OWNER = file;
  trace.span('child', () => {});
  expect(events(file).map((event) => event.name)).toContain('parent');
  expect(events(file).map((event) => event.name)).toContain('child');
});

test('a new outermost process truncates a trace left by an earlier run', () => {
  const file = join(dir, 'trace.json');
  writeFileSync(file, '[\n{"name":"stale","ph":"X","ts":1,"dur":1,"pid":1,"tid":1},\n');
  process.env.STIM_TRACE = file;
  trace.span('fresh', () => {});
  expect(events(file).map((event) => event.name)).not.toContain('stale');
});

test('an unwritable STIM_TRACE path never throws into the command', () => {
  writeFileSync(join(dir, 'file'), '');
  process.env.STIM_TRACE = join(dir, 'file', 'trace.json');
  expect(trace.span('a', () => 3)).toBe(3);
  expect(trace.enabled()).toBe(false);
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
  ]);
});

test('redactArgv bounds the argument count and length', () => {
  const out = redactArgv(Array.from({ length: 100 }, () => 'x'.repeat(400)));
  expect(out).toHaveLength(61);
  expect(out[0]).toHaveLength(243);
  expect(out.at(-1)).toBe('[+40 more]');
});

test('redactCommandLine hides secret flags and assignments in a shell command', () => {
  expect(redactCommandLine("TOKEN=abc eas build --token 'a b' --platform ios --api-key=k")).toBe(
    'TOKEN=[redacted] eas build --token [redacted] --platform ios --api-key=[redacted]',
  );
});
