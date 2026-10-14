import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withAmbientContext, type StimContext } from '@stim-cli/core';
import * as fingerprint from '@expo/fingerprint';
import { fingerprintProject } from '../cache/build-cache.ts';
import { readDoctorFingerprint } from '../doctor-fingerprint.ts';
import { detectFingerprintParity } from '../diagnostics/doctor.ts';
import { getExecutor } from '../exec.ts';
import { git } from '../workspace/git.ts';
import { runReport } from '../report-runtime.ts';

let scratch: string;
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'stim-doctor-fingerprint-')));
  vi.stubEnv('STIM_HOME', join(scratch, 'home'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

function project(): string {
  const root = join(scratch, 'app');
  mkdirSync(join(root, 'ios'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'fingerprint-proof',
      version: '1.0.0',
      private: true,
      dependencies: { 'react-native': '0.83.0' },
    }),
  );
  writeFileSync(join(root, 'ios', 'Podfile'), "platform :ios, '13.0'\n");
  return root;
}

function context(root: string, signal: AbortSignal): StimContext {
  return {
    home: join(scratch, 'home'),
    buildCache: null,
    projectRoot: root,
    cwd: root,
    runId: 'fingerprint-proof',
    signal,
    env: { ...process.env, HOME: scratch, USERPROFILE: scratch, STIM_HOME: join(scratch, 'home') },
    output: () => {},
  };
}

test('the bounded helper preserves the real SDK fingerprint and observes changed native inputs', async () => {
  const root = project();
  const operation = context(root, new AbortController().signal);
  const direct = await fingerprintProject(root, {
    platform: 'ios',
    createFingerprint: (projectRoot, options) =>
      fingerprint.createFingerprintAsync(projectRoot, { ...options, useRNCoreAutolinkingFromExpo: true }),
  });
  const report = await runReport(operation, (request) =>
    withAmbientContext(request, () => readDoctorFingerprint(request, { root, platform: 'ios', cold: true })),
  );
  expect(report).not.toBeNull();
  expect(report?.hash).toBe(direct?.hash);
  expect(report?.sources).toEqual(direct?.sources);
  writeFileSync(join(root, 'ios', 'Podfile'), "platform :ios, '14.0'\n");
  const changed = await runReport(operation, (request) =>
    withAmbientContext(request, () => readDoctorFingerprint(request, { root, platform: 'ios', cold: true })),
  );
  expect(changed?.hash).not.toBe(report?.hash);
}, 20_000);

test('cancelling cold parity inspection reaps its SDK probe and removes its locked temporary worktree', async () => {
  const root = project();
  git(root, ['init', '-q'], { write: true });
  git(root, ['add', '.'], { write: true });
  git(
    root,
    [
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ],
    { write: true },
  );
  const before = git(root, ['worktree', 'list', '--porcelain']);
  const controller = new AbortController();
  const operation = context(root, controller.signal);
  const executor = getExecutor();
  const original = executor.runFileAsync.bind(executor);
  let pid: number | undefined;
  const read = vi.spyOn(executor, 'runFileAsync').mockImplementation((file, args, options) => {
    if (file === process.execPath && args[0]?.endsWith('doctor-fingerprint.mjs')) {
      return original(file, ['-e', 'console.log("ready"); setTimeout(() => {}, 3000)'], {
        ...options,
        onSpawn: (child) => {
          pid = child.pid;
          child.stdout?.once('data', () => {
            const temporary = git(root, ['worktree', 'list', '--porcelain'])
              .split('\n')
              .filter((line) => line.startsWith('worktree '))
              .map((line) => line.slice('worktree '.length))
              .find((path) => realpathSync.native(path) !== realpathSync.native(root));
            if (!temporary) throw new Error('The controlled temporary worktree was not registered');
            git(root, ['worktree', 'lock', '--reason', 'initializing fixture', temporary], { write: true });
            controller.abort();
          });
        },
      });
    }
    return original(file, args, options);
  });
  try {
    const failure = await runReport(operation, (request) =>
      withAmbientContext(request, () => detectFingerprintParity(root, { platform: 'ios', operation: request })),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBe(controller.signal.reason);
    if (pid === undefined) throw new Error('The controlled SDK probe did not start');
    const ownPid = pid;
    expect(() => process.kill(ownPid, 0)).toThrow(/ESRCH/);
    expect(git(root, ['worktree', 'list', '--porcelain'])).toBe(before);
  } finally {
    read.mockRestore();
  }
}, 20_000);
