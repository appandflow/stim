import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNdjsonText } from '../ndjson.ts';
import { upsertProject } from '../workspace/config.ts';
import { workspaceLogsDir } from '../workspace/paths.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';
import { registerCollector } from '../stimd/logs/state.ts';
import { takeStreamClaim } from '../stimd/logs/claim.ts';

const CLAIM_MODULE = fileURLToPath(new URL('../stimd/logs/claim.ts', import.meta.url));

describe.skipIf(process.platform === 'win32')('resuming a stream whose stimd died', () => {
  let home: string;
  let root: string;
  let starts: string;
  let simctl: string;
  let env: Record<string, string>;
  const events: { level: string; event: string; msg: string }[] = [];

  beforeEach(() => {
    events.length = 0;
    home = realpathSync(mkdtempSync(join(tmpdir(), 'stim-resume-gates-home-')));
    root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-resume-gates-app-')));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    starts = join(home, 'starts');
    simctl = join(home, 'simctl.json');
    writeFileSync(
      join(bin, 'xcrun'),
      `#!/bin/sh
case "$*" in
  *"simctl list"*) cat "${simctl}"; exit 0 ;;
  *"log show"*) exit 0 ;;
  *"log stream"*) echo $$ >> "${starts}"; exec sleep 600 ;;
esac
exit 1
`,
    );
    chmodSync(join(bin, 'xcrun'), 0o755);
    vi.stubEnv('STIM_HOME', home);
    vi.stubEnv('PATH', [bin, process.env.PATH].join(delimiter));
    env = { STIM_HOME: home, PATH: process.env.PATH ?? '' };
    setDevice({ state: 'Booted' });
    writeFileSync(
      join(home, 'created-devices.json'),
      JSON.stringify({ version: 1, ios: ['U1'], android: [], web: [] }),
    );
    upsertProject(root, { platforms: { ios: { deviceUdid: 'U1', owned: true } } });
  });

  afterEach(() => {
    for (const pid of existsSync(starts) ? readFileSync(starts, 'utf8').split('\n').filter(Boolean) : []) {
      try {
        process.kill(-Number(pid), 'SIGKILL');
      } catch {}
    }
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  function setDevice({ state }: { state: string }) {
    writeFileSync(
      simctl,
      JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
            {
              udid: 'U1',
              name: 'stim-test (iPhone iOS 18)',
              state,
              isAvailable: true,
              deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
            },
          ],
        },
      }),
    );
  }

  const startCount = () => (existsSync(starts) ? readFileSync(starts, 'utf8').split('\n').filter(Boolean).length : 0);
  const interrupted = () => {
    try {
      return parseNdjsonText(readFileSync(join(workspaceLogsDir(root), 'device.ndjson'), 'utf8')).filter(
        (record) => record.event === 'collector_interrupted',
      );
    } catch {
      return [];
    }
  };
  const record = (streamId: string, spec: Record<string, unknown> | undefined) =>
    registerCollector(root, 'ios', {
      kind: 'stream',
      streamId,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      ...(spec
        ? { spec: { root, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test', ...spec } }
        : {}),
    });
  const deadClaim = async (streamId: string) => {
    const script = `import { takeStreamClaim } from ${JSON.stringify(CLAIM_MODULE)};
await takeStreamClaim(${JSON.stringify(root)}, ${JSON.stringify(streamId)});
process.kill(process.pid, 'SIGKILL');`;
    const child = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', '--input-type=module', '-e', script],
      { env: { ...process.env, STIM_HOME: home }, stdio: 'ignore' },
    );
    await once(child, 'exit');
  };
  const resume = async () => {
    const { createStreams } = await import('../stimd/logs/streams.ts');
    const streams = createStreams(
      () => {},
      (level, event, msg) => events.push({ level, event, msg }),
    );
    streams.resume([root], env);
    return streams;
  };

  test('an owner that is still running is neither replaced nor reaped', async () => {
    record('s-live', {});
    const claim = await takeStreamClaim(root, 's-live');
    const streams = await resume();
    try {
      await vi.waitFor(() => expect(events.map((entry) => entry.event)).toContain('device_log_stream_unverified'));
      expect(events.find((entry) => entry.event === 'device_log_stream_unverified')?.msg).toContain('still running');
      expect(startCount()).toBe(0);
      expect(interrupted()).toHaveLength(0);
      expect(readWorkspaceState(root)?.collectors?.ios).toMatchObject({ streamId: 's-live' });
      expect(existsSync(claim.path)).toBe(true);
    } finally {
      await streams.close().catch(() => {});
      const { releaseClaim } = await import('../ownership-claim.ts');
      releaseClaim(claim);
    }
  });

  test('a record whose claim is missing is not resumed and the log names a remedy', async () => {
    record('s-none', {});
    const streams = await resume();
    try {
      await vi.waitFor(() => expect(events.map((entry) => entry.event)).toContain('device_log_stream_unverified'));
      expect(events.find((entry) => entry.event === 'device_log_stream_unverified')?.msg).toContain('stim stop');
      expect(startCount()).toBe(0);
      expect(interrupted()).toHaveLength(0);
    } finally {
      await streams.close().catch(() => {});
    }
  });

  test('a dead owner on a device the workspace still owns and has booted is resumed', async () => {
    record('s-ok', {});
    await deadClaim('s-ok');
    const streams = await resume();
    try {
      await vi.waitFor(() => expect(startCount()).toBe(1));
      await vi.waitFor(() => expect(interrupted()).toHaveLength(1));
      expect(readWorkspaceState(root)?.collectors?.ios).toMatchObject({ streamId: 's-ok' });
    } finally {
      await streams.close().catch(() => {});
    }
  });

  test.each([
    {
      why: 'the workspace no longer records the device',
      prepare: () => upsertProject(root, { platforms: {} }),
      says: 'no longer records',
      spec: {},
    },
    {
      why: 'this home did not create the device',
      prepare: () =>
        writeFileSync(
          join(home, 'created-devices.json'),
          JSON.stringify({ version: 1, ios: [], android: [], web: [] }),
        ),
      says: 'not owned by this Stim home',
      spec: {},
    },
    {
      why: 'the simulator is shut down',
      prepare: () => setDevice({ state: 'Shutdown' }),
      says: 'not booted',
      spec: {},
    },
    {
      why: 'the record is a physical console without a spec',
      prepare: () => {},
      says: 'no stream spec',
      spec: undefined,
    },
  ])('a dead owner is not resumed when $why, and the log says so once', async ({ prepare, says, spec }) => {
    prepare();
    record('s-lost', spec);
    await deadClaim('s-lost');
    const streams = await resume();
    try {
      await vi.waitFor(() => {
        expect(interrupted()).toHaveLength(1);
        expect(readWorkspaceState(root)?.collectors?.ios).toHaveProperty('interruptedAt');
      });
      expect(interrupted()[0]?.msg).toContain(says);
      expect(interrupted()[0]).toMatchObject({ level: 'warn', streamId: 's-lost' });
      expect(startCount()).toBe(0);
      await streams.close();
      const again = await resume();
      await new Promise((done) => setTimeout(done, 500));
      expect(interrupted()).toHaveLength(1);
      await again.close();
    } finally {
      await streams.close().catch(() => {});
    }
  });
});
