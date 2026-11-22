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
import { readClaimSet, releaseClaim } from '../ownership-claim.ts';
import { claimPath, streamOwnerGone, takeStreamClaim } from '../stimd/logs/claim.ts';

const writes = vi.hoisted(
  (): {
    opened: string[];
    gate: Promise<void> | null;
    drop: boolean;
    teardown: boolean;
    ready: (streamId: string) => void;
  } => ({
    opened: [],
    gate: null,
    drop: false,
    teardown: false,
    ready: () => {},
  }),
);
vi.mock('../stimd/logs/writer.ts', async (original) => {
  const actual = await original<typeof import('../stimd/logs/writer.ts')>();
  return {
    ...actual,
    createLogWriters(...args: Parameters<typeof actual.createLogWriters>) {
      const writers = actual.createLogWriters(...args);
      const open = writers.open;
      writers.open = async (...input) => {
        const sink = await open(...input);
        writes.opened.push(input[0].streamId);
        writes.ready(input[0].streamId);
        if (writes.gate) await writes.gate;
        if (writes.drop) sink.writer.write = () => true;
        return sink;
      };
      const ownedClose = writers.ownedClose;
      writers.ownedClose = () => {
        writes.teardown = true;
        return ownedClose();
      };
      return writers;
    },
  };
});

const CLAIM_MODULE = fileURLToPath(new URL('../stimd/logs/claim.ts', import.meta.url));

describe.skipIf(process.platform === 'win32')('resuming a stream whose stimd died', () => {
  let home: string;
  let root: string;
  let starts: string;
  let simctl: string;
  let env: Record<string, string>;
  let writerOpened: Promise<void>;
  const events: { level: string; event: string; msg: string }[] = [];

  beforeEach(() => {
    events.length = 0;
    writes.opened.length = 0;
    writes.gate = null;
    writes.drop = false;
    writes.teardown = false;
    writerOpened = new Promise<void>((resolve) => {
      writes.ready = (streamId) => {
        if (streamId === 's-lost') resolve();
      };
    });
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
  const deadClaim = async (streamId: string, claimed = true) => {
    const script = `import { takeStreamClaim } from ${JSON.stringify(CLAIM_MODULE)};
${claimed ? `await takeStreamClaim(${JSON.stringify(root)}, ${JSON.stringify(streamId)});` : ''}
process.kill(process.pid, 'SIGKILL');`;
    const child = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', '--input-type=module', '-e', script],
      { env: { ...process.env, STIM_HOME: home }, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const [code, signal] = await once(child, 'close');
    if (code !== null || signal !== 'SIGKILL')
      throw new Error(`claim fixture child did not reach SIGKILL: ${JSON.stringify({ code, signal, stderr })}`);
    const survey = readClaimSet(claimPath(root, streamId));
    expect(survey).toMatchObject({
      live: [],
      unresolved: [],
      dead: [{ owner: { pid: child.pid }, details: { streamId } }],
    });
    expect(streamOwnerGone(root, streamId, survey)).toEqual({ gone: true });
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

  const lostWriteOpened = async (says: string) => {
    await writerOpened;
    expect(events.some((entry) => entry.event === 'device_log_stream_dropped' && entry.msg.includes(says))).toBe(true);
    expect(writes.opened).toContain('s-lost');
  };
  const persistedLost = (says: string) => {
    expect(interrupted()).toHaveLength(1);
    expect(readWorkspaceState(root)?.collectors?.ios).toHaveProperty('interruptedAt');
    expect(interrupted()[0]?.msg).toContain(says);
    expect(interrupted()[0]).toMatchObject({ level: 'warn', streamId: 's-lost' });
    expect(startCount()).toBe(0);
  };

  test.each(['missing', 'rejected'])('a %s dead-owner claim fails its fixture prerequisite', async (kind) => {
    const claim = kind === 'rejected' ? await takeStreamClaim(root, 's-bad') : null;
    try {
      await expect(deadClaim('s-bad', kind !== 'missing')).rejects.toThrow(
        kind === 'missing' ? /dead/ : /Another device log stream/,
      );
    } finally {
      if (claim) releaseClaim(claim);
    }
  });

  test('closing after real writer open preserves an interruption whose write is late', async () => {
    let release = () => {};
    writes.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    record('s-lost', undefined);
    await deadClaim('s-lost');
    const streams = await resume();
    try {
      await lostWriteOpened('no stream spec');
      let closed = false;
      const closing = streams.close().then(() => {
        closed = true;
        return closed;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(writes.teardown).toBe(false);
      expect(closed).toBe(false);
      expect(interrupted()).toHaveLength(0);
      release();
      await closing;
      persistedLost('no stream spec');
    } finally {
      release();
      await streams.close().catch(() => {});
    }
  });

  test('the persisted interruption assertion rejects a lost writer record', async () => {
    writes.drop = true;
    record('s-lost', undefined);
    await deadClaim('s-lost');
    const streams = await resume();
    try {
      await lostWriteOpened('no stream spec');
      await streams.close();
      expect(readWorkspaceState(root)?.collectors?.ios).toHaveProperty('interruptedAt');
      expect(() => persistedLost('no stream spec')).toThrow(/length/);
    } finally {
      await streams.close().catch(() => {});
    }
  });

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
      await lostWriteOpened(says);
      await vi.waitFor(() => persistedLost(says));
      await streams.close();
      const again = await resume();
      await new Promise((done) => setTimeout(done, 500));
      expect(interrupted()).toHaveLength(1);
      await again.close();
    } catch (error) {
      throw new Error(
        JSON.stringify({
          events,
          collector: readWorkspaceState(root)?.collectors?.ios,
          claim: readClaimSet(claimPath(root, 's-lost')),
          interrupted: interrupted(),
        }),
        { cause: error },
      );
    } finally {
      await streams.close().catch(() => {});
    }
  });
});
