import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { discoveryScanFile, readDiscoveryScan, type Config, type DiscoveryScan } from '@stim-cli/core/state';
import { runDiscoveryScanIfDue, scanForCheckouts } from '../workspace/discovery-scan.ts';
import { recognition, targetedCheckouts } from '../workspace/discovery.ts';
import {
  REAL_RECOGNITION_IO,
  scanEntryValid,
  scanMetadata,
  sameScanIdentity,
  targetedScanSkipper,
} from '../workspace/scan-rules.ts';
import { saveConfig } from '../workspace/config.ts';
import * as git from '../workspace/git.ts';
import * as gcPaths from '../commands/gc/paths.ts';
import { testContext } from './_context.ts';

vi.mock('../workspace/protected-locations.ts', () => ({ isProtectedLocation: () => false }));

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, readdirSync: vi.fn<typeof fs.readdirSync>(fs.readdirSync) };
});
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, readdir: vi.fn<typeof fs.readdir>(fs.readdir), realpath: vi.fn<typeof fs.realpath>(fs.realpath) };
});

let home: string;
const config: Config = { projects: {}, repos: {}, maintenance: { autoDiscover: true } };
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-scan-proof-')));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('STIM_HOME', '');
  saveConfig(config);
  vi.spyOn(git, 'gitAsync').mockRejectedValue(new Error('not a repository'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function app() {
  const root = join(home, 'Developer', 'mobile');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
  return root;
}

async function refresh(now = Date.now(), low = false): Promise<DiscoveryScan> {
  await runDiscoveryScanIfDue(
    {
      operation: testContext({ env: {} }),
      measured: { measurement: { disk: [{ volume: '/', freeMb: low ? 1 : 500_000 }] } },
    },
    { home, now, attempted: { at: 0 } },
  );
  const scan = readDiscoveryScan();
  if (!scan) throw new Error('normal discovery scan did not publish');
  return scan;
}

function clearListings() {
  vi.mocked(readdir).mockClear();
  vi.mocked(readdirSync).mockClear();
}
function expectNoParentListings(root: string) {
  const parents = new Set([home, dirname(root)]);
  expect(
    vi
      .mocked(readdir)
      .mock.calls.map(([path]) => String(path))
      .filter((path) => parents.has(path)),
  ).toEqual([]);
  expect(
    vi
      .mocked(readdirSync)
      .mock.calls.map(([path]) => String(path))
      .filter((path) => parents.has(path)),
  ).toEqual([]);
}

test('a normal scan-only root is authorized by current named ancestor evidence without parent enumeration', async () => {
  const root = app();
  const scan = await refresh();
  expect(scan.found).toContain(root);
  expect(scan.safety?.[home]?.mtimeNs).toMatch(/^\d+$/);
  clearListings();
  const before = readFileSync(discoveryScanFile(), 'utf8');
  expect(await targetedCheckouts(config, [], [root])).toMatchObject([{ path: root, origin: 'scan', reduceOnly: true }]);
  expectNoParentListings(root);
  expect(readFileSync(discoveryScanFile(), 'utf8')).toBe(before);
});

test('a new ancestor wildcard sentinel keeps the mark until the normal low-disk refresh proves the route again', async () => {
  const root = app();
  const now = Date.now();
  await refresh(now);
  const sentinel = join(dirname(root), 'NewApp.xcodeproj');
  mkdirSync(sentinel);
  clearListings();
  expect(await targetedCheckouts(config, [], [root])).toEqual([]);
  expectNoParentListings(root);
  expect(readDiscoveryScan()?.ranAt).toBe(now);
  const unsafe = await refresh(now + 3_600_000, true);
  expect(unsafe.found).not.toContain(root);
  rmSync(sentinel, { recursive: true });
  await refresh(now + 7_200_000, true);
  clearListings();
  expect((await targetedCheckouts(config, [], [root])).map(({ path }) => path)).toEqual([root]);
  expectNoParentListings(root);
});

test('in-place manifest changes are read even while the directory fingerprint is unchanged', async () => {
  const root = app();
  await refresh();
  const before = (await scanMetadata(root)).identity;
  if (!before) throw new Error('fixture directory has no identity');
  writeFileSync(join(root, 'package.json'), '{}');
  expect(sameScanIdentity(before, (await scanMetadata(root)).identity)).toBe(true);
  clearListings();
  expect(await targetedCheckouts(config, [], [root])).toEqual([]);
  expectNoParentListings(root);
});

test('an unreadable current ancestor sentinel keeps the root without an ancestor listing', async () => {
  const root = app();
  const parent = dirname(root);
  writeFileSync(join(parent, 'package.json'), '{}');
  const scan = await refresh();
  const io = {
    ...REAL_RECOGNITION_IO,
    readText: async (path: string) => {
      if (path === join(parent, 'package.json')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return REAL_RECOGNITION_IO.readText(path);
    },
  };
  clearListings();
  expect(
    await scanEntryValid(root, {
      home,
      isCheckout: recognition,
      skip: () => false,
      proofs: scan.safety,
      identity: scan.safety?.[root]?.native,
      io,
    }),
  ).toBe('pending');
  expectNoParentListings(root);
});

test('legacy or changed scan membership cannot acquire safety evidence during pressure lookup', async () => {
  const root = app();
  const scan = await refresh();
  for (const saved of [
    { ...scan, safety: undefined },
    { ...scan, found: [] },
  ]) {
    writeFileSync(discoveryScanFile(), JSON.stringify(saved));
    clearListings();
    expect(await targetedCheckouts(config, [], [root])).toEqual([]);
    expectNoParentListings(root);
  }
});

test('native identity aliases preserve the original mark key and still honor registered coverage', async () => {
  const root = app();
  const registered = join(root, 'src');
  mkdirSync(registered);
  await refresh();
  const alias = join(dirname(root), 'MOBILE');
  vi.mocked(realpath).mockResolvedValueOnce(root);
  expect((await targetedCheckouts(config, [], [alias])).map(({ path }) => path)).toEqual([alias]);
  vi.mocked(realpath).mockResolvedValueOnce(root);
  expect(await targetedCheckouts(config, [registered], [alias])).toEqual([]);
});

test('links and changed volume identity remain ineligible with saved safety proof', async () => {
  const root = app();
  const scan = await refresh();
  const io = {
    ...REAL_RECOGNITION_IO,
    stat: async (path: string) => {
      const info = await REAL_RECOGNITION_IO.stat(path);
      return { isDirectory: () => info.isDirectory(), dev: path === root ? info.dev + 1 : info.dev };
    },
  };
  expect(
    await scanEntryValid(root, { home, isCheckout: recognition, skip: () => false, proofs: scan.safety, io }),
  ).toBe('invalid');
  const moved = join(dirname(root), 'moved');
  renameSync(root, moved);
  symlinkSync(moved, root, process.platform === 'win32' ? 'junction' : 'dir');
  expect(await targetedCheckouts(config, [], [root])).toEqual([]);
});

test('a changed directory during scan proof capture never publishes the earlier listing as current evidence', async () => {
  const root = app();
  const io = {
    ...REAL_RECOGNITION_IO,
    metadata: async (path: string) => {
      if (path === home) mkdirSync(join(home, 'Changed.xcodeproj'), { recursive: true });
      return REAL_RECOGNITION_IO.metadata(path);
    },
  };
  const scan = await scanForCheckouts(home, recognition, { recognition: io });
  expect(scan.found).toContain(root);
  expect(scan.safety?.[root]).toBeUndefined();
});

test('a normal scan-only native-Android repository is authorized without ancestor enumeration', async () => {
  const root = join(home, 'Developer', 'native');
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, 'settings.gradle'), 'rootProject.name = "fixture"');
  writeFileSync(join(root, 'gradlew'), '#!/bin/sh\n');
  const scan = await refresh();
  expect(scan.found).toContain(root);
  clearListings();
  expect((await targetedCheckouts(config, [], [root])).map(({ path }) => path)).toEqual([root]);
  expectNoParentListings(root);
});

test('each sibling mark rechecks ancestor evidence changed after the first root check', async () => {
  const first = app();
  const second = join(dirname(first), 'second');
  mkdirSync(second);
  writeFileSync(join(second, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
  await refresh();
  const read = readdir;
  const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(read).mockImplementation(async (path, options) => {
    if (String(path) === first) mkdirSync(join(dirname(first), 'NewApp.xcodeproj'), { recursive: true });
    return native.readdir(path, options);
  });
  clearListings();
  expect((await targetedCheckouts(config, [], [first, second])).map(({ path }) => path)).toEqual([first]);
  expectNoParentListings(first);
});

test('unrelated scan state never resolves the build-worker exclusion', async () => {
  const root = app();
  await refresh();
  const pathReader = vi.spyOn(gcPaths, 'realpathAsync');
  writeFileSync(discoveryScanFile(), JSON.stringify({ ...readDiscoveryScan(), found: [] }));
  const configured = { ...config, maintenance: { autoDiscover: true, discoverRoots: [dirname(root)] } };
  expect((await targetedCheckouts(configured, [], [root])).map(({ path }) => path)).toEqual([root]);
  expect(pathReader).not.toHaveBeenCalled();
});

test('a stalled required exclusion read stays bounded and keeps scan-only authorization pending', async () => {
  let release: (path: string) => void = () => {};
  vi.spyOn(gcPaths, 'realpathAsync').mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
  );
  const result = targetedScanSkipper(home).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(3000);
  expect(await result).toMatchObject({ message: 'timed out' });
  release(home);
  await vi.advanceTimersByTimeAsync(0);
});

test('an in-place React Native ownership change keeps its saved native Android root', async () => {
  const parent = join(home, 'Developer', 'mobile');
  const root = join(parent, 'android');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(parent, 'package.json'), '{}');
  writeFileSync(join(root, 'settings.gradle'), 'rootProject.name = "fixture"');
  writeFileSync(join(root, 'gradlew'), '#!/bin/sh\n');
  const scan = await refresh();
  expect(scan.found).toContain(root);
  writeFileSync(join(parent, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '*' } }));
  clearListings();
  expect(await targetedCheckouts(config, [], [root])).toEqual([]);
  expectNoParentListings(root);
});

test('a canonical conventional-root alias above home keeps the saved native Android root', async () => {
  const owner = home;
  try {
    home = join(owner, 'agent-home');
    mkdirSync(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    saveConfig(config);
    const root = join(home, 'Developer', 'native');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'settings.gradle'), 'rootProject.name = "fixture"');
    writeFileSync(join(root, 'gradlew'), '#!/bin/sh\n');
    writeFileSync(join(owner, 'package.json'), '{}');
    symlinkSync(root, join(owner, 'android'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await refresh()).found).toContain(root);
    writeFileSync(join(owner, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
    clearListings();
    expect(await targetedCheckouts(config, [], [root])).toEqual([]);
    expectNoParentListings(root);
    expect(vi.mocked(readdirSync).mock.calls.map(([path]) => String(path))).not.toContain(owner);
    expect(vi.mocked(readdir).mock.calls.map(([path]) => String(path))).not.toContain(owner);
  } finally {
    home = owner;
  }
});

test('unreadable named ownership evidence keeps a native candidate without parent enumeration', async () => {
  const root = join(home, 'Developer', 'native');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'settings.gradle'), 'rootProject.name = "fixture"');
  writeFileSync(join(root, 'gradlew'), '#!/bin/sh\n');
  const scan = await refresh();
  const actual = REAL_RECOGNITION_IO.lstat;
  const io = {
    ...REAL_RECOGNITION_IO,
    lstat: (path: string) =>
      path === join(dirname(root), 'package.json')
        ? Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }))
        : actual(path),
  };
  clearListings();
  expect(
    await scanEntryValid(root, {
      home,
      isCheckout: recognition,
      skip: () => false,
      proofs: scan.safety,
      identity: scan.safety?.[root]?.native,
      io,
    }),
  ).toBe('pending');
  expectNoParentListings(root);
});

test('cancellation interrupts a pending named ownership read and contains its read slot', async () => {
  const root = join(home, 'Developer', 'native');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'settings.gradle'), 'rootProject.name = "fixture"');
  writeFileSync(join(root, 'gradlew'), '#!/bin/sh\n');
  const scan = await refresh();
  let started: () => void = () => {};
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release: (error: Error) => void = () => {};
  const actual = REAL_RECOGNITION_IO.lstat;
  const io = {
    ...REAL_RECOGNITION_IO,
    lstat: (path: string) => {
      if (path !== join(dirname(root), 'package.json')) return actual(path);
      started();
      return new Promise<never>((_, reject) => {
        release = reject;
      });
    },
  };
  const controller = new AbortController();
  clearListings();
  const result = scanEntryValid(root, {
    home,
    isCheckout: recognition,
    skip: () => false,
    proofs: scan.safety,
    identity: scan.safety?.[root]?.native,
    io,
    signal: controller.signal,
  }).catch((error: unknown) => error);
  await began;
  const reason = new Error('owned cancellation');
  controller.abort(reason);
  expect(await result).toBe(reason);
  release(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  await vi.advanceTimersByTimeAsync(0);
  expectNoParentListings(root);
});

test('distinct case-sensitive project containers never share an ownership proof', async (context) => {
  const root = join(home, 'Developer', 'monorepo');
  const upper = join(root, 'Apps', 'android');
  const lower = join(root, 'apps', 'android');
  for (const folder of [upper, lower]) {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'settings.gradle'), 'rootProject.name = "fixture"');
    writeFileSync(join(folder, 'gradlew'), '#!/bin/sh\n');
  }
  if ((await realpath(upper)) === (await realpath(lower))) context.skip();
  writeFileSync(join(root, 'apps', 'package.json'), '{}');
  expect((await refresh()).found).toContain(root);
  writeFileSync(join(root, 'apps', 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
  expect(recognition(root)).toBe(false);
  clearListings();
  expect(await targetedCheckouts(config, [], [root])).toEqual([]);
  expectNoParentListings(root);
});

test('an unproved Gradle child leaves an independently recognized Expo sibling available', async () => {
  const root = join(home, 'Developer', 'monorepo');
  const mobile = join(root, 'apps', 'mobile');
  const native = join(root, 'apps', 'native');
  mkdirSync(mobile, { recursive: true });
  mkdirSync(native);
  writeFileSync(join(mobile, 'package.json'), JSON.stringify({ dependencies: { expo: '*' } }));
  writeFileSync(join(native, 'settings.gradle'), 'rootProject.name = "fixture"');
  writeFileSync(join(native, 'gradlew'), '#!/bin/sh\n');
  writeFileSync(join(home, 'Developer', 'package.json'), '{');
  expect((await refresh()).found).toContain(root);
  expect(recognition(root)).toBe(true);
  clearListings();
  expect((await targetedCheckouts(config, [], [root])).map(({ path }) => path)).toEqual([root]);
  expectNoParentListings(root);
});

test('a case-insensitive container alias reuses proof only after canonical identity checks', async (context) => {
  const root = join(home, 'Developer', 'monorepo');
  const upper = join(root, 'Apps', 'native');
  const lower = join(root, 'apps', 'native');
  mkdirSync(upper, { recursive: true });
  writeFileSync(join(upper, 'settings.gradle'), 'rootProject.name = "fixture"');
  writeFileSync(join(upper, 'gradlew'), '#!/bin/sh\n');
  try {
    if ((await realpath(upper)) !== (await realpath(lower))) context.skip();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') context.skip();
    throw error;
  }
  expect((await refresh()).found).toContain(root);
  vi.mocked(realpath).mockClear();
  clearListings();
  expect((await targetedCheckouts(config, [], [root])).map(({ path }) => path)).toEqual([root]);
  expect(vi.mocked(realpath)).toHaveBeenCalledWith(upper);
  expect(vi.mocked(realpath)).toHaveBeenCalledWith(lower);
  expectNoParentListings(root);
});
