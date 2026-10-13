import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { withAmbientContext, type StimContext } from '@stim-cli/core';
import { getExecutor, resetExecutor, setExecutor, type ExecOptions } from '../exec.ts';
import { checkEasAuth, loadProjectProvider, resolveRemote, uploadRemote } from '../engine/remote-cache.ts';
import { makeWriter } from './_factories.ts';
import { operationState } from '../engine/operation-state.ts';

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-eas-cache-')));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'expo-dev-client': '*' } }));
  writeFileSync(join(root, 'app.json'), JSON.stringify({ expo: { buildCacheProvider: 'eas' } }));
  writeFileSync(join(root, 'eas.json'), '{}');
  const sdk = join(root, 'node_modules', 'eas-build-cache-provider');
  mkdirSync(sdk, { recursive: true });
  writeFileSync(join(sdk, 'package.json'), JSON.stringify({ name: 'eas-build-cache-provider', main: 'index.cjs' }));
  writeFileSync(join(sdk, 'index.cjs'), 'throw new Error("the SDK must not run inside this host");');
  const cli = join(root, 'node_modules', 'eas-cli');
  mkdirSync(join(cli, 'bin'), { recursive: true });
  writeFileSync(join(cli, 'package.json'), JSON.stringify({ name: 'eas-cli', bin: { eas: 'bin/run.js' } }));
  writeFileSync(
    join(cli, 'bin', 'run.js'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const marker = process.env.CACHE_TEST_MARKER;
fs.appendFileSync(path.join(process.cwd(), 'calls.ndjson'), JSON.stringify({ args, marker, home: process.env.STIM_HOME, cwd: process.cwd() }) + '\\n');
if (args[0] === 'fingerprint:generate' && process.env.CACHE_TEST_HASH_FAIL) process.exit(1);
if (args[0] === (process.env.CACHE_TEST_BLOCK === 'upload' ? 'upload' : 'build:download') && process.env.CACHE_TEST_BLOCK) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else {
  setTimeout(() => {
    if (args[0] === 'fingerprint:generate') console.log(JSON.stringify({ hash: 'eas-' + marker }));
    else if (args[0] === 'upload') console.log(JSON.stringify({ url: 'https://example.test/build/' + marker }));
    else {
      const app = path.join(process.cwd(), marker + '.app');
      fs.mkdirSync(app, { recursive: true });
      console.log(JSON.stringify({ path: app }));
    }
  }, Number(process.env.CACHE_TEST_DELAY || 0));
}
`,
    { mode: 0o755 },
  );
});

afterEach(() => {
  resetExecutor();
  rmSync(root, { recursive: true, force: true });
});

function context(marker: string, extra: NodeJS.ProcessEnv = {}, controller = new AbortController()) {
  const output: string[] = [];
  const ctx: StimContext = {
    home: join(root, `home-${marker}`),
    buildCache: null,
    projectRoot: root,
    cwd: root,
    runId: marker,
    env: { ...process.env, STIM_HOME: join(root, `home-${marker}`), CACHE_TEST_MARKER: marker, ...extra },
    signal: controller.signal,
    output: (_stream, text) => output.push(text),
  };
  return { ctx, output, controller };
}

function calls() {
  return readFileSync(join(root, 'calls.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

function captureChildren() {
  const executor = getExecutor();
  const children: ChildProcess[] = [];
  setExecutor({
    ...executor,
    runFileAsync(file: string, args: string[], options: ExecOptions) {
      return executor.runFileAsync(file, args, {
        ...options,
        onSpawn(child) {
          children.push(child);
          options.onSpawn?.(child);
        },
      });
    },
  });
  return children;
}

test('EAS lookup and upload use their own home and output without executing the SDK or patching host globals', async () => {
  const a = context('a');
  const b = context('b');
  const loaded = await loadProjectProvider(root);
  assert(loaded.provider);
  const stdout = process.stdout.write;
  const log = console.log;
  const listeners = process.listeners('SIGINT');
  const envHash = createHash('sha256').update(JSON.stringify(process.env)).digest('hex');
  const recordsA: unknown[] = [];
  const recordsB: unknown[] = [];
  const wa = makeWriter({
    write: (record) => {
      recordsA.push(record);
      return true;
    },
  });
  const wb = makeWriter({
    write: (record) => {
      recordsB.push(record);
      return true;
    },
  });
  const [hit, upload] = await Promise.all([
    withAmbientContext(a.ctx, () =>
      resolveRemote({
        context: a.ctx,
        provider: loaded.provider,
        projectRoot: root,
        platform: 'ios',
        fingerprintHash: 'local',
        logWriter: wa,
      }),
    ),
    withAmbientContext(b.ctx, () =>
      uploadRemote({
        context: b.ctx,
        provider: loaded.provider,
        projectRoot: root,
        platform: 'android',
        fingerprintHash: 'local',
        buildPath: join(root, 'fixture.apk'),
        logWriter: wb,
      }),
    ),
  ]);
  expect(hit).toEqual({ appPath: join(root, 'a.app') });
  expect(upload).toEqual({ uploaded: true, destination: 'https://example.test/build/b' });
  expect(process.stdout.write).toBe(stdout);
  expect(console.log).toBe(log);
  expect(process.listeners('SIGINT')).toEqual(listeners);
  expect(createHash('sha256').update(JSON.stringify(process.env)).digest('hex')).toBe(envHash);
  expect(a.output.join('')).toContain('Searching the EAS');
  expect(a.output.join('')).not.toContain('build/b');
  expect(b.output.join('')).toContain('https://example.test/build/b');
  expect(JSON.stringify(recordsA)).toContain('Searching the EAS');
  expect(JSON.stringify(recordsA)).not.toContain('build/b');
  expect(JSON.stringify(recordsB)).toContain('build/b');
  expect(calls()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        marker: 'a',
        home: a.ctx.home,
        cwd: root,
        args: [
          'build:download',
          '--platform=ios',
          '--fingerprint=eas-a',
          '--non-interactive',
          '--dev-client',
          '--json',
        ],
      }),
      expect.objectContaining({
        marker: 'b',
        home: b.ctx.home,
        cwd: root,
        args: [
          'upload',
          '--platform=android',
          '--fingerprint=eas-b',
          `--build-path=${join(root, 'fixture.apk')}`,
          '--non-interactive',
          '--json',
        ],
      }),
    ]),
  );
});

test('an EAS fingerprint failure falls back to the local fingerprint and release builds exclude dev clients', async () => {
  const { ctx } = context('fallback', { CACHE_TEST_HASH_FAIL: '1' });
  const loaded = await loadProjectProvider(root);
  const result = await withAmbientContext(ctx, () =>
    resolveRemote({
      context: ctx,
      provider: loaded.provider,
      projectRoot: root,
      platform: 'ios',
      fingerprintHash: 'local-key',
      runOptions: { configuration: 'Release' },
    }),
  );
  expect(result).toEqual({ appPath: join(root, 'fallback.app') });
  expect(calls()).toContainEqual(
    expect.objectContaining({
      args: [
        'build:download',
        '--platform=ios',
        '--fingerprint=local-key',
        '--non-interactive',
        '--no-dev-client',
        '--json',
      ],
    }),
  );
});

test('one deadline covers fingerprint and download, and timeout waits for its child to exit', async () => {
  const { ctx } = context('slow', { CACHE_TEST_DELAY: '1000' });
  const loaded = await loadProjectProvider(root);
  const children = captureChildren();
  const result = await withAmbientContext(ctx, () =>
    resolveRemote({
      context: ctx,
      provider: loaded.provider,
      projectRoot: root,
      platform: 'ios',
      fingerprintHash: 'local',
      timeoutMs: 1700,
    }),
  );
  expect(result).toMatchObject({ failed: 'EAS cache resolve timed out after 1700ms' });
  expect(calls().map((c) => c.args[0])).toEqual(['fingerprint:generate', 'build:download']);
  expect(children).toHaveLength(2);
  expect(children[1]?.signalCode).toBe('SIGKILL');
});

test('cancellation kills only the owning cache child while another operation completes', async () => {
  const a = context('blocked', { CACHE_TEST_BLOCK: '1' });
  const b = context('other');
  const loaded = await loadProjectProvider(root);
  const children = captureChildren();
  const stdout = process.stdout.write;
  const log = console.log;
  const pending = withAmbientContext(a.ctx, () =>
    resolveRemote({
      context: a.ctx,
      provider: loaded.provider,
      projectRoot: root,
      platform: 'ios',
      fingerprintHash: 'local',
      timeoutMs: 15000,
    }),
  );
  const outcome = pending.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  try {
    const waitUntil = Date.now() + 5000;
    while (!children.some((child) => child.spawnargs.includes('build:download')) && Date.now() < waitUntil)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const blocked = children.find((child) => child.spawnargs.includes('build:download'));
    assert(blocked);
    expect(process.stdout.write).toBe(stdout);
    expect(console.log).toBe(log);
    const hit = await withAmbientContext(b.ctx, () =>
      resolveRemote({
        context: b.ctx,
        provider: loaded.provider,
        projectRoot: root,
        platform: 'ios',
        fingerprintHash: 'local',
      }),
    );
    a.controller.abort('cancel this cache lookup');
    expect(await outcome).toEqual({ error: 'cancel this cache lookup' });
    expect(blocked.signalCode).toBe('SIGKILL');
    expect(hit).toEqual({ appPath: join(root, 'other.app') });
    expect(b.ctx.signal.aborted).toBe(false);
  } finally {
    a.controller.abort('fixture cleanup');
    await outcome;
  }
});

test.each(['SIGINT', 'SIGTERM'])(
  'a background upload settles %s cancellation before deployment awaits it',
  async (reason) => {
    const a = context('upload', { CACHE_TEST_BLOCK: 'upload' });
    const run = new AbortController();
    operationState(a.ctx).runSignal = run.signal;
    const loaded = await loadProjectProvider(root);
    const children = captureChildren();
    const pending = withAmbientContext(a.ctx, () =>
      uploadRemote({
        context: a.ctx,
        provider: loaded.provider,
        projectRoot: root,
        platform: 'ios',
        fingerprintHash: 'local',
        buildPath: join(root, 'fixture.app'),
        timeoutMs: 15000,
      }),
    );
    try {
      const deadline = Date.now() + 5000;
      while (!children.some((child) => child.spawnargs.includes('upload')) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      const owningChild = children.find((child) => child.spawnargs.includes('upload'));
      assert(owningChild);
      a.controller.abort(reason);
      if (reason === 'SIGINT') run.abort(reason);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await pending).toEqual({ failed: 'EAS cache upload cancelled' });
      expect(owningChild.signalCode).toBe('SIGKILL');
      expect(operationState(a.ctx)).toMatchObject({ handled: true, draining: true });
      expect(operationState(a.ctx).exitCleanups.size).toBe(0);
    } finally {
      a.controller.abort('fixture cleanup');
      run.abort('fixture cleanup');
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await pending.catch(() => {});
    }
  },
);

test('authentication is coalesced within an operation and cannot reuse another operation’s actor', async () => {
  const a = context('actor-a').ctx;
  const b = context('actor-b').ctx;
  let probes = 0;
  const probe = (ctx: StimContext) =>
    checkEasAuth({
      context: ctx,
      projectRoot: root,
      resolveBin: () => ({ file: 'eas', source: 'project' }),
      run: async () => {
        probes++;
        await Promise.resolve();
        return ctx.runId;
      },
    });
  const [first, again, other] = await Promise.all([probe(a), probe(a), probe(b)]);
  expect(first.account).toBe('actor-a');
  expect(again.account).toBe('actor-a');
  expect(other.account).toBe('actor-b');
  expect(probes).toBe(2);
});

test('a global npm batch launcher resolves to its Node entry so cancellation reaches the EAS process', async () => {
  const projectCli = join(root, 'node_modules', 'eas-cli');
  const program = readFileSync(join(projectCli, 'bin', 'run.js'));
  rmSync(projectCli, { recursive: true, force: true });
  const globalRoot = join(root, 'global');
  const globalCli = join(globalRoot, 'node_modules', 'eas-cli');
  mkdirSync(join(globalCli, 'bin'), { recursive: true });
  writeFileSync(join(globalCli, 'package.json'), JSON.stringify({ name: 'eas-cli', bin: { eas: 'bin/run.js' } }));
  writeFileSync(join(globalCli, 'bin', 'run.js'), program, { mode: 0o755 });
  writeFileSync(join(globalRoot, 'eas.cmd'), 'echo this launcher must not execute');
  const executor = getExecutor();
  setExecutor({ ...executor, findExecutable: () => join(globalRoot, 'eas.cmd') });
  const { ctx } = context('global');
  const loaded = await loadProjectProvider(root);
  const result = await withAmbientContext(ctx, () =>
    resolveRemote({
      context: ctx,
      provider: loaded.provider,
      projectRoot: root,
      platform: 'ios',
      fingerprintHash: 'local',
    }),
  );
  expect(result).toEqual({ appPath: join(root, 'global.app') });
});
