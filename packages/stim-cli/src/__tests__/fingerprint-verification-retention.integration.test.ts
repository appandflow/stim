import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceName } from '@stim-cli/core';
import { fingerprintPendingVerifyDir } from '@stim-cli/core/state';
import { buildClaimRoot } from '../engine-store/claims.ts';
import { NATIVE_RUN_LOCK } from '../engine/native-run.ts';
import { workspaceProcessLockPath } from '../engine/workspace-process-lock.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { workspaceEnv } from '../fingerprint/env.ts';
import { writeWorkspaceEnv } from '../fingerprint/index-store.ts';
import { runFingerprintVerification } from '../fingerprint-precompute.ts';
import { readClaimSet } from '../ownership-claim.ts';
import { captureProcessIdentity, inspectProcessIdentity } from '../process-identity.ts';
import { testContext } from './_context.ts';

const selected = vi.hoisted(() => ({ root: '' }));
vi.mock('../daemon/engine-switch.ts', async (original) => ({
  ...(await original<typeof import('../daemon/engine-switch.ts')>()),
  ownStoreEngine: () => ({ root: selected.root, build: '0123456789ab' }),
}));

test.skipIf(process.platform === 'win32')(
  'a killed verification retains its workspace claim and releases the selected engine claim while the evaluator survives',
  { timeout: 30_000 },
  async () => {
    const area = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fp-verify-owned-')));
    const root = join(area, 'project');
    const home = join(area, 'home');
    const temporary = join(area, 'tmp');
    selected.root = join(area, 'engine');
    const tree = join(selected.root, '0123456789ab');
    for (const dir of [root, home, temporary, join(tree, 'dist')]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(tree, 'dist', 'cli.mjs'), '');
    writeFileSync(join(tree, '.stim-manifest.json'), JSON.stringify({ format: 1, build: '0123456789ab' }));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', dependencies: { 'react-native': '*' } }),
    );
    const cli = join(root, 'node_modules', '@react-native-community', 'cli');
    const config = join(root, 'node_modules', '@react-native-community', 'cli-config');
    const reactNative = join(root, 'node_modules', 'react-native');
    for (const dir of [cli, config, reactNative]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(cli, 'package.json'), JSON.stringify({ name: '@react-native-community/cli', version: '1.0.0' }));
    writeFileSync(
      join(config, 'package.json'),
      JSON.stringify({ name: '@react-native-community/cli-config', version: '1.0.0', main: 'index.js' }),
    );
    writeFileSync(
      join(reactNative, 'package.json'),
      JSON.stringify({ name: 'react-native', version: '0.81.0', main: 'index.js' }),
    );
    writeFileSync(join(reactNative, 'index.js'), 'module.exports = {};');
    const marker = join(root, 'evaluator-pid');
    writeFileSync(
      join(config, 'index.js'),
      `
      exports.loadConfigAsync = () => {
        require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
        return { platforms: { ios: {} }, project: { ios: { sourceDir: 'ios' } } };
      };
    `,
    );
    vi.stubEnv('STIM_HOME', home);
    vi.stubEnv('STIM_TMPDIR', temporary);
    vi.stubEnv('STIM_ENGINE_ROOT', selected.root);
    const env = { PATH: process.env.PATH, STIM_HOME: home, STIM_TMPDIR: temporary, STIM_ENGINE_ROOT: selected.root };
    const controller = new AbortController();
    const context = testContext({ home, projectRoot: root, env, signal: controller.signal });
    const directory = fingerprintPendingVerifyDir();
    mkdirSync(directory, { recursive: true });
    const digest = writeWorkspaceEnv(root, workspaceEnv(env));
    writeFileSync(
      join(directory, 'pending.json'),
      JSON.stringify({
        root,
        target: { platform: 'ios' },
        embedMode: 'development',
        hash: 'a'.repeat(64),
        inputs: [],
        envRef: { id: 'fixture', digest },
      }),
    );
    const real = getExecutor();
    const children: { outer: { pid: number; processToken: string } | null } = { outer: null };
    setExecutor({
      ...real,
      runFileAsync: (file, args, options) =>
        real.runFileAsync(file, args, {
          ...options,
          onSpawn: (child) => {
            options.onSpawn?.(child);
            if (args.some((arg: string) => arg.endsWith('fingerprint-precompute.mjs')) && child.pid) {
              const identity = captureProcessIdentity(child.pid);
              if (identity.ok) children.outer = { pid: child.pid, processToken: identity.token };
            }
          },
        }),
    });
    const running = runFingerprintVerification(context, { root, platform: 'ios', pendingFile: 'pending.json' });
    const settled = running.catch((error: unknown) => error);
    let evaluator: { pid: number; processToken: string } | null = null;
    let remove = false;
    let testFailure: { error: unknown } | undefined;
    try {
      const until = Date.now() + 10_000;
      while ((!children.outer || !existsSync(marker)) && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 25));
      const outer = children.outer;
      if (!outer || !existsSync(marker)) throw new Error('verification evaluator did not start');
      const pid = Number(readFileSync(marker, 'utf8'));
      const identity = captureProcessIdentity(pid);
      if (!identity.ok) throw new Error('evaluator identity unavailable');
      evaluator = { pid, processToken: identity.token };
      if (inspectProcessIdentity(outer) !== 'same') throw new Error('verification child identity changed');
      process.kill(outer.pid, 'SIGKILL');
      expect(await settled).toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE', reportCleanup: true });
      expect(inspectProcessIdentity(evaluator)).toBe('same');
      const native = workspaceProcessLockPath(join(home, 'workspaces', workspaceName(root)), NATIVE_RUN_LOCK, true);
      expect(readClaimSet(native).live).toEqual(
        expect.arrayContaining([expect.objectContaining({ childDeclared: true })]),
      );
      expect(readClaimSet(buildClaimRoot(selected.root, '0123456789ab'))).toMatchObject({ live: [], unresolved: [] });
    } catch (error) {
      testFailure = { error };
    } finally {
      controller.abort();
      if (children.outer && inspectProcessIdentity(children.outer) === 'same')
        process.kill(children.outer.pid, 'SIGKILL');
      await settled;
      if (!evaluator && existsSync(marker)) {
        const pid = Number(readFileSync(marker, 'utf8'));
        const identity = captureProcessIdentity(pid);
        if (identity.ok) evaluator = { pid, processToken: identity.token };
      }
      if (evaluator && inspectProcessIdentity(evaluator) === 'same') process.kill(-evaluator.pid, 'SIGKILL');
      if (evaluator) {
        const until = Date.now() + 5000;
        while (inspectProcessIdentity(evaluator) === 'same' && Date.now() < until)
          await new Promise((resolve) => setTimeout(resolve, 25));
        const outerStatus = children.outer ? inspectProcessIdentity(children.outer) : 'unknown';
        remove =
          inspectProcessIdentity(evaluator) === 'gone' && (outerStatus === 'gone' || outerStatus === 'different');
      }
      resetExecutor();
      vi.unstubAllEnvs();
      if (remove) rmSync(area, { recursive: true, force: true });
    }
    if (!remove) throw new Error(`Could not verify fixture cleanup; retained ${area}.`);
    if (testFailure) throw testFailure.error;
  },
);
