import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { swiftpmArtifactSnapshot } from '../integrations/swiftpm-artifact-inputs.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { makeExecutor } from './_factories.ts';

let directory: string;
let roots: string[];
let firstRoot: string;
let secondRoot: string;
const visible = ['Package.swift', 'Package.resolved', 'Sources/App/main.swift', 'Development.plist'];
const declaration = {
  complete: true,
  ignored: ['generated.json'],
  localFiles: ['private.txt'],
  environment: ['FLAVOR'],
};
const build = { product: 'App', infoPlist: 'Development.plist', resources: {}, assetCatalog: null };
const toolchain = { swift: 'Swift 6.3', sdk: '27A266', arch: 'arm64', xcode: 'Xcode 27' };

function write(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'stim-swiftpm-inputs-')));
  process.env.STIM_HOME = join(directory, 'home');
  firstRoot = join(directory, 'one');
  secondRoot = join(directory, 'two');
  roots = [firstRoot, secondRoot];
  for (const root of roots) {
    for (const path of [...visible, 'generated.json', 'private.txt']) write(root, path, `content:${path}`);
  }
  setExecutor(
    makeExecutor({
      runFile: (file, args, options) => {
        if (file === 'git' && args?.includes('rev-parse')) return options?.cwd ?? '';
        if (file === 'git' && args?.includes('ls-files')) return visible.join('\0') + '\0';
        throw new Error(`Unexpected command ${file}`);
      },
    }),
  );
});

afterEach(() => {
  resetExecutor();
  delete process.env.STIM_HOME;
  rmSync(directory, { recursive: true, force: true });
});

const snapshot = (root: string, env: NodeJS.ProcessEnv = { FLAVOR: 'blue' }) =>
  swiftpmArtifactSnapshot(root, declaration, build, toolchain, env);

test('identical declared inputs share a key across worktree paths without leaking private contents', async () => {
  const first = await snapshot(firstRoot);
  expect((await snapshot(secondRoot)).hash).toBe(first.hash);
  expect(JSON.stringify(first)).not.toContain('content:private.txt');
  expect(JSON.stringify(first)).not.toContain('blue');
  expect(JSON.stringify(first)).not.toContain(directory);
});

test('source, lockfile, ignored inputs, private files and declared environment each invalidate reuse', async () => {
  const root = firstRoot;
  let before = await snapshot(root);
  for (const path of ['Sources/App/main.swift', 'Package.resolved', 'generated.json', 'private.txt']) {
    write(root, path, 'changed');
    const after = await snapshot(root);
    expect(after.hash).not.toBe(before.hash);
    before = after;
  }
  expect((await snapshot(root, { FLAVOR: 'red' })).hash).not.toBe(before.hash);
  expect((await snapshot(root, { FLAVOR: 'blue', UNDECLARED: 'not-an-input' })).hash).toBe(before.hash);
});

test('compiler, SDK, architecture and selected product independently invalidate reuse', async () => {
  const root = firstRoot;
  const before = await snapshot(root);
  for (const key of ['swift', 'sdk', 'arch', 'xcode'] as const) {
    expect(
      (await swiftpmArtifactSnapshot(root, declaration, build, { ...toolchain, [key]: 'other' }, {})).hash,
    ).not.toBe((await swiftpmArtifactSnapshot(root, declaration, build, toolchain, {})).hash);
  }
  expect(
    (await swiftpmArtifactSnapshot(root, declaration, { ...build, product: 'Other' }, toolchain, { FLAVOR: 'blue' }))
      .hash,
  ).not.toBe(before.hash);
});

test('a missing complete declaration refuses reusable artifacts', async () => {
  await expect(swiftpmArtifactSnapshot(firstRoot, undefined, build, toolchain, {})).rejects.toThrow('complete: true');
});

test('declared bundled resources are hashed even when Git ignores them', async () => {
  const root = firstRoot;
  write(root, 'assets/image', 'one');
  const withResources = { ...build, resources: { Images: 'assets' } };
  const first = await swiftpmArtifactSnapshot(root, declaration, withResources, toolchain, {});
  write(root, 'assets/image', 'two');
  expect((await swiftpmArtifactSnapshot(root, declaration, withResources, toolchain, {})).hash).not.toBe(first.hash);
});

test('private file declarations cannot broaden into whole directories', async () => {
  await expect(
    swiftpmArtifactSnapshot(firstRoot, { ...declaration, localFiles: ['Sources'] }, build, toolchain, {}),
  ).rejects.toThrow('exact regular files');
});

test('ignored input declarations cannot escape the repository or include whole directories', async () => {
  for (const path of ['../outside', '/absolute', '.git/config', 'Sources']) {
    await expect(
      swiftpmArtifactSnapshot(firstRoot, { ...declaration, ignored: [path] }, build, toolchain, {}),
    ).rejects.toThrow(/SwiftPM/);
  }
});

test.skipIf(process.platform === 'win32')('symlink source inputs cannot silently follow another tree', async () => {
  const root = firstRoot;
  rmSync(join(root, 'Sources/App/main.swift'));
  symlinkSync(join(secondRoot, 'Sources/App/main.swift'), join(root, 'Sources/App/main.swift'));
  await expect(snapshot(root)).rejects.toThrow('symbolic link');
});

test('cancellation interrupts fingerprinting instead of publishing an identity', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await expect(
    swiftpmArtifactSnapshot(firstRoot, declaration, build, toolchain, {}, controller.signal),
  ).rejects.toThrow('cancelled');
});
