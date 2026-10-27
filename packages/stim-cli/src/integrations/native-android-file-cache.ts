import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, readFile, realpath, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { BuildCacheCapability, FileCacheCapability } from '@stim-cli/cache';
import type { StimContext } from '@stim-cli/core';
import { artifactIn, entryDir } from '../cache/build-cache.ts';
import { materializeNativeApk } from './native-android-cache.ts';

const MAGIC = Buffer.from('STIMAPK1\n');
const HEADER_BYTES = MAGIC.length + 4;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const RECEIPT = 'native-android.json';
const fileKey = (key: string) => `native-android/v1/${key}`;

async function readExactly(file: FileHandle, size: number, position: number, signal: AbortSignal): Promise<Buffer> {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    signal.throwIfAborted();
    const { bytesRead } = await file.read(buffer, offset, size - offset, position + offset);
    if (!bytesRead) throw new Error('The shared native APK entry is truncated.');
    offset += bytesRead;
  }
  return buffer;
}

async function unpack(source: string, directory: string, signal: AbortSignal): Promise<string> {
  const file = await open(source, 'r');
  try {
    const header = await readExactly(file, HEADER_BYTES, 0, signal);
    const size = header.readUInt32BE(MAGIC.length);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC) || size === 0 || size > MAX_RECEIPT_BYTES)
      throw new Error('The shared native APK entry has an unsupported header.');
    const receipt = await readExactly(file, size, HEADER_BYTES, signal);
    const apk = join(directory, 'artifact.apk');
    await writeFile(join(directory, RECEIPT), receipt, { flag: 'wx', mode: 0o600, signal });
    await pipeline(
      file.createReadStream({ start: HEADER_BYTES + size, autoClose: false }),
      createWriteStream(apk, { flags: 'wx', mode: 0o600 }),
      { signal },
    );
    return apk;
  } finally {
    await file.close();
  }
}

export function nativeAndroidFileCache(
  files: FileCacheCapability,
  sdk: string,
  abi: string | null,
  operation?: StimContext,
): BuildCacheCapability {
  return {
    async resolve({ key, destinationDir, signal }) {
      const directory = await mkdtemp(join(destinationDir, 'native-apk-'));
      let keep = false;
      try {
        const source = await files.resolve({ key: fileKey(key), destinationDir: directory, signal });
        if (!source) return null;
        const contained = relative(await realpath(directory), await realpath(source));
        if (isAbsolute(contained) || contained === '..' || contained.startsWith(`..${sep}`))
          throw new Error('The shared native APK file is outside its download directory.');
        if (!(await stat(source)).isFile()) throw new Error('The shared native APK entry is not a regular file.');
        const unpacked = await mkdtemp(join(directory, 'unpacked-'));
        const apk = await unpack(source, unpacked, signal);
        if (!(await materializeNativeApk(key, apk, sdk, abi, operation, signal)))
          throw new Error('The shared native APK does not match its verification receipt.');
        keep = true;
        return apk;
      } finally {
        if (!keep) await rm(directory, { recursive: true, force: true });
      }
    },
    async store({ key, sourcePath, overwrite, signal }) {
      const cached = artifactIn(entryDir('android', key));
      if (!cached) throw new Error('No native APK is stored locally for this key.');
      const metadata = await readFile(join(dirname(cached), RECEIPT), { signal });
      if (metadata.length > MAX_RECEIPT_BYTES) throw new Error('The native APK receipt is too large.');
      const receipt = JSON.parse(metadata.toString('utf8'));
      if (receipt.schema !== 1 || receipt.key !== key) throw new Error('The native APK has no matching cache receipt.');
      const directory = await mkdtemp(join(tmpdir(), 'stim-native-apk-file-'));
      try {
        const envelope = join(directory, 'artifact');
        const header = Buffer.alloc(HEADER_BYTES);
        MAGIC.copy(header);
        header.writeUInt32BE(metadata.length, MAGIC.length);
        const payload = async function* () {
          yield header;
          yield metadata;
          const hash = createHash('sha256');
          for await (const chunk of createReadStream(sourcePath, { signal })) {
            hash.update(chunk);
            yield chunk;
          }
          if (hash.digest('hex') !== receipt.sha256)
            throw new Error('The native APK changed while its shared entry was packed.');
        };
        await pipeline(Readable.from(payload()), createWriteStream(envelope, { flags: 'wx', mode: 0o600 }), { signal });
        signal.throwIfAborted();
        await files.store({ key: fileKey(key), sourcePath: envelope, overwrite, signal });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
