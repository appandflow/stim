import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectTrash, deleteTrash } from '../commands/gc/trash.ts';
import { takeGcResults } from '../commands/gc/results.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { executeAction } from '../stimd/passes/act.ts';
import { resolveMaintenanceSettings } from '../stimd/passes/settings.ts';
import { goneClaimOwner, liveClaimOwner, plantClaim } from './_factories.ts';

const POSIX = process.platform !== 'win32';

let base: string;
let trash: string;

beforeEach(() => {
  resetExecutor();
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-test-trash-')));
  process.env.STIM_HOME = join(base, 'stim');
  trash = join(base, 'stim', 'trash');
});

afterEach(() => {
  takeGcResults();
  delete process.env.STIM_HOME;
  rmSync(base, { recursive: true, force: true });
});

test.skipIf(!POSIX)('gc --delete keeps a trash directory Stim did not write', async () => {
  const noManifest = join(trash, 'remove-nomanifest');
  const malformed = join(trash, 'remove-malformed');
  const incomplete = join(trash, 'remove-incomplete');
  const foreign = join(trash, 'stray');
  const crashed = join(trash, 'remove-crashed');
  for (const dir of [noManifest, malformed, incomplete, foreign, crashed]) {
    mkdirSync(join(dir, 'entries', '0'), { recursive: true });
    writeFileSync(join(dir, 'entries', '0', 'file'), 'z');
  }
  writeFileSync(join(malformed, 'trash.json'), '{not json');
  writeFileSync(join(incomplete, 'trash.json'), JSON.stringify({ worktree: '/w/a' }));
  const valid = JSON.stringify({ worktree: '/w/b', createdAt: 'T' });
  writeFileSync(join(foreign, 'trash.json'), valid);
  writeFileSync(join(crashed, 'trash.json'), valid);

  const report = await collectTrash();
  expect(report?.entries.filter((entry) => entry.willDelete).map((entry) => entry.path)).toEqual([crashed]);
  for (const dir of [noManifest, malformed, incomplete, foreign])
    expect(report?.entries.find((entry) => entry.path === dir)?.kept).toMatch(/trash\.json/);

  const done = await deleteTrash(undefined);

  expect(done).toMatchObject({ count: 1, failures: 0 });
  expect(existsSync(crashed)).toBe(false);
  for (const dir of [noManifest, malformed, incomplete, foreign])
    expect(existsSync(join(dir, 'entries', '0', 'file'))).toBe(true);
});

function plantEntry(name: string, worktree: string): string {
  const dir = join(trash, name);
  mkdirSync(join(dir, 'entries', '0'), { recursive: true });
  writeFileSync(join(dir, 'entries', '0', 'file'), 'w');
  writeFileSync(join(dir, 'trash.json'), JSON.stringify({ worktree, createdAt: 'T' }));
  return dir;
}

test.skipIf(!POSIX)('gc keeps the trash of a worktree that still exists until the worktree is gone', async () => {
  const worktree = join(base, 'survivor');
  mkdirSync(worktree);
  const interrupted = plantEntry('remove-interrupted', worktree);
  plantClaim(join(interrupted, 'claims'), 'exclusive', goneClaimOwner());

  const report = await collectTrash();
  const entry = report?.entries.find((item) => item.path === interrupted);
  expect(entry?.willDelete).toBe(false);
  expect(entry?.kept).toContain(worktree);
  expect(entry?.bytes).toBeGreaterThan(0);

  expect(await deleteTrash(undefined)).toMatchObject({
    count: 0,
    failures: 0,
  });
  expect(existsSync(join(interrupted, 'entries', '0', 'file'))).toBe(true);

  rmSync(worktree, { recursive: true });
  expect(await deleteTrash(undefined)).toMatchObject({
    count: 1,
    failures: 0,
  });
  expect(existsSync(interrupted)).toBe(false);
});

test.skipIf(!POSIX)('gc deletes the trash a crashed warm left although its worktree still exists', async () => {
  const worktree = join(base, 'warmed');
  mkdirSync(worktree);
  const crashed = plantEntry('remove-warm-crashed', worktree);
  writeFileSync(join(crashed, 'trash.json'), JSON.stringify({ worktree, createdAt: 'T', kind: 'warm' }));
  plantClaim(join(crashed, 'claims'), 'exclusive', goneClaimOwner());
  const live = plantEntry('remove-warm-live', worktree);
  writeFileSync(join(live, 'trash.json'), JSON.stringify({ worktree, createdAt: 'T', kind: 'warm' }));
  plantClaim(join(live, 'claims'), 'exclusive', liveClaimOwner());

  const report = await collectTrash();
  expect(report?.entries.find((item) => item.path === crashed)).toMatchObject({ willDelete: true, kept: null });
  expect(report?.entries.find((item) => item.path === live)?.willDelete).toBe(false);

  expect(await deleteTrash(undefined)).toMatchObject({ count: 1, failures: 0 });
  expect(existsSync(crashed)).toBe(false);
  expect(existsSync(join(live, 'entries', '0', 'file'))).toBe(true);
});

test.skipIf(!POSIX || process.getuid?.() === 0)('gc keeps the trash of a worktree it cannot prove gone', async () => {
  const parent = join(base, 'unreadable');
  mkdirSync(join(parent, 'worktree'), { recursive: true });
  const entry = plantEntry('remove-unprovable', join(parent, 'worktree'));
  chmodSync(parent, 0o000);
  try {
    const report = await collectTrash();
    const found = report?.entries.find((item) => item.path === entry);
    expect(found?.willDelete).toBe(false);
    expect(found?.kept).toMatch(/cannot be checked \(EACCES\)/);
  } finally {
    chmodSync(parent, 0o755);
  }
});

test.skipIf(!POSIX)('gc keeps a trash entry whose ownership claim cannot be verified', async () => {
  const entry = plantEntry('remove-unresolved', join(base, 'gone'));
  const claim = plantClaim(join(entry, 'claims'), 'exclusive', {
    pid: process.pid,
    processToken: 'bad',
  });

  const report = await collectTrash();
  const found = report?.entries.find((item) => item.path === entry);
  expect(found?.willDelete).toBe(false);
  expect(found?.kept).toContain(claim);

  expect(await deleteTrash(undefined)).toMatchObject({
    count: 0,
    failures: 0,
  });
  expect(existsSync(join(entry, 'entries', '0', 'file'))).toBe(true);
});

describe.skipIf(!POSIX)('the trash delete', () => {
  function recordRm(kill = false): string[][] {
    const real = getExecutor();
    const commands: string[][] = [];
    setExecutor({
      ...real,
      runFileAsync: async (file: string, args: string[], options: Parameters<typeof real.runFileAsync>[2]) => {
        const command = [file, ...args];
        if (!command.includes('rm')) return real.runFileAsync(file, args, options);
        commands.push(command);
        if (!kill) return real.runFileAsync('rm', command.slice(command.indexOf('rm') + 1), options);
        rmSync(join(command.at(-1) ?? '', '0', 'file'));
        throw Object.assign(new Error('Command failed: rm'), { status: null, signal: 'SIGKILL' });
      },
    });
    return commands;
  }

  test.each([
    { level: 'below critical', critical: false, throttled: true },
    { level: 'at critical', critical: true, throttled: false },
  ])('runs rm at a low priority $level', async ({ critical, throttled }) => {
    const entry = plantEntry('remove-priority', join(base, 'gone'));
    const commands = recordRm();

    const outcome = await executeAction(
      { kind: 'would-delete-trash', target: trash, bytes: 0, reason: '' },
      { settings: resolveMaintenanceSettings(null, { STIM_DAEMON: 'on' }), protectedRoot: '', critical },
    );

    expect(outcome.status).toBe('done');
    expect(existsSync(entry)).toBe(false);
    const [command = []] = commands;
    expect(command.slice(-4)).toEqual(['rm', '-rf', '--', join(entry, 'entries')]);
    expect(command.slice(0, -4).includes('nice')).toBe(throttled);
  });

  test('remeasures priority before each owned trash entry and leaves entries once pressure clears', async () => {
    const entries = ['first', 'second', 'third'].map((name) =>
      plantEntry(`remove-${name}`, join(base, `gone-${name}`)),
    );
    const commands = recordRm();
    const priority = vi
      .fn<() => Promise<boolean | null>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(null);

    const result = await executeAction(
      { kind: 'would-delete-trash', target: trash, bytes: 0, reason: '' },
      {
        settings: resolveMaintenanceSettings(null, { STIM_DAEMON: 'on' }),
        protectedRoot: '',
        critical: true,
        trashPriority: priority,
      },
    );

    expect(result).toMatchObject({ status: 'done', detail: '2 deleted' });
    expect(commands.map((command) => command.slice(0, -4).includes('nice'))).toEqual([false, true]);
    expect(entries.filter((entry) => existsSync(entry))).toHaveLength(1);
    expect(priority).toHaveBeenCalledTimes(3);
  });

  test('of an entry whose low-priority rm is killed part way still finishes it, as on main', async () => {
    const entry = plantEntry('remove-killed', join(base, 'gone'));
    writeFileSync(join(entry, 'entries', '0', 'other'), 'x');
    recordRm(true);

    expect(await deleteTrash(undefined, undefined, true)).toMatchObject({ count: 1, failures: 0 });

    expect(existsSync(entry)).toBe(false);
  });
});
