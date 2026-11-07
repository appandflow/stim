import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { hostStimd } from '../stimd/attached.ts';

const own = vi.hoisted(() => vi.fn<() => { root: string; build: string } | null>());
const beforeRelease = vi.hoisted(() => vi.fn<() => void>());
vi.mock('../engine-store/locks.ts', async (load) => {
  const actual = await load<typeof import('../engine-store/locks.ts')>();
  return {
    ...actual,
    takeLock: async (...args: Parameters<typeof actual.takeLock>) => {
      const lock = await actual.takeLock(...args);
      return (
        lock && {
          release: async () => {
            beforeRelease();
            await lock.release();
          },
        }
      );
    },
  };
});
vi.mock('../daemon/engine-switch.ts', async (load) => ({
  ...(await load<typeof import('../daemon/engine-switch.ts')>()),
  ownStoreEngine: own,
}));

test.skipIf(process.platform === 'win32')(
  'cancels and joins a staged selector before spawning an attached host',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'stim-host-flip-'));
    const marker = join(root, 'selector.pid');
    const a = 'aaaaaaaaaaaa';
    const b = 'bbbbbbbbbbbb';
    mkdirSync(join(root, b, 'dist'), { recursive: true });
    writeFileSync(join(root, 'current.json'), JSON.stringify({ format: 1, dir: a, version: '1' }));
    writeFileSync(join(root, 'staged.json'), JSON.stringify({ format: 1, dir: b, version: '2' }));
    writeFileSync(
      join(root, b, 'dist', 'engine-select.mjs'),
      `
    import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(marker)}, String(process.pid));
    setInterval(() => {}, 1000);
  `,
    );
    own.mockReturnValue({ root, build: a });
    const executor = getExecutor();
    const hostSpawn = vi.fn<typeof executor.spawn>(executor.spawn);
    setExecutor({ ...executor, spawn: hostSpawn });
    const controller = new AbortController();
    try {
      const hosted = hostStimd({ ...process.env, STIM_HOME: join(root, 'home') }, { signal: controller.signal });
      for (let i = 0; i < 200 && !existsSync(marker); i++) await new Promise((done) => setTimeout(done, 25));
      expect(existsSync(marker)).toBe(true);
      const pid = Number(readFileSync(marker, 'utf8'));
      beforeRelease.mockImplementation(() => expect(() => process.kill(pid, 0)).toThrow(/ESRCH/));
      expect(hostSpawn).not.toHaveBeenCalled();
      controller.abort();
      await expect(hosted).rejects.toMatchObject({ name: 'AbortError' });
      expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
      expect(beforeRelease).toHaveBeenCalledTimes(2);
      expect(hostSpawn).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      own.mockReset();
      beforeRelease.mockReset();
      resetExecutor();
      rmSync(root, { recursive: true, force: true });
    }
  },
  15_000,
);
