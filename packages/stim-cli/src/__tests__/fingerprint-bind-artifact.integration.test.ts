import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withAmbientContext } from '@stim-cli/core';
import { acquireArtifact, type ArtifactAdapter, type ArtifactRequest } from '../engine/acquire-artifact.ts';
import { acquireBuildLock, releaseBuildLock, waitForBuild } from '../engine/build-lock.ts';
import { acquireBuildSlot, releaseBuildSlot } from '../engine/build-slots.ts';
import { operationState } from '../engine/operation-state.ts';
import { verifyHit } from '../fingerprint/verify.ts';
import type { Fingerprint } from '../fingerprint/evaluate.ts';
import { readClaimSet, releaseClaim, type ClaimHandle } from '../ownership-claim.ts';
import { testContext } from './_context.ts';

const fixture = vi.hoisted((): { root: string; pause: (() => Promise<void>) | null } => ({ root: '', pause: null }));
vi.mock('../daemon/engine-switch.ts', async (original) => ({
  ...(await original<typeof import('../daemon/engine-switch.ts')>()),
  ownStoreEngine: () => ({ root: fixture.root, build: '0123456789ab' }),
}));
vi.mock('../engine-store/locks.ts', async (original) => {
  const actual = await original<typeof import('../engine-store/locks.ts')>();
  return {
    ...actual,
    takeLock: async (...args: Parameters<typeof actual.takeLock>) => {
      const lock = await actual.takeLock(...args);
      if (lock && fixture.pause) await fixture.pause();
      return lock;
    },
  };
});

test.skipIf(process.platform === 'win32')(
  'successful acquisition retains real build claims while a delayed engine admission starts verification',
  { timeout: 120_000 },
  async () => {
    const area = mkdtempSync(join(tmpdir(), 'stim-fp-bind-artifact-'));
    const root = join(area, 'project');
    const home = join(area, 'home');
    fixture.root = join(area, 'engine');
    const tree = join(fixture.root, '0123456789ab');
    const cli = join(root, 'node_modules', '@react-native-community', 'cli');
    const config = join(root, 'node_modules', '@react-native-community', 'cli-config');
    const rn = join(root, 'node_modules', 'react-native');
    for (const dir of [cli, config, rn, home, join(tree, 'dist')]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(tree, 'dist', 'cli.mjs'), '');
    writeFileSync(join(tree, '.stim-manifest.json'), JSON.stringify({ format: 1, build: '0123456789ab' }));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', dependencies: { 'react-native': '*' } }),
    );
    writeFileSync(join(cli, 'package.json'), JSON.stringify({ name: '@react-native-community/cli', version: '1.0.0' }));
    writeFileSync(
      join(config, 'package.json'),
      JSON.stringify({ name: '@react-native-community/cli-config', version: '1.0.0', main: 'index.js' }),
    );
    writeFileSync(
      join(rn, 'package.json'),
      JSON.stringify({ name: 'react-native', version: '0.81.0', main: 'index.js' }),
    );
    writeFileSync(join(rn, 'index.js'), 'module.exports = {};');
    const entered = join(area, 'entered');
    const finish = join(area, 'finish');
    writeFileSync(
      join(config, 'index.js'),
      `exports.loadConfigAsync = () => { const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(entered)}, 'yes'); while (!fs.existsSync(${JSON.stringify(finish)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); return { platforms: { ios: {} }, project: { ios: { sourceDir: 'ios' } } }; };`,
    );
    const controller = new AbortController();
    const context = testContext({
      home,
      projectRoot: root,
      cwd: root,
      env: { PATH: process.env.PATH, STIM_HOME: home },
      signal: controller.signal,
    });
    let resumeBind!: () => void;
    let bound!: () => void;
    const admission = new Promise<void>((resolve) => {
      resumeBind = resolve;
    });
    const boundPromise = new Promise<void>((resolve) => {
      bound = resolve;
    });
    fixture.pause = async () => {
      fixture.pause = null;
      bound();
      await admission;
    };
    const hit: Fingerprint = {
      schema: 2,
      hash: 'a'.repeat(64),
      platform: 'ios',
      native: 'tracked',
      inputs: [],
      nativePackages: [],
      configModules: [],
      config: null,
      portable: true,
      opaque: [],
      from: 'index',
      fingerprintConfigKeys: [],
    };
    const check = verifyHit({ root, target: { platform: 'ios' }, embedMode: 'development' }, hit, {
      env: context.env,
      passes: false,
      operation: context,
    });
    assert(check);
    let lock: ClaimHandle | undefined;
    let slot: ClaimHandle | undefined;
    const request: ArtifactRequest = {
      root,
      logFile: join(area, 'build.log'),
      deps: {
        acquireBuildLock: (options) => {
          const result = acquireBuildLock(options);
          lock = result.claim;
          return result;
        },
        releaseBuildLock,
        waitForBuild,
        acquireBuildSlot: async (options) => {
          const result = await acquireBuildSlot({ ...options, engine: null });
          slot = result.claim;
          return result;
        },
        releaseBuildSlot,
        now: Date.now,
      },
    };
    const adapter: ArtifactAdapter<string, null, null, never> = {
      platform: 'ios',
      command: 'stim ios',
      refuse: () => null,
      releaseFailed: () => {},
      temporaryReleaseFailed: () => {},
      settleBeforeRelease: async () => {
        await check.join();
      },
      lifecycle: (run) => ({
        resolve: async () => ({ kind: 'miss' }),
        claim: async () => {
          await run.claimSharedBuild({
            key: 'key',
            fingerprint: 'fingerprint',
            phase: () => {},
            waitingOn: () => {},
            warn: () => {},
            out: () => {},
          });
          return null;
        },
        reuse: async () => null,
        build: {
          admit: async () => {
            await run.takeBuildSlot({ max: 1 });
          },
          prepare: async () => null,
          revalidate: async () => null,
          compile: async () => {
            resumeBind();
            return 'built';
          },
          validate: async () => 'uncacheable',
          store: async () => {},
        },
      }),
    };
    let running: ReturnType<typeof acquireArtifact<string, null, null, never>> | undefined;
    try {
      await boundPromise;
      running = withAmbientContext(context, () => acquireArtifact(adapter, request));
      const deadline = Date.now() + 20_000;
      while (!existsSync(entered) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(existsSync(entered)).toBe(true);
      assert(lock);
      assert(slot);
      for (const claim of [lock, slot]) {
        expect(readClaimSet(claim.root).live).toEqual(
          expect.arrayContaining([expect.objectContaining({ claimId: claim.claimId, childDeclared: true })]),
        );
        expect(operationState(context).declaring.has(claim)).toBe(true);
      }
      writeFileSync(finish, 'yes');
      const result = await running;
      expect(result.ok).toBe(true);
      if (result.ok) result.release();
      for (const claim of [lock, slot])
        expect(readClaimSet(claim.root).live.some((entry) => entry.claimId === claim.claimId)).toBe(false);
    } finally {
      fixture.pause = null;
      resumeBind();
      writeFileSync(finish, 'yes');
      controller.abort();
      await check.join().catch(() => {});
      const result = await running?.catch(() => null);
      if (result?.ok) result.release();
      if (lock) releaseClaim(lock);
      if (slot) releaseClaim(slot);
      rmSync(area, { recursive: true, force: true });
    }
  },
);
