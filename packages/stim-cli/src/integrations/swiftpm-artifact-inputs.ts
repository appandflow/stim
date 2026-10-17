import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { buildCacheKey } from '../cache/build-cache.ts';
import { manifestDigest } from '../offload/manifest.ts';
import { nativeFileDigest, sourceManifest } from '../offload/native-source.ts';
import { gitAsync } from '../workspace/git.ts';
import { fingerprintNativeInputs } from './native-inputs.ts';
import { getExecutor } from '../exec.ts';
import type { StimContext } from '@stim-cli/core';
import { isJsonObject } from '@stim-cli/core/state';

const SWIFTPM_CACHE_LIMIT =
  'SwiftPM artifact caching requires macos.artifactInputs with complete: true and a complete declaration of pinned, repeatable inputs producing a relocatable app.';

interface SwiftpmArtifactInputs {
  complete: true;
  ignored: string[];
  outputs: string[];
  localFiles: string[];
  environment: string[];
}

interface SwiftpmArtifactBuild {
  product: string;
  infoPlist: string;
  resources: Record<string, string>;
  assetCatalog: string | null;
}

export interface SwiftpmArtifactToolchain {
  swift: string;
  sdk: string;
  arch: string;
  xcode: string;
}

export async function readSwiftpmArtifactToolchain(
  context: StimContext,
  signal: AbortSignal | undefined,
): Promise<SwiftpmArtifactToolchain> {
  const run = (file: string, args: string[]) =>
    getExecutor().runFileAsync(file, args, { timeoutMs: 30_000, signal, declareFor: context });
  const swift = await run('swift', ['--version']);
  const sdk = await run('xcrun', ['--sdk', 'macosx', '--show-sdk-build-version']);
  const xcode = await run('xcodebuild', ['-version']);
  return { swift, sdk, xcode, arch: process.arch };
}

function repositoryPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\\') &&
    !value.includes(':') &&
    !value.includes('\0') &&
    !value.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
  );
}

export function swiftpmArtifactInputs(value: unknown): SwiftpmArtifactInputs {
  if (!isJsonObject(value) || value.complete !== true) throw new Error(SWIFTPM_CACHE_LIMIT);
  const record = value;
  if (Object.keys(record).some((key) => !['complete', 'ignored', 'outputs', 'localFiles', 'environment'].includes(key)))
    throw new Error(SWIFTPM_CACHE_LIMIT);
  const strings = (name: string, valid: (value: unknown) => value is string): string[] => {
    const values = record[name] ?? [];
    if (!Array.isArray(values) || !values.every(valid)) throw new Error(SWIFTPM_CACHE_LIMIT);
    return [...new Set(values)].toSorted();
  };
  return {
    complete: true,
    ignored: strings('ignored', repositoryPath),
    outputs: strings('outputs', repositoryPath),
    localFiles: strings(
      'localFiles',
      (path): path is string => typeof path === 'string' && !!path && !path.includes('\0'),
    ),
    environment: strings(
      'environment',
      (name): name is string => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name),
    ),
  };
}

async function regularInput(repository: string, path: string, signal?: AbortSignal): Promise<void> {
  const parts = path.split('/');
  for (let index = 1; index <= parts.length; index++) {
    signal?.throwIfAborted();
    const entry = await lstat(join(repository, ...parts.slice(0, index)));
    if (entry.isSymbolicLink()) throw new Error(`SwiftPM cache input ${path} contains a symbolic link.`);
    if (index === parts.length ? !entry.isFile() : !entry.isDirectory())
      throw new Error(`SwiftPM cache input ${path} must be an exact regular file with real directory parents.`);
  }
}

const below = (path: string, directory: string) => path === directory || path.startsWith(`${directory}/`);

export async function swiftpmArtifactSnapshot(
  root: string,
  value: unknown,
  build: SwiftpmArtifactBuild,
  toolchain: SwiftpmArtifactToolchain,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<{ hash: string; key: string }> {
  signal?.throwIfAborted();
  const declaration = swiftpmArtifactInputs(value);
  const repository = await realpath(await gitAsync(root, ['rev-parse', '--show-toplevel'], { signal }));
  const project = relative(repository, await realpath(root))
    .split(sep)
    .join('/');
  if (project && !repositoryPath(project)) throw new Error('The SwiftPM project leaves its repository.');
  if (Object.values(toolchain).some((version) => !version.trim()))
    throw new Error('The SwiftPM toolchain identity is unavailable.');
  const files = new Map((await sourceManifest(repository, true, signal)).map((file) => [file.path, file]));
  for (const path of declaration.ignored) {
    await regularInput(repository, path, signal);
    const info = await lstat(join(repository, path));
    files.set(path, {
      path,
      kind: info.mode & 0o111 ? 'exec' : 'file',
      ...(await nativeFileDigest(join(repository, path), signal)),
    });
  }
  for (const file of files.values()) {
    if (!repositoryPath(file.path)) throw new Error('SwiftPM cache inputs must be repository-relative.');
    await regularInput(repository, file.path, signal);
    if (declaration.outputs.some((output) => below(file.path, output) || below(output, file.path)))
      throw new Error(
        `SwiftPM source ${file.path} overlaps a declared generated output; ignore generated outputs in Git.`,
      );
  }
  const bundled = [
    { name: 'info-plist', path: resolve(root, build.infoPlist) },
    ...Object.entries(build.resources).map(([destination, source]) => ({
      name: `resource/${destination}`,
      path: resolve(root, source),
    })),
    ...(build.assetCatalog ? [{ name: 'asset-catalog', path: resolve(root, build.assetCatalog) }] : []),
  ];
  for (const input of bundled) {
    const path = relative(repository, await realpath(input.path))
      .split(sep)
      .join('/');
    if (!repositoryPath(path)) throw new Error('SwiftPM bundle inputs must stay inside the repository.');
  }
  for (const path of declaration.localFiles) {
    const info = await lstat(resolve(root, path)).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    });
    if (info && !info.isFile()) throw new Error('macos.artifactInputs.localFiles must name exact regular files.');
  }
  const local = await fingerprintNativeInputs(
    [
      ...bundled,
      { name: 'package-resolved', path: join(root, 'Package.resolved'), optional: true },
      ...declaration.localFiles.map((path, index) => ({
        name: `local/${index}`,
        path: resolve(root, path),
        optional: true,
      })),
    ],
    {
      parameters: Object.fromEntries(
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
      signal,
    },
  );
  const hash = createHash('sha256')
    .update('stim-swiftpm-artifact-v1\0')
    .update(
      JSON.stringify({
        project,
        source: manifestDigest([...files.values()]),
        local: local.hash,
        declaration,
        build: {
          ...build,
          resources: Object.fromEntries(Object.entries(build.resources).toSorted(([a], [b]) => a.localeCompare(b))),
        },
        toolchain,
      }),
    )
    .digest('hex');
  signal?.throwIfAborted();
  return { hash, key: buildCacheKey('macos', hash, { configuration: 'debug' }) };
}
