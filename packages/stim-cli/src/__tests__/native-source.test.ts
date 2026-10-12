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
  verifyNativeTransfer,
  type NativeTransferFile,
} from '../offload/native-source.ts';
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

test('transfer preserves empty directories and detects changed, deleted and unlisted worker inputs', async () => {
  writeFileSync(join(root, 'Main.swift'), 'let revision = 1');
  mkdirSync(join(root, 'Empty.bundle'));
  const files = nativeTransferManifest(root, await snapshot(), [file('Main.swift')]);
  expect(files).toContainEqual({ path: 'Empty.bundle', kind: 'directory', size: 0, sha256: sha('') });
  const digest = manifestDigest(files);
  const worker = join(area, 'worker');
  cpSync(root, worker, { recursive: true });
  expect(await verifyNativeTransfer(worker, files, digest)).toBe(true);
  writeFileSync(join(worker, 'Main.swift'), 'let revision = 2');
  await expect(verifyNativeTransfer(worker, files, digest)).rejects.toThrow(/changed/);
  writeFileSync(join(worker, 'Main.swift'), 'let revision = 1');
  rmSync(join(worker, 'Empty.bundle'), { recursive: true });
  expect(await verifyNativeTransfer(worker, files, digest)).toBe(false);
  mkdirSync(join(worker, 'Empty.bundle'));
  writeFileSync(join(worker, 'ignored-secret'), 'must never enter a build');
  await expect(verifyNativeTransfer(worker, files, digest)).rejects.toThrow(/ignored or absent/);
});

test('ignored files and external named inputs refuse transfer before bytes are selected', async () => {
  writeFileSync(join(root, 'Main.swift'), 'source');
  writeFileSync(join(root, 'ignored-secret'), 'private');
  const scanned = await snapshot();
  expect(() => nativeTransferManifest(root, scanned, [file('Main.swift')])).toThrow(
    /ignored-secret.*ignored or absent/,
  );
  rmSync(join(root, 'ignored-secret'));
  const external = join(area, 'outside.swift');
  writeFileSync(external, 'external source');
  const inputs = await fingerprintNativeInputs(
    [
      { name: 'repository', path: root },
      { name: 'external-source', path: external },
    ],
    { parameters: null },
  );
  expect(() => nativeTransferManifest(root, inputs, [file('Main.swift')])).toThrow(/inside the repository/);
});

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
    const files = nativeTransferManifest(root, await snapshot(), visible);
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
      expect(() =>
        nativeTransferManifest(root, scanned, [
          file('tool', 'exec'),
          {
            path: 'alias',
            kind: 'link',
            size: Buffer.byteLength(target),
            sha256: sha(target),
          },
        ]),
      ).toThrow(/cannot be relocated/);
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
  const files = nativeTransferManifest(root, inputs, visible);
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
