import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { BuildSwiftpmArtifactQuery } from '@stim-cli/core/protocol';
import { fingerprintNativeInputs } from '../integrations/native-inputs.ts';
import {
  swiftpmArtifactInputs,
  swiftpmArtifactSnapshot,
  type SwiftpmArtifactToolchain,
} from '../integrations/swiftpm-artifact-inputs.ts';
import { gitAsync } from '../workspace/git.ts';
import { manifestDigest } from './manifest.ts';
import { sourceManifest } from './native-source.ts';

export interface SwiftpmArtifactReceipt {
  query: BuildSwiftpmArtifactQuery;
  identity: { hash: string; key: string };
  privateHash: string;
  privateLockfile: boolean;
}

async function privateSnapshot(
  root: string,
  query: BuildSwiftpmArtifactQuery,
  privateLockfile: boolean,
  toolchain: SwiftpmArtifactToolchain,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string> {
  const repository = resolve(
    root,
    ...query.project
      .split('/')
      .filter(Boolean)
      .map(() => '..'),
  );
  const declaration = swiftpmArtifactInputs(query.inputs);
  const snapshot = await fingerprintNativeInputs(
    [
      ...declaration.ignored.map((path) => ({ name: `ignored/${path}`, path: join(repository, path) })),
      ...declaration.localFiles.map((path, index) => ({
        name: `local/${index}`,
        path: resolve(root, path),
        optional: true,
      })),
      ...(privateLockfile ? [{ name: 'package-resolved', path: join(root, 'Package.resolved'), optional: true }] : []),
    ],
    {
      parameters: {
        toolchain,
        environment: Object.fromEntries(
          [
            ...new Set([
              ...declaration.environment,
              'DEVELOPER_DIR',
              'TOOLCHAINS',
              'SDKROOT',
              'SWIFT_EXEC',
              'MACOSX_DEPLOYMENT_TARGET',
            ]),
          ]
            .toSorted()
            .map((name) => [name, env[name] ?? null]),
        ),
      },
      signal,
    },
  );
  return snapshot.hash;
}

/** Certifies actual worker inputs, not the client's transfer digest or cache identity. */
export async function swiftpmWorkerArtifactSnapshot(
  root: string,
  query: BuildSwiftpmArtifactQuery,
  toolchain: SwiftpmArtifactToolchain,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<{ identity: { hash: string; key: string }; receipt: SwiftpmArtifactReceipt }> {
  signal?.throwIfAborted();
  root = await realpath(root);
  const repository = await realpath(await gitAsync(root, ['rev-parse', '--show-toplevel'], { signal }));
  const project = relative(repository, await realpath(root))
    .split(sep)
    .join('/');
  const visible = await sourceManifest(repository, true, signal);
  if (query.project !== project || manifestDigest(visible) !== query.sourceDigest)
    throw new Error('The SwiftPM worker source does not match its completed transfer.');
  const declaration = swiftpmArtifactInputs(query.inputs);
  const build = {
    ...query.build,
    resources: Object.fromEntries(
      Object.entries(query.build.resources).map(([name, path]) => [name, relative(root, resolve(repository, path))]),
    ),
    assetCatalog: query.build.assetCatalog ? relative(root, resolve(repository, query.build.assetCatalog)) : null,
  };
  const snapshot = await swiftpmArtifactSnapshot(root, declaration, build, toolchain, env, signal);
  const sourcePaths = new Set(visible.map((file) => file.path));
  const privatePaths = new Set([
    ...declaration.ignored.map((path) => resolve(repository, path)),
    ...declaration.localFiles.map((path) => resolve(root, path)),
  ]);
  for (const path of [build.infoPlist, ...Object.values(build.resources), build.assetCatalog]) {
    if (path === null) continue;
    const absolute = resolve(root, path);
    const bundled = await fingerprintNativeInputs([{ name: 'bundle', path: absolute }], { parameters: null, signal });
    for (const entry of bundled.entries) {
      if (entry.kind === 'directory') continue;
      const file = join(absolute, entry.path === 'bundle' ? '' : entry.path.slice('bundle/'.length));
      const name = relative(repository, file).split(sep).join('/');
      if (!entry.kind.startsWith('file:') || (!sourcePaths.has(name) && !privatePaths.has(file)))
        throw new Error('SwiftPM peer caching requires every ignored bundle file in the private input declaration.');
    }
  }
  const privateLockfile = !sourcePaths.has([project, 'Package.resolved'].filter(Boolean).join('/'));
  const privateHash = await privateSnapshot(root, query, privateLockfile, toolchain, env, signal);
  const hash = createHash('sha256')
    .update(JSON.stringify(['stim-swiftpm-worker-v1', snapshot.hash, query, privateHash]))
    .digest('hex');
  const identity = { hash, key: `swiftpm-peer-${hash}` };
  return { identity, receipt: { query: structuredClone(query), identity, privateHash, privateLockfile } };
}

/** Revalidates private inputs of a receipt bound to a verified completed source transfer. */
export async function swiftpmArtifactFromReceipt(
  root: string,
  query: BuildSwiftpmArtifactQuery,
  receipt: SwiftpmArtifactReceipt,
  toolchain: SwiftpmArtifactToolchain,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<{ hash: string; key: string } | null> {
  signal?.throwIfAborted();
  if (
    !isDeepStrictEqual(query, receipt.query) ||
    !/^[a-f0-9]{64}$/.test(receipt.identity.hash) ||
    receipt.identity.key !== `swiftpm-peer-${receipt.identity.hash}`
  )
    return null;
  return (await privateSnapshot(root, query, receipt.privateLockfile, toolchain, env, signal)) === receipt.privateHash
    ? receipt.identity
    : null;
}
