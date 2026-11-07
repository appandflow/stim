import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { hostStimd } from '../stimd/attached.ts';
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import * as engineSwitch from '../daemon/engine-switch.ts';

test.skipIf(process.platform === 'win32')('cancels startup and waits for the attached child to exit', async () => {
  const executor = getExecutor();
  let pid = 0;
  const controller = new AbortController();
  setExecutor({
    ...executor,
    spawn: (_file, _args, options) => {
      const child = executor.spawn(
        process.execPath,
        ['-e', "process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); setInterval(() => {}, 1000)"],
        options,
      );
      pid = child.pid ?? 0;
      controller.abort();
      return child;
    },
  });
  try {
    const hosted = hostStimd(process.env, { signal: controller.signal });
    await expect(hosted).rejects.toMatchObject({ name: 'AbortError' });
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  } finally {
    resetExecutor();
  }
});

test('startup cancellation reports a late claim refusal from the child', async () => {
  const executor = getExecutor();
  const controller = new AbortController();
  const script = `
    process.stdin.resume();
    process.stdin.on('end', () => {
      process.stdout.write(JSON.stringify({ op: 'attached-claim-refusal', refusal: {
        code: 'STIM_CLAIM_UNAVAILABLE', message: 'cleanup unverified', remedy: 'inspect claim'
      } }) + '\\n', () => process.exit(1));
    });
  `;
  setExecutor({
    ...executor,
    spawn: (_file, _args, options) => {
      const child = executor.spawn(process.execPath, ['-e', script], options);
      controller.abort();
      return child;
    },
  });
  try {
    await expect(hostStimd(process.env, { signal: controller.signal })).rejects.toMatchObject({
      code: 'STIM_CLAIM_UNAVAILABLE',
      message: 'cleanup unverified',
      remedy: 'inspect claim',
    });
  } finally {
    resetExecutor();
  }
});

describe.skipIf(process.platform === 'win32')('startup lock cancellation', () => {
  test.each(['abort', 'timeout'])(
    '%s stops a real child waiting for the store lock and retries in the same home',
    async (stop) => {
      const scratch = realpathSync(mkdtempSync('/tmp/stim-host-cancel-'));
      const root = join(scratch, 'engine');
      const build = 'bbbbbbbbbbbb';
      const selected = join(root, build);
      const home = join(scratch, 'home');
      const ready = join(scratch, 'preload-ready');
      const release = join(scratch, 'preload-release');
      const preload = join(scratch, 'wait.mjs');
      const pkg = resolve('packages/stim-cli');
      mkdirSync(join(selected, 'dist'), { recursive: true });
      cpSync(join(pkg, 'dist'), join(selected, 'dist'), { recursive: true });
      cpSync(join(pkg, 'package.json'), join(selected, 'package.json'));
      symlinkSync(join(pkg, 'node_modules'), join(selected, 'node_modules'), 'junction');
      writeFileSync(join(root, 'current.json'), JSON.stringify({ format: 1, dir: build, version: 'test' }));
      writeFileSync(
        preload,
        `import { existsSync, writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(ready)}, '');\nwhile (!existsSync(${JSON.stringify(release)})) await new Promise((done) => setTimeout(done, 10));\n`,
      );
      const own = vi.spyOn(engineSwitch, 'ownStoreEngine').mockReturnValue({ root, build });
      const executor = getExecutor();
      let child: ReturnType<typeof executor.spawn> | undefined;
      setExecutor({
        ...executor,
        spawn: (file, args, options) => {
          child = executor.spawn(
            file,
            ['--import', preload, join(selected, 'dist', 'cli.mjs'), ...args.slice(1)],
            options,
          );
          return child;
        },
      });
      const controller = new AbortController();
      const lock = createServer();
      let lockClosed = false;
      try {
        const env = { ...process.env, STIM_HOME: home, STIM_ENGINE_ROOT: root };
        const hosted = hostStimd(env, { signal: controller.signal });
        await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 10_000, interval: 20 });
        await new Promise<void>((done, fail) => lock.once('error', fail).listen(join(root, '.lock.sock'), done));
        writeFileSync(release, '');
        await vi.waitFor(() => expect(readClaimSet(join(home, 'run', 'stimd')).live).toHaveLength(1), {
          timeout: 10_000,
          interval: 20,
        });
        if (stop === 'abort') controller.abort();
        const [result] = await Promise.allSettled([hosted]);
        expect(result).toMatchObject(
          stop === 'abort'
            ? { status: 'rejected', reason: { name: 'AbortError' } }
            : { status: 'fulfilled', value: { refusal: { code: 'STIM_DAEMON_UNAVAILABLE' } } },
        );
        expect(readClaimSet(join(home, 'run', 'stimd')).unresolved).toEqual([]);
        await new Promise<void>((done) => lock.close(() => done()));
        lockClosed = true;
        const retry = await hostStimd(env, { handover: false });
        if (!retry || typeof retry !== 'object' || !('end' in retry)) throw new Error('same-home retry failed');
        await retry.end();
        expect(readClaimSet(join(home, 'run', 'stimd')).unresolved).toEqual([]);
        expect(readClaimSet(join(root, 'claims', build)).unresolved).toEqual([]);
      } finally {
        controller.abort();
        if (child?.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        if (!lockClosed && lock.listening) await new Promise<void>((done) => lock.close(() => done()));
        resetExecutor();
        own.mockRestore();
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

test.skipIf(process.platform === 'win32')(
  'does not signal the process group when startup fails and is immediately cancelled',
  async () => {
    const { spawn } = await import('node:child_process');
    const { pathToFileURL } = await import('node:url');
    const entry = pathToFileURL(resolve('packages/stim-cli/dist/attached-stimd.mjs')).href;
    const script = `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const spawn = childProcess.spawn;
    const controller = new AbortController();
    childProcess.spawn = (_file, args, options) => {
      const child = spawn('/missing-stim-cancellation-executable', args, options);
      controller.abort();
      return child;
    };
    syncBuiltinESMExports();
    const { hostStimd } = await import(${JSON.stringify(entry)});
    const result = hostStimd(process.env, { signal: controller.signal });
    try { await result; process.exitCode = 1; } catch (error) {
      if (error.name !== 'AbortError') process.exitCode = 2;
    }
  `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { detached: true, stdio: 'ignore' });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
      child.once('close', (code, signal) => done({ code, signal })),
    );
    expect(result).toEqual({ code: 0, signal: null });
  },
  15_000,
);

test('host end preserves a later structured cleanup refusal even in the same stdout chunk', async () => {
  const executor = getExecutor();
  const script = `
    process.stdout.write(JSON.stringify({ op: 'attached', instance: 'fixture', waitMs: 1000 }) + '\\n' +
      JSON.stringify({ op: 'attached-claim-refusal', refusal: { code: 'STIM_CLAIM_UNAVAILABLE', message: 'cleanup unverified', remedy: 'inspect claim' } }) + '\\n');
    process.stdin.resume();
    process.stdin.on('end', () => { process.exitCode = 1; });
  `;
  setExecutor({
    ...executor,
    spawn: (_file, _args, options) => executor.spawn(process.execPath, ['-e', script], options),
  });
  try {
    const hosted = await hostStimd(process.env);
    if (!hosted || typeof hosted !== 'object' || !('end' in hosted)) throw new Error('fixture did not host');
    await expect(hosted.end()).rejects.toMatchObject({
      code: 'STIM_CLAIM_UNAVAILABLE',
      message: 'cleanup unverified',
      remedy: 'inspect claim',
    });
  } finally {
    resetExecutor();
  }
});
