import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCacheProvider, createS3FileCache, type S3FileCacheOptions } from '../index.ts';
import { runCacheProviderContract, loadCacheProvider } from '@stim-cli/cache';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scopedClientContext } from '../credentials.ts';

const cleanupFault = vi.hoisted(() => ({ directory: '' }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    rm: (...args: Parameters<typeof fs.rm>) => {
      if (cleanupFault.directory && String(args[0]).startsWith(cleanupFault.directory))
        return Promise.reject(Object.assign(new Error('Fixture scratch permissions changed.'), { code: 'EACCES' }));
      return fs.rm(...args);
    },
  };
});

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
let resetUploads: number;
let resetAfterCommit: boolean;
let uploadCount: number;
let onReset: (() => void) | undefined;
let acceptedKeys: string[];
let signedRequests: string[];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'stim-s3-test-'));
  objects = new Map();
  slowStarted = undefined;
  resetUploads = 0;
  resetAfterCommit = false;
  uploadCount = 0;
  onReset = undefined;
  acceptedKeys = ['test-key'];
  signedRequests = [];
  vi.stubEnv('AWS_PROFILE', '');
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'test-key');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'test-secret');
  vi.stubEnv('AWS_SESSION_TOKEN', '');
  server = createServer(async (request, response) => {
    try {
      if (request.method === 'PUT') uploadCount++;
      const identity = request.headers.authorization?.match(/^AWS4-HMAC-SHA256 Credential=([^/]+)\//)?.[1];
      if (!identity || !acceptedKeys.includes(identity)) {
        response.writeHead(403).end('<Error><Code>FixtureCredentialsRequired</Code></Error>');
        return;
      }
      signedRequests.push(identity);
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
        const reset = resetUploads > 0;
        if (reset) resetUploads--;
        if (reset && !resetAfterCommit) {
          request.socket.destroy();
          onReset?.();
          return;
        }
        if (request.headers['if-none-match'] === '*' && objects.has(key)) {
          response.writeHead(412).end('<Error><Code>PreconditionFailed</Code></Error>');
          return;
        }
        const digest = request.headers['x-amz-meta-sha256'];
        if (typeof digest !== 'string') throw new Error('Missing digest metadata');
        objects.set(key, { body, digest });
        if (reset) {
          request.socket.destroy();
          onReset?.();
          return;
        }
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
  cleanupFault.directory = '';
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

function signal(): AbortSignal {
  return new AbortController().signal;
}

test('concurrent providers sign with their captured environment and credential-file profile', async () => {
  acceptedKeys = ['first-client', 'second-client'];
  const credentials = join(directory, 'credentials');
  const configuration = join(directory, 'config');
  await writeFile(credentials, '[selected]\naws_access_key_id=second-client\naws_secret_access_key=second-secret\n');
  await writeFile(configuration, '');
  const before = { ...process.env };
  const first = await loadCacheProvider({
    projectRoot: directory,
    config: {
      provider: fileURLToPath(new URL('../dist/index.mjs', import.meta.url)),
      options: { ...options },
      baseDir: directory,
    },
    env: { ...process.env, AWS_ACCESS_KEY_ID: 'first-client', AWS_SECRET_ACCESS_KEY: 'first-secret' },
  });
  const second = createCacheProvider({
    projectRoot: directory,
    options: { ...options },
    env: {
      ...process.env,
      AWS_PROFILE: 'selected',
      AWS_SHARED_CREDENTIALS_FILE: credentials,
      AWS_CONFIG_FILE: configuration,
    },
  });
  assert(first.provider?.files);
  assert(second.files);
  const sourcePath = await source('scoped credentials');
  await Promise.all([
    first.provider.files.store({ key: 'first', sourcePath, overwrite: false, signal: signal() }),
    second.files.store({ key: 'second', sourcePath, overwrite: false, signal: signal() }),
  ]);
  expect(signedRequests.toSorted()).toEqual(['first-client', 'second-client']);
  expect(process.env).toEqual(before);
});

test('scoped credential_process uses the client cwd and its complete environment', async () => {
  const configuration = join(directory, 'process-config');
  await writeFile(configuration, `[profile scoped]\ncredential_process = "${process.execPath}" "credential.cjs"\n`);
  await writeFile(
    join(directory, 'credential.cjs'),
    `process.stdout.write(JSON.stringify({ Version: 1, AccessKeyId: process.env.CLIENT_TEST_KEY, SecretAccessKey: 'scoped-secret', SessionToken: 'scoped-token', Expiration: '2099-01-01T00:00:00Z' }));`,
  );
  const found = await scopedClientContext(
    {
      ...process.env,
      CLIENT_TEST_KEY: 'process-client',
      AWS_CONFIG_FILE: configuration,
      AWS_SHARED_CREDENTIALS_FILE: join(directory, 'empty-credentials'),
    },
    directory,
    { profile: 'scoped', region: 'auto' },
    signal(),
  );
  expect(found.credentials).toMatchObject({
    accessKeyId: 'process-client',
    sessionToken: 'scoped-token',
    expiration: new Date('2099-01-01T00:00:00Z'),
  });
});

describe.skipIf(process.platform === 'win32')('scoped credential cleanup', () => {
  test('cancellation reaps credential_process and its child before returning', async () => {
    const configuration = join(directory, 'process-config');
    const marker = join(directory, 'credential-pids.json');
    await writeFile(configuration, `[profile scoped]\ncredential_process = "${process.execPath}" "credential.cjs"\n`);
    await writeFile(
      join(directory, 'credential.cjs'),
      `const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); require('node:fs').writeFileSync(process.env.CLIENT_TEST_MARKER, JSON.stringify([process.pid, child.pid])); setInterval(() => {}, 1000);`,
    );
    const controller = new AbortController();
    const resolving = scopedClientContext(
      {
        ...process.env,
        CLIENT_TEST_MARKER: marker,
        AWS_CONFIG_FILE: configuration,
        AWS_SHARED_CREDENTIALS_FILE: join(directory, 'empty-credentials'),
      },
      directory,
      { profile: 'scoped', region: 'auto' },
      controller.signal,
    );
    const failure = resolving.catch((error: unknown) => error);
    try {
      await vi.waitFor(
        async () => {
          expect(JSON.parse(await readFile(marker, 'utf8'))).toHaveLength(2);
        },
        { timeout: 3000 },
      );
      const pids: number[] = JSON.parse(await readFile(marker, 'utf8'));
      controller.abort();
      expect(await failure).toMatchObject({ name: 'AbortError' });
      await vi.waitFor(
        () => {
          for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow('ESRCH');
        },
        { timeout: 3000 },
      );
    } finally {
      controller.abort();
      await failure;
    }
  });
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

test('cancellation after a reset prevents another PUT', async () => {
  resetUploads = Infinity;
  const controller = new AbortController();
  let cancel: ReturnType<typeof setTimeout> | undefined;
  onReset = () => {
    cancel = setTimeout(() => controller.abort(), 25);
  };
  try {
    await expect(
      createS3FileCache(options).store({
        key: 'cancelled',
        sourcePath: await source('cancelled-file'),
        overwrite: false,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(uploadCount).toBe(1);
    expect(objects.size).toBe(0);
  } finally {
    clearTimeout(cancel);
  }
});

test('an authorization refusal is not retried', async () => {
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'invalid-key');
  await expect(
    createS3FileCache(options).store({
      key: 'forbidden',
      sourcePath: await source('private-file'),
      overwrite: false,
      signal: signal(),
    }),
  ).rejects.toMatchObject({ $metadata: { httpStatusCode: 403 } });
  expect(uploadCount).toBe(1);
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
    const loaded = await loadCacheProvider({
      projectRoot: directory,
      config: {
        provider: fileURLToPath(new URL('../dist/index.mjs', import.meta.url)),
        options: { ...options },
        baseDir: directory,
      },
    });
    assert(loaded?.provider);
    const results = await runCacheProviderContract({
      provider: loaded.provider,
      projectRoot: directory,
      workDir: directory,
      platform,
    });
    expect(results.filter((result) => !result.passed)).toEqual([]);
  },
);

test('aborting an extraction with an open output descriptor waits for its process to exit', async () => {
  const app = join(directory, 'Large.app');
  await mkdir(app);
  await writeFile(join(app, 'part-0'), Buffer.alloc(1024 * 1024, 'a'));
  const opened = join(directory, 'opened');
  const preload = join(directory, 'pause-open.mjs');
  await writeFile(
    preload,
    `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const open = fs.open;
fs.open = function(path, ...args) {
  const callback = args.pop();
  open.call(this, path, ...args, (error, descriptor) => {
    if (!error && String(path).replaceAll('\\\\', '/').endsWith('Large.app/part-0')) {
      fs.writeFileSync(${JSON.stringify(opened)}, String(process.pid));
      setInterval(() => {}, 1000);
      return;
    }
    callback(error, descriptor);
  });
};
syncBuiltinESMExports();
`,
  );
  const builds = createCacheProvider({
    projectRoot: directory,
    options: { ...options },
    env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
  }).builds;
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
  let pid = 0;
  try {
    await vi.waitFor(
      async () => {
        pid = Number(await readFile(opened, 'utf8'));
      },
      { interval: 2, timeout: 3000 },
    );
  } finally {
    controller.abort();
    await outcome;
  }
  expect(await outcome).toMatchObject({ name: 'AbortError' });
  expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  expect(await readdir(dir)).toEqual([]);
});

test('presence checks report size without downloading and missing objects remain misses', async () => {
  const files = createS3FileCache(options);
  await files.store({ key: 'present', sourcePath: await source('bytes'), overwrite: false, signal: signal() });
  expect(await files.stat({ key: 'present', signal: signal() })).toEqual({ size: 5 });
  expect(await files.stat({ key: 'missing', signal: signal() })).toBeNull();
  await expect(files.stat({ key: 'present', signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow(
    'cancelled',
  );
});
