import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { releaseClaim, tryAcquireClaim, type ClaimHandle } from '@stim-cli/core/ownership-claim';
import { stimdBootsFile, stimdClaimRoot, stimdRunDir, stimdSocket } from '@stim-cli/core/state';

const service = vi.hoisted(() => ({
  starter: null as { label: string; waitMs: number } | null,
  starts: 0,
  store: false,
}));

vi.mock('../daemon/engine-switch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../daemon/engine-switch.ts')>();
  return {
    ...actual,
    ownStoreEngine: () => (service.store ? { root: '/engine', build: 'b1' } : actual.ownStoreEngine()),
  };
});

vi.mock('../stimd/service-unit.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../stimd/service-unit.ts')>()),
  deferringService: () => service.starter,
  startServiceJob: () => {
    service.starts++;
  },
}));

describe('a command on a home whose service job starts its stimd', () => {
  let home: string;
  let server: Server | null = null;
  let claim: ClaimHandle | null = null;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-service-home-')));
    vi.stubEnv('STIM_HOME', home);
    mkdirSync(dirname(stimdSocket()), { recursive: true, mode: 0o700 });
    mkdirSync(stimdRunDir(), { recursive: true, mode: 0o700 });
    service.starter = { label: 'dev.stim.server', waitMs: 75_000 };
    service.starts = 0;
    service.store = false;
  });

  afterEach(async () => {
    await new Promise((done) => (server?.listening ? server.close(done) : done(undefined)));
    server = null;
    releaseClaim(claim);
    claim = null;
    vi.unstubAllEnvs();
    vi.resetModules();
    rmSync(home, { recursive: true, force: true });
  });

  /** Runs `work` on the fake clock, calling `at` with the time waited after each 50 ms step. */
  const drive = async <T>(work: Promise<T>, at: (waited: number) => void = () => {}) => {
    const state = { settled: false };
    void work.finally(() => (state.settled = true)).catch(() => {});
    let waited = 0;
    while (!state.settled) {
      await new Promise((done) => setImmediate(done));
      await vi.advanceTimersByTimeAsync(50);
      waited += 50;
      at(waited);
    }
    return { result: await work, waited };
  };

  /** A stimd on the home's socket whose net thread answers once `ready` says so. */
  const stimd = (ready: () => boolean) => {
    claim = tryAcquireClaim({ root: stimdClaimRoot(), mode: 'exclusive', label: 'test stimd' }).acquired ?? null;
    server = createServer((connection: Socket) => {
      connection.setEncoding('utf8');
      connection.once('data', () =>
        connection.write(
          `${JSON.stringify({ op: 'hello' })}\n${JSON.stringify(ready() ? { op: 'net.connected' } : { op: 'error', code: 'net-off' })}\n`,
        ),
      );
    });
    server.listen(stimdSocket());
  };

  it('waits through a restart delay longer than the start it asked for', async () => {
    const { ensureStimd } = await import('../daemon/client.ts');
    const { result, waited } = await drive(ensureStimd({ ...process.env, STIM_DAEMON: 'on' }), (now) => {
      if (now === 30_000) claim = tryAcquireClaim({ root: stimdClaimRoot(), mode: 'exclusive' }).acquired ?? null;
    });
    expect(result).toBe(true);
    expect(waited).toBeGreaterThanOrEqual(30_000);
    expect(service.starts).toBe(1);
  });

  it('fails with the service status remedy when the job does not start within its wait', async () => {
    service.starter = { label: 'dev.stim.server', waitMs: 2000 };
    const { ensureStimd } = await import('../daemon/client.ts');
    await expect(drive(ensureStimd({ ...process.env, STIM_DAEMON: 'on' }))).rejects.toMatchObject({
      code: 'STIM_DAEMON_UNAVAILABLE',
      remedy: 'Run stim service status.',
    });
  });

  it('prints the crash hold of a build the job holds instead of asking the job to start', async () => {
    service.store = true;
    const { ensureStimd, stimdBuildId } = await import('../daemon/client.ts');
    const boots = [1, 2, 3].map((at) => ({
      at: Date.now() - at * 1000,
      build: stimdBuildId(),
      pid: at,
      abnormal: true,
      cause: 'engine',
    }));
    writeFileSync(stimdBootsFile(), JSON.stringify({ boots }));
    const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = await drive(ensureStimd({ ...process.env, STIM_DAEMON: 'on' }));
    expect(result).toBe(false);
    expect(service.starts).toBe(0);
    expect(printed).toHaveBeenCalledWith(expect.stringContaining('stim engine use <version> or stim engine update'));
    printed.mockRestore();
  });

  it('connects a net client once the restarted stimd and then its net thread answer', async () => {
    const { connectNet } = await import('../daemon/client.ts');
    let netReady = false;
    const { result } = await drive(connectNet(1000), (now) => {
      if (now === 3000) stimd(() => netReady);
      if (now === 6000) netReady = true;
    });
    expect(result).not.toBeNull();
    result?.destroy();
    expect(service.starts).toBe(1);
  });

  it('answers a net client at once on a home without one', async () => {
    service.starter = null;
    const { connectNet } = await import('../daemon/client.ts');
    const { result, waited } = await drive(connectNet(1000));
    expect(result).toBeNull();
    expect(waited).toBeLessThan(1000);
    expect(service.starts).toBe(0);
  });
});
