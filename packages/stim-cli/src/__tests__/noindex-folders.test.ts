import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { metroCacheRoot } from '@stim-cli/core';
import { sharedCcache, sharedCompilationCache, workspaceAgentDeviceDir } from '@stim-cli/core/state';
import * as identity from '../process-identity.ts';
import { cacheClaimRoot } from '../cache/cache-claim.ts';
import { releaseBuildSlot, tryAcquireBuildSlot } from '../engine/build-slots.ts';
import { releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import { leftoverNoindexCaches, migrateNoindexFolders } from '../workspace/noindex-folders.ts';
import { ensureWorkspaceStorage, workspaceDir } from '../workspace/paths.ts';

let home: string;
const root = '/repo/app';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-test-'));
  process.env.STIM_HOME = home;
  ensureWorkspaceStorage(root);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.STIM_HOME;
  delete process.env.STIM_METRO_CACHE;
  rmSync(home, { recursive: true, force: true });
});

function oldFolder(path: string): string {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'entry'), path);
  return path;
}

const moved = () => migrateNoindexFolders().filter((rename) => rename.moved);

test('a fresh home creates nothing and renames nothing', () => {
  expect(migrateNoindexFolders()).toEqual([]);
  expect(metroCacheRoot()).toBe(join(home, 'metro-cache.noindex'));
  expect(workspaceAgentDeviceDir(root)).toBe(join(workspaceDir(root), 'agent-device.noindex'));
});

test('an existing home moves each old folder once, with its contents and its cache registrations', () => {
  const folders = [
    oldFolder(join(home, 'compilation-cache')),
    oldFolder(join(home, 'ccache')),
    oldFolder(join(home, 'metro-cache', 'app')),
    oldFolder(join(workspaceDir(root), 'agent-device', 'sessions')),
  ];
  writeFileSync(
    join(home, 'caches.json'),
    JSON.stringify({
      version: 1,
      caches: [
        { dir: join(home, 'compilation-cache'), name: 'Xcode compilation cache', prune: 'atomic' },
        { dir: join(home, 'metro-cache', 'app'), name: 'Metro transform cache', prune: 'entries' },
      ],
    }),
  );

  expect(moved().map((rename) => rename.to)).toEqual([
    join(home, 'compilation-cache.noindex'),
    join(home, 'ccache.noindex'),
    join(home, 'metro-cache.noindex'),
    join(workspaceDir(root), 'agent-device.noindex'),
  ]);
  expect(migrateNoindexFolders()).toEqual([]);
  for (const folder of folders) {
    expect(existsSync(folder)).toBe(false);
    const renamed = folder.replace(/(compilation-cache|ccache|metro-cache|agent-device)(?=\/|$)/, '$1.noindex');
    expect(readFileSync(join(renamed, 'entry'), 'utf8')).toBe(folder);
  }
  expect(sharedCompilationCache()).toBe(join(home, 'compilation-cache.noindex'));
  expect(sharedCcache()).toBe(join(home, 'ccache.noindex'));
  expect(workspaceAgentDeviceDir(root)).toBe(join(workspaceDir(root), 'agent-device.noindex'));
  const caches = JSON.parse(readFileSync(join(home, 'caches.json'), 'utf8')).caches.map(
    (cache: { dir: string }) => cache.dir,
  );
  expect(caches).toEqual([join(home, 'compilation-cache.noindex'), join(home, 'metro-cache.noindex', 'app')]);
  expect(leftoverNoindexCaches()).toEqual([]);
});

test('an old folder beside its new name is left alone and reported as a leftover cache', () => {
  oldFolder(join(home, 'compilation-cache'));
  oldFolder(join(home, 'compilation-cache.noindex'));
  oldFolder(join(workspaceDir(root), 'agent-device'));
  oldFolder(join(workspaceDir(root), 'agent-device.noindex'));

  expect(migrateNoindexFolders()).toEqual([]);
  expect(readFileSync(join(home, 'compilation-cache', 'entry'), 'utf8')).toBe(join(home, 'compilation-cache'));
  expect(readFileSync(join(home, 'compilation-cache.noindex', 'entry'), 'utf8')).toBe(
    join(home, 'compilation-cache.noindex'),
  );
  expect(existsSync(join(workspaceDir(root), 'agent-device', 'entry'))).toBe(true);
  expect(leftoverNoindexCaches()).toEqual([{ dir: join(home, 'compilation-cache'), category: 'compilation-cache' }]);
});

test('an agent-device daemon that may still run keeps its state directory until it stops', () => {
  const old = oldFolder(join(workspaceDir(root), 'agent-device'));
  writeFileSync(
    join(old, 'daemon.json'),
    JSON.stringify({ pid: process.pid, processStartTime: '2026-11-01T05:50:03Z' }),
  );
  vi.spyOn(identity, 'inspectProcessStart').mockReturnValue({
    status: 'running',
    startedAtMs: Date.parse('2026-11-01T05:50:03Z'),
  });

  expect(migrateNoindexFolders()).toEqual([
    {
      from: old,
      to: join(workspaceDir(root), 'agent-device.noindex'),
      moved: false,
      kept: 'its agent-device daemon may be running',
    },
  ]);
  expect(workspaceAgentDeviceDir(root)).toBe(old);

  rmSync(join(old, 'daemon.json'));
  writeFileSync(join(old, 'daemon.lock'), '');
  expect(migrateNoindexFolders()[0]).toMatchObject({ moved: false, kept: 'its agent-device daemon may be starting' });

  rmSync(join(old, 'daemon.lock'));
  expect(moved().map((rename) => rename.from)).toEqual([old]);
  expect(existsSync(join(workspaceDir(root), 'agent-device.noindex', 'entry'))).toBe(true);
});

test('a build that holds the compilation cache and a dev server that holds its Metro claim keep their folders', () => {
  const compilation = oldFolder(join(home, 'compilation-cache'));
  oldFolder(join(home, 'metro-cache'));
  const build = tryAcquireClaim({ root: cacheClaimRoot(compilation), mode: 'shared', label: 'cache' }).acquired;
  const metro = tryAcquireClaim({
    root: join(workspaceDir(root), 'metro.claim'),
    mode: 'exclusive',
    label: 'Metro',
  }).acquired;

  const kept = migrateNoindexFolders();
  expect(kept.map((rename) => [rename.from, rename.moved])).toEqual([
    [compilation, false],
    [join(home, 'metro-cache'), false],
  ]);
  expect(sharedCompilationCache()).toBe(compilation);

  releaseClaim(build);
  releaseClaim(metro);
  expect(moved().map((rename) => rename.from)).toEqual([compilation, join(home, 'metro-cache')]);
});

test('a running build keeps ccache, which no build claims, under its old name', () => {
  const ccache = oldFolder(join(home, 'ccache'));
  const slot = tryAcquireBuildSlot({ max: 2, root: '/w/android' });

  expect(migrateNoindexFolders()).toEqual([
    { from: ccache, to: join(home, 'ccache.noindex'), moved: false, kept: 'a running build holds build slot 0' },
  ]);

  releaseBuildSlot(slot);
  expect(moved().map((rename) => rename.from)).toEqual([ccache]);
});

test('a Metro cache root a setting or the environment names, and an old folder that is a link, stay as they are', () => {
  const linked = join(home, 'ccache');
  symlinkSync(oldFolder(join(home, 'elsewhere')), linked, 'junction');
  oldFolder(join(home, 'metro-cache'));
  process.env.STIM_METRO_CACHE = join(home, 'metro-cache');
  expect(migrateNoindexFolders()).toEqual([]);
  delete process.env.STIM_METRO_CACHE;
  writeFileSync(join(home, 'config.json'), JSON.stringify({ caches: { metroCache: join(home, 'metro-cache') } }));

  expect(migrateNoindexFolders()).toEqual([]);
  expect(metroCacheRoot()).toBe(join(home, 'metro-cache'));
  expect(sharedCcache()).toBe(linked);
  expect(existsSync(join(home, 'metro-cache.noindex'))).toBe(false);
  expect(existsSync(join(home, 'ccache.noindex'))).toBe(false);
});
