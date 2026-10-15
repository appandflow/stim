import { createHash } from 'node:crypto';
import { access, lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gitAsync } from '../workspace/git.ts';
import { fingerprintNativeInputs } from './native-inputs.ts';
import { manifestDigest } from '../offload/manifest.ts';
import {
  nativeFileDigest,
  nativeTransferManifest,
  sourceManifest,
  type NativeTransferFile,
} from '../offload/native-source.ts';

import type { GradleOffloadInputs } from '@stim-cli/core/protocol';
export type { GradleOffloadInputs } from '@stim-cli/core/protocol';

export interface GradleTransfer {
  repository: string;
  project: string;
  declaration: GradleOffloadInputs;
  files: NativeTransferFile[];
  digest: string;
}

function containedPath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !path.includes('\\') &&
    !path.includes(':') &&
    !path.includes('\0') &&
    !path.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
  );
}

export function gradleOffloadInputs(value: unknown): GradleOffloadInputs {
  const input = value as Partial<GradleOffloadInputs> | null;
  if (
    !input ||
    typeof input !== 'object' ||
    input.complete !== true ||
    Object.keys(input).some((key) => !['complete', 'ignored', 'outputs'].includes(key)) ||
    !Array.isArray(input.ignored) ||
    !input.ignored.every(containedPath) ||
    !Array.isArray(input.outputs) ||
    !input.outputs.every(containedPath)
  )
    throw new Error(
      'Native Gradle offload requires android.offloadInputs with complete: true, ignored: [exact repository-relative files], and outputs: [generated repository-relative directories].',
    );
  const ignored = [...new Set(input.ignored)].toSorted();
  const outputs = [...new Set(input.outputs)].toSorted();
  if (ignored.some((path) => path.split('/').at(-1) === 'local.properties'))
    throw new Error('local.properties is machine-local; remove it from android.offloadInputs.ignored.');
  if (outputs.some((path) => path.split('/').some((part) => part === '.gradle' || part === '.kotlin')))
    throw new Error('Gradle project state is worker-owned and cannot be declared as a generated output.');
  for (const output of outputs) {
    if (outputs.some((other) => other !== output && output.startsWith(`${other}/`)))
      throw new Error(`Generated output ${output} is nested inside another output declaration.`);
  }
  return { complete: true, ignored, outputs };
}

const below = (path: string, directory: string) => path === directory || path.startsWith(`${directory}/`);

export function gradleStateDirectories(project: string): string[] {
  return ['.gradle', '.kotlin'].map((name) => (project ? `${project}/${name}` : name));
}

async function statIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function requireRealParents(repository: string, path: string, signal?: AbortSignal): Promise<void> {
  const parts = path.split('/');
  for (let index = 1; index < parts.length; index++) {
    signal?.throwIfAborted();
    const parent = join(repository, ...parts.slice(0, index));
    const stat = await statIfPresent(parent);
    if (stat && !stat.isDirectory()) throw new Error(`Native input ${path} has a non-directory parent.`);
  }
}

export async function nativeGradleTransfer(
  root: string,
  value: unknown,
  signal?: AbortSignal,
): Promise<GradleTransfer> {
  return nativeGradleInventory(root, value, [], signal, true);
}

export async function nativeGradleLocalSourceDigest(
  root: string,
  value: unknown,
  localFiles: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  const { project, digest } = await nativeGradleInventory(root, value, localFiles, signal, false);
  return createHash('sha256').update(JSON.stringify({ project, digest })).digest('hex');
}

async function nativeGradleInventory(
  root: string,
  value: unknown,
  localFiles: readonly string[],
  signal: AbortSignal | undefined,
  transfer: boolean,
): Promise<GradleTransfer> {
  signal?.throwIfAborted();
  const declaration = gradleOffloadInputs(value);
  const repository = await realpath(await gitAsync(root, ['rev-parse', '--show-toplevel'], { signal }));
  const project = relative(repository, await realpath(root))
    .split(sep)
    .join('/');
  if (project && !containedPath(project)) throw new Error('The native Gradle project leaves its repository.');
  if (transfer && (await statIfPresent(join(repository, project, 'buildSrc')))?.isDirectory())
    throw new Error(
      'Native Gradle offload does not support buildSrc: AGP does not report its build directories, so the worker cannot keep them.',
    );
  const state = gradleStateDirectories(project);
  const files = new Map((await sourceManifest(repository, true, signal)).map((file) => [file.path, file]));
  for (const path of declaration.ignored) {
    await requireRealParents(repository, path, signal);
    const absolute = join(repository, path);
    const stat = await lstat(absolute);
    if (!stat.isFile() && !stat.isSymbolicLink())
      throw new Error(`Ignored native input ${path} must be an exact file or link, not a directory.`);
    if (stat.isSymbolicLink()) {
      const content = Buffer.from(await readlink(absolute));
      files.set(path, {
        path,
        kind: 'link',
        size: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
      });
    } else {
      files.set(path, {
        path,
        kind: stat.mode & 0o111 ? 'exec' : 'file',
        ...(await nativeFileDigest(absolute, signal)),
      });
    }
  }
  for (const file of files.values()) {
    if (localFiles.some((path) => resolve(path) === resolve(repository, file.path))) {
      files.delete(file.path);
      continue;
    }
    if (!containedPath(file.path)) throw new Error(`Native input ${file.path} is not a contained relative path.`);
    await requireRealParents(repository, file.path, signal);
    if (state.some((path) => below(file.path, path)))
      throw new Error('Gradle project state cannot be transferred as source.');
    if (declaration.outputs.some((output) => below(file.path, output) || below(output, file.path)))
      throw new Error(`Native input ${file.path} overlaps a declared generated output.`);
    if (file.path.split('/').at(-1) === 'local.properties') {
      if (file.kind === 'link') throw new Error(`Native input ${file.path} is a machine-local properties link.`);
      const content = await readFile(join(repository, file.path), { encoding: 'utf8', signal });
      if (
        content
          .split(/\r?\n/)
          .some((line) => line.trim() && !/^\s*[#!]/.test(line) && !/^\s*sdk\.dir\s*[:=].*[^\\]$/.test(line))
      )
        throw new Error(`Native input ${file.path} contains unsupported machine-local properties.`);
      files.delete(file.path);
      continue;
    }
  }
  for (const file of files.values()) {
    if (file.kind === 'link') {
      const absolute = join(repository, file.path);
      const target = await readlink(absolute);
      const resolved = await realpath(resolve(dirname(absolute), target));
      const destination = relative(repository, resolved).split(sep).join('/');
      if (isAbsolute(target) || !containedPath(destination) || !files.has(destination))
        throw new Error(`Native input ${file.path} links to a target outside the declared source inventory.`);
    }
  }
  for (const output of declaration.outputs) {
    await requireRealParents(repository, output, signal);
    const stat = await statIfPresent(join(repository, output));
    if (stat && !stat.isDirectory()) throw new Error(`Generated output ${output} is not a real directory.`);
    if (state.some((path) => below(output, path) || below(path, output)))
      throw new Error(`Generated output ${output} overlaps Gradle project state.`);
  }
  const empty = createHash('sha256').update('').digest('hex');
  for (const path of files.keys()) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) {
      const directory = parts.slice(0, index).join('/');
      files.set(directory, { path: directory, kind: 'directory', size: 0, sha256: empty });
    }
  }
  const selected = [...files.values()].toSorted((a, b) => a.path.localeCompare(b.path));
  return { repository, project, declaration, files: selected, digest: manifestDigest(selected) };
}

async function canonicalParent(path: string): Promise<string> {
  const missing: string[] = [];
  while (
    !(await access(path).then(
      () => true,
      () => false,
    )) &&
    dirname(path) !== path
  ) {
    missing.unshift(basename(path));
    path = dirname(path);
  }
  return join(await realpath(path), ...missing);
}

export async function nativeGradleOutputs(
  repository: string,
  declaration: GradleOffloadInputs,
  reported: unknown,
  signal?: AbortSignal,
): Promise<string[]> {
  signal?.throwIfAborted();
  if (!Array.isArray(reported) || !reported.every((path) => typeof path === 'string' && isAbsolute(path)))
    throw new Error('AGP did not report the configured native Gradle build directories.');
  const real = await realpath(repository);
  const reportedPaths = new Set<string>();
  for (const absolute of reported) {
    const resolved = resolve(absolute);
    const canonical = join(await canonicalParent(dirname(resolved)), basename(resolved));
    const path = relative(real, canonical).split(sep).join('/');
    if (!containedPath(path)) throw new Error('A Gradle build directory leaves the transferred repository.');
    await requireRealParents(repository, path, signal);
    const stat = await statIfPresent(join(repository, path));
    if (stat && !stat.isDirectory()) throw new Error(`Gradle build directory ${path} is not a real directory.`);
    reportedPaths.add(path);
  }
  for (const output of declaration.outputs) {
    if (!reportedPaths.has(output)) throw new Error(`Declared output ${output} was not reported by AGP.`);
  }
  for (const path of reportedPaths) {
    if (
      (await statIfPresent(join(repository, path)))?.isDirectory() &&
      !declaration.outputs.some((output) => below(path, output))
    )
      throw new Error(`Gradle build directory ${path} is not declared; add it to android.offloadInputs.outputs.`);
  }
  const outputs: string[] = [];
  for (const path of declaration.outputs) {
    signal?.throwIfAborted();
    if ((await statIfPresent(join(repository, path)))?.isDirectory()) outputs.push(path);
  }
  return outputs;
}

export function validateGradleManifest(
  project: string,
  declaration: GradleOffloadInputs,
  files: readonly NativeTransferFile[],
): void {
  gradleOffloadInputs(declaration);
  if (project && !containedPath(project)) throw new Error('The native Gradle project leaves its repository.');
  const excluded = [...declaration.outputs, ...gradleStateDirectories(project)];
  for (const file of files) {
    if (
      !containedPath(file.path) ||
      excluded.some((path) => below(file.path, path) || (file.kind !== 'directory' && below(path, file.path)))
    )
      throw new Error(`Native source ${file.path} overlaps worker outputs or leaves the repository.`);
  }
  for (const path of declaration.ignored) {
    if (!files.some((file) => file.path === path && file.kind !== 'directory'))
      throw new Error(`Declared ignored input ${path} is missing from the transfer.`);
  }
}

export async function verifyGradleTransfer(
  repository: string,
  project: string,
  declaration: GradleOffloadInputs,
  files: readonly NativeTransferFile[],
  digest: string,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  validateGradleManifest(project, declaration, files);
  const excluded = [...declaration.outputs, ...gradleStateDirectories(project)];
  for (const path of excluded) {
    await requireRealParents(repository, path, signal);
    const stat = await statIfPresent(join(repository, path));
    if (stat && !stat.isDirectory()) throw new Error(`Worker output ${path} is not a real directory.`);
  }
  const markers = excluded.flatMap((path) =>
    path
      .split('/')
      .slice(0, -1)
      .map((_, index) => join(repository, ...path.split('/').slice(0, index + 1))),
  );
  const snapshot = await fingerprintNativeInputs([{ name: 'repository', path: repository }], {
    excluded: [join(repository, '.git'), ...excluded.map((path) => join(repository, path))],
    ignoredDirectoryMarkers: markers.filter((path) => !files.some((file) => join(repository, file.path) === path)),
    parameters: null,
    signal,
  });
  const known = new Set(files.map((file) => file.path));
  for (const entry of snapshot.entries) {
    if (!entry.path.startsWith('repository/') || entry.path.includes('/@target')) continue;
    const parts = entry.path.slice('repository/'.length).split('/');
    const index = parts.findIndex((_, depth) => !known.has(parts.slice(0, depth + 1).join('/')));
    if (index >= 0 && (index < parts.length - 1 || entry.kind === 'directory'))
      throw new Error(
        `Native Gradle directory ${parts.slice(0, index + 1).join('/')} is outside the source transfer and not a declared output reported by AGP; such directories, for example, included builds or externalNativeBuild staging, are not supported for remote builds.`,
      );
  }
  return manifestDigest(await nativeTransferManifest(repository, snapshot, files, signal)) === digest;
}
