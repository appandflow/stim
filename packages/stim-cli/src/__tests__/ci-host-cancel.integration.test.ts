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
