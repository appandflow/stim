import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readdir, readlink, realpath, symlink, writeFile, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseHostedAppManifest, type HostedAppFile } from '@stim-cli/core/state';
import { nativeFileDigest } from '../offload/native-source.ts';

const MAGIC = Buffer.from('STIMMAC1\n');
const MAX_HEADER_BYTES = 16 * 1024 * 1024;
const canonical = (path: string) => path.normalize('NFC').toLowerCase();

async function bundleFiles(
  bundle: string,
  signal: AbortSignal,
): Promise<{ files: HostedAppFile[]; directories: string[] }> {
  const files: HostedAppFile[] = [];
  const directories: string[] = [];
  const walk = async (path: string) => {
    signal.throwIfAborted();
    const absolute = join(bundle, path);
    const info = await lstat(absolute);
    if (info.isDirectory()) {
      if (path) directories.push(path);
      for (const entry of await readdir(absolute)) await walk(path ? `${path}/${entry}` : entry);
    } else if (info.isFile()) {
      files.push({ path, kind: info.mode & 0o111 ? 'exec' : 'file', ...(await nativeFileDigest(absolute, signal)) });
    } else if (info.isSymbolicLink()) {
      const bytes = Buffer.from(await readlink(absolute));
      files.push({ path, kind: 'link', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    } else throw new Error('The cached macOS bundle contains an unsupported file.');
  };
  await walk('');
  const parsed = parseHostedAppManifest(files);
  if (!parsed || directories.length > 20000) throw new Error('The cached macOS bundle has an invalid file inventory.');
  return { files: parsed, directories: directories.toSorted() };
}

export async function packMacosArtifact(
  bundle: string,
  key: string,
  output: string,
  signal: AbortSignal,
): Promise<void> {
  const { files, directories } = await bundleFiles(bundle, signal);
  const metadata = Buffer.from(JSON.stringify({ key, files, directories }));
  if (metadata.length > MAX_HEADER_BYTES) throw new Error('The cached macOS bundle receipt is too large.');
  const header = Buffer.alloc(MAGIC.length + 4);
  MAGIC.copy(header);
  header.writeUInt32BE(metadata.length, MAGIC.length);
  const payload = async function* () {
    yield header;
    yield metadata;
    for (const file of files) {
      signal.throwIfAborted();
      const hash = createHash('sha256');
      let size = 0;
      const path = join(bundle, file.path);
      const input = file.kind === 'link' ? [Buffer.from(await readlink(path))] : createReadStream(path, { signal });
      for await (const bytes of input) {
        hash.update(bytes);
        size += bytes.length;
        yield bytes;
      }
      if (size !== file.size || hash.digest('hex') !== file.sha256)
        throw new Error('The macOS bundle changed while its cache entry was packed.');
    }
  };
  await pipeline(Readable.from(payload()), createWriteStream(output, { flags: 'wx', mode: 0o600 }), { signal });
}

async function readExactly(file: FileHandle, size: number, position: number, signal: AbortSignal): Promise<Buffer> {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    signal.throwIfAborted();
    const read = await file.read(bytes, offset, size - offset, position + offset);
    if (!read.bytesRead) throw new Error('The cached macOS entry is truncated.');
    offset += read.bytesRead;
  }
  return bytes;
}

export async function unpackMacosArtifact(
  source: string,
  key: string,
  bundle: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const file = await open(source, 'r');
  try {
    const header = await readExactly(file, MAGIC.length + 4, 0, signal);
    const size = header.readUInt32BE(MAGIC.length);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC) || size === 0 || size > MAX_HEADER_BYTES)
      throw new Error('The cached macOS entry has an unsupported header.');
    const metadata = JSON.parse((await readExactly(file, size, header.length, signal)).toString('utf8'));
    const files = parseHostedAppManifest(metadata?.files);
    if (metadata?.key !== key || !files)
      throw new Error('The cached macOS entry has an invalid identity or inventory.');
    const directories: unknown = metadata.directories;
    if (
      !Array.isArray(directories) ||
      directories.length > 20000 ||
      !directories.every(
        (path): path is string =>
          typeof path === 'string' &&
          path.length > 0 &&
          path.length <= 1024 &&
          !/[\\\0\r\n]/.test(path) &&
          path.split('/').every((part) => part && part !== '.' && part !== '..'),
      )
    )
      throw new Error('The cached macOS entry has invalid directories.');
    const filePaths = new Set(files.map((entry) => canonical(entry.path)));
    for (const path of directories) {
      let ancestor = canonical(path);
      while (ancestor !== '.') {
        if (filePaths.has(ancestor)) throw new Error('A cached macOS directory overlaps a file or link.');
        ancestor = posix.dirname(ancestor);
      }
    }
    let position = header.length + size;
    if ((await file.stat()).size !== position + files.reduce((sum, entry) => sum + entry.size, 0))
      throw new Error('The cached macOS entry has an invalid payload length.');
    await mkdir(bundle, { mode: 0o700 });
    for (const path of directories) {
      signal.throwIfAborted();
      await mkdir(join(bundle, path), { recursive: true, mode: 0o755 });
    }
    const links: Array<{ path: string; target: string }> = [];
    for (const entry of files) {
      signal.throwIfAborted();
      const path = join(bundle, entry.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      if (entry.kind === 'link') {
        const bytes = await readExactly(file, entry.size, position, signal);
        if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
          throw new Error('A cached macOS link differs from its digest.');
        const target = bytes.toString('utf8');
        const destination = posix.normalize(posix.join(posix.dirname(entry.path), target));
        if (
          !target ||
          !Buffer.from(target).equals(bytes) ||
          /[\\\0\r\n]/.test(target) ||
          posix.isAbsolute(target) ||
          destination === '.' ||
          destination === '..' ||
          destination.startsWith('../') ||
          entry.path.startsWith(`${destination}/`)
        )
          throw new Error('A cached macOS link leaves its bundle or forms an ancestor cycle.');
        links.push({ path, target });
      } else {
        const hash = createHash('sha256');
        if (entry.size === 0)
          await writeFile(path, '', { flag: 'wx', mode: entry.kind === 'exec' ? 0o755 : 0o644, signal });
        else {
          const bytes = async function* () {
            for await (const chunk of file.createReadStream({
              start: position,
              end: position + entry.size - 1,
              autoClose: false,
            })) {
              signal.throwIfAborted();
              hash.update(chunk);
              yield chunk;
            }
          };
          await pipeline(
            Readable.from(bytes()),
            createWriteStream(path, { flags: 'wx', mode: entry.kind === 'exec' ? 0o755 : 0o644 }),
            { signal },
          );
        }
        if (hash.digest('hex') !== entry.sha256) throw new Error('A cached macOS file differs from its digest.');
      }
      position += entry.size;
    }
    for (const link of links) await symlink(link.target, link.path);
    const root = await realpath(bundle);
    for (const link of links) {
      signal.throwIfAborted();
      const path = relative(root, await realpath(link.path));
      if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`))
        throw new Error('A cached macOS link leaves its bundle.');
    }
  } finally {
    await file.close();
  }
}
