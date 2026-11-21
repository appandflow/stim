import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { releaseClaim, tryAcquireClaim, type ClaimHandle } from '@stim-cli/core/ownership-claim';
import { stimdClaimRoot, stimdRecordFile, stimdRunDir, stimdSocket } from '@stim-cli/core/state';

describe('a command that a stimd of another build refused', () => {
  let home: string;
  let server: Server | null = null;
  let claim: ClaimHandle | null = null;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-service-successor-')));
    vi.stubEnv('STIM_HOME', home);
    mkdirSync(dirname(stimdSocket()), { recursive: true, mode: 0o700 });
    mkdirSync(stimdRunDir(), { recursive: true, mode: 0o700 });
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

  /** Runs `work` on the fake clock in 50 ms steps and returns its result and how long it waited. */
  const drive = async <T>(work: Promise<T>) => {
    const state = { settled: false };
    void work.finally(() => (state.settled = true)).catch(() => {});
    let waited = 0;
    while (!state.settled) {
      await new Promise((done) => setImmediate(done));
      await vi.advanceTimersByTimeAsync(50);
      waited += 50;
    }
    return { result: await work, waited };
  };

  /**
   * A stimd that refuses this command for a switch to this command's build, `toJob` when it leaves the home to its
   * service job, and lets its claim go; returns whether the command launched a stimd itself and how long it waited.
   */
  const refuse = async (toJob: boolean) => {
    claim = tryAcquireClaim({ root: stimdClaimRoot(), mode: 'exclusive', label: 'test stimd' }).acquired ?? null;
    vi.resetModules();
    const { getExecutor, setExecutor } = await import('../exec.ts');
    const real = getExecutor();
    const { connectNet, stimdBuildId } = await import('../daemon/client.ts');
    const refusing = createServer((connection) => {
      connection.resume();
      releaseClaim(claim);
      claim = null;
      connection.end(
        `${JSON.stringify({ op: 'engine-changed', build: stimdBuildId(), pid: 4242, handover: true, ...(toJob ? { job: true } : {}) })}\n`,
      );
      refusing.close();
    });
    server = refusing;
    await new Promise<void>((done) => refusing.listen(stimdSocket(), done));
    const launches: string[][] = [];
    // The launched stimd binds as soon as it is started.
    const launched = (command: string, args: readonly string[]) => {
      launches.push([command, ...args]);
      writeFileSync(stimdRecordFile(), JSON.stringify({ pid: 1, build: stimdBuildId() }));
    };
    setExecutor({
      ...real,
      runFile: (...call: Parameters<typeof real.runFile>) => {
        const [command, args = []] = call;
        if (!['launchctl', 'systemd-run'].includes(basename(command))) return real.runFile(...call);
        launched(command, args);
        return '';
      },
      spawn: (command: string, args: string[]) => {
        launched(command, args);
        return Object.assign(new EventEmitter(), { unref: () => {} });
      },
    });
    const { waited } = await drive(connectNet(2000));
    return {
      launched: launches.some((launch) => launch.includes('__stimd') || launch.some((arg) => arg.endsWith('.plist'))),
      waited,
    };
  };

  it('starts the stimd of the selected build itself once a stimd that leaves the home to its service job is gone', async () => {
    const { launched, waited } = await refuse(true);
    expect(launched).toBe(true);
    expect(waited).toBeLessThan(5000);
  });

  it('waits for the successor a stimd starts when it hands over without a service job', async () => {
    expect((await refuse(false)).launched).toBe(false);
  });

  it('asks for the net thread on the port a pairing names', async () => {
    claim = tryAcquireClaim({ root: stimdClaimRoot(), mode: 'exclusive', label: 'test stimd' }).acquired ?? null;
    const asked: unknown[] = [];
    server = createServer((connection) => {
      let buffer = '';
      connection.setEncoding('utf8');
      connection.on('data', (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split('\n').filter(Boolean);
        if (lines.length < 2) return;
        asked.push(JSON.parse(lines[1] ?? '{}'));
        connection.write(
          `${JSON.stringify({ op: 'hello' })}\n${JSON.stringify({ op: 'net', listening: true, port: 17788 })}\n`,
        );
      });
    });
    await new Promise<void>((done) => server?.listen(stimdSocket(), done));
    vi.resetModules();
    const { ensureNet } = await import('../daemon/client.ts');
    const { result } = await drive(ensureNet(false, process.env, 17788));
    expect(result).toEqual({ listening: true, port: 17788 });
    expect(asked).toEqual([
      expect.objectContaining({ op: 'net.ensure', params: expect.objectContaining({ port: 17788 }) }),
    ]);
  });
});
