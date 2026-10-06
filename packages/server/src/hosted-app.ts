import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readlinkSync,
  readSync,
  realpathSync,
  statSync,
  appendFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { withDirLock } from '@stim-cli/core';
import {
  HOSTED_APP_CHUNK_BYTES,
  hostedAppArea,
  hostedAppBlobs,
  validHostedAppBlob,
  isJsonObject,
  readHostedApp,
  readHostedAppMetadata,
  type HostedAppRecord,
  type HostedAppDelivery,
  type HostedAppOffer,
} from '@stim-cli/core/state';
import { writeJson } from './registry.ts';

export function appDelivery(
  record: Omit<HostedAppRecord, 'files'> & { files?: HostedAppRecord['files'] },
): HostedAppDelivery {
  const { files: _files, manifest: _manifest, ...delivery } = record;
  return delivery;
}

function writeHostedApp(record: HostedAppRecord): void {
  const { files: _files, ...receipt } = record;
  writeJson(join(hostedAppArea(record.session, record.attempt), 'receipt.json'), receipt);
}

export function changeHostedApp(
  session: string,
  attempt: string,
  update: (record: HostedAppRecord) => void,
): HostedAppRecord {
  return withDirLock(`${hostedAppArea(session, attempt)}.lock`, () => {
    const record = readHostedApp(session, attempt);
    update(record);
    writeHostedApp(record);
    return record;
  });
}

export function offerHostedApp(offer: HostedAppOffer): {
  delivery: HostedAppDelivery;
  missing: { sha256: string; size: number; offset: number }[];
} {
  const blobs = hostedAppBlobs(offer.session);
  return withDirLock(
    `${blobs}.lock`,
    () => {
      mkdirSync(blobs, { recursive: true, mode: 0o700 });
      const manifest = join(blobs, offer.manifest.sha256);
      if (existsSync(manifest) && !validHostedAppBlob(manifest, offer.manifest)) rmSync(manifest, { force: true });
      const next = {
        session: offer.session,
        attempt: offer.attempt,
        bundleId: offer.bundleId,
        mode: offer.mode,
        ...(offer.devClientScheme ? { devClientScheme: offer.devClientScheme } : {}),
        ...(offer.arguments ? { arguments: offer.arguments } : {}),
        manifest: offer.manifest,
      };
      const area = hostedAppArea(offer.session, offer.attempt);
      const record = withDirLock(
        `${area}.lock`,
        () => {
          if (!existsSync(area)) {
            mkdirSync(area, { recursive: true, mode: 0o700 });
            writeHostedApp({ ...next, files: [], state: 'receiving', launched: null });
          }
          const stored = readHostedApp(offer.session, offer.attempt);
          const previous = {
            session: stored.session,
            attempt: stored.attempt,
            bundleId: stored.bundleId,
            mode: stored.mode,
            ...(stored.devClientScheme ? { devClientScheme: stored.devClientScheme } : {}),
            ...(stored.arguments ? { arguments: stored.arguments } : {}),
            manifest: stored.manifest,
          };
          if (JSON.stringify(previous) !== JSON.stringify(next))
            throw new Error('This app attempt already describes different content.');
          return stored;
        },
        { ensureParent: () => mkdirSync(join(area, '..'), { recursive: true, mode: 0o700 }) },
      );
      const missing = [
        ...new Map(
          (record.files.length ? record.files : [record.manifest]).map((file) => [file.sha256, file]),
        ).values(),
      ].flatMap((file) => {
        const complete = join(blobs, file.sha256);
        if (validHostedAppBlob(complete, file)) return [];
        rmSync(complete, { force: true });
        const partial = `${complete}.part`;
        const stat = lstatSync(partial, { throwIfNoEntry: false });
        if (stat && (!stat.isFile() || stat.size >= file.size)) {
          if (validHostedAppBlob(partial, file)) {
            renameSync(partial, complete);
            return [];
          }
          rmSync(partial, { force: true });
        }
        return [
          { sha256: file.sha256, size: file.size, offset: stat?.isFile() && stat.size < file.size ? stat.size : 0 },
        ];
      });
      return { delivery: appDelivery(record), missing };
    },
    { ensureParent: () => mkdirSync(join(blobs, '..'), { recursive: true, mode: 0o700 }) },
  );
}

async function digest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function chunkHostedApp(record: HostedAppRecord, params: unknown): Promise<{ offset: number }> {
  if (
    !isJsonObject(params) ||
    typeof params.sha256 !== 'string' ||
    typeof params.offset !== 'number' ||
    !Number.isSafeInteger(params.offset) ||
    params.offset < 0 ||
    typeof params.data !== 'string' ||
    params.data.length > Math.ceil(HOSTED_APP_CHUNK_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(params.data)
  )
    throw new Error('App chunks need a manifest digest, byte offset and bounded base64 data.');
  const file =
    record.manifest.sha256 === params.sha256
      ? record.manifest
      : record.files.find((each) => each.sha256 === params.sha256);
  if (!file) throw new Error('The chunk digest is not in this app attempt.');
  const bytes = Buffer.from(params.data, 'base64');
  const start = params.offset;
  if (bytes.length > HOSTED_APP_CHUNK_BYTES || params.offset + bytes.length > file.size || (!bytes.length && file.size))
    throw new Error('The chunk exceeds the declared file.');
  const blobs = hostedAppBlobs(record.session);
  const complete = join(blobs, file.sha256);
  const partial = `${complete}.part`;
  const offset = withDirLock(`${blobs}.lock`, () => {
    if (validHostedAppBlob(complete, file)) return file.size;
    rmSync(complete, { force: true });
    if (readHostedAppMetadata(record.session, record.attempt).state !== 'receiving')
      throw new Error('This app attempt is no longer receiving content.');
    const stat = lstatSync(partial, { throwIfNoEntry: false });
    if (stat && !stat.isFile()) throw new Error('The partial app blob is not a regular file.');
    const current = stat?.size ?? 0;
    if (start !== current) {
      if (start + bytes.length > current) throw new Error(`Resume this file at byte ${current}.`);
      const previous = Buffer.alloc(bytes.length);
      const fd = openSync(partial, 'r');
      try {
        readSync(fd, previous, 0, previous.length, start);
      } finally {
        closeSync(fd);
      }
      if (!previous.equals(bytes)) throw new Error('A replayed chunk differs from the received bytes.');
      return current;
    }
    appendFileSync(partial, bytes, { mode: 0o600 });
    const received = current + bytes.length;
    if (received !== file.size) return received;
    if (!validHostedAppBlob(partial, file)) {
      rmSync(partial, { force: true });
      throw new Error('App content digest mismatch; the partial file was discarded.');
    }
    renameSync(partial, complete);
    if (file.sha256 === record.manifest.sha256) {
      try {
        readHostedApp(record.session, record.attempt);
      } catch (error) {
        rmSync(complete, { force: true });
        throw error;
      }
    }
    return received;
  });
  return { offset };
}

/**
 * Fills the attempt's missing content from `bundle`, a build this Mac staged: only a regular file, or a link where the
 * manifest declares one, whose directory resolves inside the bundle and whose copied bytes match the manifest digest.
 * Anything else stays missing for the client to send.
 */
export async function handOverHostedApp(
  record: HostedAppRecord,
  bundle: string,
): Promise<{ files: number; bytes: number }> {
  const blobs = hostedAppBlobs(record.session);
  const root = realpathSync(bundle);
  let files = 0;
  let bytes = 0;
  for (const file of record.files) {
    const blob = join(blobs, file.sha256);
    if (validHostedAppBlob(blob, file)) continue;
    const source = join(root, file.path);
    const temp = `${blob}.handoff-${randomUUID()}`;
    try {
      const stat = lstatSync(source, { throwIfNoEntry: false });
      if (!stat || (file.kind === 'link' ? !stat.isSymbolicLink() : !stat.isFile()) || stat.size !== file.size)
        continue;
      const parent = realpathSync(dirname(source));
      if (parent !== root && !parent.startsWith(`${root}/`)) continue;
      if (file.kind === 'link') writeFileSync(temp, readlinkSync(source, { encoding: 'buffer' }), { mode: 0o600 });
      else await copyFile(source, temp, constants.COPYFILE_FICLONE);
      if (statSync(temp).size !== file.size || (await digest(temp)) !== file.sha256) continue;
      const placed = withDirLock(`${blobs}.lock`, () => {
        if (validHostedAppBlob(blob, file)) return false;
        if (readHostedAppMetadata(record.session, record.attempt).state !== 'receiving')
          throw new Error('This app attempt is no longer receiving content.');
        renameSync(temp, blob);
        return true;
      });
      if (placed) {
        files++;
        bytes += file.size;
      }
    } finally {
      rmSync(temp, { force: true });
    }
  }
  return { files, bytes };
}
