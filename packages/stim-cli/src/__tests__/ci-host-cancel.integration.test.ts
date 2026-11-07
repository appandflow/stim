import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { hostStimd } from '../stimd/attached.ts';

test.skipIf(process.platform === 'win32')('cancels startup and waits for the attached child to exit', async () => {
  const executor = getExecutor();
  let pid = 0;
  setExecutor({
    ...executor,
    spawn: (_file, _args, options) => {
      const child = executor.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
      pid = child.pid ?? 0;
      return child;
    },
  });
  const controller = new AbortController();
  try {
    const hosted = hostStimd(process.env, { signal: controller.signal });
    controller.abort();
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
    childProcess.spawn = (_file, args, options) => spawn('/missing-stim-cancellation-executable', args, options);
    syncBuiltinESMExports();
    const { hostStimd } = await import(${JSON.stringify(entry)});
    const controller = new AbortController();
    const result = hostStimd(process.env, { signal: controller.signal });
    controller.abort();
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
