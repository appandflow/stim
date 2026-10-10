import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statfsSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import { BuildHost, type BuildLimits } from '../src/build.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const file = (path: string, text: string, size = text.length) => ({ path, kind: 'file', size, sha256: sha(text) });
const frame = (digest: string, bytes: string) => Buffer.concat([Buffer.from(digest, 'hex'), Buffer.from(bytes)]);

let home: string;
let root: string;
let host: BuildHost | null = null;

const start = (limits: Partial<BuildLimits> = {}) => {
  host = new BuildHost({ worker: 'unused', env: process.env, limits });
  return host;
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-build-limits-'));
  process.env.STIM_HOME = home;
  root = join(home, 'build-worker');
  mkdirSync(root, { recursive: true });
});

afterEach(async () => {
  await host?.close();
  host = null;
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

test('refuses build.sync while the worker volume is under its free floor', () => {
  const session = start({ minFreeBytes: Number.MAX_SAFE_INTEGER }).session('client', {} as WebSocket, () => {});
  expect(session.sync({ repo: 'app-1', files: [file('a', 'x')], done: true })).toHaveProperty(
    'error.code',
    'build-busy',
  );
});

test('refuses a blob whose declared size would take the worker volume under its free floor', () => {
  const stats = statfsSync(root);
  const free = stats.bavail * stats.bsize;
  const declared = 2 * 1024 ** 3;
  const session = start({ minFreeBytes: free - declared / 2 }).session('client', {} as WebSocket, () => {});
  expect(session.sync({ repo: 'app-1', files: [{ ...file('a', 'big'), size: declared }], done: true })).toHaveProperty(
    'result.missing',
    [sha('big')],
  );
  expect(session.blob(frame(sha('big'), 'b'))).toMatch(/declines the upload/);
  expect(existsSync(join(root, 'client', 'blobs'))).toBe(false);
});

test('caps the declared bytes of one manifest across its pages', () => {
  const session = start({ maxManifestBytes: 10 }).session('client', {} as WebSocket, () => {});
  expect(session.sync({ repo: 'app-1', files: [file('a', 'aaaaaa')], done: true })).toHaveProperty('result');
  expect(session.sync({ repo: 'app-1', files: [file('a', 'aaaaaa')], done: false })).toHaveProperty('result');
  expect(session.sync({ repo: 'app-1', files: [file('b', 'bbbbbb')], done: true })).toHaveProperty(
    'error.code',
    'limit-exceeded',
  );
});

test('refuses a blob that streams more bytes than its manifest entry declares', () => {
  const session = start().session('client', {} as WebSocket, () => {});
  session.sync({ repo: 'app-1', files: [file('a', 'x')], done: true });
  expect(session.blob(frame(sha('x'), 'xx'))).toMatch(/larger than its manifest entry/);
  expect(existsSync(join(root, 'client', 'blobs', sha('x').slice(0, 2), sha('x')))).toBe(false);
});

test("deletes a revoked client's area, but not through a symlink or outside the worker root", async () => {
  const host = start();
  mkdirSync(join(root, 'gone', 'repos', 'app-1', 'src'), { recursive: true });
  writeFileSync(join(root, 'gone', 'repos', 'app-1', 'src', 'a'), 'x');
  const outside = join(home, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep'), 'x');
  symlinkSync(outside, join(root, 'linked'));

  await host.remove('gone');
  await host.remove('linked');
  await host.remove('..');

  expect(existsSync(join(root, 'gone'))).toBe(false);
  expect(existsSync(join(outside, 'keep'))).toBe(true);
  expect(existsSync(root)).toBe(true);
});

test('prunes blobs no mirror or open manifest references, and none while a mirror is unreadable', () => {
  const host = start();
  const client = join(root, 'client');
  const blob = (text: string) => join(client, 'blobs', sha(text).slice(0, 2), sha(text));
  for (const text of ['mirrored', 'synced', 'stale']) {
    mkdirSync(join(blob(text), '..'), { recursive: true });
    writeFileSync(blob(text), text);
  }
  const incoming = join(client, 'blobs', '.incoming-upload');
  writeFileSync(incoming, 'partial');
  mkdirSync(join(client, 'repos', 'app-1'), { recursive: true });
  writeFileSync(
    join(client, 'repos', 'app-1', 'mirror.json'),
    JSON.stringify({ a: { sha256: sha('mirrored'), kind: 'file', mtimeMs: 0, size: 8 } }),
  );
  const session = host.session('client', {} as WebSocket, () => {});
  session.sync({ repo: 'app-2', files: [file('b', 'synced')], done: true });

  mkdirSync(join(client, 'repos', 'app-3'));
  writeFileSync(join(client, 'repos', 'app-3', 'mirror.json'), '{');
  host.pruneBlobs('client');
  expect(existsSync(blob('stale'))).toBe(true);

  rmSync(join(client, 'repos', 'app-3'), { recursive: true });
  host.pruneBlobs('client');
  expect(existsSync(blob('stale'))).toBe(false);
  expect(existsSync(blob('mirrored'))).toBe(true);
  expect(existsSync(blob('synced'))).toBe(true);
  expect(existsSync(incoming)).toBe(true);

  session.close(false);
  host.pruneBlobs('client');
  expect(existsSync(blob('synced'))).toBe(false);
});
