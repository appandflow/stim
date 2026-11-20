import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectTrash, deleteTrash } from '../commands/gc/trash.ts';
import { takeGcResults } from '../commands/gc/results.ts';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { executeAction } from '../stimd/passes/act.ts';
import { resolveMaintenanceSettings } from '../stimd/passes/settings.ts';
import { testContext } from './_context.ts';
import { goneClaimOwner, liveClaimOwner, plantClaim } from './_factories.ts';

const seams = vi.hoisted(
  (): {
    mounts: string;
    beforeClaim?: (root: string) => void;
    otherDevice?: string;
    afterListing?: { dir: string; run: () => void };
  } => ({ mounts: '' }),
);

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const lstatOnOtherDevice = (...args: Parameters<typeof fs.lstatSync>) => {
    const stat = fs.lstatSync(...args);
    if (stat && seams.otherDevice && String(args[0]) === seams.otherDevice) stat.dev = Number(stat.dev) + 1;
    return stat;
  };
  return { ...fs, default: { ...fs, lstatSync: lstatOnOtherDevice }, lstatSync: lstatOnOtherDevice };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  const readdir = async (...args: Parameters<typeof fs.readdir>) => {
    const listed = await fs.readdir(...args);
    const after = seams.afterListing;
    if (after && String(args[0]) === after.dir) {
      seams.afterListing = undefined;
      after.run();
    }
    return listed;
  };
  return { ...fs, default: { ...fs, readdir }, readdir };
});

vi.mock('../workspace/remover.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace/remover.ts')>()),
  LINUX_MOUNT_INFO: () => seams.mounts,
}));

vi.mock('@stim-cli/core/ownership-claim', async (importOriginal) => {
  const claims = await importOriginal<typeof import('@stim-cli/core/ownership-claim')>();
  return {
    ...claims,
    tryAcquireClaim: (options: Parameters<typeof claims.tryAcquireClaim>[0]) => {
      seams.beforeClaim?.(options.root);
      return claims.tryAcquireClaim(options);
    },
  };
});

const POSIX = process.platform !== 'win32';

let base: string;
let trash: string;

beforeEach(() => {
  resetExecutor();
  setExecutor({
    ...getExecutor(),
    spawn: () => {
      throw new Error('the delete child runs only in integration tests');
    },
  });
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-test-trash-')));
  process.env.STIM_HOME = join(base, 'stim');
  trash = join(base, 'stim', 'trash');
});

afterEach(() => {
  seams.mounts = '';
  seams.beforeClaim = undefined;
  seams.otherDevice = undefined;
  seams.afterListing = undefined;
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

test.skipIf(!POSIX)(
  'gc finishes an entry whose delete stopped after its manifest went, and only once its claim is free',
  async () => {
    const stopped = join(trash, 'remove-stopped');
    plantClaim(join(stopped, 'claims'), 'exclusive', goneClaimOwner(), { claimId: randomUUID() });
    const finishing = join(trash, 'remove-finishing');
    plantClaim(join(finishing, 'claims'), 'exclusive', liveClaimOwner(), { claimId: randomUUID() });

    const report = await collectTrash();
    expect(report?.entries.find((item) => item.path === stopped)).toMatchObject({ willDelete: true, kept: null });
    expect(report?.entries.find((item) => item.path === finishing)?.kept).toBe(
      'a worktree removal is still moving or deleting it',
    );

    expect(await deleteTrash(undefined)).toMatchObject({ count: 1, failures: 0 });
    expect(existsSync(stopped)).toBe(false);
    expect(existsSync(join(finishing, 'claims'))).toBe(true);
  },
);

test.skipIf(!POSIX)(
  'cancelling the trash action stops a delete in this thread part way and keeps the entry',
  async () => {
    const entry = plantEntry('remove-cancelled', join(base, 'gone'));
    for (let index = 0; index < 2000; index++) writeFileSync(join(entry, 'entries', '0', `f${index}`), 'x');
    const controller = new AbortController();
    const operation = testContext({ home: join(base, 'stim'), signal: controller.signal });
    const watch = () => {
      if (readdirSync(join(entry, 'entries', '0')).length < 2001)
        controller.abort(new Error('cancel the trash action'));
      else setImmediate(watch);
    };
    setImmediate(watch);

    const outcome = await executeAction(
      { kind: 'would-delete-trash', target: trash, bytes: 0, reason: '' },
      { settings: resolveMaintenanceSettings(null, { STIM_DAEMON: 'on' }), protectedRoot: '', operation },
    ).catch((error: unknown) => error);

    expect(outcome).toMatchObject({ message: 'cancel the trash action' });
    expect(existsSync(join(entry, 'trash.json'))).toBe(true);
    expect(readdirSync(join(entry, 'entries', '0')).length).toBeGreaterThan(0);
  },
);

test.skipIf(!POSIX)('gc keeps a trash entry with a mount point at it and writes no claim there', async () => {
  const mounted = plantEntry('remove-mounted', join(base, 'gone'));
  seams.mounts = `36 35 98:0 /elsewhere ${mounted} rw - ext4 /dev/sda1 rw\n`;

  expect(await deleteTrash(undefined)).toMatchObject({ count: 0, failures: 0 });

  expect(readdirSync(mounted).toSorted()).toEqual(['entries', 'trash.json']);
});

test.skipIf(!POSIX)(
  'gc rereads an entry once it holds its claim and keeps one a removal filled meanwhile',
  async () => {
    const worktree = join(base, 'worktree');
    mkdirSync(worktree);
    const entry = join(trash, 'remove-opening');
    mkdirSync(entry, { recursive: true });
    seams.beforeClaim = (root) => {
      if (root !== join(entry, 'claims')) return;
      mkdirSync(join(entry, 'entries', '0'), { recursive: true });
      writeFileSync(join(entry, 'entries', '0', 'file'), 'moved');
      writeFileSync(join(entry, 'trash.json'), JSON.stringify({ worktree, createdAt: 'T' }));
    };

    expect(await deleteTrash(undefined)).toMatchObject({ count: 0, failures: 0 });

    expect(existsSync(join(entry, 'entries', '0', 'file'))).toBe(true);
    expect(existsSync(join(entry, 'trash.json'))).toBe(true);
  },
);

test.skipIf(!POSIX)(
  'gc clears claim staging a crash left and counts the entry once its directory is gone',
  async () => {
    const entry = plantEntry('remove-staged', join(base, 'gone'));
    const claims = join(entry, 'claims');
    const id = '0f0e0d0c-0b0a-4908-8706-050403020100';
    mkdirSync(join(claims, `.staging-${id}`), { recursive: true });
    writeFileSync(join(claims, `.staging-${id}`, `${id}.claim`), '{}');
    writeFileSync(join(claims, `.staging-child-${id}`), '{}');
    writeFileSync(join(claims, `.staging-details-${id}`), '{}');

    expect(await deleteTrash(undefined)).toMatchObject({ count: 1, failures: 0 });

    expect(existsSync(entry)).toBe(false);
  },
);

test.skipIf(!POSIX)('gc keeps an entry whose claims hold files Stim did not write, and leaves them', async () => {
  const withManifest = plantEntry('remove-foreign', join(base, 'gone'));
  mkdirSync(join(withManifest, 'claims', '.staging-backup'), { recursive: true });
  writeFileSync(join(withManifest, 'claims', '.staging-backup', 'file'), 'keep');
  const manifestless = join(trash, 'remove-foreign-claims');
  mkdirSync(join(manifestless, 'claims', '.staging-backup'), { recursive: true });
  writeFileSync(join(manifestless, 'claims', '.staging-backup', 'file'), 'keep');

  const report = await collectTrash();
  expect(report?.entries.find((item) => item.path === manifestless)?.willDelete).toBe(false);
  expect(await deleteTrash(undefined)).toMatchObject({ count: 0, failures: 1 });

  for (const entry of [withManifest, manifestless])
    expect(readFileSync(join(entry, 'claims', '.staging-backup', 'file'), 'utf8')).toBe('keep');
});

test.skipIf(!POSIX)('gc deletes an entry with a top-level name that is not valid UTF-8', async ({ skip }) => {
  const entry = plantEntry('remove-bytes', join(base, 'gone'));
  try {
    writeFileSync(Buffer.concat([Buffer.from(`${entry}/`), Buffer.from([0x78, 0xff])]), 'x');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EILSEQ')
      skip('this filesystem rejects such names');
    throw error;
  }

  expect(await deleteTrash(undefined)).toMatchObject({ count: 1, failures: 0 });

  expect(existsSync(entry)).toBe(false);
});

test.skipIf(!POSIX || !existsSync('/dev/shm'))(
  'gc deletes from a trash that is a link to another volume',
  async ({ skip }) => {
    const target = mkdtempSync('/dev/shm/stim-test-trash-');
    onTestFinished(() => rmSync(target, { recursive: true, force: true }));
    if (lstatSync(target).dev === lstatSync(base).dev)
      skip('/dev/shm is on the same volume as the temporary directory');
    mkdirSync(join(base, 'stim'), { recursive: true });
    symlinkSync(target, trash);
    const entry = plantEntry('remove-linked', join(base, 'gone'));

    expect(await deleteTrash(undefined)).toMatchObject({ count: 1, failures: 0 });

    expect(existsSync(entry)).toBe(false);
  },
);

test.skipIf(!POSIX)(
  'gc keeps an entry without a manifest whose claims hold a file the claim code does not write',
  async () => {
    const entry = join(trash, 'remove-notes');
    mkdirSync(join(entry, 'claims', 'shared'), { recursive: true });
    writeFileSync(join(entry, 'claims', 'shared', 'notes.child'), 'keep');

    const report = await collectTrash();
    expect(report?.entries.find((item) => item.path === entry)?.willDelete).toBe(false);
    expect(await deleteTrash(undefined)).toMatchObject({ count: 0, failures: 0 });

    expect(readFileSync(join(entry, 'claims', 'shared', 'notes.child'), 'utf8')).toBe('keep');
  },
);

test.skipIf(!POSIX)('gc keeps an entry whose claims are on another volume and takes no claim there', async () => {
  const entry = plantEntry('remove-claims-elsewhere', join(base, 'gone'));
  const dead = plantClaim(join(entry, 'claims'), 'exclusive', goneClaimOwner(), { claimId: randomUUID() });
  seams.otherDevice = join(entry, 'claims');

  expect(await deleteTrash(undefined)).toMatchObject({ count: 0, failures: 0 });

  expect(existsSync(dead)).toBe(true);
  expect(existsSync(join(entry, 'entries', '0', 'file'))).toBe(true);
});

test.skipIf(!POSIX)(
  'gc keeps the manifest of an entry that something filled while its payload was deleted',
  async () => {
    const entry = plantEntry('remove-refilled', join(base, 'gone'));
    seams.afterListing = { dir: entry, run: () => writeFileSync(join(entry, 'late'), 'late') };

    expect(await deleteTrash(undefined)).toMatchObject({ count: 0, failures: 1 });

    expect(existsSync(join(entry, 'trash.json'))).toBe(true);
    expect(existsSync(join(entry, 'late'))).toBe(true);
  },
);
