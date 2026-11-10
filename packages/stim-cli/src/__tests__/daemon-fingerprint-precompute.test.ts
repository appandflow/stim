import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonWorkspaceDecision } from '@stim-cli/core/state';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  createFingerprintPrecompute,
  MAX_PRECOMPUTES_PER_PASS,
  treeSignature,
  type PrecomputeInput,
} from '../daemon/fingerprint-precompute.ts';
import type { FingerprintPrecomputeRequest } from '../fingerprint-precompute.ts';
import { getExecutor } from '../exec.ts';
import { testContext } from './_context.ts';
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';
import * as workspaceGit from '../workspace/git.ts';

const live = (path: string, outcome: DaemonWorkspaceDecision['outcome'] = 'active'): DaemonWorkspaceDecision => ({
  path,
  lastActivity: null,
  outcome,
  detail: '',
});

function setup(paths: Record<string, DaemonWorkspaceDecision['outcome']>, level: 'normal' | 'high' = 'normal') {
  const input: PrecomputeInput = {
    config: {
      version: 2,
      repos: {},
      projects: Object.fromEntries(Object.keys(paths).map((path) => [path, { platforms: { ios: {} } }])),
    },
    workspaces: Object.entries(paths).map(([path, outcome]) => live(path, outcome)),
    pressure: { level },
    operation: testContext(),
  };
  const signatures = new Map<string, string>();
  const ran: string[] = [];
  const records: { event: string; fields: Record<string, unknown> | undefined }[] = [];
  let deferred = false;
  let outcome: 'recorded' | 'present' | 'throw' = 'recorded';
  const step = createFingerprintPrecompute((_level, event, _msg, fields) => records.push({ event, fields }), {
    signature: async (root) => signatures.get(root) ?? 'head-1',
    requests: async (path) => [{ root: path, platform: 'ios' }],
    run: async (_operation, request) => {
      ran.push(request.root);
      if (outcome === 'throw') throw new Error('child failed');
      return { outcome };
    },
    loadDeferred: () => deferred,
  });
  return {
    input,
    ran,
    records,
    signatures,
    run: (act = true) => step.run(input, act),
    defer: (value: boolean) => (deferred = value),
    child: (value: typeof outcome) => (outcome = value),
  };
}

let base: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-precompute-')));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('the daemon fingerprint precompute', () => {
  test.each(['signature', 'requests', 'run'])('preserves unverified %s cleanup after cancellation', async (stage) => {
    const controller = new AbortController();
    const failure = new WorkspaceProcessCleanupError([], 'child cleanup is unverified', 'Inspect the child.');
    const fail = () => {
      controller.abort();
      throw failure;
    };
    const step = createFingerprintPrecompute(() => {}, {
      signature: async () => (stage === 'signature' ? fail() : 'head'),
      requests: async () => (stage === 'requests' ? fail() : [{ root: base, platform: 'ios' }]),
      run: async () => (stage === 'run' ? fail() : { outcome: 'recorded' }),
      loadDeferred: () => false,
    });
    await expect(
      step.run(
        {
          config: { version: 2, repos: {}, projects: { [base]: { platforms: { ios: {} } } } },
          workspaces: [live(base)],
          pressure: { level: 'normal' },
          operation: testContext({ signal: controller.signal }),
        },
        true,
      ),
    ).rejects.toBe(failure);
  });

  test('tree signature preserves an unverified git child instead of replacing it with no-head', async () => {
    const failure = new WorkspaceProcessCleanupError([], 'git cleanup is unverified', 'Inspect git.');
    const read = vi.spyOn(workspaceGit, 'gitAsync').mockRejectedValueOnce(failure);
    try {
      await expect(treeSignature(base, new AbortController().signal)).rejects.toBe(failure);
    } finally {
      read.mockRestore();
    }
  });
  test('starts a child for a live, non-idle workspace once per HEAD and lockfile, and again when they change', async () => {
    const t = setup({ '/a': 'active' });
    await t.run();
    await t.run();
    expect(t.ran).toEqual(['/a']);
    t.signatures.set('/a', 'head-2');
    await t.run();
    expect(t.ran).toEqual(['/a', '/a']);
  });

  test('leaves a workspace that is kept, idle or running no dev server out', async () => {
    const t = setup({ '/kept': 'kept', '/idle': 'idle', '/would': 'would-idle', '/failed': 'failed' });
    await t.run();
    expect(t.ran).toEqual([]);
  });

  test.each([
    ['daemon.mode report', (t: ReturnType<typeof setup>) => t.run(false)],
    [
      'pressure above normal',
      async (t: ReturnType<typeof setup>) => {
        t.input.pressure = { level: 'high' };
        await t.run();
      },
    ],
    [
      'a loaded host',
      async (t: ReturnType<typeof setup>) => {
        t.defer(true);
        await t.run();
      },
    ],
  ])('starts nothing under %s, and starts the workspace once it clears', async (_name, hold) => {
    const t = setup({ '/a': 'active' });
    await hold(t);
    expect(t.ran).toEqual([]);
    t.input.pressure = { level: 'normal' };
    t.defer(false);
    await t.run();
    expect(t.ran).toEqual(['/a']);
  });

  test('starts at most a fixed number of children per pass and takes the rest on the next', async () => {
    const paths = ['/a', '/b', '/c'];
    const t = setup(Object.fromEntries(paths.map((path) => [path, 'active' as const])));
    await t.run();
    expect(t.ran).toEqual(paths.slice(0, MAX_PRECOMPUTES_PER_PASS));
    await t.run();
    expect(t.ran).toEqual(paths);
  });

  test('does not retry a child that failed until HEAD or the lockfile changes', async () => {
    const t = setup({ '/a': 'active' });
    t.child('throw');
    await t.run();
    await t.run();
    expect(t.ran).toEqual(['/a']);
    expect(t.records.find((record) => record.event === 'daemon_fingerprint_precompute')?.fields).toMatchObject({
      outcome: 'failed',
      reason: 'child failed',
    });
  });
});

describe('the project a precompute fingerprints', () => {
  test('is the one a run fingerprints: the platforms the workspace has a device for, with its configured iOS path', async () => {
    const root = join(base, 'app');
    mkdirSync(join(root, 'custom-ios', 'App.xcodeproj'), { recursive: true });
    mkdirSync(join(root, 'android'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '1.0.0' } }));
    writeFileSync(join(root, 'android', 'build.gradle'), '');
    writeFileSync(join(root, '.stim.json'), JSON.stringify({ ios: { projectPath: 'custom-ios' } }));
    const requests: FingerprintPrecomputeRequest[] = [];
    const step = createFingerprintPrecompute(() => {}, {
      signature: async () => 'head-1',
      run: async (_operation, request) => {
        requests.push(request);
        return { outcome: 'present' };
      },
      loadDeferred: () => false,
    });
    await step.run(
      {
        config: { version: 2, repos: {}, projects: { [root]: { platforms: { ios: {}, android: {} } } } },
        workspaces: [live(root)],
        pressure: { level: 'normal' },
        operation: testContext({ projectRoot: root, cwd: root }),
      },
      true,
    );
    expect(requests).toMatchObject([
      { root, platform: 'ios', iosProjectPath: 'custom-ios' },
      { root, platform: 'android', androidLayout: { gradleRootRelative: 'android' } },
    ]);
  });
});

describe('what starts a precompute', () => {
  test('changes with the git HEAD, the lockfile and the finished install of node_modules, and with nothing else', async () => {
    const git = (...args: string[]) =>
      getExecutor().runFile(
        'git',
        ['-C', base, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
        {
          timeoutMs: 20_000,
        },
      );
    git('init', '--quiet');
    writeFileSync(join(base, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    git('add', '.');
    git('commit', '--quiet', '-m', 'one');
    const signal = new AbortController().signal;
    const first = await treeSignature(base, signal);
    expect(await treeSignature(base, signal)).toBe(first);

    writeFileSync(join(base, 'unrelated.txt'), 'x');
    expect(await treeSignature(base, signal)).toBe(first);

    git('commit', '--quiet', '--allow-empty', '-m', 'two');
    const afterCommit = await treeSignature(base, signal);
    expect(afterCommit).not.toBe(first);

    writeFileSync(join(base, 'pnpm-lock.yaml'), 'lockfileVersion: 9\npackages: {}\n');
    const afterLockfile = await treeSignature(base, signal);
    expect(afterLockfile).not.toBe(afterCommit);

    mkdirSync(join(base, 'node_modules'));
    writeFileSync(join(base, 'node_modules', '.modules.yaml'), 'layoutVersion: 5\n');
    const afterInstall = await treeSignature(base, signal);
    expect(afterInstall).not.toBe(afterLockfile);

    const later = new Date(Date.now() + 60_000);
    utimesSync(join(base, 'node_modules', '.modules.yaml'), later, later);
    expect(await treeSignature(base, signal)).not.toBe(afterInstall);
  });
});
