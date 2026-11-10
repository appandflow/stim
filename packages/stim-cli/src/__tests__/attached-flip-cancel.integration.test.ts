import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { takeLock } from '../engine-store/locks.ts';
import { hostStimd } from '../stimd/attached.ts';

const own = vi.hoisted(() => vi.fn<() => { root: string; build: string } | null>());
vi.mock('../daemon/engine-switch.ts', async (load) => ({
  ...(await load<typeof import('../daemon/engine-switch.ts')>()),
  ownStoreEngine: own,
}));
vi.mock('../spawn-entry.ts', async (load) => {
  const actual = await load<typeof import('../spawn-entry.ts')>();
  return {
    ...actual,
    spawnEntry: (name: Parameters<typeof actual.spawnEntry>[0]) =>
      name === 'engine-flip' ? join(process.cwd(), 'packages/stim-cli/dist/engine-flip.mjs') : actual.spawnEntry(name),
  };
});

function fixture() {
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
    await new Promise(() => {});
  `,
  );
  return { root, marker, a };
}

async function waitMarker(marker: string): Promise<number> {
  for (let i = 0; i < 200 && !existsSync(marker); i++) await new Promise((done) => setTimeout(done, 25));
  if (!existsSync(marker)) throw new Error('selector did not start');
  return Number(readFileSync(marker, 'utf8'));
}

async function expectLocksFree(root: string) {
  const store = await takeLock(root, '.lock.sock');
  const flip = await takeLock(root, '.flip.sock');
  expect(store).not.toBeNull();
  expect(flip).not.toBeNull();
  await flip?.release();
  await store?.release();
}

test.skipIf(process.platform === 'win32')(
  'cancels and joins the selector process before starting a host',
  async () => {
    const { root, marker, a } = fixture();
    own.mockReturnValue({ root, build: a });
    const executor = getExecutor();
    const hostSpawn = vi.fn<typeof executor.spawn>(executor.spawn);
    setExecutor({ ...executor, spawn: hostSpawn });
    const controller = new AbortController();
    try {
      const hosted = hostStimd({ ...process.env, STIM_HOME: join(root, 'home') }, { signal: controller.signal });
      const pid = await waitMarker(marker);
      expect(await takeLock(root, '.lock.sock')).toBeNull();
      expect(await takeLock(root, '.flip.sock')).toBeNull();
      expect(hostSpawn).not.toHaveBeenCalled();
      controller.abort();
      await expect(hosted).rejects.toMatchObject({ name: 'AbortError' });
      expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
      await expectLocksFree(root);
      expect(hostSpawn).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      own.mockReset();
      resetExecutor();
      rmSync(root, { recursive: true, force: true });
    }
  },
  15_000,
);

test.skipIf(process.platform === 'win32')(
  'an unverified selector keeps both locks and prevents another promotion',
  async () => {
    const identities = await import('../process-identity.ts');
    const { root, marker, a } = fixture();
    own.mockReturnValue({ root, build: a });
    const unknown = vi.spyOn(identities, 'inspectProcessIdentity').mockReturnValue('unknown');
    const controller = new AbortController();
    let pid = 0;
    try {
      const hosted = hostStimd({ ...process.env, STIM_HOME: join(root, 'home') }, { signal: controller.signal });
      pid = await waitMarker(marker);
      controller.abort();
      await expect(hosted).rejects.toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE' });
      expect(await takeLock(root, '.lock.sock')).toBeNull();
      expect(await takeLock(root, '.flip.sock')).toBeNull();
    } finally {
      unknown.mockRestore();
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
        for (let i = 0; i < 100; i++) {
          try {
            process.kill(pid, 0);
          } catch {
            break;
          }
          await new Promise((done) => setTimeout(done, 20));
        }
      }
      await expectLocksFree(root);
      own.mockReset();
      resetExecutor();
      rmSync(root, { recursive: true, force: true });
    }
  },
  15_000,
);

test.skipIf(process.platform === 'win32')(
  'selector keeps both locks after its launcher exits',
  async () => {
    const { spawn } = await import('node:child_process');
    const { root, marker } = fixture();
    const entry = join(process.cwd(), 'packages/stim-cli/dist/engine-flip.mjs');
    const script = `
    import { spawn } from 'node:child_process';
    spawn(process.execPath, [${JSON.stringify(entry)}], {
      detached: true, stdio: 'ignore', env: { ...process.env, STIM_ENGINE_ROOT: ${JSON.stringify(root)}, STIM_HOME: ${JSON.stringify(join(root, 'home'))} }
    }).unref();
  `;
    let pid = 0;
    try {
      const launcher = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
      const code = await new Promise<number | null>((done) => launcher.once('close', done));
      expect(code).toBe(0);
      pid = await waitMarker(marker);
      expect(await takeLock(root, '.lock.sock')).toBeNull();
      expect(await takeLock(root, '.flip.sock')).toBeNull();
    } finally {
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
        for (let i = 0; i < 100; i++) {
          try {
            process.kill(pid, 0);
          } catch {
            break;
          }
          await new Promise((done) => setTimeout(done, 20));
        }
      }
      await expectLocksFree(root);
      rmSync(root, { recursive: true, force: true });
    }
  },
  15_000,
);
