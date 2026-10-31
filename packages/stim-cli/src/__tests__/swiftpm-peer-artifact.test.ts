import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { manifestDigest } from '../offload/manifest.ts';
import { sourceManifest } from '../offload/native-source.ts';
import { swiftpmWorkerArtifactSnapshot, swiftpmArtifactFromReceipt } from '../offload/swiftpm-artifact.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { makeExecutor } from './_factories.ts';
import type { BuildSwiftpmArtifactQuery } from '@stim-cli/core/protocol';

let directory: string;
let root: string;
let visible: string[];
let query: Extract<BuildSwiftpmArtifactQuery, { compat: number }>;
const toolchain = {
  swift: 'Swift 6.3',
  sdk: '27A266',
  arch: 'arm64',
  xcode: 'Xcode 27',
  selection: {
    command: '/usr/bin/swift',
    compiler: '/Xcode/usr/bin/swift',
    sdk: '/Xcode/SDKs/MacOSX.sdk',
    xcrun: '/usr/bin/xcrun',
    xcodebuild: '/usr/bin/xcodebuild',
    overrides: {},
    checkoutRequired: false,
  },
};
const environment = { FLAVOR: 'private-blue-value' };

function write(path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

beforeEach(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'stim-swiftpm-peer-')));
  root = join(directory, 'src');
  visible = ['Package.swift', 'Package.resolved', 'Sources/App/main.swift', 'Development.plist', 'assets/image'];
  for (const path of visible) write(path, `content:${path}`);
  write('private.txt', 'private-file-value');
  setExecutor(
    makeExecutor({
      runFile: (file, args) => {
        if (file === 'git' && args?.includes('rev-parse')) return root;
        if (file === 'git' && args?.includes('ls-files')) return visible.join('\0') + '\0';
        throw new Error(`Unexpected command ${file}`);
      },
    }),
  );
  query = {
    project: '',
    sourceDigest: manifestDigest(await sourceManifest(root, true)),
    compat: 1,
    inputs: { complete: true, ignored: [], outputs: [], localFiles: ['private.txt'], environment: ['FLAVOR'] },
    build: { product: 'App', infoPlist: 'Development.plist', resources: { Assets: 'assets' }, assetCatalog: null },
  };
});

afterEach(() => {
  resetExecutor();
  rmSync(directory, { recursive: true, force: true });
});

test('a nested project retains repository-scoped resources and project-scoped private inputs', async () => {
  const repository = root;
  const project = 'apps/example';
  const nested = join(repository, project);
  mkdirSync(nested, { recursive: true });
  for (const name of ['Package.swift', 'Package.resolved', 'Sources', 'Development.plist'])
    renameSync(join(repository, name), join(nested, name));
  renameSync(join(repository, 'assets'), join(repository, 'shared'));
  visible = visible.map((path) => (path === 'assets/image' ? 'shared/image' : `${project}/${path}`));
  setExecutor(
    makeExecutor({
      runFile: (file, args) => {
        if (file === 'git' && args?.includes('rev-parse')) return repository;
        if (file === 'git' && args?.includes('ls-files')) return visible.join('\0') + '\0';
        throw new Error(`Unexpected command ${file}`);
      },
    }),
  );
  root = nested;
  query.project = project;
  query.sourceDigest = manifestDigest(await sourceManifest(repository, true));
  query.inputs.localFiles = ['../../private.txt'];
  query.build.resources = { Assets: 'shared' };
  const snapshot = await swiftpmWorkerArtifactSnapshot(root, query, toolchain, environment);
  expect(await swiftpmArtifactFromReceipt(root, query, snapshot.receipt, toolchain, environment)).toEqual(
    snapshot.identity,
  );
  writeFileSync(join(repository, 'private.txt'), 'changed');
  expect(await swiftpmArtifactFromReceipt(root, query, snapshot.receipt, toolchain, environment)).toBeNull();
});

test('undeclared ignored bundle files cannot become reusable worker artifacts', async () => {
  write('assets/private-image', 'private asset');
  await expect(swiftpmWorkerArtifactSnapshot(root, query, toolchain, environment)).rejects.toThrow('declar');
  query.inputs.ignored.push('assets/private-image');
  const snapshot = await swiftpmWorkerArtifactSnapshot(root, query, toolchain, environment);
  write('assets/private-image', 'changed');
  expect(await swiftpmArtifactFromReceipt(root, query, snapshot.receipt, toolchain, environment)).toBeNull();
});

test('cancellation refuses both receipt creation and private-input revalidation', async () => {
  const snapshot = await swiftpmWorkerArtifactSnapshot(root, query, toolchain, environment);
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await expect(swiftpmWorkerArtifactSnapshot(root, query, toolchain, environment, controller.signal)).rejects.toThrow(
    'cancelled',
  );
  await expect(
    swiftpmArtifactFromReceipt(root, query, snapshot.receipt, toolchain, environment, controller.signal),
  ).rejects.toThrow('cancelled');
});
