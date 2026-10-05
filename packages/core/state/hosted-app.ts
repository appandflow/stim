import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { deviceHostArea } from './device-host.ts';
import { isJsonObject } from './json-file.ts';

export interface HostedAppFile {
  path: string;
  kind: 'file' | 'exec' | 'link';
  size: number;
  sha256: string;
}

export interface HostedAppOffer {
  session: string;
  attempt: string;
  bundleId: string;
  mode: 'development' | 'release';
  devClientScheme?: string;
  arguments?: string[];
  manifest: { sha256: string; size: number };
}

export interface HostedAppDelivery extends Omit<HostedAppOffer, 'manifest'> {
  state: 'receiving' | 'installing' | 'installed' | 'unknown';
  launched: true | 'unverified' | null;
  notice?: string;
}

export interface HostedAppRecord extends HostedAppDelivery {
  manifest: HostedAppOffer['manifest'];
  files: HostedAppFile[];
}

export const HOSTED_APP_CHUNK_BYTES: number = 32 * 1024;

export function hostedAppAttempt(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

export function hostedAppArea(session: string, attempt: string, workerHome?: string): string {
  if (!hostedAppAttempt(attempt)) throw new Error('Invalid hosted app attempt.');
  if (workerHome) return join(workerHome, '..', 'apps', attempt);
  return join(deviceHostArea(session), 'apps', attempt);
}

export function parseHostedAppOffer(value: unknown): HostedAppOffer | null {
  if (
    !isJsonObject(value) ||
    typeof value.session !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(value.session) ||
    !hostedAppAttempt(value.attempt) ||
    typeof value.bundleId !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(value.bundleId) ||
    (value.mode !== 'development' && value.mode !== 'release') ||
    (value.devClientScheme !== undefined &&
      (value.mode !== 'development' ||
        typeof value.devClientScheme !== 'string' ||
        !/^[a-zA-Z][a-zA-Z0-9+.-]{0,127}$/.test(value.devClientScheme))) ||
    !isJsonObject(value.manifest) ||
    typeof value.manifest.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.manifest.sha256) ||
    typeof value.manifest.size !== 'number' ||
    !Number.isSafeInteger(value.manifest.size) ||
    value.manifest.size < 1 ||
    value.manifest.size > 8 * 1024 ** 2
  )
    return null;
  if (value.arguments !== undefined) {
    if (
      !Array.isArray(value.arguments) ||
      value.arguments.length > 32 ||
      value.arguments.some(
        (argument) => typeof argument !== 'string' || argument.length > 1024 || /[\0\r\n]/.test(argument),
      ) ||
      value.arguments.reduce((total, argument) => total + argument.length, 0) > 8192
    )
      return null;
  }
  return {
    session: value.session,
    attempt: value.attempt,
    bundleId: value.bundleId,
    mode: value.mode,
    ...(typeof value.devClientScheme === 'string' ? { devClientScheme: value.devClientScheme } : {}),
    ...(value.arguments?.length ? { arguments: value.arguments } : {}),
    manifest: { sha256: value.manifest.sha256, size: value.manifest.size },
  };
}

/** Relative normalized paths, with no file or link as another entry's ancestor. */
export function parseHostedAppManifest(value: unknown): HostedAppFile[] | null {
  if (!Array.isArray(value) || !value.length || value.length > 20000) return null;
  const files: HostedAppFile[] = [];
  const paths = new Set<string>();
  const sizes = new Map<string, number>();
  let total = 0;
  for (const file of value) {
    if (
      !isJsonObject(file) ||
      typeof file.path !== 'string' ||
      !file.path ||
      file.path.length > 1024 ||
      /[\\\0\r\n]/.test(file.path) ||
      file.path.split('/').some((part) => !part || part === '.' || part === '..') ||
      paths.has(file.path.normalize('NFC').toLowerCase()) ||
      !['file', 'exec', 'link'].includes(String(file.kind)) ||
      typeof file.size !== 'number' ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > (file.kind === 'link' ? 1024 : 1024 ** 3) ||
      typeof file.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(file.sha256) ||
      (sizes.has(file.sha256) && sizes.get(file.sha256) !== file.size)
    )
      return null;
    total += file.size;
    if (total > 4 * 1024 ** 3) return null;
    paths.add(file.path.normalize('NFC').toLowerCase());
    sizes.set(file.sha256, file.size);
    files.push({ path: file.path, kind: file.kind as HostedAppFile['kind'], size: file.size, sha256: file.sha256 });
  }
  for (const path of paths) {
    let ancestor = posix.dirname(path);
    while (ancestor !== '.') {
      if (paths.has(ancestor)) return null;
      ancestor = posix.dirname(ancestor);
    }
  }
  if (
    !files.some((file) => file.path === 'Info.plist' && file.kind === 'file') &&
    !(
      files.some((file) => file.path === 'Contents/Info.plist' && file.kind === 'file') &&
      files.some((file) => file.path.startsWith('Contents/MacOS/') && file.kind === 'exec')
    ) &&
    !(files.length === 1 && files[0]?.path === 'App.apk' && files[0].kind === 'file')
  )
    return null;
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

/** Reads a server-written receipt; malformed or missing established state remains unresolved. */
export function readHostedAppMetadata(
  session: string,
  attempt: string,
  workerHome?: string,
): Omit<HostedAppRecord, 'files'> {
  const value: unknown = JSON.parse(
    readFileSync(join(hostedAppArea(session, attempt, workerHome), 'receipt.json'), 'utf8'),
  );
  const offer = parseHostedAppOffer(value);
  if (
    !offer ||
    offer.session !== session ||
    offer.attempt !== attempt ||
    !isJsonObject(value) ||
    !['receiving', 'installing', 'installed', 'unknown'].includes(String(value.state)) ||
    (value.launched !== null && value.launched !== true && value.launched !== 'unverified') ||
    (value.notice !== undefined && typeof value.notice !== 'string')
  )
    throw new Error('The hosted app receipt is malformed.');
  return {
    ...offer,
    state: value.state as HostedAppRecord['state'],
    launched: value.launched as HostedAppRecord['launched'],
    ...(typeof value.notice === 'string' ? { notice: value.notice } : {}),
  };
}

export function readHostedApp(session: string, attempt: string, workerHome?: string): HostedAppRecord {
  const record = readHostedAppMetadata(session, attempt, workerHome);
  const manifest = join(hostedAppArea(session, attempt, workerHome), 'blobs', record.manifest.sha256);
  const files = existsSync(manifest) ? parseHostedAppManifest(JSON.parse(readFileSync(manifest, 'utf8'))) : [];
  if (!files || (!files.length && record.state !== 'receiving'))
    throw new Error('The hosted app manifest is missing or malformed.');
  return { ...record, files };
}
