import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FingerprintSource } from '@expo/fingerprint';
import { readFingerprintMemo } from '@stim-cli/core/state';
import type { ProjectFingerprint } from '../cache/build-cache.ts';
import { FINGERPRINT_MEMO_TTL_MS, memoizedFingerprint, type BackgroundFingerprint } from '../cache/fingerprint-memo.ts';
import { testContext } from './_context.ts';

const MOBILE_EXPO = join(import.meta.dirname, '..', '..', '..', '..', 'apps', 'mobile', 'node_modules', 'expo');

let scratch: string;
let root: string;
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fingerprint-memo-')));
  vi.stubEnv('STIM_HOME', join(scratch, 'home'));
  root = join(scratch, 'app');
  mkdirSync(join(root, 'ios', 'App'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"app"}');
  writeFileSync(join(root, '.gitignore'), 'build\n');
  writeFileSync(join(root, 'ios', 'App', 'AppDelegate.swift'), 'class AppDelegate {}');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

const SOURCES: FingerprintSource[] = [
  { type: 'file', filePath: '.gitignore', reasons: ['bareGitIgnore'], hash: 'g1' },
  { type: 'dir', filePath: 'ios', reasons: ['bareNativeDir'], hash: 'i1' },
];

/** Recording refuses inputs changed within 2 s of the fingerprint's start, so the tests run on a clock past that. */
const later =
  (ms = 0) =>
  () =>
    Date.now() + 10_000 + ms;

function counting(hash = 'aaaa1111') {
  const calls: string[] = [];
  const fingerprint = async (projectRoot: string): Promise<ProjectFingerprint> => {
    calls.push(projectRoot);
    return { hash, sources: SOURCES };
  };
  return { calls, fingerprint };
}

const agreeing: BackgroundFingerprint = async () => ({ hash: 'aaaa1111', sources: SOURCES });

async function lookup(
  fingerprint: (projectRoot: string) => Promise<ProjectFingerprint>,
  { now = later(), background = agreeing, consult = true } = {},
) {
  return memoizedFingerprint(
    root,
    { platform: 'ios' },
    { consult, record: true, operation: testContext({ cwd: root }), fingerprint, background, now },
  );
}

const memoVolume = process.platform === 'darwin' || process.platform === 'linux';

describe.runIf(memoVolume)('on a volume with nanosecond timestamps', () => {
  test('an unchanged tree reuses the recorded fingerprint without running it, and checks it in the background', async () => {
    const first = counting();
    expect((await lookup(first.fingerprint)).memoHit).toBe(false);

    const second = counting('bbbb2222');
    let checked = 0;
    const result = await lookup(second.fingerprint, {
      background: async () => {
        checked += 1;
        return { hash: 'aaaa1111', sources: SOURCES };
      },
    });

    expect(second.calls).toEqual([]);
    expect(result.memoHit).toBe(true);
    expect(result.fingerprint?.hash).toBe('aaaa1111');
    expect(result.fingerprint?.sources).toEqual(SOURCES);
    expect(await result.check?.settle()).toMatchObject({ status: 'confirmed' });
    expect(checked).toBe(1);
    expect(readFingerprintMemo(root, 'ios')).not.toBe(null);
  });

  test.each([
    [
      'an edited hashed file',
      () => writeFileSync(join(root, 'ios', 'App', 'AppDelegate.swift'), 'class AppDelegate2 {}'),
    ],
    ['a file added to a walked directory', () => writeFileSync(join(root, 'ios', 'App', 'Extra.swift'), '')],
    [
      'a dependency install',
      () => {
        mkdirSync(join(root, 'node_modules'), { recursive: true });
        writeFileSync(join(root, 'node_modules', '.modules.yaml'), 'layoutVersion: 5');
      },
    ],
    ['a changed lockfile', () => writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9')],
    ['a new local module under modules/', () => mkdirSync(join(root, 'modules', 'my-module'), { recursive: true })],
    ['a new patches/ directory', () => mkdirSync(join(root, 'patches'))],
    [
      'a new app-level react-native.config.js',
      () => writeFileSync(join(root, 'react-native.config.js'), 'module.exports = {};'),
    ],
  ])('%s forces a full fingerprint', async (_name, change) => {
    await lookup(counting().fingerprint);
    change();

    const next = counting('cccc3333');
    const result = await lookup(next.fingerprint, { now: later(5_000) });

    expect(next.calls).toEqual([root]);
    expect(result.memoHit).toBe(false);
    expect(result.fingerprint?.hash).toBe('cccc3333');
  });

  test('a changed environment forces a full fingerprint, but the run id of each CLI run does not', async () => {
    vi.stubEnv('STIM_RUN_ID', 'run-1');
    await lookup(counting().fingerprint);
    vi.stubEnv('STIM_RUN_ID', 'run-2');
    expect((await lookup(counting().fingerprint)).memoHit).toBe(true);
    vi.stubEnv('APP_VARIANT', 'production');

    const next = counting();
    expect((await lookup(next.fingerprint)).memoHit).toBe(false);
    expect(next.calls).toEqual([root]);
  });

  test('a check that has not confirmed leaves no record, so a run that ends before it settles cannot reuse it', async () => {
    await lookup(counting().fingerprint);
    const hit = await lookup(counting().fingerprint, {
      background: (_operation, _root, _target, signal) =>
        new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
    });
    expect(hit.memoHit).toBe(true);
    expect(readFingerprintMemo(root, 'ios')).toBe(null);

    hit.check?.cancel();
    expect(await hit.check?.settle()).toMatchObject({ status: 'failed' });
    expect(readFingerprintMemo(root, 'ios')).toBe(null);
  });

  test('a background fingerprint that disagrees drops the record, so the next run computes in full', async () => {
    await lookup(counting().fingerprint);
    const hit = await lookup(counting().fingerprint, {
      background: async () => ({ hash: 'dddd4444', sources: SOURCES }),
    });

    expect(await hit.check?.settle()).toEqual({ status: 'stale', recorded: 'aaaa1111', current: 'dddd4444' });
    expect(readFingerprintMemo(root, 'ios')).toBe(null);
    const next = counting();
    await lookup(next.fingerprint);
    expect(next.calls).toEqual([root]);
  });

  test('a record older than 24 hours is not used', async () => {
    await lookup(counting().fingerprint);

    const next = counting();
    const result = await lookup(next.fingerprint, { now: later(FINGERPRINT_MEMO_TTL_MS + 1) });

    expect(result.memoHit).toBe(false);
    expect(next.calls).toEqual([root]);
  });

  test('a lookup that does not consult the memo, as with --no-build-cache, always computes in full', async () => {
    await lookup(counting().fingerprint);

    const next = counting();
    expect((await lookup(next.fingerprint, { consult: false })).memoHit).toBe(false);
    expect(next.calls).toEqual([root]);
  });

  test("an input changed within the racy window of the fingerprint's start is never recorded", async () => {
    await lookup(counting().fingerprint, { now: () => Date.now() });
    expect(readFingerprintMemo(root, 'ios')).toBe(null);
  });

  test('the installed @expo/fingerprint config loader evaluates the app config, and a config edit misses', async () => {
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    symlinkSync(realpathSync(MOBILE_EXPO), join(root, 'node_modules', 'expo'));
    const config = (name: string) =>
      writeFileSync(join(root, 'app.config.js'), `module.exports = { name: '${name}', slug: 'memo' };`);
    config('first');
    await lookup(counting().fingerprint, { now: later(5_000) });

    const same = counting();
    expect((await lookup(same.fingerprint, { now: later(5_000) })).memoHit).toBe(true);
    expect(same.calls).toEqual([]);

    config('second');
    const edited = counting();
    expect((await lookup(edited.fingerprint, { now: later(5_000) })).memoHit).toBe(false);
    expect(edited.calls).toEqual([root]);
  }, 60_000);
});
