import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { hostStimd } from '../stimd/attached.ts';

test.skipIf(process.platform === 'win32')('cancels startup and waits for the attached child to exit', async () => {
  const executor = getExecutor();
  let pid = 0;
  const controller = new AbortController();
  setExecutor({
    ...executor,
    spawn: (_file, _args, options) => {
      const child = executor.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
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

test.skipIf(process.platform === 'win32')(
  'does not signal the process group when startup fails and is immediately cancelled',
  async () => {
    const { spawn } = await import('node:child_process');
    const { pathToFileURL } = await import('node:url');
    const { resolve } = await import('node:path');
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
