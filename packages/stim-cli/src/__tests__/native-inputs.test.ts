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

test('native source, ignored resources, build configuration and dependency locks invalidate reuse', () => {
  const root = join(directory, 'project');
  const files = ['src/Main.kt', 'assets/ignored.dat', 'build.gradle.kts', 'gradle.lockfile'];
  write(join(root, '.gitignore'), 'assets/ignored.dat');
  for (const file of files) write(join(root, file), 'before');
  for (const file of files) {
    const previous = snapshot(root);
    write(join(root, file), 'after');
    expect(snapshot(root).hash).not.toBe(previous.hash);
  }
  expect(snapshot(root, [], { variant: 'release' }).hash).not.toBe(snapshot(root).hash);
});

test('the same source is reusable across worktrees and named-input ordering', () => {
  const first = join(directory, 'first');
  const second = join(directory, 'second');
  write(join(first, 'src/Main.kt'), 'source');
  write(join(first, 'gradle.lockfile'), 'locked');
  cpSync(first, second, { recursive: true });
  expect(snapshot(first)).toEqual(snapshot(second));
  const inputs = [
    { name: 'source', path: join(first, 'src') },
    { name: 'dependencies', path: join(first, 'gradle.lockfile') },
  ];
  expect(fingerprintNativeInputs(inputs, { parameters: {} })).toEqual(
    fingerprintNativeInputs(inputs.toReversed(), { parameters: {} }),
  );
});

test('only declared outputs are excluded, including when another input is named build', () => {
  const root = join(directory, 'project');
  write(join(root, 'products/apk/app.apk'), 'compiled');
  write(join(root, 'src/build/input.txt'), 'source');
  const excluded = [join(root, 'products')];
  const before = snapshot(root, excluded);
  write(join(root, 'products/apk/app.apk'), 'new compiled bytes');
  expect(snapshot(root, excluded)).toEqual(before);
  write(join(root, 'src/build/input.txt'), 'new source');
  expect(snapshot(root, excluded).hash).not.toBe(before.hash);
});

test('missing optional locks, newly present files and source deletion have distinct identities', () => {
  const path = join(directory, 'gradle.lockfile');
  const inputs = [{ name: 'lock', path, optional: true }];
  const absent = fingerprintNativeInputs(inputs, { parameters: {} });
  write(path, '');
  expect(fingerprintNativeInputs(inputs, { parameters: {} }).hash).not.toBe(absent.hash);
  const present = snapshot(directory);
  rmSync(path);
  expect(snapshot(directory).hash).not.toBe(present.hash);
  expect(() => fingerprintNativeInputs([{ name: 'lock', path }], { parameters: {} })).toThrow(
    'Could not read native build inputs',
  );
});

test.skipIf(process.platform === 'win32')('executable input changes invalidate reuse', () => {
  const path = join(directory, 'gradlew');
  write(path, 'wrapper');
  chmodSync(path, 0o644);
  const before = snapshot(directory);
  chmodSync(path, 0o755);
  expect(snapshot(directory).hash).not.toBe(before.hash);
});

test.skipIf(process.platform === 'win32')(
  'linked external source bytes participate and output links are refused',
  () => {
    const root = join(directory, 'project');
    const external = join(directory, 'external');
    mkdirSync(root);
    write(join(external, 'Resources/data.txt'), 'one');
    symlinkSync('../external', join(root, 'shared'));
    const before = snapshot(root);
    write(join(external, 'Resources/data.txt'), 'two');
    expect(snapshot(root).hash).not.toBe(before.hash);
    expect(() => snapshot(root, [external])).toThrow('links into an excluded output');
  },
);

test.skipIf(process.platform === 'win32')('cyclic and dangling links refuse a partial input identity', () => {
  const root = join(directory, 'project');
  mkdirSync(root);
  symlinkSync('.', join(root, 'loop'));
  expect(() => snapshot(root)).toThrow('cycle');
  rmSync(join(root, 'loop'));
  symlinkSync('../missing', join(root, 'dangling'));
  expect(() => snapshot(root)).toThrow('Could not read native build inputs');
});
