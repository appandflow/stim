import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readFootprints } from '../footprint.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { withAmbientContext } from '@stim-cli/core';
import { captureProcessIdentity, inspectProcessIdentity, waitForProcessExit } from '@stim-cli/core/process-identity';
import * as identities from '../process-identity.ts';
import { executeGc, withGcMaintenanceClaim } from '../commands/gc.ts';
import * as memory from '../commands/gc/memory.ts';
import { testContext } from './_context.ts';
import { operationState } from '../engine/operation-state.ts';
import { readClaimSet, releaseClaim, type ClaimHandle } from '../ownership-claim.ts';

let root: string;
let savedHome: string | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-footprint-')));
  savedHome = process.env.STIM_HOME;
  process.env.STIM_HOME = join(root, 'state');
});

afterEach(() => {
  vi.restoreAllMocks();
  resetExecutor();
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.STIM_HOME;
  else process.env.STIM_HOME = savedHome;
});

test.skipIf(process.platform === 'win32').each(['developer', 'compile', 'helper'])(
  'unresolved footprint %s child retains GC admission and a later operation can retry after it exits',
  async (phase) => {
    resetExecutor();
    const executor = getExecutor();
    const real = executor.runFileAsync.bind(executor);
    const operation = testContext({ cwd: root, projectRoot: root });
    vi.spyOn(memory, 'memorySweepIsScoped').mockReturnValue(false);
    let owned: { pid: number; processToken: string } | undefined;
    let handles: ClaimHandle[] = [];
    let closed = Promise.resolve();
    const inspect = vi
      .spyOn(identities, 'inspectProcessIdentity')
      .mockImplementation((record) =>
        owned && record?.pid === owned.pid ? 'unknown' : inspectProcessIdentity(record),
      );
    const probe = vi.spyOn(executor, 'runFileAsync').mockImplementation(async (file, args, options) => {
      const wanted =
        phase === 'developer'
          ? file === 'xcode-select'
          : phase === 'compile'
            ? file === 'xcrun'
            : file.includes('stim-footprint-');
      if (wanted && !owned)
        return real(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
          ...options,
          timeoutMs: 25,
          onSpawn: (child) => {
            options.onSpawn?.(child);
            const birth = child.pid === undefined ? null : captureProcessIdentity(child.pid);
            if (child.pid === undefined || !birth?.ok) throw new Error('The footprint fixture child has no identity');
            owned = { pid: child.pid, processToken: birth.token };
            handles = [...operationState(operation).declaring];
            closed = new Promise<void>((resolve) => child.once('close', resolve));
          },
        });
      if (file === 'xcode-select') return '/Library/Developer/CommandLineTools';
      if (file === 'ps') return '';
      if (file === 'watchman') return '{}';
      if (file === 'xcrun') {
        const output = args[args.indexOf('-o') + 1];
        if (!output) throw new Error('The compiler output path is missing');
        writeFileSync(output, 'fixture helper');
        return '';
      }
      return '123 456\n';
    });
    try {
      await expect(
        withAmbientContext(operation, () =>
          withGcMaintenanceClaim({ delete: true }, (claim) =>
            executeGc({ delete: true, cache: 'watchman' }, { operation }, () => {}, claim),
          ),
        ),
      ).rejects.toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE' });
      if (!owned) throw new Error('The footprint operation did not start');
      expect(inspectProcessIdentity(owned)).toBe('same');
      expect(handles.length).toBeGreaterThan(0);
      for (const handle of handles)
        expect(readClaimSet(handle.root).live).toMatchObject([{ child: { pid: owned.pid } }]);
      await expect(
        withAmbientContext(operation, () => withGcMaintenanceClaim({ delete: true }, async () => {})),
      ).rejects.toMatchObject({ code: 'STIM_CLAIM_REFUSED' });
    } finally {
      inspect.mockRestore();
      if (owned && inspectProcessIdentity(owned) === 'same') process.kill(owned.pid, 'SIGKILL');
      await closed;
      expect(owned ? await waitForProcessExit(owned, 5000) : true).toBe(true);
      for (const handle of handles) releaseClaim(handle);
    }
    try {
      const next = testContext({ cwd: root, projectRoot: root });
      expect(await withAmbientContext(next, () => readFootprints(next))).toEqual(new Map([[123, 456]]));
    } finally {
      probe.mockRestore();
    }
  },
);

function mockExecutor(allowXcode: () => boolean, calls: string[]) {
  setExecutor({
    runFileQuiet: (file: string) => {
      if (file === 'xcode-select') {
        calls.push('xcode-select');
        return allowXcode() ? '/Library/Developer/CommandLineTools' : null;
      }
      calls.push('helper');
      return '123 456\n';
    },
    runFileAsync: async (_file: string, args: string[] = []) => {
      calls.push('compile');
      const output = args[args.indexOf('-o') + 1]!;
      writeFileSync(output, '#!/bin/sh\n', { mode: 0o755 });
      return '';
    },
  });
}

test('readFootprints retries a failed helper build after a backoff instead of pinning the failure forever', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let allowXcode = false;
  const calls: string[] = [];
  mockExecutor(() => allowXcode, calls);

  expect(await readFootprints()).toBeNull();
  expect(calls).toEqual(['xcode-select']);

  calls.length = 0;
  vi.setSystemTime(5_000);
  expect(await readFootprints()).toBeNull();
  expect(calls).toEqual([]);

  calls.length = 0;
  allowXcode = true;
  vi.setSystemTime(10_001);
  expect(await readFootprints()).toEqual(new Map([[123, 456]]));
  expect(calls).toEqual(['xcode-select', 'compile', 'helper']);

  calls.length = 0;
  vi.setSystemTime(999_999);
  expect(await readFootprints()).toEqual(new Map([[123, 456]]));
  expect(calls).toEqual(['helper']);
});

test('readFootprints doubles the backoff on repeated failures, then recovers once the cause clears', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let allowXcode = false;
  const calls: string[] = [];
  mockExecutor(() => allowXcode, calls);

  expect(await readFootprints()).toBeNull(); // backoff -> 10s
  calls.length = 0;

  vi.setSystemTime(10_001);
  expect(await readFootprints()).toBeNull(); // backoff -> 20s
  expect(calls).toEqual(['xcode-select']);

  calls.length = 0;
  vi.setSystemTime(25_000);
  expect(await readFootprints()).toBeNull();
  expect(calls).toEqual([]);

  calls.length = 0;
  allowXcode = true;
  vi.setSystemTime(30_002);
  expect(await readFootprints()).toEqual(new Map([[123, 456]]));
  expect(calls).toEqual(['xcode-select', 'compile', 'helper']);
});

test('readFootprints caps the backoff at 10 minutes after repeated failures', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const calls: string[] = [];
  mockExecutor(() => false, calls);

  // Uncapped doubling from 10s would exceed a 600001ms wait by the 7th failure (10s, 20s, ..., 640s).
  // A retry on every iteration proves the backoff never grew past the 10-minute cap.
  let now = 0;
  for (let i = 0; i < 8; i++) {
    calls.length = 0;
    expect(await readFootprints()).toBeNull();
    expect(calls).toEqual(['xcode-select']);
    now += 600_001;
    vi.setSystemTime(now);
  }
});

test('readFootprints shares one in-flight build between concurrent calls', async () => {
  vi.setSystemTime(0);
  const calls: string[] = [];
  mockExecutor(() => true, calls);

  const [first, second] = await Promise.all([readFootprints(), readFootprints()]);
  expect(first).toEqual(new Map([[123, 456]]));
  expect(second).toEqual(new Map([[123, 456]]));
  expect(calls.filter((c) => c === 'compile')).toHaveLength(1);
});
