import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { getExecutor, resetExecutor } from '../exec.ts';
import { gitAsync, gitQuietAsync } from '../workspace/git.ts';
import { gitCommonDirAsync } from '../workspace/worktree.ts';
import { withAmbientContext } from '@stim-cli/core';
import { captureProcessIdentity, inspectProcessIdentity, waitForProcessExit } from '@stim-cli/core/process-identity';
import * as identities from '../process-identity.ts';
import { withWorkspaceProcessLock } from '../engine/workspace-process-lock.ts';
import { readClaimSet, releaseClaim, type ClaimHandle } from '../ownership-claim.ts';
import { testContext } from './_context.ts';
import { childEnvironment } from '../workspace/git-read.ts';
import { pullRequestLookupAsync, pullRequestLookups } from '../workspace/pull-request.ts';
import { runOperationFile } from '../engine/operation-exec.ts';
import { maintenancePinnedAsync } from '../maintenance/protect.ts';
import { collectArtifactsAsync } from '../maintenance/artifacts.ts';
import { cachedDeviceActivityAsync, workspaceActiveReasonAsync } from '../maintenance/activity.ts';
import { previewMaintenance } from '../maintenance/preview.ts';
import * as maintenanceMeasure from '../maintenance/measure.ts';
import { enforceBudget } from '../budget.ts';

let dir: string;
let path: string | undefined;

beforeEach(() => {
  resetExecutor();
  dir = mkdtempSync(join(tmpdir(), 'stim-git-'));
  path = process.env.PATH;
});

afterEach(() => {
  process.env.PATH = path;
  rmSync(dir, { recursive: true, force: true });
});

function blockGit(): void {
  writeFileSync(join(dir, 'git'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  process.env.PATH = `${dir}${delimiter}${path ?? ''}`;
}

test.each([
  'read',
  'quiet read',
  'repository metadata',
  'operation',
  'PR lookup',
  'bulk PR lookup',
  'maintenance pin',
  'maintenance artifacts',
  'maintenance activity',
  'maintenance preview',
  'maintenance budget',
  ...(process.platform === 'darwin' ? ['maintenance pressure'] : []),
])('a cancelled repository %s probe preserves its actual claim when child cleanup is unverifiable', async (kind) => {
  const controller = new AbortController();
  const context = testContext({
    projectRoot: dir,
    cwd: dir,
    home: join(dir, 'home'),
    env: { ...process.env, STIM_HOME: join(dir, 'home'), HOME: dir, USERPROFILE: dir, STIM_MAINTENANCE: 'report' },
    signal: controller.signal,
  });
  if (kind.startsWith('maintenance')) {
    const { saveConfig } = await import('../workspace/config.ts');
    withAmbientContext(context, () =>
      saveConfig({
        version: 2,
        repos: {},
        projects: { [dir]: { platforms: { ios: { owned: true, deviceUdid: 'fixture-sim' } } } },
        maintenance: { mode: 'report' },
      }),
    );
  }
  const readPressure = maintenanceMeasure.measurePressureAsync;
  const pressure = vi.spyOn(maintenanceMeasure, 'measurePressureAsync').mockResolvedValue({
    disk: [{ volume: dir, freeMb: 1024 * 1024 }],
    memory: { level: 'normal', availableBytes: null, pressured: false },
    warningSince: null,
  });
  const executor = getExecutor();
  const original = executor.runFileAsync.bind(executor);
  const findOriginal = executor.findExecutable.bind(executor);
  const find = vi
    .spyOn(executor, 'findExecutable')
    .mockImplementation((name) => (name === 'gh' ? '/fixture/gh' : findOriginal(name)));
  let owned: { pid: number; processToken: string } | undefined;
  const targets: { pid: number; processToken: string }[] = [];
  let claim: ClaimHandle | undefined;
  let closed: Promise<void> = Promise.resolve();
  const inspectOriginal = inspectProcessIdentity;
  const inspect = vi
    .spyOn(identities, 'inspectProcessIdentity')
    .mockImplementation((record) => (owned && record?.pid === owned.pid ? 'unknown' : inspectOriginal(record)));
  const probe = vi.spyOn(executor, 'runFileAsync').mockImplementation((file, args, options) =>
    original(
      file === 'git' || file === 'gh' || file === 'xcrun' || file === '/usr/sbin/sysctl' ? process.execPath : file,
      file === 'git' || file === 'gh' || file === 'xcrun' || file === '/usr/sbin/sysctl'
        ? [
            '-e',
            'console.log(JSON.stringify({pid:process.pid,parent:process.ppid})); ' +
              (file === 'gh' || kind.startsWith('maintenance')
                ? 'setTimeout(()=>{},2000)'
                : 'setInterval(()=>{},1000)'),
          ]
        : args,
      {
        ...options,
        onSpawn: (child) => {
          options.onSpawn?.(child);
          const birth = child.pid === undefined ? null : captureProcessIdentity(child.pid);
          if (!birth?.ok || child.pid === undefined) throw new Error('The fixture Git child has no identity');
          owned = { pid: child.pid, processToken: birth.token };
          targets.push(owned);
          closed = new Promise<void>((resolve) => child.once('close', resolve));
          child.stdout?.once('data', (data) => {
            const metadata = JSON.parse(String(data));
            for (const pid of process.platform === 'win32' ? [metadata.pid, metadata.parent] : [metadata.pid]) {
              if (targets.some((record) => record.pid === pid)) continue;
              const captured = captureProcessIdentity(pid);
              if (!captured.ok) throw new Error(captured.reason);
              targets.push({ pid, processToken: captured.token });
            }
            controller.abort(new Error('cancel Git read'));
          });
        },
      },
    ),
  );
  try {
    const request = withAmbientContext(context, () =>
      withWorkspaceProcessLock(
        dir,
        'git-read',
        async (handle) => {
          claim = handle;
          const options = { ...childEnvironment(context.env), signal: context.signal, declareFor: context };
          if (kind === 'maintenance pressure') {
            const { resolveMaintenanceSettings } = await import('../maintenance/settings.ts');
            return readPressure(resolveMaintenanceSettings(undefined, context.env), null, Date.now(), context);
          }
          if (kind === 'maintenance budget')
            return enforceBudget(
              {
                root: join(dir, 'trigger'),
                dryRun: true,
                note: () => {},
                budget: { minFreeDiskMb: 10, hardFloorDiskMb: 0, maxCommittedMemoryMb: 0, maxLiveWorkspaces: 0 },
                env: { ...context.env, STIM_HOME: undefined },
                signal: context.signal,
                operation: context,
              },
              { volumes: () => [{ volume: dir, freeMb: 0 }] },
            );
          if (kind === 'maintenance pin') return maintenancePinnedAsync(dir, context);
          if (kind === 'maintenance artifacts')
            return collectArtifactsAsync(
              'build',
              {
                now: Date.now(),
                windowMs: 0,
                protectedRoot: '',
                pinned: () => false,
              },
              context.signal,
              context,
            );
          if (kind === 'maintenance activity')
            return workspaceActiveReasonAsync(
              dir,
              Date.now(),
              0,
              cachedDeviceActivityAsync(Date.now(), context.env, context.signal, context),
              context.signal,
            );
          if (kind === 'maintenance preview') return previewMaintenance({ operation: context });
          if (kind === 'PR lookup') return pullRequestLookupAsync(context)(dir, 'feature', '1'.repeat(40));
          if (kind === 'bulk PR lookup')
            return pullRequestLookups({ operation: context })(dir, [
              { cwd: dir, branch: 'feature', head: '1'.repeat(40) },
            ]);
          if (kind === 'operation')
            return runOperationFile(context, executor, 'git', ['status'], { timeoutMs: 10_000 });
          return kind === 'repository metadata'
            ? gitCommonDirAsync(dir, options)
            : (kind === 'quiet read' ? gitQuietAsync : gitAsync)(dir, ['status'], options);
        },
        { external: true, signal: context.signal, declareSpawnsFor: context },
      ),
    );
    await expect(request).rejects.toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE' });
    if (!claim || !owned) throw new Error('The fixture Git claim or child was not created');
    expect(readClaimSet(claim.root).live).toMatchObject([{ child: { pid: owned.pid } }]);
    expect(inspectProcessIdentity(owned)).toBe('same');
  } finally {
    inspect.mockRestore();
    probe.mockRestore();
    find.mockRestore();
    pressure.mockRestore();
    controller.abort();
    for (const target of targets.toReversed())
      if (inspectProcessIdentity(target) === 'same') process.kill(target.pid, 'SIGKILL');
    await closed;
    for (const target of targets) expect(await waitForProcessExit(target, 5000)).toBe(true);
    if (claim) releaseClaim(claim);
  }
});

test.skipIf(process.platform === 'win32')(
  'aborting an active git rejects with the caller reason and frees its slot',
  async () => {
    blockGit();
    const controller = new AbortController();
    const reason = new Error('cancel source listing');
    const started = Date.now();
    const pending = gitAsync(dir, ['status'], { timeoutMs: 10_000, signal: controller.signal });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(Date.now() - started).toBeLessThan(5000);
  },
);

test.skipIf(process.platform === 'win32')(
  'aborting a queued git never starts it and does not consume a slot',
  async () => {
    blockGit();
    const running = Array.from({ length: 6 }, () => new AbortController());
    const pending = running.map((controller) =>
      gitAsync(dir, ['status'], { timeoutMs: 10_000, signal: controller.signal }),
    );
    const queued = new AbortController();
    const reason = new Error('cancel queued listing');
    let spawned = false;
    const seventh = gitAsync(dir, ['status'], {
      timeoutMs: 10_000,
      signal: queued.signal,
      onSpawn: () => {
        spawned = true;
      },
    });
    try {
      queued.abort(reason);
      await expect(seventh).rejects.toBe(reason);
      expect(spawned).toBe(false);
    } finally {
      for (const controller of running) controller.abort();
      await Promise.allSettled(pending);
    }
    const next = new AbortController();
    const eighth = gitAsync(dir, ['status'], {
      timeoutMs: 10_000,
      signal: next.signal,
      onSpawn: () => {
        spawned = true;
      },
    });
    next.abort(reason);
    await expect(eighth).rejects.toBe(reason);
    expect(spawned).toBe(true);
  },
);
