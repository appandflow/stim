import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  nativeGradleOutputs,
  nativeGradleTransfer,
  verifyGradleTransfer,
  type GradleOffloadInputs,
} from '../integrations/native-gradle-inputs.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { makeExecutor } from './_factories.ts';

let root: string;
let visible: string[];
const declaration: GradleOffloadInputs = {
  complete: true,
  ignored: ['app/src/main/assets/generated.json'],
  outputs: ['app/build'],
};
function write(path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-gradle-transfer-')));
  visible = ['settings.gradle.kts', 'app/build.gradle.kts', 'app/src/main/Main.kt'];
  for (const path of visible) write(path, 'source');
  write('app/src/main/assets/generated.json', 'one');
  write('app/build/outputs/app.apk', 'old-local-output');
  write('private-unlisted.txt', 'not transferred');
  setExecutor(
    makeExecutor({
      runFile: (program, args) => {
        if (program === 'git' && args?.includes('rev-parse')) return root;
        if (program === 'git' && args?.includes('ls-files')) return `${visible.join('\0')}\0`;
        throw new Error(`Unexpected command ${program}`);
      },
    }),
  );
});
afterEach(() => {
  resetExecutor();
  rmSync(root, { recursive: true, force: true });
});

test('declared ignored file changes and visible source deletions change transfer while outputs are omitted', async () => {
  const before = await nativeGradleTransfer(root, declaration);
  expect(before.files.map((file) => file.path)).toContain('app/src/main/assets/generated.json');
  expect(before.files.some((file) => file.path.includes('app/build/'))).toBe(false);
  expect(before.files.map((file) => file.path)).not.toContain('private-unlisted.txt');
  write('app/build/outputs/app.apk', 'different output');
  expect((await nativeGradleTransfer(root, declaration)).digest).toBe(before.digest);
  write('app/src/main/assets/generated.json', 'two');
  const edited = await nativeGradleTransfer(root, declaration);
  expect(edited.digest).not.toBe(before.digest);
  rmSync(join(root, 'app/src/main/Main.kt'));
  const removed = await nativeGradleTransfer(root, declaration);
  expect(removed.digest).not.toBe(edited.digest);
  expect(removed.files.map((file) => file.path)).not.toContain('app/src/main/Main.kt');
});

test('absence of the sufficiency declaration refuses before reading Git or uploading anything', async () => {
  setExecutor(
    makeExecutor({
      runFile: () => {
        throw new Error('Git must not run');
      },
    }),
  );
  await expect(nativeGradleTransfer(root, undefined)).rejects.toThrow('complete: true');
  await expect(nativeGradleTransfer(root, { ...declaration, complete: false })).rejects.toThrow('complete: true');
  await expect(nativeGradleTransfer(root, { ...declaration, ignored: ['local.properties'] })).rejects.toThrow(
    'remove it from android.offloadInputs.ignored',
  );
  await expect(nativeGradleTransfer(root, { ...declaration, ignored: ['app/local.properties'] })).rejects.toThrow(
    'remove it from android.offloadInputs.ignored',
  );
});

test.each(['../outside', '/absolute', '.', 'app/../source', '.git/config', 'C:/source'])(
  'an ignored path outside the supported contained inventory is refused: %s',
  async (path) => {
    await expect(nativeGradleTransfer(root, { ...declaration, ignored: [path] })).rejects.toThrow(
      'repository-relative',
    );
  },
);

test('ignored directories cannot broaden a declaration to upload every private file', async () => {
  await expect(nativeGradleTransfer(root, { ...declaration, ignored: ['app/src/main/assets'] })).rejects.toThrow(
    'exact file or link',
  );
});

test('declared output and transferred source cannot overlap in either direction', async () => {
  await expect(nativeGradleTransfer(root, { ...declaration, outputs: ['app/src'] })).rejects.toThrow('overlaps');
  await expect(
    nativeGradleTransfer(root, { ...declaration, outputs: ['app/build.gradle.kts/generated'] }),
  ).rejects.toThrow('overlaps');
});

test('tracked Gradle state is refused and machine SDK properties are omitted without copying other properties', async () => {
  write('.gradle/private-state', 'private');
  visible.push('.gradle/private-state');
  await expect(nativeGradleTransfer(root, declaration)).rejects.toThrow('state cannot be transferred');
  visible.pop();
  write('local.properties', '# local SDK\nsdk.dir=/private/android-sdk\n');
  visible.push('local.properties');
  expect((await nativeGradleTransfer(root, declaration)).files.map((file) => file.path)).not.toContain(
    'local.properties',
  );
  write('local.properties', 'sdk.dir=/private/android-sdk\nprivate.key=secret\n');
  await expect(nativeGradleTransfer(root, declaration)).rejects.toThrow('unsupported machine-local properties');
});

test.skipIf(process.platform === 'win32')('executable source mode affects the transfer digest', async () => {
  chmodSync(join(root, 'settings.gradle.kts'), 0o644);
  const before = await nativeGradleTransfer(root, declaration);
  chmodSync(join(root, 'settings.gradle.kts'), 0o755);
  expect((await nativeGradleTransfer(root, declaration)).digest).not.toBe(before.digest);
});

test.skipIf(process.platform === 'win32')(
  'external links and links into untransferred ignored files are refused',
  async () => {
    symlinkSync('../private-unlisted.txt', join(root, 'app/link'));
    visible.push('app/link');
    await expect(nativeGradleTransfer(root, declaration)).rejects.toThrow('outside the declared source inventory');
    rmSync(join(root, 'app/link'));
    symlinkSync('/etc/hosts', join(root, 'app/link'));
    await expect(nativeGradleTransfer(root, declaration)).rejects.toThrow('outside the declared source inventory');
  },
);

test.skipIf(process.platform === 'win32')('generated directory links cannot preserve another directory', async () => {
  rmSync(join(root, 'app/build'), { recursive: true });
  symlinkSync('../src', join(root, 'app/build'));
  await expect(nativeGradleTransfer(root, declaration)).rejects.toThrow('not a real directory');
});

test('only declared real output directories reported by AGP become reusable worker state', async () => {
  expect(await nativeGradleOutputs(root, declaration, [join(root, 'app/build'), join(root, 'build')])).toEqual([
    'app/build',
  ]);
  await expect(nativeGradleOutputs(root, declaration, [join(root, 'other-output')])).rejects.toThrow(
    'was not reported by AGP',
  );
  await expect(nativeGradleOutputs(root, declaration, [join(root, '../outside')])).rejects.toThrow(
    'leaves the transferred repository',
  );
  rmSync(join(root, 'app/build'), { recursive: true });
  expect(await nativeGradleOutputs(root, declaration, [join(root, 'app/build')])).toEqual([]);
  mkdirSync(join(root, 'lib/build'), { recursive: true });
  await expect(
    nativeGradleOutputs(root, declaration, [join(root, 'app/build'), join(root, 'lib/build')]),
  ).rejects.toThrow('lib/build is not declared; add it to android.offloadInputs.outputs');
});

test('a build directory Gradle creates outside reported outputs is named after the build', async () => {
  write('build-logic/settings.gradle.kts', 'source');
  visible.push('build-logic/settings.gradle.kts');
  const transfer = await nativeGradleTransfer(root, declaration);
  rmSync(join(root, 'private-unlisted.txt'));
  write('build-logic/build/classes/Plugin.class', 'compiled');
  await expect(verifyGradleTransfer(root, '', declaration, transfer.files, transfer.digest)).rejects.toThrow(
    'directory build-logic/build is outside the source transfer',
  );
  rmSync(join(root, 'build-logic/build'), { recursive: true });
  mkdirSync(join(root, 'app/.cxx'));
  await expect(verifyGradleTransfer(root, '', declaration, transfer.files, transfer.digest)).rejects.toThrow(
    'directory app/.cxx is outside the source transfer',
  );
});

test('a buildSrc build refuses before upload because AGP does not report its build directories', async () => {
  write('buildSrc/build.gradle.kts', 'source');
  visible.push('buildSrc/build.gradle.kts');
  await expect(nativeGradleTransfer(root, declaration)).rejects.toThrow('does not support buildSrc');
});

test.skipIf(process.platform === 'win32')(
  'reported build directories match declared outputs across a symlinked worker root in either direction',
  async () => {
    const link = `${root}-link`;
    symlinkSync(root, link);
    try {
      expect(await nativeGradleOutputs(link, declaration, [join(root, 'app/build')])).toEqual(['app/build']);
      expect(await nativeGradleOutputs(root, declaration, [join(link, 'app/build')])).toEqual(['app/build']);
      rmSync(join(root, 'app/build'), { recursive: true });
      expect(await nativeGradleOutputs(link, declaration, [join(root, 'app/build')])).toEqual([]);
    } finally {
      rmSync(link);
    }
  },
);

test('Kotlin persistent state is never uploaded as project input', async () => {
  write('.kotlin/private-state', 'not source');
  visible.push('.kotlin/private-state');
  await expect(nativeGradleTransfer(root, declaration)).rejects.toThrow('state cannot be transferred');
});

test('a tracked submodule directory refuses rather than silently omitting its required bytes', async () => {
  visible.push('library');
  write('library/Source.kt', 'external library');
  await expect(nativeGradleTransfer(root, declaration)).rejects.toThrow('submodule contents explicitly');
});

test.skipIf(process.platform === 'win32')(
  'a link to removed machine-local properties is not a transferable input',
  async () => {
    visible.push('a-link', 'local.properties');
    write('local.properties', 'sdk.dir=/local/sdk');
    symlinkSync('local.properties', join(root, 'a-link'));
    await expect(nativeGradleTransfer(root, declaration)).rejects.toThrow('outside the declared source inventory');
  },
);

test('worker verification excludes only declared outputs and project state, detects source edits and unexpected ignored bytes', async () => {
  const transfer = await nativeGradleTransfer(root, declaration);
  rmSync(join(root, 'private-unlisted.txt'));
  expect(await verifyGradleTransfer(root, '', declaration, transfer.files, transfer.digest)).toBe(true);
  write('.gradle/cache', 'worker state');
  write('.kotlin/cache', 'compiler state');
  write('app/build/result.apk', 'worker result');
  expect(await verifyGradleTransfer(root, '', declaration, transfer.files, transfer.digest)).toBe(true);
  write('private-unlisted.txt', 'unexpected');
  await expect(verifyGradleTransfer(root, '', declaration, transfer.files, transfer.digest)).rejects.toThrow(
    'ignored or absent',
  );
  rmSync(join(root, 'private-unlisted.txt'));
  write('app/src/main/Main.kt', 'modified by build');
  await expect(verifyGradleTransfer(root, '', declaration, transfer.files, transfer.digest)).rejects.toThrow('changed');
});
