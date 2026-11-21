import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readRescuedCopies, rescuedRoot } from '@stim-cli/core/state';
import { expireRescued, rescueBeforeDelete, rescuedFindings } from '../workspace/rescue.ts';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
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

const rescue = () => rescueBeforeDelete(root, { trees: [tree] });

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-test-')));
  vi.stubEnv('STIM_HOME', join(base, 'home'));
  mkdirSync(join(base, 'home'));
  root = join(base, 'checkout');
  tree = join(root, 'node_modules');
});

afterEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(readdir).mockImplementation(actual.readdir);
  vi.mocked(mkdir).mockImplementation(actual.mkdir);
  vi.mocked(writeFile).mockImplementation(actual.writeFile);
  vi.mocked(writeFile).mockClear();
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
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

test('a search whose last read ends past 30 s keeps the tree', async () => {
  const last = dirname(patchFile('index.js'));
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(readdir).mockImplementation(async (path, options) => {
    if (String(path) === last) vi.advanceTimersByTime(31_000);
    return actual.readdir(path, options);
  });

  expect(await rescue()).toContain('over 30 s');
  expect(readRescuedCopies()).toEqual([]);
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

test.skipIf(process.platform === 'win32')(
  'a link inside an edit folder is skipped while the rest is copied',
  async () => {
    const file = patchFile('index.js');
    symlinkSync('/elsewhere/index.js', join(dirname(file), 'linked.js'));

    expect(await rescue()).toBeNull();
    expect(readRescuedCopies()[0]?.items.map((item) => item.source)).toEqual([file]);
  },
);

test.skipIf(process.platform === 'win32')(
  'a node_modules linked outside the checkout is skipped and copies nothing',
  async () => {
    const outside = join(base, 'elsewhere', 'node_modules');
    mkdirSync(join(outside, '.pnpm_patches', 'pkg@1.0.0'), { recursive: true });
    writeFileSync(join(outside, '.pnpm_patches', 'pkg@1.0.0', 'index.js'), 'patched');
    mkdirSync(root, { recursive: true });
    symlinkSync(outside, tree);

    expect(await rescue()).toBeNull();
    expect(readRescuedCopies()).toEqual([]);
  },
);

test.skipIf(process.platform === 'win32')('a linked target/ is not followed and holds nothing', async () => {
  mkdirSync(join(base, 'elsewhere', 'deploy'), { recursive: true });
  writeFileSync(join(base, 'elsewhere', 'deploy', 'program-keypair.json'), '[1]');
  mkdirSync(root, { recursive: true });
  symlinkSync(join(base, 'elsewhere'), join(root, 'target'));

  expect(await rescueBeforeDelete(root, { trees: [], whole: true })).toBeNull();
  expect(readRescuedCopies()).toEqual([]);
});

test('two rescues in the same millisecond get their own folders', async () => {
  patchFile('index.js');

  expect(await rescue()).toBeNull();
  expect(await rescue()).toBeNull();

  expect(new Set(readRescuedCopies().map((copy) => copy.dir)).size).toBe(2);
});

test('a checkout reached through a linked path keeps its copies at their paths in the checkout', async () => {
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
