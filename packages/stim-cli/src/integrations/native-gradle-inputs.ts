import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { getExecutor } from '../exec.ts';
import { fingerprintNativeInputs } from './native-inputs.ts';
import { manifestDigest } from '../offload/manifest.ts';
import { nativeTransferManifest, sourceManifest, type NativeTransferFile } from '../offload/native-source.ts';

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

function requireRealParents(repository: string, path: string): void {
  const parts = path.split('/');
  for (let index = 1; index < parts.length; index++) {
    const parent = join(repository, ...parts.slice(0, index));
    const stat = lstatSync(parent, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) throw new Error(`Native input ${path} has a non-directory parent.`);
  }
}

export function nativeGradleTransfer(root: string, value: unknown): GradleTransfer {
  const declaration = gradleOffloadInputs(value);
  const repository = realpathSync(getExecutor().runFile('git', ['-C', root, 'rev-parse', '--show-toplevel']));
  const project = relative(repository, realpathSync(root)).split(sep).join('/');
  if (project && !containedPath(project)) throw new Error('The native Gradle project leaves its repository.');
  const state = gradleStateDirectories(project);
  const files = new Map(sourceManifest(repository, true).map((file) => [file.path, file]));
  for (const path of declaration.ignored) {
    requireRealParents(repository, path);
    const absolute = join(repository, path);
    const stat = lstatSync(absolute);
    if (!stat.isFile() && !stat.isSymbolicLink())
      throw new Error(`Ignored native input ${path} must be an exact file or link, not a directory.`);
    const content = stat.isSymbolicLink() ? Buffer.from(readlinkSync(absolute)) : readFileSync(absolute);
    files.set(path, {
      path,
      kind: stat.isSymbolicLink() ? 'link' : stat.mode & 0o111 ? 'exec' : 'file',
      size: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  }
  for (const file of files.values()) {
    if (!containedPath(file.path)) throw new Error(`Native input ${file.path} is not a contained relative path.`);
    requireRealParents(repository, file.path);
    if (state.some((path) => below(file.path, path)))
      throw new Error('Gradle project state cannot be transferred as source.');
    if (declaration.outputs.some((output) => below(file.path, output) || below(output, file.path)))
      throw new Error(`Native input ${file.path} overlaps a declared generated output.`);
    if (file.path.split('/').at(-1) === 'local.properties') {
      if (file.kind === 'link') throw new Error(`Native input ${file.path} is a machine-local properties link.`);
      const content = readFileSync(join(repository, file.path), 'utf8');
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
      const target = readlinkSync(absolute);
      const resolved = realpathSync(resolve(dirname(absolute), target));
      const destination = relative(repository, resolved).split(sep).join('/');
      if (isAbsolute(target) || !containedPath(destination) || !files.has(destination))
        throw new Error(`Native input ${file.path} links to a target outside the declared source inventory.`);
    }
  }
  for (const output of declaration.outputs) {
    requireRealParents(repository, output);
    const stat = lstatSync(join(repository, output), { throwIfNoEntry: false });
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

export function nativeGradleOutputs(repository: string, declaration: GradleOffloadInputs, reported: unknown): string[] {
  if (!Array.isArray(reported) || !reported.every((path) => typeof path === 'string' && isAbsolute(path)))
    throw new Error('AGP did not report the configured native Gradle build directories.');
  const reportedPaths = new Set<string>();
  for (const absolute of reported) {
    const path = relative(repository, resolve(absolute)).split(sep).join('/');
    if (!containedPath(path)) throw new Error('A Gradle build directory leaves the transferred repository.');
    requireRealParents(repository, path);
    const stat = lstatSync(join(repository, path), { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) throw new Error(`Gradle build directory ${path} is not a real directory.`);
    reportedPaths.add(path);
  }
  for (const output of declaration.outputs) {
    if (!reportedPaths.has(output)) throw new Error(`Declared output ${output} was not reported by AGP.`);
  }
  return declaration.outputs.filter((path) =>
    lstatSync(join(repository, path), { throwIfNoEntry: false })?.isDirectory(),
  );
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

export function verifyGradleTransfer(
  repository: string,
  project: string,
  declaration: GradleOffloadInputs,
  files: readonly NativeTransferFile[],
  digest: string,
): boolean {
  validateGradleManifest(project, declaration, files);
  const excluded = [...declaration.outputs, ...gradleStateDirectories(project)];
  for (const path of excluded) {
    requireRealParents(repository, path);
    const stat = lstatSync(join(repository, path), { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) throw new Error(`Worker output ${path} is not a real directory.`);
  }
  const markers = excluded.flatMap((path) =>
    path
      .split('/')
      .slice(0, -1)
      .map((_, index) => join(repository, ...path.split('/').slice(0, index + 1))),
  );
  const snapshot = fingerprintNativeInputs([{ name: 'repository', path: repository }], {
    excluded: [join(repository, '.git'), ...excluded.map((path) => join(repository, path))],
    ignoredDirectoryMarkers: markers.filter((path) => !files.some((file) => join(repository, file.path) === path)),
    parameters: null,
  });
  return manifestDigest(nativeTransferManifest(repository, snapshot, files)) === digest;
}
