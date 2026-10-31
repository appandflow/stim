import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
