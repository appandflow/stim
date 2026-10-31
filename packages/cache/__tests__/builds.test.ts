import { execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTieredBuild, storeTieredBuild } from '../builds.ts';
import type { BuildCacheCapability, BuildCacheTarget } from '../provider.ts';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'stim-cache-builds-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function artifact(name: string): string {
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'app.apk');
  writeFileSync(path, name);
  return path;
}

const target: BuildCacheTarget = { projectRoot: '/repo/app', platform: 'android', key: 'fingerprint-debug-sim' };

function capability(overrides: Partial<BuildCacheCapability> = {}) {
  const calls = { resolve: 0, store: 0 };
  const inputs: { resolve: unknown[]; store: unknown[] } = { resolve: [], store: [] };
  const cap: BuildCacheCapability = {
    resolve: (input) => {
      calls.resolve += 1;
      inputs.resolve.push(input);
      return overrides.resolve ? overrides.resolve(input) : null;
    },
    store: (input) => {
      calls.store += 1;
      inputs.store.push(input);
      return overrides.store ? overrides.store(input) : undefined;
    },
  };
  return { cap, calls, inputs };
}

test('a provider miss, timeout, failure, or missing path returns a miss', async () => {
  const local = capability({ resolve: () => null });

  const miss = await resolveTieredBuild({
    local: local.cap,
    loadProvider: () => ({ provider: { builds: capability({ resolve: () => null }).cap } }),
    target,
    destinationDir: workDir,
  });
  expect(miss).toBeNull();

  const timedOutWarnings: string[] = [];
  const timedOut = await resolveTieredBuild({
    local: local.cap,
    loadProvider: () => ({
      name: 'team-cache',
      provider: { builds: capability({ resolve: () => new Promise(() => {}) }).cap },
    }),
    target,
    destinationDir: workDir,
    timeoutMs: 5,
    warn: (_code, message) => timedOutWarnings.push(message),
  });
  expect(timedOut).toBeNull();
  expect(timedOutWarnings[0]).toBe('team-cache did not answer within 5ms; building instead');

  const failureWarnings: string[] = [];
  const failed = await resolveTieredBuild({
    local: local.cap,
    loadProvider: () => ({
      name: 'team-cache',
      provider: {
        builds: capability({
          resolve: () => {
            throw new Error('unauthorized');
          },
        }).cap,
      },
    }),
    target,
    destinationDir: workDir,
    warn: (_code, message) => failureWarnings.push(message),
  });
  expect(failed).toBeNull();
  expect(failureWarnings[0]).toBe('team-cache could not be used: unauthorized; building instead');

  const missingWarnings: string[] = [];
  const missing = await resolveTieredBuild({
    local: local.cap,
    loadProvider: () => ({
      name: 'team-cache',
      provider: { builds: capability({ resolve: () => join(workDir, 'nope.apk') }).cap },
    }),
    target,
    destinationDir: workDir,
    warn: (_code, message) => missingWarnings.push(message),
  });
  expect(missing).toBeNull();
  expect(missingWarnings[0]).toMatch(/which does not exist/);
});

test.each(['resolve', 'upload'] as const)(
  'cancelled provider %s waits for its real child and stays a cancellation',
  async (operation) => {
    const controller = new AbortController();
    const reason = new Error('run cancelled');
    const warnings: string[] = [];
    let notifyReady = () => {};
    const ready = new Promise<void>((resolve) => {
      notifyReady = resolve;
    });
    let child: ChildProcess | undefined;
    let closed = false;
    const cancelledChild = (signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        let failure: Error | null = null;
        child = execFile(
          process.execPath,
          [
            '-e',
            `
      process.on('SIGTERM', () => setTimeout(() => process.exit(0), 80));
      process.stdout.write('ready');
      setInterval(() => {}, 1000);
    `,
          ],
          { signal },
          (error) => {
            failure = error;
          },
        );
        child.stdout?.once('data', notifyReady);
        child.once('close', () => {
          closed = true;
          reject(failure ?? new Error('child closed'));
        });
      });
    const local = capability();
    const provider = capability({
      resolve: ({ signal }) => cancelledChild(signal),
      store: ({ signal }) => cancelledChild(signal),
    });
    const loadProvider = () => ({ provider: { builds: provider.cap } });
    const common = {
      local: local.cap,
      loadProvider,
      target,
      signal: controller.signal,
      warn: (_code: string, message: string) => warnings.push(message),
    };
    const pending =
      operation === 'resolve'
        ? resolveTieredBuild({ ...common, destinationDir: workDir })
        : storeTieredBuild({ ...common, sourcePath: artifact('built'), overwrite: false }).then(
            (stored) => stored.providerUpload,
          );
    const observed = pending.then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await ready;
      controller.abort(reason);
      await nextTurn();
      expect(await observed).toBe(reason);
      expect(closed).toBe(true);
      expect(warnings).toEqual([]);
      expect(local.calls.store).toBe(operation === 'resolve' ? 0 : 1);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'close');
      }
      await observed;
    }
  },
  20_000,
);

test('cancelling local backfill refuses the fetched hit instead of installing it', async () => {
  const controller = new AbortController();
  const reason = new Error('backfill cancelled');
  const warnings: string[] = [];
  const downloaded = artifact('downloaded');
  const local = capability({
    store: ({ signal }) => {
      controller.abort(reason);
      signal.throwIfAborted();
    },
  });
  await expect(
    resolveTieredBuild({
      local: local.cap,
      loadProvider: () => ({ provider: { builds: capability({ resolve: () => downloaded }).cap } }),
      target,
      destinationDir: workDir,
      signal: controller.signal,
      warn: (_code, message) => warnings.push(message),
    }),
  ).rejects.toBe(reason);
  expect(warnings).toEqual([]);
});

test('upload cancellation is observed even when the consumer waits until after installation', async () => {
  const controller = new AbortController();
  const reason = new Error('upload cancelled');
  const result = await storeTieredBuild({
    local: capability().cap,
    loadProvider: () => ({
      provider: {
        builds: capability({
          store: ({ signal }) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            }),
        }).cap,
      },
    }),
    target,
    sourcePath: artifact('built'),
    overwrite: false,
    signal: controller.signal,
  });
  controller.abort(reason);
  await nextTurn();
  await nextTurn();
  await expect(result.providerUpload).rejects.toBe(reason);
});
