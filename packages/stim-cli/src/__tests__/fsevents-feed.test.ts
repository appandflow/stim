import { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { GC_MARK_VERSION, gcMarkFile, readGcMark } from '@stim-cli/core/state';
import { startHistoryFeed, type HistoryFeed } from '../fsevents-helper.ts';
import * as historyState from '../fsevents-state.ts';

const { dirtyGcMarks, readHistoryCheckpoints } = historyState;
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { writeCacheFile } from '../cache-file.ts';

let home: string;
let binary: string;
let sha256: string;
let feed: HistoryFeed | undefined;
let child: ChildProcess;
let stdin: PassThrough;
let output: PassThrough;
let input: { generation: number; watch: { dev: number; roots: string[]; since: number | null }[] }[];
const ROOTS: [{ root: string; device: number }] = [{ root: '/projects/a', device: 1 }];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-history-'));
  vi.stubEnv('STIM_HOME', home);
  binary = join(home, 'helper');
  writeFileSync(binary, 'fixture helper');
  sha256 = createHash('sha256').update(readFileSync(binary)).digest('hex');
  input = [];
  stdin = new PassThrough();
  output = new PassThrough();
  stdin.on('data', (data: Buffer) => input.push(JSON.parse(data.toString())));
  child = new ChildProcess();
  child.stdin = stdin;
  child.stdout = output;
  child.stderr = new PassThrough();
  vi.spyOn(child, 'kill').mockReturnValue(true);
  stdin.on('finish', () => child.emit('close', 0));
  setExecutor({ ...getExecutor(), spawn: () => child });
});

afterEach(async () => {
  await feed?.close();
  feed = undefined;
  resetExecutor();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function line(record: object) {
  output.emit('data', Buffer.from(`${JSON.stringify(record)}\n`));
}

function mark(root: string) {
  const file = gcMarkFile(root);
  writeCacheFile(file, {
    v: GC_MARK_VERSION,
    root,
    device: 1,
    markedAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: null,
    candidates: [],
  });
}

test('purged roots are persisted before the cursor, and an empty replay stores its UUID and timestamp', async () => {
  mark(ROOTS[0].root);
  let finish!: () => void;
  let held = false;
  const dirty = vi.fn<(roots: readonly string[], at: number) => Promise<void>>(async (roots, at) => {
    if (held)
      await new Promise<void>((done) => {
        finish = done;
      });
    dirtyGcMarks(roots, at);
  });
  feed = startHistoryFeed({ binary, sha256, dirty, log: vi.fn<(reason: string) => void>(), platform: 'darwin' });
  await feed.update(ROOTS);
  held = true;
  line({ generation: 1, dev: 1, purged: 'no-since', uuid: 'uuid', eventId: 10 });
  await vi.waitFor(() => expect(finish).toBeDefined());
  expect(readHistoryCheckpoints()).toEqual({});
  finish();
  await feed.changed([]);
  expect(readGcMark(ROOTS[0].root)?.dirtyAt).toBeDefined();
  expect(readHistoryCheckpoints()['1']).toMatchObject({ uuid: 'uuid', eventId: 10, roots: ['/projects/a'] });
  held = false;
  line({ generation: 1, dev: 1, historyDone: true, uuid: 'uuid', eventId: 11 });
  await feed.changed([]);
  expect(readHistoryCheckpoints()['1']?.sinceAt).toBeGreaterThan(0);
  expect(readHistoryCheckpoints()['1']?.eventId).toBe(11);
});

test('replacement watches replay from the durable cursor and ignore old root indexes', async () => {
  const dirty = vi.fn<(roots: readonly string[], at: number) => Promise<void>>(async () => {});
  feed = startHistoryFeed({ binary, sha256, dirty, log: vi.fn<(reason: string) => void>(), platform: 'darwin' });
  await feed.update(ROOTS);
  line({ generation: 1, dev: 1, historyDone: true, uuid: 'uuid', eventId: 10 });
  await feed.changed([]);
  await feed.update([{ root: '/projects/b', device: 1 }]);
  expect(input[1]).toMatchObject({ generation: 2, watch: [{ dev: 1, since: 10, roots: ['/projects/b'] }] });
  dirty.mockClear();
  line({ generation: 1, dev: 1, dirty: [0], eventId: 100 });
  line({ generation: 2, dev: 1, dirty: [0], eventId: 12 });
  await feed.changed([]);
  expect(dirty).toHaveBeenCalledTimes(1);
  expect(dirty.mock.calls[0]?.[0]).toEqual(['/projects/b']);
  expect(readHistoryCheckpoints()['1']?.eventId).toBe(12);
});

test('the lines of one flush cost one dirty acknowledgement and one checkpoint write', async () => {
  const roots = [...ROOTS, { root: '/projects/b', device: 1 }];
  const dirty = vi.fn<(roots: readonly string[], at: number) => Promise<void>>(async () => {});
  feed = startHistoryFeed({ binary, sha256, dirty, log: vi.fn<(reason: string) => void>(), platform: 'darwin' });
  await feed.update(roots);
  dirty.mockClear();
  const write = vi.spyOn(historyState, 'writeHistoryCheckpoints');
  const flush = Array.from(
    { length: 38 },
    (_, index) =>
      `${JSON.stringify({ generation: 1, dev: 1, dirty: [index % 2], uuid: 'uuid', eventId: 100 + index })}\n`,
  );
  output.emit('data', Buffer.from(flush.join('')));
  await feed.changed([]);
  expect(dirty).toHaveBeenCalledTimes(1);
  expect(dirty.mock.calls[0]?.[0]).toEqual(['/projects/a', '/projects/b']);
  expect(write).toHaveBeenCalledTimes(1);
  expect(readHistoryCheckpoints()['1']).toMatchObject({ uuid: 'uuid', eventId: 137 });
  write.mockRestore();
});

test('a bad line later in a flush keeps the prior checkpoint and dirties every watched root', async () => {
  const roots = [...ROOTS, { root: '/projects/b', device: 1 }];
  const dirty = vi.fn<(roots: readonly string[], at: number) => Promise<void>>(async () => {});
  feed = startHistoryFeed({ binary, sha256, dirty, log: vi.fn<(reason: string) => void>(), platform: 'darwin' });
  await feed.update(roots);
  line({ generation: 1, dev: 1, historyDone: true, uuid: 'uuid', eventId: 10 });
  await feed.changed([]);
  dirty.mockClear();
  const flush = [
    { generation: 1, dev: 1, dirty: [0], uuid: 'uuid', eventId: 20 },
    { generation: 1, dev: 1, dirty: [1], uuid: 'uuid', eventId: 15 },
  ];
  output.emit('data', Buffer.from(flush.map((record) => `${JSON.stringify(record)}\n`).join('')));
  await feed.changed([]);
  expect(readHistoryCheckpoints()['1']?.eventId).toBe(10);
  expect(dirty.mock.calls.flatMap(([named]) => named).toSorted()).toEqual(['/projects/a', '/projects/b']);
  expect(feed.status()).toMatchObject({ source: 'fallback' });
});

test('a dirty-write failure retains the prior checkpoint', async () => {
  const dirty = vi.fn<(roots: readonly string[], at: number) => Promise<void>>(async () => {});
  const log = vi.fn<(reason: string) => void>();
  feed = startHistoryFeed({ binary, sha256, dirty, log, platform: 'darwin' });
  await feed.update(ROOTS);
  line({ generation: 1, dev: 1, historyDone: true, uuid: 'uuid', eventId: 10 });
  await feed.changed([]);
  dirty.mockRejectedValue(new Error('disk full'));
  line({ generation: 1, dev: 1, dirty: [0], eventId: 20 });
  await feed.changed([]);
  expect(readHistoryCheckpoints()['1']?.eventId).toBe(10);
  expect(log.mock.calls.flat().join(' ')).toContain('disk full');
});

test.each(['missing', 'digest', 'platform'] as const)('%s helper falls back once per root', async (failure) => {
  if (failure === 'missing') rmSync(binary);
  if (failure === 'digest') writeFileSync(binary, 'changed helper');
  const dirty = vi.fn<(roots: readonly string[], at: number) => Promise<void>>(async () => {});
  feed = startHistoryFeed({
    binary,
    sha256,
    dirty,
    log: vi.fn<(reason: string) => void>(),
    platform: failure === 'platform' ? 'linux' : 'darwin',
  });
  await feed.update(ROOTS);
  await feed.update(ROOTS);
  expect(dirty).toHaveBeenCalledTimes(1);
  await feed.update([...ROOTS, { root: '/projects/b', device: 1 }]);
  expect(dirty.mock.calls[1]?.[0]).toEqual(['/projects/b']);
  expect(input).toEqual([]);
  expect(feed.status()).toMatchObject({ source: 'fallback', reason: expect.any(String) });
});

test('a replaced volume cursor may reset after a purge, and shutdown closes helper input', async () => {
  mkdirSync(join(home, 'gc'), { recursive: true });
  writeFileSync(
    join(home, 'gc', 'fsevents.json'),
    JSON.stringify({
      v: 1,
      devices: {
        '1': { uuid: 'old', eventId: 100, sinceAt: Math.floor(Date.now() / 1000), roots: ['/projects/a'] },
      },
    }),
  );
  const dirty = vi.fn<(roots: readonly string[], at: number) => Promise<void>>(async () => {});
  feed = startHistoryFeed({ binary, sha256, dirty, log: vi.fn<(reason: string) => void>(), platform: 'darwin' });
  await feed.update(ROOTS);
  line({ generation: 1, dev: 1, purged: 'uuid-changed', uuid: 'new', eventId: 10 });
  await feed.changed([]);
  expect(dirty.mock.calls[0]?.[0]).toEqual(['/projects/a']);
  expect(readHistoryCheckpoints()['1']).toMatchObject({ uuid: 'new', eventId: 10 });
  await feed.close();
  expect(stdin.writableEnded).toBe(true);
});

test('a root replacement waits for the captured generation dirty acknowledgement', async () => {
  let release!: () => void;
  let held = false;
  const dirty = vi.fn<(roots: readonly string[], at: number) => Promise<void>>(async () => {
    if (held)
      await new Promise<void>((done) => {
        release = done;
      });
  });
  feed = startHistoryFeed({ binary, sha256, dirty, log: vi.fn<(reason: string) => void>(), platform: 'darwin' });
  await feed.update(ROOTS);
  held = true;
  line({ generation: 1, dev: 1, purged: 'no-since', uuid: 'uuid', eventId: 10 });
  await vi.waitFor(() => expect(release).toBeDefined());
  const replacement = feed.update([{ root: '/projects/b', device: 1 }]);
  expect(input).toHaveLength(1);
  expect(readHistoryCheckpoints()).toEqual({});
  held = false;
  release();
  await replacement;
  expect(input[1]).toMatchObject({ generation: 2, watch: [{ since: 10, roots: ['/projects/b'] }] });
  expect(readHistoryCheckpoints()['1']).toMatchObject({ eventId: 10, roots: ['/projects/a'] });
});

test('an exited helper falls back once without restarting', async () => {
  const dirty = vi.fn<(roots: readonly string[], at: number) => Promise<void>>(async () => {});
  feed = startHistoryFeed({ binary, sha256, dirty, log: vi.fn<(reason: string) => void>(), platform: 'darwin' });
  await feed.update(ROOTS);
  dirty.mockClear();
  child.emit('close', 1);
  await feed.changed([]);
  await feed.update(ROOTS);
  await feed.update(ROOTS);
  expect(dirty).toHaveBeenCalledTimes(1);
  expect(input).toHaveLength(1);
});

test('dirty publication preserves candidate metadata and is newer than a mark written in the same millisecond', () => {
  const root = ROOTS[0].root;
  const at = Date.parse('2026-01-01T00:00:00.000Z');
  const candidates = [
    {
      kind: 'outputs',
      path: '/outputs/a',
      device: 2,
      bytes: 10,
      measuredAt: null,
      keep: { reason: 'busy', at: new Date(at).toISOString() },
      future: 'preserved',
    },
  ];
  writeCacheFile(gcMarkFile(root), {
    v: GC_MARK_VERSION,
    root,
    device: 1,
    markedAt: new Date(at).toISOString(),
    lastActivityAt: null,
    candidates,
  });
  dirtyGcMarks([root], at);
  expect(readGcMark(root)?.candidates).toEqual(candidates);
  expect(Date.parse(readGcMark(root)?.dirtyAt ?? '')).toBeGreaterThan(at);
});

test.each(['unknown version', 'torn JSON'] as const)('%s checkpoint requests fresh history', async (kind) => {
  mkdirSync(join(home, 'gc'), { recursive: true });
  writeFileSync(join(home, 'gc', 'fsevents.json'), kind === 'torn JSON' ? '{' : JSON.stringify({ v: 7, devices: {} }));
  const dirty = vi.fn<(roots: readonly string[], at: number) => Promise<void>>(async () => {});
  feed = startHistoryFeed({ binary, sha256, dirty, log: vi.fn<(reason: string) => void>(), platform: 'darwin' });
  await feed.update(ROOTS);
  expect(input[0]?.watch[0]?.since).toBeNull();
  expect(dirty.mock.calls[0]?.[0]).toEqual(['/projects/a']);
});
