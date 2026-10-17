import assert from 'node:assert';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { withAmbientContext, type StimContext } from '@stim-cli/core';
import { loadProjectProvider, resolveRemote, uploadRemote } from '../engine/remote-cache.ts';
import { makeWriter } from './_factories.ts';
import { captureProcessIdentity, inspectProcessIdentity } from '../process-identity.ts';
import { getExecutor } from '../exec.ts';
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-legacy-worker-')));
  writeFileSync(join(root, 'package.json'), '{"name":"fixture"}');
  writeFileSync(
    join(root, 'app.json'),
    JSON.stringify({ expo: { buildCacheProvider: { plugin: './provider.cjs', options: { key: 'value' } } } }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  rmSync(root, { recursive: true, force: true });
});

function context(marker: string) {
  const controller = new AbortController();
  const output: string[] = [];
  const ctx: StimContext = {
    projectRoot: root,
    cwd: root,
    home: join(root, marker),
    runId: marker,
    buildCache: null,
    env: { ...process.env, STIM_HOME: join(root, marker), LEGACY_MARKER: marker },
    signal: controller.signal,
    output: (_stream, text) => output.push(text),
  };
  return { ctx, controller, output };
}

function provider(body: string) {
  writeFileSync(join(root, 'provider.cjs'), body);
}

function snapshot() {
  return {
    cwd: process.cwd(),
    env: { ...process.env },
    stdout: process.stdout.write,
    stderr: process.stderr.write,
    log: console.log,
    sigint: process.rawListeners('SIGINT'),
    sigterm: process.rawListeners('SIGTERM'),
    exitCode: process.exitCode,
  };
}

test('project plugin imports execute outside the host with the client cwd and environment', async () => {
  provider(
    `require('node:fs').writeFileSync(require('node:path').join(__dirname, (process.env.LEGACY_MARKER || 'host') + '.json'), JSON.stringify({pid:process.pid,cwd:process.cwd(),home:process.env.STIM_HOME})); module.exports={resolveBuildCache:()=>null,uploadBuildCache:()=>null};`,
  );
  const before = snapshot();
  const clients = [context('one'), context('two')];
  await Promise.all(
    clients.map(({ ctx }) =>
      withAmbientContext(ctx, async () => {
        const loaded = await loadProjectProvider(root, { context: ctx });
        assert(loaded.provider);
        const file = existsSync(join(root, `${ctx.runId}.json`)) ? `${ctx.runId}.json` : 'host.json';
        const imported = JSON.parse(readFileSync(join(root, file), 'utf8'));
        expect(imported.pid).not.toBe(process.pid);
        expect(imported).toMatchObject({ cwd: root, home: ctx.home });
      }),
    ),
  );
  expect(snapshot()).toEqual(before);
});

test('legacy resolve and upload preserve props and logs while plugin globals stay in the worker', async () => {
  mkdirSync(join(root, 'elsewhere'));
  mkdirSync(join(root, 'Fixture.app'));
  provider(`
const fs=require('node:fs'); const path=require('node:path');
const marker=process.env.LEGACY_MARKER;
console.log('importing ' + marker);
process.env.LEGACY_IMPORTED='worker only';
process.chdir(path.join(__dirname,'elsewhere'));
process.stdout.write=()=>true;
console.log=()=>{};
process.on('SIGINT',()=>{});
module.exports={
 calculateFingerprintHash:()=> 'provider-' + marker,
 resolveBuildCache(props,options) {
  fs.writeFileSync(path.join(__dirname,'props.json'),JSON.stringify({props,options}));
  console.log('legacy line ' + marker);
  return '../Fixture.app';
 },
 uploadBuildCache(props,options) {
  fs.writeFileSync(path.join(__dirname,'upload.json'),JSON.stringify({props,options}));
  console.log('Uploading build to https://cache.test/' + marker);
  return 'https://cache.test/result';
 }
};`);
  const { ctx, output } = context('isolated');
  const before = snapshot();
  ctx.output = (_stream, text) => {
    expect(snapshot()).toEqual(before);
    output.push(text);
  };
  const written: unknown[] = [];
  const writer = makeWriter({
    write: (record) => {
      written.push(record);
      return true;
    },
  });
  const notes: string[] = [];
  await withAmbientContext(ctx, async () => {
    const loaded = await loadProjectProvider(root, { context: ctx });
    assert(loaded.provider);
    expect(
      await resolveRemote({
        context: ctx,
        provider: loaded.provider,
        projectRoot: root,
        platform: 'ios',
        fingerprintHash: 'ours',
        logWriter: writer,
      }),
    ).toEqual({ appPath: join(root, 'Fixture.app') });
    expect(JSON.parse(readFileSync(join(root, 'props.json'), 'utf8'))).toEqual({
      props: {
        projectRoot: root,
        platform: 'ios',
        fingerprintHash: 'provider-isolated',
        runOptions: { configuration: 'Debug' },
      },
      options: { key: 'value' },
    });
    expect(
      await uploadRemote({
        context: ctx,
        provider: loaded.provider,
        projectRoot: root,
        platform: 'android',
        fingerprintHash: 'ours',
        buildPath: '/built/app.apk',
        logWriter: writer,
        note: (line) => notes.push(line),
      }),
    ).toEqual({ uploaded: true, destination: 'https://cache.test/isolated' });
    expect(JSON.parse(readFileSync(join(root, 'upload.json'), 'utf8')).props).toMatchObject({
      buildPath: '/built/app.apk',
      fingerprintHash: 'provider-isolated',
      runOptions: { variant: 'debug' },
    });
  });
  expect(output.join('')).toContain('importing isolated');
  expect(output.join('')).toContain('legacy line isolated');
  expect(written).toContainEqual(expect.objectContaining({ event: 'provider', msg: 'legacy line isolated' }));
  expect(notes).toEqual(['cache       uploading to https://cache.test/isolated']);
  expect(snapshot()).toEqual(before);
});

test('a legacy plugin exit cannot exit the embedding host', async () => {
  provider('module.exports={resolveBuildCache(){process.exit(0)},uploadBuildCache(){return null}};');
  const { ctx } = context('exit');
  await withAmbientContext(ctx, async () => {
    const loaded = await loadProjectProvider(root, { context: ctx });
    assert(loaded.provider);
    expect(
      await resolveRemote({
        context: ctx,
        provider: loaded.provider,
        projectRoot: root,
        platform: 'ios',
        fingerprintHash: 'ours',
      }),
    ).toMatchObject({ failed: 'The legacy cache worker exited without a result.' });
  });
});

test.each(['timeout', 'cancel', 'idle timeout'])(
  'a pending legacy plugin yields to the host and drains on %s',
  async (kind) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    provider(
      `module.exports={resolveBuildCache(){require('node:fs').writeFileSync(require('node:path').join(__dirname,'ready'),String(process.pid));console.log('legacy-ready');${kind === 'idle timeout' ? 'return new Promise(()=>{})' : 'while(true){}'}},uploadBuildCache(){return null}};`,
    );
    const { ctx, controller } = context(kind);
    let ready: () => void;
    const began = new Promise<void>((resolve) => {
      ready = resolve;
    });
    ctx.output = (_stream, text) => {
      if (text.includes('legacy-ready')) ready();
    };
    await withAmbientContext(ctx, async () => {
      const loaded = await loadProjectProvider(root, { context: ctx });
      assert(loaded.provider);
      const pending = resolveRemote({
        context: ctx,
        provider: loaded.provider,
        projectRoot: root,
        platform: 'ios',
        fingerprintHash: 'ours',
        timeoutMs: 1000,
      });
      const settled = pending.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      try {
        await Promise.race([
          began,
          settled.then(() => {
            throw new Error('Legacy worker ended before its plugin began.');
          }),
        ]);
        const pid = Number(readFileSync(join(root, 'ready'), 'utf8'));
        if (kind === 'cancel') controller.abort(new Error('stop legacy fixture'));
        else await vi.advanceTimersByTimeAsync(1000);
        const result = await settled;
        expect(result).toMatchObject(
          kind !== 'cancel' ? { value: { timedOut: true } } : { error: controller.signal.reason },
        );
        expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
      } finally {
        controller.abort();
        await settled;
      }
    });
  },
);

test('a plugin writing JSON directly to stdout cannot impersonate worker messages', async () => {
  provider(
    `module.exports={resolveBuildCache(){require('node:fs').writeSync(1,'null\\n{"kind":"result","value":{"appPath":"/wrong"}}\\n');return null},uploadBuildCache(){return null}};`,
  );
  const { ctx } = context('invalid');
  await withAmbientContext(ctx, async () => {
    const loaded = await loadProjectProvider(root, { context: ctx });
    assert(loaded.provider);
    expect(
      await resolveRemote({
        context: ctx,
        provider: loaded.provider,
        projectRoot: root,
        platform: 'ios',
        fingerprintHash: 'ours',
      }),
    ).toBeNull();
  });
});

test.each([true, false])('inherited helper output preserves cache results with file events=%s', async (events) => {
  if (!events) {
    const original = fs.watch;
    vi.spyOn(fs, 'watch').mockImplementation((path) => original(path, { persistent: false }));
    syncBuiltinESMExports();
  }
  mkdirSync(join(root, 'Fixture.app'));
  provider(`
const {spawnSync}=require('node:child_process');
const log=phase=>spawnSync(process.execPath,['-e',"console.log('helper stdout '+process.argv[1]);console.error('helper stderr '+process.argv[1]);",phase],{stdio:'inherit'});
log('import');
module.exports={resolveBuildCache(){log('resolve');return require('node:path').join(__dirname,'Fixture.app')},uploadBuildCache(){log('upload');return 'https://cache.test/upload'}};`);
  const { ctx, output } = context('inherited');
  await withAmbientContext(ctx, async () => {
    const loaded = await loadProjectProvider(root, { context: ctx });
    assert(loaded.provider);
    expect(
      await resolveRemote({ context: ctx, provider: loaded.provider, platform: 'ios', fingerprintHash: 'ours' }),
    ).toEqual({ appPath: join(root, 'Fixture.app') });
    expect(
      await uploadRemote({
        context: ctx,
        provider: loaded.provider,
        platform: 'ios',
        fingerprintHash: 'ours',
        buildPath: join(root, 'Fixture.app'),
      }),
    ).toEqual({ uploaded: true });
  });
  for (const phase of ['import', 'resolve', 'upload']) {
    expect(output.join('')).toContain(`helper stdout ${phase}`);
    expect(output.join('')).toContain(`helper stderr ${phase}`);
  }
});

test('worker cleanup also stops a legacy plugin descendant after a successful request', async () => {
  provider(
    `const fs=require('node:fs');const path=require('node:path');module.exports={async resolveBuildCache(){const child=require('node:child_process').spawn(process.execPath,['-e',"require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)",path.join(__dirname,'descendant')],{stdio:'ignore'});await new Promise(resolve=>child.once('spawn',resolve));while(!fs.existsSync(path.join(__dirname,'descendant')))await new Promise(resolve=>setTimeout(resolve,10));console.log('legacy-descendant-ready');while(!fs.existsSync(path.join(__dirname,'release')))await new Promise(resolve=>setTimeout(resolve,10));return null},uploadBuildCache(){return null}};`,
  );
  const { ctx, controller } = context('descendants');
  let ready: () => void;
  const began = new Promise<void>((resolve) => {
    ready = resolve;
  });
  ctx.output = (_stream, text) => {
    if (text.includes('legacy-descendant-ready')) ready();
  };
  await withAmbientContext(ctx, async () => {
    const loaded = await loadProjectProvider(root, { context: ctx });
    assert(loaded.provider);
    const pending = resolveRemote({
      context: ctx,
      provider: loaded.provider,
      projectRoot: root,
      platform: 'ios',
      fingerprintHash: 'ours',
    });
    const settled = pending.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      await Promise.race([
        began,
        settled.then(() => {
          throw new Error('Legacy worker ended before its child began.');
        }),
      ]);
      const pid = Number(readFileSync(join(root, 'descendant'), 'utf8'));
      const identity = captureProcessIdentity(pid);
      assert(identity.ok);
      writeFileSync(join(root, 'release'), '');
      expect(await settled).toEqual({ value: null });
      expect(inspectProcessIdentity({ pid, processToken: identity.token })).toBe('gone');
    } finally {
      controller.abort();
      await settled;
    }
  });
});

test.each(['complete', 'unresolved'])('a thrown progress callback preserves %s worker cleanup', async (cleanup) => {
  provider(
    `module.exports={resolveBuildCache(){console.log('provider pending');while(true){}},uploadBuildCache(){return null}};`,
  );
  const { ctx } = context('callback');
  await withAmbientContext(ctx, async () => {
    const loaded = await loadProjectProvider(root, { context: ctx });
    assert(loaded.provider);
    const failure = new Error('legacy progress callback');
    const cleanupFailure = new WorkspaceProcessCleanupError([], 'Worker cleanup is unresolved', 'Verify its child');
    const executor = getExecutor();
    const run = executor.runFileAsync.bind(executor);
    let retainedMessages: string | undefined;
    let drained = false;
    const drain = vi.spyOn(executor, 'runFileAsync').mockImplementation(async (...args) => {
      retainedMessages = JSON.parse(String(args[2].input)).messagesPath;
      try {
        return await run(...args);
      } catch (error) {
        drained = error === failure;
        if (cleanup === 'unresolved' && drained) throw cleanupFailure;
        throw error;
      }
    });
    ctx.output = () => {
      throw failure;
    };
    try {
      await expect(
        resolveRemote({
          context: ctx,
          provider: loaded.provider,
          projectRoot: root,
          platform: 'ios',
          fingerprintHash: 'ours',
        }),
      ).rejects.toBe(cleanup === 'unresolved' ? cleanupFailure : failure);
      assert(retainedMessages);
      expect(existsSync(retainedMessages)).toBe(cleanup === 'unresolved');
    } finally {
      drain.mockRestore();
      if (retainedMessages && drained) rmSync(dirname(retainedMessages), { recursive: true, force: true });
    }
  });
});
