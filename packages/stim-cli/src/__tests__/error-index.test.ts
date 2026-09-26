import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countErrorsSinceMarker } from '../diagnostics/error-index.ts';
import { queryLogs } from '@stim-cli/core/state';
import { parseNdjsonLine } from '../ndjson.ts';

vi.mock('../ndjson.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ndjson.ts')>();
  return { ...actual, parseNdjsonLine: vi.fn<typeof actual.parseNdjsonLine>(actual.parseNdjsonLine) };
});

const inodes = vi.hoisted(() => ({ beyondDoublePrecision: false }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const fstatSync = ((fd: number, options?: { bigint?: boolean }) => {
    const stat = actual.fstatSync(fd, { bigint: true });
    if (!inodes.beyondDoublePrecision) return options?.bigint ? stat : actual.fstatSync(fd);
    // NTFS file IDs carry a sequence number in their top 16 bits, so they often exceed 2^53.
    const ino = (1n << 60n) + stat.ino;
    const size = options?.bigint ? stat.size : Number(stat.size);
    return { dev: options?.bigint ? stat.dev : Number(stat.dev), ino: options?.bigint ? ino : Number(ino), size };
  }) as typeof actual.fstatSync;
  return { ...actual, fstatSync, default: { ...actual, fstatSync } };
});

let root: string;
let dir: string;
let index: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-error-index-'));
  dir = join(root, 'logs');
  index = join(root, 'log-error-index.json');
  mkdirSync(dir);
  vi.mocked(parseNdjsonLine).mockClear();
});
afterEach(() => {
  inodes.beyondDoublePrecision = false;
  rmSync(root, { recursive: true, force: true });
});

function lines(records: unknown[]): string {
  return records.map((r) => `${JSON.stringify(r)}\n`).join('');
}

function write(name: string, records: unknown[]) {
  writeFileSync(join(dir, name), lines(records));
}

function append(name: string, records: unknown[]) {
  appendFileSync(join(dir, name), lines(records));
}

function count(): number {
  const counted = countErrorsSinceMarker(dir, index);
  expect(counted).toBe(queryLogs({ dir, errorsOnly: true }).length);
  return counted;
}

test('counts what logs --errors counts across marker boundaries', () => {
  write('metro.ndjson', [
    { ts: 5, src: 'metro', level: 'error', msg: 'before the launch marker' },
    { ts: 29, src: 'metro', level: 'error', msg: 'after the launch, before the bundle marker' },
    { ts: 30, src: 'metro', level: 'info', msg: 'bundle built', marker: true },
    { ts: 30, src: 'metro', level: 'error', msg: 'at the bundle marker counts' },
    { ts: 31, src: 'metro', level: 'fatal', msg: 'after both markers' },
  ]);
  write('client.ndjson', [
    { ts: 20, src: 'client', level: 'error', msg: 'at the launch marker does not count' },
    { ts: 21, src: 'client', level: 'error', msg: 'after the launch marker' },
    { src: 'client', level: 'error', msg: 'no timestamp' },
    { ts: 22, src: 'client', level: 'warn', msg: 'a warning' },
  ]);
  write('build-ios.ndjson', [
    { ts: 1, src: 'build', level: 'error', msg: 'older default-slot build error' },
    { ts: 20, src: 'build', level: 'info', marker: true, event: 'launch_attempt', slot: 'default' },
    { ts: 25, src: 'build', level: 'error', msg: 'default-slot error after its launch', slot: 'default' },
  ]);
  write('build-ios.duo.ndjson', [
    { ts: 2, src: 'build', level: 'error', msg: 'duo has no launch marker, so this counts', slot: 'duo' },
  ]);
  write('device.ndjson', [
    { ts: 23, src: 'device', level: 'error', msg: 'socket noise' },
    { ts: 24, src: 'device', level: 'fatal', event: 'native_crash', msg: 'crash' },
    { ts: 3, src: 'device', level: 'error', event: 'native_crash', msg: 'crash before the launch' },
  ]);
  writeFileSync(
    join(dir, 'device.ndjson.1'),
    lines([{ ts: 26, src: 'device', level: 'error', event: 'native_crash' }]),
  );

  expect(count()).toBe(7);
});

test('a later marker in any generation raises the boundary for records already read', () => {
  write('client.ndjson', [{ ts: 5, src: 'client', level: 'error', msg: 'boom' }]);
  expect(count()).toBe(1);

  write('build-android.ndjson', []);
  expect(count()).toBe(1);
  writeFileSync(join(dir, 'build-android.ndjson.1'), lines([{ ts: 6, src: 'build', marker: true }]));
  expect(count()).toBe(0);
});

test('files whose inodes differ only beyond double precision keep separate summaries', () => {
  inodes.beyondDoublePrecision = true;
  write('client.ndjson', [{ ts: 5, src: 'client', level: 'error', msg: 'boom' }]);
  write('build-android.ndjson', []);
  writeFileSync(join(dir, 'build-android.ndjson.1'), lines([{ ts: 6, src: 'build', marker: true }]));
  expect(count()).toBe(0);
});

test('a large log file is not parsed line by line, and a later call reads only what was appended', () => {
  const noise = Array.from({ length: 20_000 }, (_, i) => ({ ts: i, src: 'metro', level: 'info', msg: `line ${i}` }));
  write('metro.ndjson', [
    ...noise,
    { ts: 20_000, src: 'metro', level: 'error', msg: 'first' },
    { ts: 20_001, src: 'metro', level: 'info', msg: 'bundle built', marker: true },
  ]);

  expect(countErrorsSinceMarker(dir, index)).toBe(0);
  expect(vi.mocked(parseNdjsonLine)).toHaveBeenCalledTimes(2);

  vi.mocked(parseNdjsonLine).mockClear();
  append('metro.ndjson', [...noise.slice(0, 100), { ts: 20_002, src: 'metro', level: 'error', msg: 'second' }]);
  expect(countErrorsSinceMarker(dir, index)).toBe(1);
  expect(vi.mocked(parseNdjsonLine)).toHaveBeenCalledTimes(1);

  vi.mocked(parseNdjsonLine).mockClear();
  expect(countErrorsSinceMarker(dir, index)).toBe(1);
  expect(vi.mocked(parseNdjsonLine)).not.toHaveBeenCalled();
});

test('an unterminated last line counts once its newline arrives', () => {
  const partial = JSON.stringify({ ts: 1, src: 'metro', level: 'error', msg: 'half' });
  writeFileSync(join(dir, 'metro.ndjson'), partial);
  expect(count()).toBe(0);

  appendFileSync(join(dir, 'metro.ndjson'), '\n');
  expect(count()).toBe(1);
});

test('a log truncated and rewritten in place is read again', () => {
  write('build-ios.ndjson', [
    { ts: 1, src: 'build', level: 'error', msg: 'first build failed' },
    { ts: 2, src: 'build', level: 'error', msg: 'first build failed again' },
  ]);
  expect(count()).toBe(2);

  write('build-ios.ndjson', [
    { ts: 3, src: 'build', level: 'info', msg: 'second build, a longer line so the file grows past the old offset' },
    { ts: 4, src: 'build', level: 'error', msg: 'second build failed' },
  ]);
  expect(count()).toBe(1);
});

test('rotation keeps every generation counted once without rereading the rotated file', () => {
  write('device.ndjson', [{ ts: 1, src: 'device', level: 'error', event: 'native_crash' }]);
  expect(count()).toBe(1);

  renameSync(join(dir, 'device.ndjson'), join(dir, 'device.ndjson.1'));
  write('device.ndjson', [{ ts: 2, src: 'device', level: 'error', event: 'native_crash' }]);
  vi.mocked(parseNdjsonLine).mockClear();
  expect(countErrorsSinceMarker(dir, index)).toBe(2);
  expect(vi.mocked(parseNdjsonLine)).toHaveBeenCalledTimes(1);
});

test('an unreadable index is rebuilt from the logs', () => {
  write('metro.ndjson', [{ ts: 1, src: 'metro', level: 'error' }]);
  writeFileSync(index, '{ not json');
  expect(count()).toBe(1);
  expect(count()).toBe(1);
});
