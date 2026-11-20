import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRescuedCopies, rescuedRoot } from '@stim-cli/core/state';
import { expireRescued, rescueBeforeDelete, rescuedFindings } from '../workspace/rescue.ts';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: vi.fn<typeof actual.lstat>(actual.lstat),
    readdir: vi.fn<typeof actual.readdir>(actual.readdir),
    mkdir: vi.fn<typeof actual.mkdir>(actual.mkdir),
    writeFile: vi.fn<typeof actual.writeFile>(actual.writeFile),
  };
});

const DAY = 86_400_000;
let base: string;
let root: string;
let tree: string;

function patchFile(name: string, text = 'patched'): string {
  const file = join(tree, '.pnpm_patches', 'pkg@1.0.0', name);
  mkdirSync(join(tree, '.pnpm_patches', 'pkg@1.0.0'), { recursive: true });
  writeFileSync(file, text);
  return file;
}

const rescue = (act = true) => rescueBeforeDelete(root, tree, { trees: [tree] }, { act });

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-test-')));
  vi.stubEnv('STIM_HOME', join(base, 'home'));
  mkdirSync(join(base, 'home'));
  root = join(base, 'checkout');
  tree = join(root, 'node_modules');
});

afterEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(lstat).mockImplementation(actual.lstat);
  vi.mocked(readdir).mockImplementation(actual.readdir);
  vi.mocked(mkdir).mockImplementation(actual.mkdir);
  vi.mocked(writeFile).mockImplementation(actual.writeFile);
  vi.mocked(writeFile).mockClear();
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

test('a pnpm patch over the size cap keeps the tree and copies nothing', async () => {
  truncateSync(patchFile('huge.bin'), 51 * 1024 * 1024);

  expect(await rescue()).toContain('over 50 MB');
  expect(readRescuedCopies()).toEqual([]);
});

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'a copy that fails keeps the tree and leaves no partial copy',
  async () => {
    patchFile('index.js');
    const locked = patchFile('locked.js');
    chmodSync(locked, 0o000);
    try {
      expect(await rescue()).toContain('could not be copied');
    } finally {
      chmodSync(locked, 0o644);
    }
    expect(readdirSync(rescuedRoot(), { recursive: true }).filter((name) => String(name).endsWith('.js'))).toEqual([]);
  },
);

describe.skipIf(process.platform === 'win32')('links', () => {
  test.each([
    ['a keypair-named link in a target', 'target'],
    ['a link inside an edit folder', 'edit'],
    ['a linked .pnpm_patches', 'patches'],
    ['a .pnpm_patches whose only package entry is a link', 'entry'],
  ])('%s keeps the folder and copies nothing', async (_, layout) => {
    const target = join(root, 'target');
    mkdirSync(join(target, 'debug'), { recursive: true });
    if (layout === 'target') symlinkSync('../keys/app.json', join(target, 'debug', 'program-keypair.json'));
    if (layout === 'edit') symlinkSync('/elsewhere/index.js', patchFile('index.js').replace('index.js', 'linked.js'));
    if (layout === 'entry') {
      mkdirSync(join(tree, '.patch-work', 'pkg@1.0.0'), { recursive: true });
      mkdirSync(join(tree, '.pnpm_patches'), { recursive: true });
      writeFileSync(join(tree, '.pnpm_patches', 'state.json'), '{}');
      symlinkSync('../.patch-work/pkg@1.0.0', join(tree, '.pnpm_patches', 'pkg@1.0.0'));
    }
    if (layout === 'patches') {
      mkdirSync(join(tree, '.patch-work', 'pkg@1.0.0'), { recursive: true });
      symlinkSync('.patch-work', join(tree, '.pnpm_patches'));
    }

    expect(await rescueBeforeDelete(root, root, { trees: [], whole: true }, { act: true })).toMatch(
      /is a link|is not a plain file/,
    );
    expect(readRescuedCopies()).toEqual([]);
  });
});

test('a pnpm --edit-dir inside the deleted folder that state.json names keeps it; one elsewhere does not', async () => {
  const edit = join(tree, '.cache', 'pkg');
  mkdirSync(edit, { recursive: true });
  writeFileSync(join(edit, 'index.js'), 'patched');
  mkdirSync(join(tree, '.pnpm_patches'));
  const state = (named: string) =>
    writeFileSync(join(tree, '.pnpm_patches', 'state.json'), JSON.stringify({ [named]: { applyToAll: false } }));

  state(edit);
  expect(await rescue()).toContain(`edits in ${edit} lie outside`);

  state(join(base, 'main', 'node_modules', '.pnpm_patches', 'pkg@1.0.0'));
  mkdirSync(join(base, 'main', 'node_modules', '.pnpm_patches', 'pkg@1.0.0'), { recursive: true });
  expect(await rescue()).toBeNull();
});

test.skipIf(process.platform === 'win32')(
  'a pnpm --edit-dir recorded through a linked parent of the deleted folder keeps it',
  async () => {
    const edit = join(tree, '.cache', 'pkg');
    mkdirSync(edit, { recursive: true });
    mkdirSync(join(tree, '.pnpm_patches'));
    symlinkSync(root, join(base, 'alias'));
    const recorded = join(base, 'alias', 'node_modules', '.cache', 'pkg');
    writeFileSync(join(tree, '.pnpm_patches', 'state.json'), JSON.stringify({ [recorded]: { applyToAll: false } }));

    expect(await rescue()).toContain(`edits in ${edit} lie outside`);
  },
);

test('a pnpm --edit-dir outside the deleted folder gets its state.json copied, which restores the registration', async () => {
  const edit = join(base, 'elsewhere', 'pkg');
  mkdirSync(edit, { recursive: true });
  mkdirSync(join(tree, '.pnpm_patches'), { recursive: true });
  const state = JSON.stringify({ [edit]: { patchedPkg: 'pkg@1.0.0', applyToAll: false } });
  writeFileSync(join(tree, '.pnpm_patches', 'state.json'), state);

  expect(await rescue()).toBeNull();
  rmSync(tree, { recursive: true });
  const [copy] = readRescuedCopies();
  mkdirSync(join(tree, '.pnpm_patches'), { recursive: true });
  writeFileSync(
    join(tree, '.pnpm_patches', 'state.json'),
    readFileSync(join(copy?.dir ?? '', 'node_modules', '.pnpm_patches', 'state.json')),
  );

  expect(JSON.parse(readFileSync(join(tree, '.pnpm_patches', 'state.json'), 'utf8'))).toEqual({
    [edit]: { patchedPkg: 'pkg@1.0.0', applyToAll: false },
  });
});

test.skipIf(process.platform === 'win32')(
  'a node_modules linked to a folder holding a pnpm patch keeps the worktree',
  async () => {
    mkdirSync(join(root, '.cache', 'deps', '.pnpm_patches', 'pkg@1.0.0'), { recursive: true });
    writeFileSync(join(root, '.cache', 'deps', '.pnpm_patches', 'pkg@1.0.0', 'index.js'), 'patched');
    symlinkSync('.cache/deps', join(root, 'node_modules'));

    expect(await rescueBeforeDelete(root, root, { trees: [], whole: true }, { act: true })).toContain(
      'is a link to a node_modules holding a .pnpm_patches',
    );
  },
);

test('a node_modules on another volume, or a mount under the folder being deleted, keeps the worktree', async () => {
  patchFile('index.js');
  const whole = (mountInfo: (() => string) | null) =>
    rescueBeforeDelete(root, root, { trees: [], whole: true }, { act: true, mountInfo });

  expect(await whole(() => `36 35 98:0 / ${realpathSync(root)}/node_modules rw - ext4 /dev/sdb rw\n`)).toContain(
    'is a mount point',
  );

  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(lstat).mockImplementation(async (path, options) => {
    const stat = await actual.lstat(path, options);
    return String(path).endsWith(`${'/'}node_modules`) ? Object.assign(stat, { dev: Number(stat.dev) + 1 }) : stat;
  });
  expect(await whole(null)).toContain('node_modules is on another volume');
});

test('a folder whose name starts with two dots is inside the checkout', async () => {
  mkdirSync(join(root, '..cache'), { recursive: true });
  writeFileSync(join(root, '..cache', 'program-keypair.json'), '[1]');

  expect(await rescueBeforeDelete(root, root, { trees: [], whole: true }, { act: true })).toBeNull();
  expect(readRescuedCopies()[0]?.items).toEqual([expect.objectContaining({ size: 3 })]);
});

test('a rescue store inside the folder being deleted keeps it', async () => {
  vi.stubEnv('STIM_HOME', join(tree, '.cache', 'stim'));
  mkdirSync(join(tree, '.cache', 'stim'), { recursive: true });
  patchFile('index.js');

  expect(await rescue()).toContain('lies inside');
});

test.skipIf(process.platform === 'win32')(
  'a linked rescue store keeps the tree, and expiry removes nothing through a linked workspace folder',
  async () => {
    patchFile('index.js');
    const outside = join(base, 'outside');
    mkdirSync(join(outside, 'old'), { recursive: true });
    symlinkSync(outside, rescuedRoot());

    expect(await rescue()).toContain('is not a real directory');
    expect(readdirSync(outside)).toEqual(['old']);

    rmSync(rescuedRoot());
    mkdirSync(rescuedRoot());
    symlinkSync(outside, join(rescuedRoot(), 'workspace'));
    writeFileSync(join(outside, 'old', 'manifest.json'), JSON.stringify({ from: root, at: 0, items: [] }));
    await expireRescued(Date.now());
    expect(existsSync(join(outside, 'old', 'manifest.json'))).toBe(true);
  },
);

test('a scan root on another volume than the folder being deleted keeps it', async () => {
  patchFile('index.js');
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(lstat).mockImplementation(async (path, options) => {
    const stat = await actual.lstat(path, options);
    return String(path).includes('.pnpm_patches') ? Object.assign(stat, { dev: Number(stat.dev) + 1 }) : stat;
  });

  expect(await rescue()).toContain('another volume');
});

test('a search whose last read ends past 30 s keeps the tree', async () => {
  const last = patchFile('index.js');
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(lstat).mockImplementation(async (path, options) => {
    if (String(path) === last) vi.advanceTimersByTime(31_000);
    return actual.lstat(path, options);
  });

  expect(await rescue(false)).toContain('over 30 s');
});

test('a copy that runs past 30 s stops before its next write and keeps the tree', async () => {
  patchFile('index.js');
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(mkdir).mockImplementationOnce(async (path, options) => {
    vi.advanceTimersByTime(31_000);
    return actual.mkdir(path, options);
  });

  expect(await rescue()).toContain('over 30 s');
  expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
});

test('a manifest written past 30 s keeps the tree and leaves no copy', async () => {
  patchFile('index.js');
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(writeFile).mockImplementation(async (path, data, options) => {
    vi.advanceTimersByTime(31_000);
    return actual.writeFile(path, data, options);
  });

  expect(await rescue()).toContain('over 30 s');
  expect(readRescuedCopies()).toEqual([]);
});

test.skipIf(process.platform === 'win32')('a linked target/ is not followed and holds nothing', async () => {
  mkdirSync(join(base, 'elsewhere', 'deploy'), { recursive: true });
  writeFileSync(join(base, 'elsewhere', 'deploy', 'program-keypair.json'), '[1]');
  mkdirSync(root, { recursive: true });
  symlinkSync(join(base, 'elsewhere'), join(root, 'target'));

  expect(await rescueBeforeDelete(root, root, { trees: [], whole: true }, { act: true })).toBeNull();
  expect(readRescuedCopies()).toEqual([]);
});

test('a Stim home inside a node_modules with no pnpm patch does not hold its delete', async () => {
  vi.stubEnv('STIM_HOME', join(tree, '.cache', 'stim'));
  mkdirSync(join(tree, '.cache', 'stim'), { recursive: true });

  expect(await rescue()).toBeNull();
});

test('expiry with no Stim home folder yet removes nothing and does not fail', async () => {
  vi.stubEnv('STIM_HOME', join(base, 'missing'));

  await expect(expireRescued(Date.now())).resolves.toBeUndefined();
});

test('two rescues in the same millisecond get their own folders', async () => {
  patchFile('index.js');

  expect(await rescue()).toBeNull();
  expect(await rescue()).toBeNull();

  expect(new Set(readRescuedCopies().map((copy) => copy.dir)).size).toBe(2);
});

test('a checkout reached through a linked path is rescued, not held as outside itself', async () => {
  root = join(mkdtempSync(join(tmpdir(), 'stim-test-')), 'checkout');
  tree = join(root, 'node_modules');
  patchFile('index.js', 'edited');
  try {
    expect(await rescue()).toBeNull();
    const [copy] = readRescuedCopies();
    expect(readFileSync(join(copy?.dir ?? '', 'node_modules', '.pnpm_patches', 'pkg@1.0.0', 'index.js'), 'utf8')).toBe(
      'edited',
    );
  } finally {
    rmSync(join(root, '..'), { recursive: true, force: true });
  }
});

test('gc expiry removes a rescued copy older than 30 days, and doctor lists the rest with source and age', async () => {
  const now = Date.now();
  for (const [stamp, age] of [
    ['old', 31],
    ['recent', 1],
  ] as const) {
    const dir = join(rescuedRoot(), 'workspace', stamp);
    mkdirSync(dir, { recursive: true });
    const item = { source: join(root, 'target', 'deploy', `${stamp}-keypair.json`), copy: 'x', size: 7 };
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ from: root, at: now - age * DAY, items: [item] }));
  }

  await expireRescued(now);

  expect(readRescuedCopies().map((copy) => copy.dir)).toEqual([join(rescuedRoot(), 'workspace', 'recent')]);
  const [finding] = rescuedFindings(now);
  expect(finding?.detail).toContain('1 day old');
  expect(finding?.detail).toContain(join(root, 'target', 'deploy', 'recent-keypair.json'));
});
