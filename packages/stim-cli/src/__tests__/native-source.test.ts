import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprintNativeInputs } from '../integrations/native-inputs.ts';
import {
  checkNativeTransferMembership,
  nativeTransferManifest,
  sourceManifest,
  verifyNativeTransfer,
  type NativeTransferFile,
} from '../offload/native-source.ts';
import { git } from '../workspace/git.ts';
import { manifestDigest } from '../offload/manifest.ts';
import { nativeXcodeInputSnapshot, nativeXcodeMetadataDirectories } from '../integrations/native-xcode-inputs.ts';
import { selectNativeXcodeProject } from '../integrations/native-xcode-project.ts';
import { writeNativeXcodeProject } from './_native-xcode-project.ts';

let area: string;
let root: string;
beforeEach(() => {
  area = realpathSync(mkdtempSync(join(tmpdir(), 'stim-native-transfer-')));
  root = join(area, 'source');
  mkdirSync(root);
});
afterEach(() => rmSync(area, { recursive: true, force: true }));
const sha = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
const file = (path: string, kind: NativeTransferFile['kind'] = 'file'): NativeTransferFile => {
  const content = readFileSync(join(root, path));
  return { path, kind, size: content.length, sha256: sha(content) };
};
const snapshot = () => fingerprintNativeInputs([{ name: 'repository', path: root }], { parameters: null });

test('an input inside a git submodule names the submodule instead of an ignore rule', async () => {
  mkdirSync(join(root, 'Vendor', 'Lib'), { recursive: true });
  writeFileSync(join(root, 'Vendor', 'Lib', 'Lib.swift'), 'submodule source');
  writeFileSync(join(root, 'Main.swift'), 'source');
  const scanned = await snapshot();
  expect(() => checkNativeTransferMembership(scanned, new Set(['Main.swift', 'Vendor/Lib']))).toThrow(
    /Vendor\/Lib\/Lib\.swift is inside the git submodule Vendor\/Lib/,
  );
  expect(() => checkNativeTransferMembership(scanned, new Set(['Main.swift']))).toThrow(/ignored or absent/);
});

test.skipIf(process.platform === 'win32')(
  'transfer retains contained links and executable mode, refusing external and absolute links',
  async () => {
    writeFileSync(join(root, 'tool'), 'tool bytes');
    chmodSync(join(root, 'tool'), 0o755);
    symlinkSync('tool', join(root, 'alias'));
    const visible = [file('tool', 'exec'), { path: 'alias', kind: 'link' as const, size: 4, sha256: sha('tool') }];
    const files = await nativeTransferManifest(root, await snapshot(), visible);
    const worker = join(area, 'worker');
    cpSync(root, worker, { recursive: true, verbatimSymlinks: true });
    expect(await verifyNativeTransfer(worker, files, manifestDigest(files))).toBe(true);
    chmodSync(join(worker, 'tool'), 0o644);
    await expect(verifyNativeTransfer(worker, files, manifestDigest(files))).rejects.toThrow(/executable mode/);
    for (const target of [join(root, 'tool'), '../outside']) {
      writeFileSync(join(area, 'outside'), 'outside');
      rmSync(join(root, 'alias'));
      symlinkSync(target, join(root, 'alias'));
      const scanned = await snapshot();
      await expect(
        nativeTransferManifest(root, scanned, [
          file('tool', 'exec'),
          {
            path: 'alias',
            kind: 'link',
            size: Buffer.byteLength(target),
            sha256: sha(target),
          },
        ]),
      ).rejects.toThrow(/cannot be relocated/);
    }
  },
);

test('native transfer tolerates only declared Xcode directory markers, never untransferred contents', async () => {
  const project = writeNativeXcodeProject(root);
  const workspace = join(project, 'project.xcworkspace');
  mkdirSync(workspace);
  const selection = selectNativeXcodeProject(root);
  const inputs = await nativeXcodeInputSnapshot(
    root,
    selection,
    {
      sdk: 'iphonesimulator',
      architecture: 'arm64',
      toolchain: { xcode: 'fixture' },
      optimizations: {},
    },
    process.env,
  );
  if ('cacheIneligible' in inputs) throw new Error(inputs.cacheIneligible);
  const visible = inputs.entries
    .filter((entry) => entry.kind === 'file:0')
    .map((entry) => file(entry.path.slice('repository/'.length)));
  const files = await nativeTransferManifest(root, inputs, visible);
  const markers = nativeXcodeMetadataDirectories(selection);
  const digest = manifestDigest(files);
  expect(await verifyNativeTransfer(root, files, digest, markers)).toBe(true);
  const configuration = join(workspace, 'xcshareddata', 'swiftpm', 'configuration');
  mkdirSync(configuration, { recursive: true });
  expect(await verifyNativeTransfer(root, files, digest, markers)).toBe(true);
  writeFileSync(join(configuration, 'mirrors.json'), 'untransferred');
  await expect(verifyNativeTransfer(root, files, digest, markers)).rejects.toThrow(/ignored or absent/);
  rmSync(configuration, { recursive: true });
  writeFileSync(configuration, 'a file replacing the directory');
  await expect(verifyNativeTransfer(root, files, digest, markers)).rejects.toThrow(/ignored or absent/);
});

test('a source manifest yields while listing and hashing and preserves exactly Git-visible bytes', async () => {
  git(root, ['init', '--quiet'], { write: true });
  const content = Buffer.alloc(2 * 1024 * 1024, 0x61);
  writeFileSync(join(root, 'tracked'), content);
  git(root, ['add', 'tracked'], { write: true });
  writeFileSync(join(root, 'untracked'), 'fresh');
  writeFileSync(join(root, '.gitignore'), 'private\n');
  writeFileSync(join(root, 'private'), 'must not upload');
  let yielded = false;
  const pending = sourceManifest(root);
  setImmediate(() => {
    yielded = true;
  });
  const files = await pending;
  expect(yielded).toBe(true);
  expect(files.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
    { path: '.gitignore', kind: 'file', size: 8, sha256: sha('private\n') },
    { path: 'tracked', kind: 'file', size: content.length, sha256: sha(content) },
    { path: 'untracked', kind: 'file', size: 5, sha256: sha('fresh') },
  ]);
});

test('an aborted source scan refuses before touching a nonexistent repository', async () => {
  const controller = new AbortController();
  const reason = new Error('source scan cancelled');
  controller.abort(reason);
  await expect(sourceManifest(join(area, 'missing'), false, controller.signal)).rejects.toBe(reason);
});
