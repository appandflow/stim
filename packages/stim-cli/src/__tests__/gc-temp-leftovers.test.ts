import {
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as gcDevices from '../commands/gc/devices.ts';
import { collectTempLeftovers, deleteTempLeftovers } from '../commands/gc/temp-leftovers.ts';
import { takeGcResults } from '../commands/gc/results.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { executeAction } from '../maintenance/act.ts';
import { planPressureLevels } from '../maintenance/levels.ts';
import { resolveMaintenanceSettings } from '../maintenance/settings.ts';
import { saveConfig, upsertProject } from '../workspace/config.ts';
import * as claims from '@stim-cli/core/ownership-claim';
import { liveClaimOwner, plantClaim } from './_factories.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const POSIX = process.platform !== 'win32';

let home: string;
let fakeTmp: string;
let outside: string;
let processes: string;
const TMP_KEYS = ['TMPDIR', 'TEMP', 'TMP'] as const;
const realTmp = Object.fromEntries(TMP_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-test-')));
  fakeTmp = join(home, 'tmp');
  outside = join(home, 'outside');
  mkdirSync(fakeTmp);
  mkdirSync(outside);
  process.env.STIM_HOME = join(home, 'stim');
  for (const key of TMP_KEYS) process.env[key] = fakeTmp;
  saveConfig({ version: 2, projects: {}, repos: {} });
  processes = '/sbin/launchd\n/usr/bin/node\n';
  setExecutor({
    ...getExecutor(),
    runFile: (file: string) => {
      if (file === 'ps') return processes;
      throw new Error(`unexpected ${file}`);
    },
  });
  vi.spyOn(gcDevices, 'deviceSweepIsScoped').mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetExecutor();
  takeGcResults();
  for (const key of TMP_KEYS) {
    const value = realTmp[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete process.env.STIM_HOME;
  rmSync(home, { recursive: true, force: true });
});

function age(path: string, ms: number) {
  const when = new Date(Date.now() - ms);
  if (lstatSync(path).isDirectory()) for (const name of readdirSync(path)) age(join(path, name), ms);
  lutimesSync(path, when, when);
}

function oldDir(name: string, files: Record<string, string> = {}): string {
  const dir = join(fakeTmp, name);
  mkdirSync(dir);
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  age(dir, 2 * DAY_MS);
  return dir;
}

function leftovers() {
  return collectTempLeftovers()?.entries ?? [];
}

function kept(path: string) {
  return leftovers().find((entry) => entry.path === path)?.kept;
}

test('only recognized Stim temp directories and xctrace recordings idle for a day are deleted', () => {
  const idle = oldDir('stim-claim-AbC123', { 'note.txt': 'x' });
  const recent = oldDir('stim-ws-recent');
  writeFileSync(join(recent, 'package.json'), '{}');
  const trace = join(fakeTmp, 'instruments5D1A.ktrace');
  writeFileSync(trace, 'trace');
  age(trace, 2 * DAY_MS);
  const unrelated = oldDir('stim-s3-test-abc123');
  const other = oldDir('metro-cache');

  expect(collectTempLeftovers()?.root).toBe(realpathSync(fakeTmp));
  expect(leftovers().map((entry) => [entry.path, entry.willDelete])).toEqual([
    [trace, true],
    [idle, true],
    [recent, false],
  ]);
  expect(kept(recent)).toMatch(/24h/);

  expect(deleteTempLeftovers()).toEqual({ count: 2, bytes: expect.any(Number), failures: 0 });
  expect([existsSync(idle), existsSync(trace)]).toEqual([false, false]);
  expect([existsSync(recent), existsSync(unrelated), existsSync(other)]).toEqual([true, true, true]);
});

test.skipIf(!POSIX)('a symlink is never followed, at the top level or inside a deleted directory', () => {
  const target = join(outside, 'keep.txt');
  writeFileSync(target, 'keep');
  mkdirSync(join(outside, 'stim-ws-target'));
  symlinkSync(join(outside, 'stim-ws-target'), join(fakeTmp, 'stim-ws-link'));
  const dir = oldDir('stim-fakehome-AbC123');
  symlinkSync(target, join(dir, 'link'));
  symlinkSync(outside, join(dir, 'dirlink'));
  age(dir, 2 * DAY_MS);

  expect(leftovers().map((entry) => entry.path)).toEqual([dir]);
  deleteTempLeftovers();

  expect(existsSync(dir)).toBe(false);
  expect(existsSync(target)).toBe(true);
  expect(existsSync(join(outside, 'stim-ws-target'))).toBe(true);
});

test('a Stim temp directory with a live claim or a registered project inside is kept', () => {
  const claimed = oldDir('stim-claim-live');
  plantClaim(join(claimed, 'build.lock'), 'exclusive', liveClaimOwner());
  age(claimed, 2 * DAY_MS);
  const registered = oldDir('stim-ws-project');
  upsertProject(join(registered.replace(/^\/private\//, '/'), 'gone-app'), { metroPort: 8100 });
  age(registered, 2 * DAY_MS);

  expect(kept(claimed)).toMatch(/live ownership claim/);
  expect(kept(registered)).toMatch(/registered project/);
  expect(deleteTempLeftovers().count).toBe(0);
  expect([existsSync(claimed), existsSync(registered)]).toEqual([true, true]);
});

test('a lock directory with no verifiable owner keeps its Stim temp directory', () => {
  const dir = oldDir('stim-ws-legacy');
  mkdirSync(join(dir, 'build.lock'));
  age(dir, 2 * DAY_MS);

  expect(kept(dir)).toMatch(/no verifiable owner/);
  expect(deleteTempLeftovers().count).toBe(0);
  expect(existsSync(dir)).toBe(true);
});

test('a claim taken after the scan keeps the directory, under its own name', () => {
  const dir = oldDir('stim-claim-race');
  mkdirSync(join(dir, 'build.lock', 'exclusive'), { recursive: true });
  age(dir, 2 * DAY_MS);
  const held = join(outside, 'held.lock');
  plantClaim(held, 'exclusive', liveClaimOwner());
  const live = claims.readClaimSet(held);
  vi.spyOn(claims, 'readClaimSet')
    .mockReturnValueOnce({ live: [], dead: [], unresolved: [], orphans: [] })
    .mockReturnValue(live);

  expect(deleteTempLeftovers().count).toBe(0);
  expect(existsSync(dir)).toBe(true);
  expect(takeGcResults()).toEqual([expect.objectContaining({ status: 'kept', label: dir })]);
});

test('xctrace recordings stay while xctrace or Instruments runs, or when processes cannot be listed', () => {
  const trace = join(fakeTmp, 'instrumentsAbC.ktrace');
  writeFileSync(trace, 'trace');
  age(trace, 2 * DAY_MS);

  let calls = 0;
  setExecutor({
    ...getExecutor(),
    runFile: () => (calls++ === 0 ? '/usr/bin/node\n' : '/Applications/Xcode.app/Contents/Developer/usr/bin/xctrace\n'),
  });
  expect(deleteTempLeftovers().count).toBe(0);
  expect(existsSync(trace)).toBe(true);
  setExecutor({ ...getExecutor(), runFile: () => processes });

  processes = '/Applications/Xcode.app/Contents/Developer/usr/bin/xctrace\n';
  expect(kept(trace)).toBe('xctrace is running');
  processes = '/Applications/Xcode.app/Contents/Applications/Instruments.app/Contents/MacOS/Instruments\n';
  expect(kept(trace)).toBe('Instruments is running');
  setExecutor({
    ...getExecutor(),
    runFile: () => {
      throw new Error('ps failed');
    },
  });
  expect(kept(trace)).toBe('the running processes could not be listed');
  expect(deleteTempLeftovers().count).toBe(0);
  expect(existsSync(trace)).toBe(true);
});

test.skipIf(!POSIX)("Jest's cache is reported and never deleted", () => {
  const jest = oldDir(`jest_${process.getuid?.().toString(36)}`, { 'haste-map': 'x' });
  setExecutor({ ...getExecutor(), runFile: (file: string) => (file === 'du' ? `12\t${jest}\n` : processes) });

  expect(leftovers()).toEqual([
    { kind: 'jest', path: jest, bytes: 12 * 1024, willDelete: false, kept: 'report only: Jest owns it' },
  ]);
  deleteTempLeftovers();
  expect(existsSync(jest)).toBe(true);
});

test('a STIM_HOME-scoped run neither reports nor deletes TMPDIR leftovers', () => {
  vi.mocked(gcDevices.deviceSweepIsScoped).mockReturnValue(true);
  const idle = oldDir('stim-host-871a9a');

  expect(collectTempLeftovers()).toBeNull();
  expect(deleteTempLeftovers().count).toBe(0);
  expect(existsSync(idle)).toBe(true);
});

test('maintenance at disk pressure level 2 plans and deletes the idle leftovers', async () => {
  const idle = oldDir('stim-server-AbC123', { 'state.json': '{}' });
  const recent = join(fakeTmp, 'stim-server-recent');
  mkdirSync(recent);
  const settings = { ...resolveMaintenanceSettings(null, { STIM_MAINTENANCE: 'on' }), removeFinishedWorktrees: false };

  const planned = await planPressureLevels(2, {
    settings,
    sizes: [],
    protectedRoot: '',
    pinned: () => false,
    now: Date.now(),
  });
  const action = planned.actions.find((entry) => entry.kind === 'would-delete-temp-leftovers');
  expect(action).toEqual(expect.objectContaining({ target: realpathSync(fakeTmp), level: 2 }));
  if (!action) return;

  const outcome = await executeAction(action, {
    settings,
    budget: { minFreeDiskMb: 0, hardFloorDiskMb: 0, maxCommittedMemoryMb: 0, maxLiveWorkspaces: 0 },
    protectedRoot: '',
  });
  expect(outcome).toEqual(expect.objectContaining({ status: 'done', detail: '1 deleted' }));
  expect([existsSync(idle), existsSync(recent)]).toEqual([false, true]);
});
