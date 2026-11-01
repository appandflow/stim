import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countErrorsSinceMarker } from '../diagnostics/error-index.ts';
import { countErrorEntries, queryLogs } from '@stim-cli/core/state';
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
    if (options?.bigint) return { dev: stat.dev, ino: (1n << 60n) + stat.ino, size: stat.size };
    return { dev: Number(stat.dev), ino: 2 ** 60, size: Number(stat.size) };
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
  expect(counted).toBe(countErrorEntries(queryLogs({ dir, errorsOnly: true })));
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
  write('web.ndjson', [
    { ts: 27, src: 'device', platform: 'web', level: 'error', event: 'web_document_failed', msg: 'ERR_CERT' },
    { ts: 28, src: 'device', platform: 'web', level: 'info', event: 'web_page_loaded' },
  ]);

  expect(count()).toBe(8);
});

test('a page load resets only the web page records, and a native launch leaves them', () => {
  write('build-ios.ndjson', [{ ts: 10, src: 'build', level: 'info', marker: true, platform: 'ios' }]);
  write('client.ndjson', [{ ts: 11, src: 'client', level: 'error', msg: 'app threw' }]);
  write('web.ndjson', [
    { ts: 12, src: 'device', platform: 'web', level: 'info', event: 'web_navigation', marker: true },
    { ts: 13, src: 'device', platform: 'web', level: 'error', event: 'web_document_failed', msg: 'ERR_CERT' },
    { ts: 13, src: 'client', platform: 'web', level: 'error', event: 'web_exception', msg: 'page threw' },
  ]);
  expect(count()).toBe(3);

  append('web.ndjson', [
    { ts: 14, src: 'device', platform: 'web', level: 'info', event: 'web_navigation', marker: true },
  ]);
  expect(count()).toBe(1);

  append('build-ios.ndjson', [{ ts: 15, src: 'build', level: 'info', marker: true, platform: 'ios' }]);
  append('web.ndjson', [
    { ts: 14, src: 'device', platform: 'web', level: 'error', event: 'web_document_failed', msg: 'ERR_CERT' },
  ]);
  expect(count()).toBe(1);
});

test('an unterminated last line counts once its newline arrives', () => {
  const partial = JSON.stringify({ ts: 1, src: 'metro', level: 'error', msg: 'half' });
  writeFileSync(join(dir, 'metro.ndjson'), partial);
  expect(count()).toBe(0);

  appendFileSync(join(dir, 'metro.ndjson'), '\n');
  expect(count()).toBe(1);
});

test('counts an Expo bundling failure under its own platform, as logs --errors does', () => {
  write('build-android.ndjson', [{ ts: 10, src: 'build', level: 'info', marker: true, platform: 'android' }]);
  write('build-ios.ios18.ndjson', [
    { ts: 20, src: 'build', level: 'info', marker: true, platform: 'ios', slot: 'ios18' },
  ]);
  write('metro.ndjson', [
    { ts: 12, src: 'metro', level: 'info', raw: true, marker: true, msg: 'Android Bundled 640ms index.ts' },
    { ts: 25, src: 'metro', level: 'error', raw: true, marker: true, msg: 'iOS Bundling failed 90ms index.ts' },
  ]);
  append('build-android.ndjson', [{ ts: 27, src: 'build', level: 'info', marker: true, platform: 'android' }]);
  expect(count()).toBe(1);

  append('metro.ndjson', [
    { ts: 30, src: 'metro', level: 'info', raw: true, marker: true, msg: 'iOS Bundled 90ms index.ts' },
  ]);
  expect(count()).toBe(0);
});
