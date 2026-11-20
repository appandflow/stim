import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRescuedCopies, rescuedRoot } from '@stim-cli/core/state';
import { expireRescued, rescueBeforeDelete, rescuedFindings } from '../workspace/rescue.ts';

const DAY = 86_400_000;
let base: string;
let root: string;
let tree: string;

function patchFile(name: string): string {
  const file = join(tree, '.pnpm_patches', 'pkg@1.0.0', name);
  mkdirSync(join(tree, '.pnpm_patches', 'pkg@1.0.0'), { recursive: true });
  writeFileSync(file, 'patched');
  return file;
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-test-')));
  vi.stubEnv('STIM_HOME', join(base, 'home'));
  root = join(base, 'checkout');
  tree = join(root, 'node_modules');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(base, { recursive: true, force: true });
});

test('a pnpm patch over the size cap keeps the tree and copies nothing', async () => {
  truncateSync(patchFile('huge.bin'), 51 * 1024 * 1024);

  expect(await rescueBeforeDelete(root, { trees: [tree], targets: [] }, { act: true })).toContain('over 50 MB');
  expect(readRescuedCopies()).toEqual([]);
});

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'a copy that fails keeps the tree and leaves no partial copy',
  async () => {
    patchFile('index.js');
    const locked = patchFile('locked.js');
    chmodSync(locked, 0o000);
    try {
      expect(await rescueBeforeDelete(root, { trees: [tree], targets: [] }, { act: true })).toContain(
        'could not be copied',
      );
    } finally {
      chmodSync(locked, 0o644);
    }
    expect(readdirSync(rescuedRoot(), { recursive: true }).filter((name) => String(name).endsWith('.js'))).toEqual([]);
  },
);

test.skipIf(process.platform === 'win32')(
  'a keypair link is copied as a link, and other target files are left alone',
  async () => {
    const target = join(root, 'target');
    mkdirSync(join(target, 'debug'), { recursive: true });
    writeFileSync(join(target, 'debug', 'app'), 'binary');
    symlinkSync('/elsewhere/program-keypair.json', join(target, 'debug', 'program-keypair.json'));

    expect(await rescueBeforeDelete(root, { trees: [], targets: [target] }, { act: true })).toBeNull();

    const [copy] = readRescuedCopies();
    expect(copy?.items).toEqual([expect.objectContaining({ link: '/elsewhere/program-keypair.json', size: 0 })]);
    const copied = join(copy?.dir ?? '', 'target', 'debug', 'program-keypair.json');
    expect(lstatSync(copied).isSymbolicLink()).toBe(true);
    expect(readlinkSync(copied)).toBe('/elsewhere/program-keypair.json');
  },
);

test('gc expiry removes a rescued copy older than 30 days, and doctor lists the rest with source and age', async () => {
  const now = Date.now();
  for (const [stamp, age] of [
    ['old', 31],
    ['recent', 1],
  ] as const) {
    const dir = join(rescuedRoot(), 'workspace', stamp);
    mkdirSync(dir, { recursive: true });
    const item = { source: join(root, 'target', 'deploy', `${stamp}-keypair.json`), copy: 'x', size: 7, link: null };
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ from: root, at: now - age * DAY, items: [item] }));
  }

  await expireRescued(now);

  expect(readRescuedCopies().map((copy) => copy.dir)).toEqual([join(rescuedRoot(), 'workspace', 'recent')]);
  const [finding] = rescuedFindings(now);
  expect(finding?.detail).toContain('1 day old');
  expect(finding?.detail).toContain(join(root, 'target', 'deploy', 'recent-keypair.json'));
});
