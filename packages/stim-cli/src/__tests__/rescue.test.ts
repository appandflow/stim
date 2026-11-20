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
import { lstat, readdir } from 'node:fs/promises';
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

const rescue = (act = true) => rescueBeforeDelete(root, tree, { trees: [tree], targets: [] }, { act });

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
  ])('%s keeps the folder and copies nothing', async (_, layout) => {
    const target = join(root, 'target');
    mkdirSync(join(target, 'debug'), { recursive: true });
    if (layout === 'target') symlinkSync('../keys/app.json', join(target, 'debug', 'program-keypair.json'));
    if (layout === 'edit') symlinkSync('/elsewhere/index.js', patchFile('index.js').replace('index.js', 'linked.js'));
    if (layout === 'patches') {
      mkdirSync(join(tree, '.patch-work', 'pkg@1.0.0'), { recursive: true });
      symlinkSync('.patch-work', join(tree, '.pnpm_patches'));
    }

    expect(await rescueBeforeDelete(root, root, { trees: [tree], targets: [target] }, { act: true })).toMatch(
      /is a link|is not a plain file/,
    );
    expect(readRescuedCopies()).toEqual([]);
  });
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
    return String(path).endsWith('.pnpm_patches') ? Object.assign(stat, { dev: Number(stat.dev) + 1 }) : stat;
  });

  expect(await rescue()).toContain('another volume');
});

test('a scan whose many fast reads add up past 30 s keeps the tree', async () => {
  patchFile('index.js');
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(readdir).mockImplementation(async (path, options) => {
    vi.advanceTimersByTime(31_000);
    return actual.readdir(path, options);
  });

  expect(await rescue()).toContain('over 30 s');
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
