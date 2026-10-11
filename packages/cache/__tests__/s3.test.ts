import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCacheProvider, createS3FileCache, type S3FileCacheOptions } from '../s3.ts';
import { runCacheProviderContract } from '../contract.ts';

interface ObjectEntry {
  body: Buffer;
  digest: string;
  slow?: boolean;
}

let directory: string;
let server: Server;
let options: S3FileCacheOptions;
let objects: Map<string, ObjectEntry>;
let slowStarted: (() => void) | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'stim-s3-test-'));
  objects = new Map();
  slowStarted = undefined;
  vi.stubEnv('AWS_PROFILE', '');
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'test-key');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test-secret');
  vi.stubEnv('AWS_SESSION_TOKEN', '');
  server = createServer(async (request, response) => {
    try {
      if (!request.headers.authorization?.startsWith('AWS4-HMAC-SHA256 Credential=test-key/')) {
        response.writeHead(403).end('<Error><Code>FixtureCredentialsRequired</Code></Error>');
        return;
      }
      assert(request.url);
      const key = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (request.method === 'PUT') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        if (request.headers['content-md5'] !== createHash('md5').update(body).digest('base64')) {
          response.writeHead(400).end('<Error><Code>BadDigest</Code></Error>');
          return;
        }
        if (request.headers['if-none-match'] === '*' && objects.has(key)) {
          response.writeHead(412).end('<Error><Code>PreconditionFailed</Code></Error>');
          return;
        }
        const digest = request.headers['x-amz-meta-sha256'];
        if (typeof digest !== 'string') throw new Error('Missing digest metadata');
        objects.set(key, { body, digest });
        response.writeHead(200).end();
        return;
      }
      const stored = objects.get(key);
      if (!stored) {
        response.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>');
        return;
      }
      response.writeHead(200, { 'x-amz-meta-sha256': stored.digest, 'content-length': stored.body.length });
      if (stored.slow) {
        response.write(stored.body.subarray(0, 1));
        slowStarted?.();
      } else response.end(stored.body);
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address');
  options = {
    bucket: 'cache',
    prefix: 'team/v1',
    region: 'auto',
    endpoint: `http://127.0.0.1:${address.port}`,
    forcePathStyle: true,
  };
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

function signal(): AbortSignal {
  return new AbortController().signal;
}

test('an explicit cache profile overrides the ambient AWS profile', async () => {
  const credentials = join(directory, 'credentials');
  const configuration = join(directory, 'config');
  await writeFile(credentials, '[cache-test]\naws_access_key_id=test-key\naws_secret_access_key=test-secret\n');
  await writeFile(configuration, '');
  vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', credentials);
  vi.stubEnv('AWS_CONFIG_FILE', configuration);
  vi.stubEnv('AWS_PROFILE', 'not-configured');
  const provider = createCacheProvider({ projectRoot: directory, options: { ...options, profile: 'cache-test' } });
  assert(provider.files);
  await provider.files.store({
    key: 'explicit-profile',
    sourcePath: await source('owned'),
    overwrite: false,
    signal: signal(),
  });
  const found = await provider.files.resolve({
    key: 'explicit-profile',
    destinationDir: await destination(),
    signal: signal(),
  });
  assert(found);
  expect(await readFile(found, 'utf8')).toBe('owned');
});

async function source(contents: string, name = 'source'): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, contents);
  return path;
}

async function destination(name = 'destination'): Promise<string> {
  const path = join(directory, name);
  await mkdir(path);
  return path;
}

test('opaque files reuse one key across clients, preserve existing entries, and support explicit replacement', async () => {
  const writer = createS3FileCache(options);
  const reader = createS3FileCache(options);
  const first = await source('first');
  const second = await source('second', 'other');
  const context = { key: 'deps/linux/lock-hash', signal: signal() };
  await writer.store({ ...context, sourcePath: first, overwrite: false });
  await writer.store({ ...context, sourcePath: second, overwrite: false });
  const dir = await destination();
  const found = await reader.resolve({ ...context, destinationDir: dir });
  assert(found);
  expect(await readFile(found, 'utf8')).toBe('first');
  expect(await readdir(dir)).toEqual([found.slice(dir.length + 1)]);
  await writer.store({ ...context, sourcePath: second, overwrite: true });
  const replaced = await reader.resolve({ ...context, destinationDir: await destination('replacement') });
  assert(replaced);
  expect(await readFile(replaced, 'utf8')).toBe('second');
});

test('misses and corrupt downloads leave no partially reusable file', async () => {
  const cache = createS3FileCache(options);
  const dir = await destination();
  expect(await cache.resolve({ key: 'missing', destinationDir: dir, signal: signal() })).toBeNull();
  objects.set('/cache/team/v1/corrupt', { body: Buffer.from('broken'), digest: '0'.repeat(64) });
  await expect(cache.resolve({ key: 'corrupt', destinationDir: dir, signal: signal() })).rejects.toThrow('SHA-256');
  expect(await readdir(dir)).toEqual([]);
});

test('aborting a download closes the transfer and removes its partial file', async () => {
  const body = Buffer.alloc(1024, 'a');
  objects.set('/cache/team/v1/slow', { body, digest: createHash('sha256').update(body).digest('hex'), slow: true });
  const started = new Promise<void>((resolve) => {
    slowStarted = resolve;
  });
  const controller = new AbortController();
  const dir = await destination();
  const call = createS3FileCache(options).resolve({ key: 'slow', destinationDir: dir, signal: controller.signal });
  const outcome = call.then(
    () => null,
    (error: unknown) => error,
  );
  await started;
  controller.abort();
  expect(await outcome).toMatchObject({ name: 'AbortError' });
  expect(await readdir(dir)).toEqual([]);
});

test.each(['ios', 'android'] as const)(
  'the real S3 transport passes the existing %s and Metro contracts',
  async (platform) => {
    const results = await runCacheProviderContract({
      provider: createCacheProvider({ projectRoot: directory, options: { ...options } }),
      projectRoot: directory,
      workDir: directory,
      platform,
    });
    expect(results.filter((result) => !result.passed)).toEqual([]);
  },
);

describe.skipIf(process.platform === 'win32')('iOS framework link containment', () => {
  test.each(['..', '../../escape'])(
    'iOS framework links survive transfer but outside link %s is rejected',
    async (outside) => {
      const app = join(directory, 'Test.app');
      await mkdir(join(app, 'Frameworks', 'Example.framework', 'Versions', 'A'), { recursive: true });
      await writeFile(join(app, 'Frameworks', 'Example.framework', 'Versions', 'A', 'Example'), 'framework');
      await symlink('A', join(app, 'Frameworks', 'Example.framework', 'Versions', 'Current'));
      await symlink('Versions/Current/Example', join(app, 'Frameworks', 'Example.framework', 'Example'));
      const context = { projectRoot: directory, platform: 'ios' as const, signal: signal() };
      const builds = createCacheProvider({ projectRoot: directory, options: { ...options } }).builds;
      assert(builds);
      await builds.store({ ...context, key: 'linked', sourcePath: app, overwrite: false });
      const restored = await builds.resolve({ ...context, key: 'linked', destinationDir: await destination() });
      assert(restored);
      expect(await readFile(join(restored, 'Frameworks', 'Example.framework', 'Example'), 'utf8')).toBe('framework');
      await symlink(outside, join(app, 'outside'));
      await builds.store({ ...context, key: 'outside', sourcePath: app, overwrite: false });
      const dir = await destination('rejected');
      await expect(builds.resolve({ ...context, key: 'outside', destinationDir: dir })).rejects.toThrow('outside');
      expect(await readdir(dir)).toEqual([]);
    },
  );
});

test('aborting during archive extraction discards the artifact and settles', async () => {
  const app = join(directory, 'Large.app');
  await mkdir(app);
  const chunk = Buffer.alloc(1024 * 1024, 'a');
  for (let index = 0; index < 64; index++) await writeFile(join(app, `part-${index}`), chunk);
  const builds = createCacheProvider({ projectRoot: directory, options: { ...options } }).builds;
  assert(builds);
  const context = { projectRoot: directory, platform: 'ios' as const, key: 'large' };
  await builds.store({ ...context, sourcePath: app, overwrite: false, signal: signal() });
  const dir = await destination();
  const controller = new AbortController();
  const call = builds.resolve({ ...context, destinationDir: dir, signal: controller.signal });
  const outcome = Promise.resolve(call).then(
    () => null,
    (error: unknown) => error,
  );
  await vi.waitFor(
    async () => {
      const staging = await readdir(dir);
      expect(staging.length).toBe(1);
      const [path] = staging;
      assert(path);
      expect((await readdir(join(dir, path, 'Large.app'))).length).toBeGreaterThan(0);
    },
    { interval: 2, timeout: 3000 },
  );
  controller.abort();
  expect(await outcome).toMatchObject({ name: 'AbortError' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(await readdir(dir)).toEqual([]);
});
