import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { EMBEDDED_PROFILE, findSigningIdentities, readEmbeddedProfile, resealBundle } from '../engine/ios-signing.ts';

let dir: string;
let appPath: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stim-signing-async-'));
  appPath = join(dir, 'Fixture.app');
  mkdirSync(appPath);
  writeFileSync(join(appPath, EMBEDDED_PROFILE), 'fixture CMS');
});

afterEach(() => {
  resetExecutor();
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

test('profile decoding yields to timers and honors an explicitly omitted host environment value', async () => {
  const real = getExecutor();
  const profile = readFileSync(new URL('./fixtures/ios-signing/development-profile.plist', import.meta.url), 'utf8');
  const hostValue = process.env.STIM_SIGNING_HOST_ONLY;
  process.env.STIM_SIGNING_HOST_ONLY = 'host';
  let timerRan = false;
  const timer = setTimeout(() => {
    timerRan = true;
  }, 10);
  setExecutor({
    runFileAsync(_file, _args, opts) {
      return real.runFileAsync(
        process.execPath,
        [
          '-e',
          `
        if (process.env.STIM_SIGNING_HOST_ONLY !== undefined || process.env.STIM_SIGNING_CLIENT !== 'client') process.exit(1);
        setTimeout(() => process.stdout.write(${JSON.stringify(profile)}), 100);
      `,
        ],
        opts,
      );
    },
  });
  try {
    const read = await readEmbeddedProfile(appPath, { env: { STIM_SIGNING_CLIENT: 'client' } });
    expect(read.profile?.uuid).toBe('9d1f8f6a-0e0c-4c33-9a1f-2b6a5c7d8e90');
    expect(timerRan).toBe(true);
  } finally {
    clearTimeout(timer);
    if (hostValue === undefined) delete process.env.STIM_SIGNING_HOST_ONLY;
    else process.env.STIM_SIGNING_HOST_ONLY = hostValue;
  }
});

test.each(['profile', 'identities'] as const)(
  'cancelling the %s reader rejects instead of returning unavailable signing data',
  async (stage) => {
    const real = getExecutor();
    const controller = new AbortController();
    setExecutor({
      runFileAsync(_file, _args, opts) {
        return real.runFileAsync(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
          ...opts,
          onSpawn(child) {
            children.push(child);
            opts.onSpawn?.(child);
            controller.abort();
          },
        });
      },
    });
    const pending =
      stage === 'profile'
        ? readEmbeddedProfile(appPath, { signal: controller.signal })
        : findSigningIdentities({ signal: controller.signal });
    await expect(pending).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
    expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
  },
);

test.each(['preserve', 'extract', 'fallback', 'verify'] as const)(
  'cancelling codesign during %s stops the child without starting another signing attempt',
  async (stage) => {
    const real = getExecutor();
    const controller = new AbortController();
    const attempts: string[] = [];
    let entitlementsPath: string | undefined;
    setExecutor({
      runFileAsync(_file, args, opts) {
        const current = args.includes('--verify')
          ? 'verify'
          : args.includes('-d')
            ? 'extract'
            : args.some((arg: string) => arg.startsWith('--preserve-metadata='))
              ? 'preserve'
              : 'fallback';
        attempts.push(current);
        if (current === 'preserve' && (stage === 'extract' || stage === 'fallback'))
          return Promise.reject(new Error('metadata preservation unavailable'));
        if (current === 'extract' && stage === 'fallback')
          return Promise.resolve('<plist version="1.0"><dict><key>get-task-allow</key><true/></dict></plist>');
        if (current !== stage) return Promise.resolve('');
        if (current === 'fallback') entitlementsPath = args[args.indexOf('--entitlements') + 1];
        return real.runFileAsync(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
          ...opts,
          onSpawn(child) {
            children.push(child);
            opts.onSpawn?.(child);
            controller.abort();
          },
        });
      },
    });
    await expect(
      resealBundle({ appPath, identity: { name: '-', sha1: '' }, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
    expect(attempts.at(-1)).toBe(stage);
    expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
    if (stage === 'fallback') {
      assert(entitlementsPath);
      assert.equal(existsSync(dirname(entitlementsPath)), false);
    }
  },
);
