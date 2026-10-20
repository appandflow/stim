import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fingerprintNativeInputs } from '../integrations/native-inputs.ts';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'stim-native-inputs-'));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const write = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
const snapshot = (root: string, excluded: string[] = [], parameters = { variant: 'debug' }) =>
  fingerprintNativeInputs([{ name: 'project', path: root }], { excluded, parameters });

test('native source, ignored resources, build configuration and dependency locks invalidate reuse', async () => {
  const root = join(directory, 'project');
  const files = ['src/Main.kt', 'assets/ignored.dat', 'build.gradle.kts', 'gradle.lockfile'];
  write(join(root, '.gitignore'), 'assets/ignored.dat');
  for (const file of files) write(join(root, file), 'before');
  for (const file of files) {
    const previous = await snapshot(root);
    write(join(root, file), 'after');
    expect((await snapshot(root)).hash).not.toBe(previous.hash);
  }
  expect((await snapshot(root, [], { variant: 'release' })).hash).not.toBe((await snapshot(root)).hash);
});

test('the same source is reusable across worktrees and named-input ordering', async () => {
  const first = join(directory, 'first');
  const second = join(directory, 'second');
  write(join(first, 'src/Main.kt'), 'source');
  write(join(first, 'gradle.lockfile'), 'locked');
  cpSync(first, second, { recursive: true });
  expect(await snapshot(first)).toEqual(await snapshot(second));
  const inputs = [
    { name: 'source', path: join(first, 'src') },
    { name: 'dependencies', path: join(first, 'gradle.lockfile') },
  ];
  expect(await fingerprintNativeInputs(inputs, { parameters: {} })).toEqual(
    await fingerprintNativeInputs(inputs.toReversed(), { parameters: {} }),
  );
});

test('only declared outputs are excluded, including when another input is named build', async () => {
  const root = join(directory, 'project');
  write(join(root, 'products/apk/app.apk'), 'compiled');
  write(join(root, 'src/build/input.txt'), 'source');
  const excluded = [join(root, 'products')];
  const before = await snapshot(root, excluded);
  write(join(root, 'products/apk/app.apk'), 'new compiled bytes');
  expect(await snapshot(root, excluded)).toEqual(before);
  write(join(root, 'src/build/input.txt'), 'new source');
  expect((await snapshot(root, excluded)).hash).not.toBe(before.hash);
});

test('missing optional locks, newly present files and source deletion have distinct identities', async () => {
  const path = join(directory, 'gradle.lockfile');
  const inputs = [{ name: 'lock', path, optional: true }];
  const absent = await fingerprintNativeInputs(inputs, { parameters: {} });
  write(path, '');
  expect((await fingerprintNativeInputs(inputs, { parameters: {} })).hash).not.toBe(absent.hash);
  const present = await snapshot(directory);
  rmSync(path);
  expect((await snapshot(directory)).hash).not.toBe(present.hash);
  await expect(fingerprintNativeInputs([{ name: 'lock', path }], { parameters: {} })).rejects.toThrow(
    'Could not read native build inputs',
  );
});

test.skipIf(process.platform === 'win32')('executable input changes invalidate reuse', async () => {
  const path = join(directory, 'gradlew');
  write(path, 'wrapper');
  chmodSync(path, 0o644);
  const before = await snapshot(directory);
  chmodSync(path, 0o755);
  expect((await snapshot(directory)).hash).not.toBe(before.hash);
});

test.skipIf(process.platform === 'win32')(
  'linked external source bytes participate and output links are refused',
  async () => {
    const root = join(directory, 'project');
    const external = join(directory, 'external');
    mkdirSync(root);
    write(join(external, 'Resources/data.txt'), 'one');
    symlinkSync('../external', join(root, 'shared'));
    const before = await snapshot(root);
    write(join(external, 'Resources/data.txt'), 'two');
    expect((await snapshot(root)).hash).not.toBe(before.hash);
    await expect(snapshot(root, [external])).rejects.toThrow('links into an excluded output');
  },
);

test.skipIf(process.platform === 'win32')('cyclic and dangling links refuse a partial input identity', async () => {
  const root = join(directory, 'project');
  mkdirSync(root);
  symlinkSync('.', join(root, 'loop'));
  await expect(snapshot(root)).rejects.toThrow('cycle');
  rmSync(join(root, 'loop'));
  symlinkSync('../missing', join(root, 'dangling'));
  await expect(snapshot(root)).rejects.toThrow('Could not read native build inputs');
});

test('native input keys retain the existing v1 format', async () => {
  const root = join(directory, 'project');
  write(join(root, 'a.txt'), 'alpha');
  write(join(root, 'nested/b.txt'), 'beta');
  expect((await snapshot(root)).hash).toBe('5a52adadb11470cb2f799d936e970cd68c4afcb8e188d3fde9d03221bfca26c6');
});

test('a large file yields to timers while independent input sets keep their own hashes', async () => {
  const first = join(directory, 'first');
  const second = join(directory, 'second');
  mkdirSync(first);
  writeFileSync(join(first, 'large'), Buffer.alloc(32 * 1024 * 1024, 1));
  write(join(second, 'small'), 'independent');
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    const [large, small] = await Promise.all([snapshot(first), snapshot(second)]);
    expect(ticks).toBeGreaterThan(1);
    expect(small.entries.find((entry) => entry.path === 'project/small')?.sha256).toBe(
      '0275fca08c216c77b2a122787b6491a6796ab293e4097e5d62162c0ed4910f08',
    );
    expect(large.hash).not.toBe(small.hash);
  } finally {
    clearInterval(timer);
  }
});

test('cancelling a streamed fingerprint rejects without a partial identity and leaves other calls usable', async () => {
  const root = join(directory, 'project');
  mkdirSync(root);
  writeFileSync(join(root, 'large'), Buffer.alloc(32 * 1024 * 1024, 1));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('stop hashing')), 5);
  try {
    await expect(
      fingerprintNativeInputs([{ name: 'project', path: root }], {
        parameters: null,
        signal: controller.signal,
      }),
    ).rejects.toThrow('stop hashing');
    const recovered = await fingerprintNativeInputs([{ name: 'project', path: root }], { parameters: null });
    expect(recovered.entries.find((entry) => entry.path === 'project/large')?.sha256).toBe(
      'e35460e26db59551591797d5d9f6c5dcc1177e7b9ad3947eaafe1fe7432e84ee',
    );
  } finally {
    clearTimeout(timer);
  }
});
