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
let query: BuildSwiftpmArtifactQuery;
const toolchain = { swift: 'Swift 6.3', sdk: '27A266', arch: 'arm64', xcode: 'Xcode 27' };
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
    stimBuild: 'verified-stim-build',
    inputs: { complete: true, ignored: [], outputs: [], localFiles: ['private.txt'], environment: ['FLAVOR'] },
    build: { product: 'App', infoPlist: 'Development.plist', resources: { Assets: 'assets' }, assetCatalog: null },
  };
});

afterEach(() => {
  resetExecutor();
  rmSync(directory, { recursive: true, force: true });
});

test('a verified completed receipt survives pruning the checkout and build output, without exposing private values', async () => {
  const privateInput = join(directory, 'worker-private.txt');
  writeFileSync(privateInput, 'private-file-value');
  query.inputs.localFiles = [privateInput];
  const output = join(directory, 'out');
  mkdirSync(output);
  writeFileSync(join(output, 'App.app'), 'completed output');
  const snapshot = await swiftpmWorkerArtifactSnapshot(root, query, toolchain, environment);
  expect(snapshot.identity.hash).not.toBe(query.sourceDigest);
  expect(JSON.stringify(snapshot.receipt)).not.toContain('private-file-value');
  expect(JSON.stringify(snapshot.receipt)).not.toContain('private-blue-value');
  rmSync(root, { recursive: true });
  rmSync(output, { recursive: true });
  expect(await swiftpmArtifactFromReceipt(root, query, snapshot.receipt, toolchain, environment)).toEqual(
    snapshot.identity,
  );
});

test('a source transfer digest cannot certify altered worker files', async () => {
  write('Sources/App/main.swift', 'changed after transfer');
  await expect(swiftpmWorkerArtifactSnapshot(root, query, toolchain, environment)).rejects.toThrow('source');
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

test('worker-private files, declared environment, compiler and SDK changes invalidate a completed receipt', async () => {
  const snapshot = await swiftpmWorkerArtifactSnapshot(root, query, toolchain, environment);
  for (const key of ['swift', 'sdk', 'arch', 'xcode'] as const)
    expect(
      await swiftpmArtifactFromReceipt(root, query, snapshot.receipt, { ...toolchain, [key]: 'other' }, environment),
    ).toBeNull();
  expect(await swiftpmArtifactFromReceipt(root, query, snapshot.receipt, toolchain, { FLAVOR: 'other' })).toBeNull();
  write('private.txt', 'changed private input');
  expect(await swiftpmArtifactFromReceipt(root, query, snapshot.receipt, toolchain, environment)).toBeNull();
});

test('build choices and different source queries cannot borrow an existing receipt', async () => {
  const snapshot = await swiftpmWorkerArtifactSnapshot(root, query, toolchain, environment);
  for (const changed of [
    { ...query, sourceDigest: 'a'.repeat(64) },
    { ...query, stimBuild: 'another-stim-build' },
    { ...query, project: 'another-project' },
    { ...query, build: { ...query.build, product: 'Other' } },
    { ...query, inputs: { ...query.inputs, environment: [] } },
  ])
    expect(await swiftpmArtifactFromReceipt(root, changed, snapshot.receipt, toolchain, environment)).toBeNull();
});

test('ignored lockfile changes are private inputs even after visible source is pruned', async () => {
  visible = visible.filter((path) => path !== 'Package.resolved');
  query.sourceDigest = manifestDigest(await sourceManifest(root, true));
  const snapshot = await swiftpmWorkerArtifactSnapshot(root, query, toolchain, environment);
  write('Package.resolved', 'different pins');
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
