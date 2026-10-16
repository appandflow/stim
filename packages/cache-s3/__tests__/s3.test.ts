import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCacheProvider, createS3FileCache, type S3FileCacheOptions } from '../index.ts';
import { runCacheProviderContract, loadCacheProvider } from '@stim-cli/cache';
import { fileURLToPath } from 'node:url';
import { scopedClientContext } from '../credentials.ts';

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

test.each(['environment', 'profile'] as const)(
  'scoped %s endpoints cannot fall back to the host destination',
  async (mode) => {
    acceptedKeys = ['scoped-client'];
    let trapRequests = 0;
    const trap = createServer((request, response) => {
      trapRequests++;
      request.resume();
      response.writeHead(200).end();
    });
    await new Promise<void>((resolve) => trap.listen(0, '127.0.0.1', resolve));
    const address = trap.address();
    assert(address && typeof address !== 'string');
    const home = join(directory, 'client-home');
    await mkdir(join(home, '.aws'), { recursive: true });
    await writeFile(
      join(home, '.aws', 'credentials'),
      '[captured]\naws_access_key_id=scoped-client\naws_secret_access_key=scoped-secret\naws_session_token=scoped-token\n',
    );
    await writeFile(join(home, '.aws', 'config'), `[profile captured]\nendpoint_url=${options.endpoint}\n`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AWS_PROFILE: '',
      AWS_ACCESS_KEY_ID: 'scoped-client',
      AWS_SECRET_ACCESS_KEY: 'scoped-secret',
      AWS_SESSION_TOKEN: 'scoped-token',
      AWS_ENDPOINT_URL: '',
      AWS_ENDPOINT_URL_S3: mode === 'environment' ? options.endpoint : '',
      AWS_USE_FIPS_ENDPOINT: 'false',
      AWS_USE_DUALSTACK_ENDPOINT: 'false',
    };
    delete env.AWS_CONFIG_FILE;
    delete env.AWS_SHARED_CREDENTIALS_FILE;
    vi.stubEnv('AWS_ENDPOINT_URL_S3', `http://127.0.0.1:${address.port}`);
    vi.stubEnv('AWS_USE_FIPS_ENDPOINT', 'true');
    vi.stubEnv('AWS_USE_DUALSTACK_ENDPOINT', 'true');
    const { endpoint: _endpoint, ...withoutEndpoint } = options;
    const provider = createS3FileCache({
      ...withoutEndpoint,
      env,
      projectRoot: directory,
      ...(mode === 'profile' ? { profile: 'captured' } : {}),
    });
    try {
      await provider.store({
        key: 'scoped-endpoint',
        sourcePath: await source('private fixture'),
        overwrite: false,
        signal: signal(),
      });
      expect(signedRequests).toEqual(['scoped-client']);
      expect(trapRequests).toBe(0);
    } finally {
      trap.closeAllConnections();
      await new Promise<void>((resolve, reject) => trap.close((error) => (error ? reject(error) : resolve())));
    }
  },
);

test('captured clock-skew correction recovers despite a conflicting host setting', async () => {
  const future = new Date(Date.now() + 10 * 60_000);
  let requests = 0;
  const clock = createServer((request, response) => {
    requests++;
    const signed = String(request.headers['x-amz-date']);
    const timestamp = Date.parse(
      `${signed.slice(0, 4)}-${signed.slice(4, 6)}-${signed.slice(6, 8)}T${signed.slice(9, 11)}:${signed.slice(11, 13)}:${signed.slice(13, 15)}Z`,
    );
    if (Math.abs(timestamp - future.getTime()) < 60_000)
      response.writeHead(200, { date: future.toUTCString(), 'content-length': '0' }).end();
    else response.writeHead(403, { date: future.toUTCString(), 'x-amzn-errortype': 'RequestTimeTooSkewed' }).end();
  });
  await new Promise<void>((resolve) => clock.listen(0, '127.0.0.1', resolve));
  const address = clock.address();
  assert(address && typeof address !== 'string');
  vi.stubEnv('AWS_DISABLE_CLOCK_SKEW_CORRECTION', 'true');
  const provider = createS3FileCache({
    ...options,
    endpoint: `http://127.0.0.1:${address.port}`,
    projectRoot: directory,
    env: { ...process.env, AWS_DISABLE_CLOCK_SKEW_CORRECTION: 'false', AWS_MAX_ATTEMPTS: '2' },
  });
  try {
    expect(await provider.stat({ key: 'clock', signal: signal() })).toEqual({ size: 0 });
    expect(requests).toBe(2);
  } finally {
    clock.closeAllConnections();
    await new Promise<void>((resolve, reject) => clock.close((error) => (error ? reject(error) : resolve())));
  }
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

test.each([
  { committed: false, overwrite: false },
  { committed: false, overwrite: true },
  { committed: true, overwrite: false },
  { committed: true, overwrite: true },
])(
  'a reset after consuming a file recovers with committed=$committed and overwrite=$overwrite',
  async ({ committed, overwrite }) => {
    resetUploads = 1;
    resetAfterCommit = committed;
    const contents = 'complete-cache-file\n'.repeat(65_536);
    const path = await source(contents);
    const cache = createS3FileCache(options);
    await cache.store({ key: 'reset', sourcePath: path, overwrite, signal: signal() });
    const found = await cache.resolve({ key: 'reset', destinationDir: await destination(), signal: signal() });
    assert(found);
    expect(await readFile(found, 'utf8')).toBe(contents);
    expect(uploadCount).toBe(2);
  },
);

test('persistent resets stop after three PUT attempts and preserve the local file', async () => {
  resetUploads = Infinity;
  const path = await source('local-cache-file');
  await expect(
    createS3FileCache(options).store({ key: 'reset', sourcePath: path, overwrite: false, signal: signal() }),
  ).rejects.toMatchObject({ code: 'ECONNRESET' });
  expect(uploadCount).toBe(3);
  expect(objects.size).toBe(0);
  expect(await readFile(path, 'utf8')).toBe('local-cache-file');
});

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

test('presence checks report size without downloading and missing objects remain misses', async () => {
  const files = createS3FileCache(options);
  await files.store({ key: 'present', sourcePath: await source('bytes'), overwrite: false, signal: signal() });
  expect(await files.stat({ key: 'present', signal: signal() })).toEqual({ size: 5 });
  expect(await files.stat({ key: 'missing', signal: signal() })).toBeNull();
  await expect(files.stat({ key: 'present', signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow(
    'cancelled',
  );
});
