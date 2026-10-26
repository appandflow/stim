import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

test('with STIM_TRACE unset every call runs its function and nothing is written or exported', async () => {
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    expect(trace.enabled()).toBe(false);
    expect(trace.span('a', () => 1)).toBe(1);
    expect(await trace.spanAsync('b', async () => 2)).toBe(2);
    trace.phases('p').enter('x');
    trace.mark('m');
    trace.command('stim x');
  } finally {
    process.chdir(cwd);
  }
  expect(readdirSync(dir)).toEqual([]);
  expect(process.env.STIM_TRACE_OWNER).toBeUndefined();
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

test('a process that is not a command appends to an existing trace and starts a missing one with its bracket', () => {
  const file = join(dir, 'trace.json');
  writeFileSync(file, '[\n{"name":"parent","ph":"X","ts":1,"dur":1,"pid":1,"tid":1},\n');
  process.env.STIM_TRACE = file;
  trace.span('child', () => {});
  expect(events(file).map((event) => event.name)).toEqual(expect.arrayContaining(['parent', 'child']));
  rmSync(file);
  process.env.STIM_TRACE = join(dir, 'other.json');
  trace.span('alone', () => {});
  expect(events(join(dir, 'other.json')).map((event) => event.name)).toContain('alone');
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

const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl';

test.each<[string, string, string[], string[]]>([
  [
    'a header attached to a short flag is scrubbed in place and the next argument is kept',
    'curl',
    ['-HAuthorization:Bearer abcdefghijkl12345', 'https://example.com/x'],
    ['-HAuthorization:[redacted]', 'https://example.com/x'],
  ],
  [
    'an api key header attached to a short flag',
    'curl',
    ['-HX-Api-Key:k123', 'https://example.com/x'],
    ['-HX-Api-Key:[redacted]', 'https://example.com/x'],
  ],
  [
    'curl -u takes user:password',
    'curl',
    ['-u', 'user:hunter2', 'https://example.com'],
    ['-u', '[redacted]', 'https://example.com'],
  ],
  [
    'curl -u with the credential attached',
    'curl',
    ['-uuser:hunter2', 'https://example.com'],
    ['-u[redacted]', 'https://example.com'],
  ],
  ['curl --user with =', 'curl', ['--user=user:hunter2'], ['--user=[redacted]']],
  ['curl --proxy-user', 'curl', ['--proxy-user', 'u:p'], ['--proxy-user', '[redacted]']],
  [
    'security import -P takes the p12 passphrase',
    'security',
    ['import', 'x.p12', '-P', 'hunter2', '-k', 'build.keychain'],
    ['import', 'x.p12', '-P', '[redacted]', '-k', 'build.keychain'],
  ],
  [
    'security unlock-keychain -p takes the keychain password',
    'security',
    ['unlock-keychain', '-p', 'hunter2', 'build.keychain'],
    ['unlock-keychain', '-p', '[redacted]', 'build.keychain'],
  ],
  ['a JWT', 'tool', [jwt], ['[redacted]']],
  ['a Stripe live key', 'tool', ['sk_live_abcdefghijklmnop1234'], ['[redacted]']],
  ['a Stripe test key', 'tool', ['sk_test_abcdefghijklmnop1234'], ['[redacted]']],
  ['a Google API key', 'tool', ['AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'], ['[redacted]']],
  ['a GitLab token', 'tool', ['glpat-abcdefghij1234567890'], ['[redacted]']],
  ['an npm token', 'tool', [`npm_${'a1B2'.repeat(9)}`], ['[redacted]']],
  [
    'a password that contains @ in a URL',
    'git',
    ['clone', 'https://user:pa@ss@host/x.git'],
    ['clone', 'https://[redacted]@host/x.git'],
  ],
  ['a token shape inside a longer argument', 'tool', [`--header=X: ${jwt}`], [`--header=X: [redacted]`]],
])('redactArgv hides %s', (_name, program, args, expected) => {
  expect(redactArgv(args, [], program)).toEqual(expected);
});

test.each<[string, string, string[]]>([
  ['security find-identity -p names a policy', 'security', ['find-identity', '-v', '-p', 'codesigning']],
  ['security find-certificate -p prints PEM', 'security', ['find-certificate', '-p', '-c', 'Apple Development']],
  ['mkdir -p takes a path', 'mkdir', ['-p', '/Users/me/build/out']],
  ['ssh -p takes a port', 'ssh', ['-p', '2222', 'host']],
  ['git push -u sets an upstream', 'git', ['push', '-u', 'origin', 'main']],
  [
    'curl without credentials',
    'curl',
    ['-sS', '--max-time', '5', '-HContent-Type:application/json', 'https://example.com/a@b'],
  ],
  ['version strings', 'node', ['--version', '22.12.0', 'v1.2.3-rc.1', '2026.10.23']],
  ['dotted identifiers', 'tool', ['com.example.app', 'Library/Developer/Xcode/DerivedData/App-abc.def.ghi']],
  ['paths with token-like words', 'tool', ['/Users/me/.cache/glpat', './node_modules/.bin/npm_run', 'sk_live']],
  ['a URL with a path but no credentials', 'git', ['clone', 'https://github.com/org/repo.git']],
  ['an scp-style remote', 'git', ['clone', 'git@github.com:org/repo.git']],
  ['a URL whose path contains @', 'tool', ['https://example.com/@scope/pkg']],
])('redactArgv keeps %s', (_name, program, args) => {
  expect(redactArgv(args, [], program)).toEqual(args);
});

test('redactArgv treats an argument named like an object property as plain text', () => {
  expect(redactArgv(['constructor', '-p', 'x'], [], 'security')).toEqual(['constructor', '-p', 'x']);
  expect(redactArgv(['length', 'x'], [], 'constructor')).toEqual(['length', 'x']);
});

test('redactArgv ignores the credential flags of a program it does not list', () => {
  expect(redactArgv(['-u', 'user:pw'])).toEqual(['-u', 'user:pw']);
  expect(redactArgv(['-u', 'user:pw'], [], 'docker')).toEqual(['-u', 'user:pw']);
});

test('redactArgv finishes quickly on a huge argument made of flag-like text', () => {
  const started = performance.now();
  redactArgv([`--${'ab-'.repeat(60_000)}`, `-${'-'.repeat(20_000)}`]);
  redactCommandLine(`--${'ab-'.repeat(60_000)}`);
  expect(performance.now() - started).toBeLessThan(2000);
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
