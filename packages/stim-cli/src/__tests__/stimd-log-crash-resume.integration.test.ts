import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stimBuildId, stimdRecordFile, stimdSocket } from '@stim-cli/core/state';
import { parseNdjsonText } from '../ndjson.ts';
import { upsertProject } from '../workspace/config.ts';
import { workspaceLogsDir } from '../workspace/paths.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { machineCopy } from './fixtures/machine-copy.ts';

const PACKAGE = fileURLToPath(new URL('../..', import.meta.url));

const simctlList = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
      {
        udid: 'U1',
        name: 'stim-test (iPhone iOS 18)',
        state: 'Booted',
        isAvailable: true,
        deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
      },
    ],
  },
});

test.skipIf(process.platform === 'win32')(
  'a stimd killed with SIGKILL leaves a stream that its successor resumes, records the gap and backfills it',
  async () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'stim-crash-resume-')));
    const home = join(tmp, 'home');
    mkdirSync(home);
    process.env.STIM_HOME = home;
    const bin = join(tmp, 'bin');
    mkdirSync(bin);
    const app = join(tmp, 'app');
    mkdirSync(app);
    upsertProject(app, { platforms: { ios: { deviceUdid: 'U1', owned: true } } });
    writeFileSync(
      join(home, 'created-devices.json'),
      JSON.stringify({ version: 1, ios: ['U1'], android: [], web: [] }),
    );
    const streamPids = join(tmp, 'stream-pids');
    const simctl = join(tmp, 'simctl.json');
    writeFileSync(simctl, simctlList);
    const gap = join(tmp, 'gap');
    writeFileSync(
      gap,
      `${JSON.stringify({ eventType: 'logEvent', eventMessage: 'logged while stimd was down', timestamp: new Date(Date.now() + 60_000).toISOString() })}\n`,
    );
    writeFileSync(
      join(bin, 'xcrun'),
      `#!/bin/sh
case "$*" in
  *"simctl list"*) cat '${simctl}'; exit 0 ;;
  *"log show"*) cat '${gap}'; exit 0 ;;
  *"log stream"*)
    echo $$ >> '${streamPids}'
    printf '{"eventType":"logEvent","eventMessage":"line from %s"}\\n' $$
    exec sleep 600 ;;
esac
exit 1
`,
    );
    chmodSync(join(bin, 'xcrun'), 0o755);
    for (const tool of ['launchctl', 'systemd-run']) {
      writeFileSync(join(bin, tool), '#!/bin/sh\nexit 1\n');
      chmodSync(join(bin, tool), 0o755);
    }
    const env = {
      ...process.env,
      HOME: tmp,
      STIM_HOME: home,
      STIM_ENGINE_ROOT: join(tmp, 'engine'),
      STIM_DAEMON: 'on',
      PATH: `${bin}:${process.env.PATH}`,
    };
    const dist = join(machineCopy(PACKAGE, join(tmp, 'prefix')), 'dist');
    const childPids = (): number[] => {
      try {
        return readFileSync(streamPids, 'utf8').trim().split('\n').map(Number);
      } catch {
        return [];
      }
    };
    const records = () => {
      try {
        return parseNdjsonText(readFileSync(join(workspaceLogsDir(app), 'device.ndjson'), 'utf8'));
      } catch {
        return [];
      }
    };
    const lines = () => records().map((line) => String(line.msg));
    const stimdPid = (): number | null => {
      try {
        const record: unknown = JSON.parse(readFileSync(stimdRecordFile(), 'utf8'));
        return typeof record === 'object' && record && 'pid' in record && typeof record.pid === 'number'
          ? record.pid
          : null;
      } catch {
        return null;
      }
    };
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const until = async (what: string, check: () => boolean) => {
      for (const deadline = Date.now() + 30_000; !check();) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((done) => setTimeout(done, 20));
      }
    };
    const admitted = (params: Record<string, unknown>) =>
      new Promise<Socket>((resolve, reject) => {
        const socket = connect(stimdSocket());
        socket.setEncoding('utf8');
        let buffer = '';
        socket.on('data', (chunk: string) => {
          buffer += chunk;
          if (buffer.includes('"op.begun"')) resolve(socket);
        });
        socket.once('error', reject);
        socket.once('connect', () =>
          socket.write(
            `${JSON.stringify({ kind: 'cli', build: stimBuildId(dist) })}\n${JSON.stringify({ op: 'op.begin', params })}\n`,
          ),
        );
      });
    const stimds: ChildProcess[] = [];
    const startStimd = () =>
      stimds.push(
        spawn(process.execPath, [join(dist, 'cli.mjs'), '__stimd', '--mode', 'on'], {
          env,
          cwd: tmp,
          stdio: 'ignore',
          detached: true,
        }),
      );
    try {
      startStimd();
      await until('the first stimd', () => stimdPid() !== null);
      const first = stimdPid();
      assert(first !== null);
      const streamOp = await admitted({
        workspace: app,
        forwarded: { cwd: app, env: { PATH: env.PATH, HOME: tmp, STIM_HOME: home } },
      });
      const started = await new Promise<Record<string, unknown>>((resolve) => {
        let buffer = '';
        streamOp.on('data', (chunk: string) => {
          buffer += chunk;
          const line = buffer.split('\n').find((entry) => entry.includes('"logs.'));
          if (line) resolve(JSON.parse(line));
        });
        streamOp.write(
          `${JSON.stringify({ op: 'logs.start', params: { root: app, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' } })}\n`,
        );
      });
      await until('the first device line', () => childPids().length === 1 && lines().length > 1);
      const [orphan] = childPids();
      assert(orphan !== undefined);
      streamOp.destroy();

      process.kill(first, 'SIGKILL');
      await until('the first stimd to die', () => !alive(first));
      expect(alive(orphan)).toBe(true);
      expect(readWorkspaceState(app)?.collectors?.ios).toMatchObject({ kind: 'stream', streamId: started.streamId });

      startStimd();
      await until('the second stimd', () => stimdPid() !== null && stimdPid() !== first);
      await until('the resumed stream', () => childPids().length === 2);
      const [, resumed] = childPids();
      await until('the backfilled gap', () => lines().includes('logged while stimd was down'));
      expect(alive(orphan)).toBe(false);
      expect(lines().filter((line) => line === `line from ${orphan}`)).toHaveLength(1);
      expect(lines().filter((line) => line === 'logged while stimd was down')).toHaveLength(1);
      const interrupted = records().filter((record) => record.event === 'collector_interrupted');
      expect(interrupted).toHaveLength(1);
      expect(interrupted[0]).toMatchObject({ level: 'warn', streamId: started.streamId });
      expect(readWorkspaceState(app)?.collectors?.ios).toMatchObject({ kind: 'stream', streamId: started.streamId });
      assert(resumed !== undefined);
    } finally {
      const pids = [stimdPid(), ...stimds.map((stimd) => stimd.pid), ...childPids()].filter(
        (pid): pid is number => pid !== undefined && pid !== null,
      );
      for (const pid of pids.filter(alive)) process.kill(pid, 'SIGTERM');
      await until('the processes to exit', () => !pids.some(alive)).catch(() => {
        for (const pid of pids.filter(alive)) process.kill(pid, 'SIGKILL');
      });
      delete process.env.STIM_HOME;
      rmSync(tmp, { recursive: true, force: true });
    }
  },
  120_000,
);
