import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readSync,
  statSync,
  appendFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { withDirLock } from '@stim-cli/core';
import {
  HOSTED_APP_CHUNK_BYTES,
  hostedAppArea,
  isJsonObject,
  readHostedApp,
  readHostedAppMetadata,
  type HostedAppRecord,
  type HostedAppDelivery,
  type HostedAppOffer,
} from '@stim-cli/core/state';
import { writeJson } from './registry.ts';

export function appDelivery(record: HostedAppRecord): HostedAppDelivery {
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
  const next = {
    session: offer.session,
    attempt: offer.attempt,
    bundleId: offer.bundleId,
    mode: offer.mode,
    manifest: offer.manifest,
  };
  const area = hostedAppArea(offer.session, offer.attempt);
  const record = withDirLock(
    `${area}.lock`,
    () => {
      if (!existsSync(area)) {
        mkdirSync(join(area, 'blobs'), { recursive: true, mode: 0o700 });
        writeHostedApp({ ...next, files: [], state: 'receiving', launched: null });
      }
      const stored = readHostedApp(offer.session, offer.attempt);
      const previous = {
        session: stored.session,
        attempt: stored.attempt,
        bundleId: stored.bundleId,
        mode: stored.mode,
        manifest: stored.manifest,
      };
      if (JSON.stringify(previous) !== JSON.stringify(next))
        throw new Error('This app attempt already describes different content.');
      return stored;
    },
    { ensureParent: () => mkdirSync(join(area, '..'), { recursive: true, mode: 0o700 }) },
  );
  const missing = [
    ...new Map((record.files.length ? record.files : [record.manifest]).map((file) => [file.sha256, file])).values(),
  ]
    .filter((file) => !existsSync(join(area, 'blobs', file.sha256)))
    .map((file) => {
      const partial = join(area, 'blobs', `${file.sha256}.part`);
      return { sha256: file.sha256, size: file.size, offset: existsSync(partial) ? statSync(partial).size : 0 };
    });
  return { delivery: appDelivery(record), missing };
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
  const area = hostedAppArea(record.session, record.attempt);
  const complete = join(area, 'blobs', file.sha256);
  const partial = `${complete}.part`;
  const offset = withDirLock(`${area}.lock`, () => {
    if (existsSync(complete)) return file.size;
    if (readHostedAppMetadata(record.session, record.attempt).state !== 'receiving')
      throw new Error('This app attempt is no longer receiving content.');
    const current = existsSync(partial) ? statSync(partial).size : 0;
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
    return current + bytes.length;
  });
  if (offset === file.size && !existsSync(complete)) {
    if ((await digest(partial)) !== file.sha256) {
      withDirLock(`${area}.lock`, () => rmSync(partial, { force: true }));
      throw new Error('App content digest mismatch; the partial file was discarded.');
    }
    withDirLock(`${area}.lock`, () => {
      if (!existsSync(complete)) renameSync(partial, complete);
    });
    if (file.sha256 === record.manifest.sha256) {
      try {
        readHostedApp(record.session, record.attempt);
      } catch (error) {
        withDirLock(`${area}.lock`, () => rmSync(complete, { force: true }));
        throw error;
      }
    }
  }
  return { offset };
}
