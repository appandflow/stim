import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { deserialize, serialize } from 'node:v8';
import { create, extract } from 'tar';
import { CACHE_PROVIDER_API_VERSION, type CacheProvider, type FileCacheCapability } from '@stim-cli/cache';

export const apiVersion: typeof CACHE_PROVIDER_API_VERSION = CACHE_PROVIDER_API_VERSION;

export interface S3FileCacheOptions {
  bucket: string;
  prefix?: string | undefined;
  endpoint?: string | undefined;
  region?: string | undefined;
  profile?: string | undefined;
  forcePathStyle?: boolean | undefined;
}

async function fileDigests(path: string, signal: AbortSignal): Promise<{ sha256: string; md5: string }> {
  const sha256 = createHash('sha256');
  const md5 = createHash('md5');
  for await (const chunk of createReadStream(path, { signal })) {
    sha256.update(chunk);
    md5.update(chunk);
  }
  return { sha256: sha256.digest('hex'), md5: md5.digest('base64') };
}

function status(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('$metadata' in error)) return undefined;
  const metadata = error.$metadata;
  if (!metadata || typeof metadata !== 'object' || !('httpStatusCode' in metadata)) return undefined;
  return typeof metadata.httpStatusCode === 'number' ? metadata.httpStatusCode : undefined;
}

/** Stores opaque files; each cache adapter owns its key and serialization. Credentials use the AWS SDK chain. */
export function createS3FileCache(
  options: S3FileCacheOptions,
): FileCacheCapability & Required<Pick<FileCacheCapability, 'stat'>> {
  if (!options.bucket) throw new Error('The S3 cache needs a bucket.');
  const config: S3ClientConfig = {
    ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
    region: options.region ?? 'us-east-1',
    ...(options.profile !== undefined ? { profile: options.profile } : {}),
    ...(options.forcePathStyle !== undefined ? { forcePathStyle: options.forcePathStyle } : {}),
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
  const client = new S3Client(config);
  const prefix = (options.prefix ?? 'stim/v1').replace(/^\/+|\/+$/g, '');
  const objectKey = (key: string) => `${prefix}/${key}`;
  return {
    async stat({ key, signal }) {
      signal.throwIfAborted();
      try {
        const object = await client.send(new HeadObjectCommand({ Bucket: options.bucket, Key: objectKey(key) }), {
          abortSignal: signal,
        });
        return typeof object.ContentLength === 'number' ? { size: object.ContentLength } : null;
      } catch (error) {
        if (status(error) === 404) return null;
        throw error;
      }
    },
    async resolve({ key, destinationDir, signal }) {
      signal.throwIfAborted();
      let object;
      try {
        object = await client.send(new GetObjectCommand({ Bucket: options.bucket, Key: objectKey(key) }), {
          abortSignal: signal,
        });
      } catch (error) {
        if (status(error) === 404) return null;
        throw error;
      }
      const expected = object.Metadata?.sha256;
      if (!(object.Body instanceof Readable) || !expected || !/^[a-f0-9]{64}$/.test(expected)) {
        if (object.Body instanceof Readable) object.Body.destroy();
        throw new Error('The S3 cache entry has no SHA-256 metadata.');
      }
      const temporary = join(destinationDir, `${randomUUID()}.partial`);
      const complete = join(destinationDir, `${randomUUID()}.cache`);
      const digest = createHash('sha256');
      try {
        await mkdir(destinationDir, { recursive: true });
        await pipeline(
          object.Body,
          new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              digest.update(chunk);
              callback(null, chunk);
            },
          }),
          createWriteStream(temporary, { flags: 'wx' }),
          { signal },
        );
        if (digest.digest('hex') !== expected) throw new Error('The S3 cache entry failed SHA-256 verification.');
        signal.throwIfAborted();
        await rename(temporary, complete);
        return complete;
      } finally {
        object.Body.destroy();
        await rm(temporary, { force: true });
      }
    },
    async store({ key, sourcePath, overwrite, signal }) {
      signal.throwIfAborted();
      const digests = await fileDigests(sourcePath, signal);
      const size = (await stat(sourcePath)).size;
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        const body = createReadStream(sourcePath, { signal });
        try {
          await client.send(
            new PutObjectCommand({
              Bucket: options.bucket,
              Key: objectKey(key),
              Body: body,
              ContentLength: size,
              ContentMD5: digests.md5,
              Metadata: { sha256: digests.sha256 },
              IfNoneMatch: overwrite ? undefined : '*',
            }),
            { abortSignal: signal },
          );
          return;
        } catch (error) {
          if (!overwrite && status(error) === 412) return;
          if (
            attempt === 2 ||
            signal.aborted ||
            !(error instanceof Error) ||
            !('code' in error) ||
            error.code !== 'ECONNRESET'
          )
            throw error;
        } finally {
          body.destroy();
        }
        await sleep(100 * 2 ** attempt, undefined, { signal });
      }
    },
  };
}

async function scratch<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'stim-s3-cache-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function createCacheProvider({
  options,
}: {
  projectRoot: string;
  options: Record<string, unknown>;
}): CacheProvider {
  const files = createS3FileCache({
    bucket: typeof options.bucket === 'string' ? options.bucket : '',
    prefix: typeof options.prefix === 'string' ? options.prefix : undefined,
    endpoint: typeof options.endpoint === 'string' ? options.endpoint : undefined,
    region: typeof options.region === 'string' ? options.region : undefined,
    profile: typeof options.profile === 'string' ? options.profile : undefined,
    forcePathStyle: typeof options.forcePathStyle === 'boolean' ? options.forcePathStyle : undefined,
  });
  return {
    files,
    builds: {
      async resolve({ platform, key, destinationDir, signal }) {
        return scratch(async (dir) => {
          const archive = await files.resolve({ key: `builds/${platform}/${key}`, destinationDir: dir, signal });
          if (!archive) return null;
          const staging = await mkdtemp(join(destinationDir, 's3-'));
          try {
            let invalidLink = false;
            await pipeline(
              createReadStream(archive),
              extract({
                cwd: staging,
                strict: true,
                filter(path, entry) {
                  if (!('type' in entry)) return true;
                  if (entry.type !== 'SymbolicLink' && entry.type !== 'Link') return true;
                  const link = entry.linkpath ?? '';
                  const target = resolve(staging, entry.type === 'SymbolicLink' ? dirname(path) : '', link);
                  const root = relative(staging, resolve(staging, path)).split(sep)[0];
                  const outside = relative(resolve(staging, root ?? ''), target);
                  if (isAbsolute(link) || outside === '..' || outside.startsWith(`..${sep}`)) {
                    invalidLink = true;
                    return false;
                  }
                  return true;
                },
              }),
              { signal },
            );
            if (invalidLink) throw new Error('The S3 build entry contains a link outside the artifact.');
            signal.throwIfAborted();
            const entries = await readdir(staging);
            const [entry] = entries;
            if (entries.length !== 1 || entry === undefined)
              throw new Error('The S3 build entry must contain one artifact.');
            const path = join(staging, entry);
            const info = await lstat(path);
            if (
              platform === 'ios'
                ? !info.isDirectory() || !path.endsWith('.app')
                : !info.isFile() || !path.endsWith('.apk')
            ) {
              throw new Error('The S3 build entry has the wrong artifact type.');
            }
            return path;
          } catch (error) {
            await rm(staging, { recursive: true, force: true });
            throw error;
          }
        });
      },
      async store({ platform, key, sourcePath, overwrite, signal }) {
        await scratch(async (dir) => {
          signal.throwIfAborted();
          const archive = join(dir, 'artifact.tar');
          await pipeline(
            create({ cwd: dirname(sourcePath), portable: true }, [basename(sourcePath)]),
            createWriteStream(archive, { flags: 'wx' }),
            { signal },
          );
          signal.throwIfAborted();
          await files.store({ key: `builds/${platform}/${key}`, sourcePath: archive, overwrite, signal });
        });
      },
    },
    metro: {
      async get({ cacheName, key, signal }) {
        return scratch(async (dir) => {
          const path = await files.resolve({
            key: `metro/${encodeURIComponent(cacheName)}/${key.toString('hex')}`,
            destinationDir: dir,
            signal,
          });
          if (!path) return null;
          return deserialize(await readFile(path, { signal }));
        });
      },
      async set({ cacheName, key, value, signal }) {
        await scratch(async (dir) => {
          const path = join(dir, 'transform');
          await writeFile(path, serialize(value), { signal });
          await files.store({
            key: `metro/${encodeURIComponent(cacheName)}/${key.toString('hex')}`,
            sourcePath: path,
            overwrite: true,
            signal,
          });
        });
      },
    },
  };
}
