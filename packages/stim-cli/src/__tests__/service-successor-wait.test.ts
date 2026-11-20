import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { releaseClaim, tryAcquireClaim, type ClaimHandle } from '@stim-cli/core/ownership-claim';
import { stimdClaimRoot, stimdRecordFile, stimdRunDir, stimdSocket } from '@stim-cli/core/state';

const service = vi.hoisted(() => ({ starter: null as string | null, homes: [] as string[] }));

vi.mock('../stimd/service-unit.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../stimd/service-unit.ts')>()),
  deferringService: (home: string) => {
    service.homes.push(home);
    return service.starter;
  },
}));

describe('a command that a switching stimd refused', () => {
  let home: string;
  let server: Server | null = null;
  let claim: ClaimHandle | null = null;

  beforeEach(() => {
    service.homes = [];
    home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-service-successor-')));
    vi.stubEnv('STIM_HOME', home);
  });

  afterEach(async () => {
    (await import('../exec.ts')).resetExecutor();
    await new Promise((done) => (server?.listening ? server.close(done) : done(undefined)));
    server = null;
    releaseClaim(claim);
    claim = null;
    vi.unstubAllEnvs();
    vi.resetModules();
    rmSync(home, { recursive: true, force: true });
  });

  /** Refuses the command as a switching stimd does, lets its claim go, and returns what the command launched and how long it waited. */
  const refuse = async () => {
    mkdirSync(dirname(stimdSocket()), { recursive: true, mode: 0o700 });
    mkdirSync(stimdRunDir(), { recursive: true, mode: 0o700 });
    writeFileSync(join(stimdRunDir(), 'service.json'), JSON.stringify({ label: 'dev.stim.server', port: 7787 }));
    claim = tryAcquireClaim({ root: stimdClaimRoot(), mode: 'exclusive', label: 'test stimd' }).acquired ?? null;
    const refusing = createServer((connection) => {
      connection.resume();
      releaseClaim(claim);
      claim = null;
      connection.end(`${JSON.stringify({ op: 'engine-changed', build: 'aaaaaaaaaaaa', pid: 4242, handover: true })}\n`);
      refusing.close();
    });
    server = refusing;
    await new Promise<void>((done) => refusing.listen(stimdSocket(), done));
    vi.resetModules();
    const { getExecutor, setExecutor } = await import('../exec.ts');
    const real = getExecutor();
    const { connectNet, stimdBuildId } = await import('../daemon/client.ts');
    const launches: string[][] = [];
    // The launched stimd stands in for the job's: it binds as soon as it is started.
    const launched = (command: string, args: string[]) => {
      launches.push([command, ...args]);
      writeFileSync(stimdRecordFile(), JSON.stringify({ pid: 1, build: stimdBuildId() }));
    };
    setExecutor({
      ...real,
      runFile: (...call: Parameters<typeof real.runFile>) => {
        const [command, args] = call;
        if (command !== 'launchctl' && command !== 'systemd-run') return real.runFile(...call);
        launched(command, args);
        return '';
      },
      spawn: (command: string, args: string[]) => {
        launched(command, args);
        return Object.assign(new EventEmitter(), { unref: () => {} });
      },
    });

    const state = { settled: false };
    const asked = connectNet(2000).finally(() => (state.settled = true));
    let waited = 0;
    while (!state.settled) {
      await new Promise((done) => setImmediate(done));
      await vi.advanceTimersByTimeAsync(50);
      waited += 50;
    }
    await asked;
    return {
      launched: launches.some((launch) => launch.includes('__stimd') || launch.some((arg) => arg.endsWith('.plist'))),
      waited,
    };
  };

  it('on a home whose service job is its only starter, starts a stimd, which asks the job to start, once the old stimd is gone', async () => {
    service.starter = 'dev.stim.server';
    const { launched, waited } = await refuse();
    expect(launched).toBe(true);
    expect(waited).toBeLessThan(10_000);
    expect(service.homes).toEqual([home]);
  });

  it('on a home whose recorded service job is not its only starter, waits for the successor the old stimd starts', async () => {
    service.starter = null;
    expect((await refuse()).launched).toBe(false);
  });
});
