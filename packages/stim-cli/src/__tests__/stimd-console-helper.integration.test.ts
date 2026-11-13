import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
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
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isJsonObject } from '@stim-cli/core/state';
import { inspectProcessIdentity } from '@stim-cli/core/process-identity';
import { processGroupAlive, readClaimSet } from '@stim-cli/core/ownership-claim';
import { parseNdjsonText } from '../ndjson.ts';
import { claimPath, consoleExitFile } from '../stimd/logs/claim.ts';
import { createStreams } from '../stimd/logs/streams.ts';
import { workspaceLogsDir } from '../workspace/paths.ts';
import { readWorkspaceState } from '../workspace/workspace-state.ts';

const STREAMS = pathToFileURL(join(import.meta.dirname, '..', 'stimd', 'logs', 'streams.ts')).href;

/** A devicectl console stand-in: counts its launches, prints, writes the ready marker, then follows the go files. */
const CONSOLE = `
const fs = require('node:fs');
const env = process.env;
fs.appendFileSync(env.CONSOLE_LAUNCHES, 'x');
console.log('before the crash');
fs.writeFileSync(env.CONSOLE_READY, '');
const after = (file, then) => {
  const timer = setInterval(() => {
    if (!fs.existsSync(file)) return;
    clearInterval(timer);
    then();
  }, 20);
};
after(env.CONSOLE_GO_1, () => {
  console.log('logged while no stimd ran');
  after(env.CONSOLE_GO_2, () => {
    process.stderr.write('BSErrorCodeDescription = Locked\\n');
    process.exitCode = 1;
  });
});
`;

/** A stimd stand-in: starts the physical console through stimd's stream table, prints its stream id, and waits. */
const STIMD = (root: string) => `
const { createStreams } = await import(${JSON.stringify(STREAMS)});
const streams = createStreams(() => {});
const spec = { root: ${JSON.stringify(root)}, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test', physical: true };
process.stdout.write(JSON.stringify(await streams.start(spec, process.env)) + '\\n');
setInterval(() => {}, 1000);
`;

let tmp: string;
let root: string;
let env: Record<string, string>;
let launches: string;
let ready: string;
let go1: string;
let go2: string;
const spawned: ChildProcess[] = [];

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'stim-console-helper-')));
  const home = join(tmp, 'home');
  root = join(tmp, 'app');
  const bin = join(tmp, 'bin');
  for (const dir of [home, root, bin]) mkdirSync(dir);
  vi.stubEnv('STIM_HOME', home);
  writeFileSync(join(tmp, 'console.cjs'), CONSOLE);
  writeFileSync(
    join(bin, 'xcrun'),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(tmp, 'console.cjs'))} "$@"\n`,
  );
  chmodSync(join(bin, 'xcrun'), 0o755);
  launches = join(tmp, 'launches');
  ready = join(tmp, 'ready');
  go1 = join(tmp, 'go-1');
  go2 = join(tmp, 'go-2');
  env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    STIM_HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    CONSOLE_LAUNCHES: launches,
    CONSOLE_READY: ready,
    CONSOLE_GO_1: go1,
    CONSOLE_GO_2: go2,
  };
});

afterEach(() => {
  for (const child of spawned.splice(0))
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

const records = () => {
  try {
    return parseNdjsonText(readFileSync(join(workspaceLogsDir(root), 'device.ndjson'), 'utf8'));
  } catch {
    return [];
  }
};

function identityOf(value: unknown): { pid: number; processToken: string } {
  assert(isJsonObject(value) && typeof value.pid === 'number' && typeof value.processToken === 'string');
  return { pid: value.pid, processToken: value.processToken };
}

/** The console helper and devicectl of the stream's claim. */
function claimed(streamId: string) {
  const holder = readClaimSet(claimPath(root, streamId)).live[0];
  assert(holder?.child);
  return { helper: identityOf(holder.details.helper), console: holder.child };
}

describe.skipIf(process.platform === 'win32')('the physical iPhone console helper', () => {
  test('a console outlives a crashed stimd: its successor takes it over without a relaunch and records every line and the exit', async () => {
    const stimd = spawn(process.execPath, ['--input-type=module', '-e', STIMD(root)], {
      env,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    spawned.push(stimd);
    assert(stimd.stdout);
    const [line]: unknown[] = await once(stimd.stdout, 'data');
    const started: unknown = JSON.parse(String(line));
    assert(isJsonObject(started) && typeof started.streamId === 'string');
    const { streamId } = started;
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 10_000 });
    const { helper } = claimed(streamId);
    stimd.kill('SIGKILL');
    await once(stimd, 'exit');
    writeFileSync(go1, '');
    await vi.waitFor(() => expect(records().map((record) => record.msg)).toContain('logged while no stimd ran'), {
      timeout: 10_000,
    });

    const streams = createStreams(() => {});
    try {
      streams.resume([root], env);
      await vi.waitFor(() => expect(streams.running()).toBe(true), { timeout: 10_000 });
      expect(claimed(streamId).helper).toEqual(helper);
      writeFileSync(go2, '');
      await vi.waitFor(() => expect(streams.running()).toBe(false), { timeout: 15_000 });
    } finally {
      await streams.close();
    }
    const messages = records().map((record) => String(record.msg));
    const failed = messages.findIndex((msg) => msg.includes('the devicectl console ended with exit code 1'));
    expect(failed).toBeGreaterThan(messages.indexOf('BSErrorCodeDescription = Locked'));
    expect(messages.indexOf('BSErrorCodeDescription = Locked')).toBeGreaterThan(
      messages.indexOf('logged while no stimd ran'),
    );
    expect(messages.indexOf('logged while no stimd ran')).toBeGreaterThan(messages.indexOf('before the crash'));
    expect(records().filter((record) => record.event === 'collector_started')).toHaveLength(1);
    expect(records().every((record) => record.streamId === streamId)).toBe(true);
    expect(readFileSync(launches, 'utf8')).toBe('x');
    expect(readWorkspaceState(root)?.collectors).toBeUndefined();
    expect(readClaimSet(claimPath(root, streamId)).live).toEqual([]);
    expect(existsSync(consoleExitFile(root, streamId))).toBe(false);
  }, 60_000);

  test('a stop goes through the helper, which ends devicectl and records the stop', async () => {
    const streams = createStreams(() => {});
    try {
      const { streamId } = await streams.start(
        { root, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test', physical: true },
        env,
      );
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 10_000 });
      const { helper, console } = claimed(streamId);
      expect(await streams.stop(root, 'ios', 'default', streamId)).toBe(true);
      expect(inspectProcessIdentity(helper)).not.toBe('same');
      expect(processGroupAlive(console.pid)).toBe(false);
      expect(records().at(-1)).toMatchObject({ event: 'collector_stopped', msg: 'device log stream stopped' });
      expect(readWorkspaceState(root)?.collectors).toBeUndefined();
      expect(streams.running()).toBe(false);
    } finally {
      await streams.close();
    }
  }, 30_000);

  test('a helper that ends without recording the exit has stimd stop devicectl and record the failure', async () => {
    const streams = createStreams(() => {});
    try {
      await streams.start(
        { root, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test', physical: true },
        env,
      );
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 10_000 });
      const streamId = records()[0]?.streamId;
      assert(typeof streamId === 'string');
      const { helper, console } = claimed(streamId);
      if (inspectProcessIdentity(helper) === 'same') process.kill(helper.pid, 'SIGKILL');
      await vi.waitFor(() => expect(streams.running()).toBe(false), { timeout: 15_000 });
      expect(processGroupAlive(console.pid)).toBe(false);
      expect(records().at(-1)).toMatchObject({ streamId, event: 'collector_failed' });
      expect(String(records().at(-1)?.msg)).toContain(`helper pid ${helper.pid} ended without recording`);
      expect(readWorkspaceState(root)?.collectors).toBeUndefined();
    } finally {
      await streams.close();
    }
  }, 30_000);

  test('a console whose predecessor still runs past the wait is refused by name, then taken over once it exits', async () => {
    const stimd = spawn(process.execPath, ['--input-type=module', '-e', STIMD(root)], {
      env,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    spawned.push(stimd);
    assert(stimd.stdout);
    const [line]: unknown[] = await once(stimd.stdout, 'data');
    const started: unknown = JSON.parse(String(line));
    assert(isJsonObject(started) && typeof started.streamId === 'string');
    const { streamId } = started;
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 10_000 });
    const { helper } = claimed(streamId);
    const logged: string[] = [];
    const streams = createStreams(
      () => {},
      (_level, event, msg) => logged.push(`${event}: ${msg}`),
    );
    try {
      streams.resume([root], env);
      await vi.waitFor(
        () => expect(logged.find((entry) => entry.startsWith('device_log_stream_unverified'))).toBeDefined(),
        { timeout: 20_000 },
      );
      expect(logged.find((entry) => entry.startsWith('device_log_stream_unverified'))).toContain(
        claimPath(root, streamId),
      );
      expect(streams.running()).toBe(true);
      stimd.kill('SIGKILL');
      await once(stimd, 'exit');
      await vi.waitFor(() => expect(logged.some((entry) => entry.startsWith('device_console_adopted'))).toBe(true), {
        timeout: 10_000,
      });
      expect(claimed(streamId).helper).toEqual(helper);
      expect(await streams.stop(root, 'ios', 'default', streamId)).toBe(true);
      expect(records().at(-1)).toMatchObject({ event: 'collector_stopped', msg: 'device log stream stopped' });
      expect(readFileSync(launches, 'utf8')).toBe('x');
    } finally {
      await streams.close();
    }
  }, 60_000);
});
