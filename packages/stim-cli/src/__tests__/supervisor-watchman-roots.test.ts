import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NdjsonWriter } from '../ndjson.ts';
import { newRootsContaining, trackMetroWatchRoots } from '../supervisor/watchman-roots.ts';
import type { WatchmanCommand } from '../watchman.ts';

let base: string;
let worktree: string;
let workspace: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-watchman-')));
  worktree = join(base, 'app');
  workspace = join(worktree, 'apps', 'mobile');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(base, 'app-2'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const METRO_PID = 4242;

function subscription(pid: number, path = 'apps-mobile') {
  return { info: { pid, name: `metro-file-map-${pid}-${path}-0cb4f16e`, query: {} } };
}

function fakeWatchman({
  before = [] as string[],
  after = [] as string[],
  running = {} as Record<string, unknown[]>,
  stopped = {} as Record<string, unknown[]>,
  triggers = {} as Record<string, unknown[]>,
}) {
  const calls: string[][] = [];
  let listed = 0;
  let closed = false;
  const command: WatchmanCommand = async (args) => {
    calls.push(args);
    if (args[0] === 'watch-list') return { version: '2026.03.02.00', roots: listed++ === 0 ? before : after };
    if (args[0] === 'debug-get-subscriptions') {
      const root = args[1] as string;
      return { version: '2026.03.02.00', subscribers: (closed ? stopped : running)[root] ?? [] };
    }
    if (args[0] === 'trigger-list') return { version: '2026.03.02.00', triggers: triggers[args[1] as string] ?? [] };
    if (args[0] === 'watch-del') return { 'watch-del': true, root: args[1] };
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  return {
    command,
    calls,
    close() {
      closed = true;
    },
  };
}

function recordingWriter() {
  const records: Array<{ event?: string; level?: string; msg?: string }> = [];
  return { records, writer: { write: (record: unknown) => records.push(record as never) > 0 } as NdjsonWriter };
}

async function runLifecycle(fake: ReturnType<typeof fakeWatchman>) {
  const { records, writer } = recordingWriter();
  const tracker = trackMetroWatchRoots({
    workspaceRoot: workspace,
    writer,
    watchman: fake.command,
    probeDelaysMs: [],
  });
  tracker.started(METRO_PID);
  await tracker.beforeClose();
  fake.close();
  await tracker.afterClose();
  return {
    records,
    deleted: fake.calls.filter((args) => args[0] === 'watch-del').map((args) => args[1]),
  };
}

describe('newRootsContaining', () => {
  test('keeps only roots that appeared since the snapshot and contain the workspace', () => {
    const link = join(base, 'link');
    symlinkSync(worktree, link);
    expect(newRootsContaining([], [link], workspace)).toEqual([link]);
    expect(newRootsContaining([worktree], [link], workspace)).toEqual([]);
    expect(newRootsContaining([], [join(base, 'app-2'), join(base, 'gone')], workspace)).toEqual([]);
    expect(newRootsContaining([], [workspace], workspace)).toEqual([workspace]);
  });
});

describe('trackMetroWatchRoots', () => {
  test("removes the root while this Metro's own subscriptions are still closing", async () => {
    const mine = [subscription(METRO_PID), subscription(METRO_PID, 'packages-core')];
    const fake = fakeWatchman({ after: [worktree], running: { [worktree]: mine }, stopped: { [worktree]: mine } });
    expect((await runLifecycle(fake)).deleted).toEqual([worktree]);
  });

  test('stops calling watchman once shutdown has spent its time budget, and keeps the root', async () => {
    vi.useFakeTimers();
    try {
      const calls: string[][] = [];
      const fake = fakeWatchman({ after: [worktree], running: { [worktree]: [subscription(METRO_PID)] } });
      const { records, writer } = recordingWriter();
      const tracker = trackMetroWatchRoots({
        workspaceRoot: workspace,
        writer,
        watchman: async (args, timeoutMs) => {
          calls.push([...args, String(timeoutMs)]);
          vi.advanceTimersByTime(1000);
          return fake.command(args, timeoutMs);
        },
        probeDelaysMs: [],
      });
      tracker.started(METRO_PID);
      await tracker.beforeClose();
      await tracker.afterClose();
      expect(calls.slice(1)).toEqual([
        ['watch-list', '2000'],
        ['debug-get-subscriptions', worktree, '2000'],
        ['debug-get-subscriptions', worktree, '1000'],
      ]);
      expect(records.map((r) => r.msg)).toEqual([`kept the watchman root ${worktree}: could not list its triggers`]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('keeps the root when its subscriptions cannot be listed after the server closes', async () => {
    let failing = false;
    const fake = fakeWatchman({ after: [worktree], running: { [worktree]: [subscription(METRO_PID)] } });
    const inner = fake.command;
    fake.command = async (args, timeoutMs) => {
      if (failing && args[0] === 'debug-get-subscriptions') throw new Error('Command timed out after 2000ms');
      return inner(args, timeoutMs);
    };
    const { records, writer } = recordingWriter();
    const tracker = trackMetroWatchRoots({
      workspaceRoot: workspace,
      writer,
      watchman: fake.command,
      probeDelaysMs: [],
    });
    tracker.started(METRO_PID);
    await tracker.beforeClose();
    failing = true;
    await tracker.afterClose();
    expect(fake.calls.some((args) => args[0] === 'watch-del')).toBe(false);
    expect(records.map((r) => r.event)).toEqual(['watchman_root_kept']);
  });
});
