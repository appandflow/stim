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
import { isJsonObject, stimdRecordFile } from '@stim-cli/core/state';
import { inspectProcessIdentity } from '@stim-cli/core/process-identity';
import { processGroupAlive, readClaimSet, tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import { stopDeviceLogStream } from '../daemon/client.ts';
import { daemonFindings, daemonStatus, unverifiedLines } from '../daemon/status.ts';
import { parseNdjsonText } from '../ndjson.ts';
import { claimPath, consoleExitFile } from '../stimd/logs/claim.ts';
import { registerCollector } from '../stimd/logs/state.ts';
import { createStreams } from '../stimd/logs/streams.ts';
import { runStimd } from '../stimd/main.ts';
import * as groupStop from '../stimd/metro/group-stop.ts';
import { upsertProject } from '../workspace/config.ts';
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

  test('a refused console stop is reported until a retry reaches the helper and stops it', async () => {
    const streams = createStreams(() => {});
    try {
      const { streamId } = await streams.start(
        { root, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test', physical: true },
        env,
      );
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 10_000 });
      const { helper, console } = claimed(streamId);
      const stopHelper = vi.spyOn(groupStop, 'stopHelperProcess');
      stopHelper.mockRejectedValueOnce(new Error('fixture could not stop the helper'));
      try {
        await expect(streams.stop(root, 'ios', 'default', streamId)).rejects.toThrow(
          'fixture could not stop the helper',
        );
        expect(streams.unverifiedConsoles()).toEqual([
          {
            kind: 'console',
            since: expect.any(String),
            message: expect.stringContaining('could not be settled'),
            remedy: expect.stringContaining(`shows console-run`),
          },
        ]);
        expect(inspectProcessIdentity(helper)).toBe('same');
      } finally {
        stopHelper.mockRestore();
      }
      expect(await streams.stop(root, 'ios', 'default', streamId)).toBe(true);
      expect(inspectProcessIdentity(helper)).not.toBe('same');
      expect(processGroupAlive(console.pid)).toBe(false);
      expect(records().at(-1)).toMatchObject({ event: 'collector_stopped', msg: 'device log stream stopped' });
      expect(readWorkspaceState(root)?.collectors).toBeUndefined();
      expect(streams.running()).toBe(false);
      expect(streams.unverifiedConsoles()).toEqual([]);
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

  test('an unresolved claim at startup is reported only for a recorded physical console', async () => {
    const consoleId = 'unknown-console';
    const ordinaryId = 'unknown-simulator';
    const consoleRoot = claimPath(root, consoleId);
    for (const [slot, id] of [
      ['ios', consoleId],
      ['ios:qa', ordinaryId],
    ] as const) {
      const claim = tryAcquireClaim({
        root: claimPath(root, id),
        mode: 'exclusive',
        details: { streamId: id },
      }).acquired;
      assert(claim);
      writeFileSync(claim.path, JSON.stringify({ ...claim, owner: { ...claim.owner, processToken: 'bad-token' } }));
      expect(readClaimSet(claimPath(root, id)).unresolved).toHaveLength(1);
      registerCollector(root, slot, {
        kind: 'stream',
        streamId: id,
        ...(id === ordinaryId
          ? { spec: { root, platform: 'ios', udid: 'U2', bundleId: 'com.test.app', appName: 'Test' } }
          : {}),
      });
    }
    const streams = createStreams(() => {});
    try {
      streams.resume([root], env);
      await vi.waitFor(() =>
        expect(streams.unverifiedConsoles()).toEqual([
          expect.objectContaining({
            kind: 'console',
            message: expect.stringContaining(consoleRoot),
            remedy: expect.stringContaining('its process identity token does not decode'),
          }),
        ]),
      );
      expect(readClaimSet(consoleRoot).unresolved).toHaveLength(1);
      expect(existsSync(launches)).toBe(false);
      rmSync(consoleRoot, { recursive: true });
      await vi.waitFor(() => expect(streams.unverifiedConsoles()).toEqual([]), { timeout: 5000 });
    } finally {
      await streams.close();
    }
  }, 15_000);

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
    const holder = readClaimSet(claimPath(root, streamId)).live[0];
    assert(holder);
    const claimText = readFileSync(holder.path, 'utf8');
    upsertProject(root, {});
    const before = new Set(process.listeners('SIGTERM'));
    const successor = runStimd({ mode: 'on', tickMs: 60_000 });
    try {
      await vi.waitFor(() => expect(existsSync(stimdRecordFile())).toBe(true), { timeout: 10_000 });
      await vi.waitFor(() => expect(daemonStatus().unverified?.[0]?.message).toContain(claimPath(root, streamId)), {
        timeout: 20_000,
      });
      const waiting = daemonStatus();
      expect(waiting.unverified).toEqual([
        {
          kind: 'console',
          since: expect.any(String),
          message: expect.stringContaining('could not be taken over'),
          remedy: expect.stringContaining(`pid ${stimd.pid}`),
        },
      ]);
      expect(unverifiedLines(waiting).join(' ')).toContain(`pid ${stimd.pid}`);
      expect(daemonFindings(waiting, { serving: () => [] })).toContainEqual(
        expect.objectContaining({
          title: 'The stim-daemon could not recover a device console',
          fix: waiting.unverified?.[0]?.remedy,
        }),
      );
      expect(await stopDeviceLogStream(root, 'ios', 'default', streamId)).toMatchObject({
        code: 'STIM_CLAIM_UNAVAILABLE',
        error: expect.stringContaining(claimPath(root, streamId)),
        remedy: expect.stringContaining(`pid ${stimd.pid}`),
      });
      writeFileSync(holder.path, '{');
      await vi.waitFor(() => expect(daemonStatus().unverified?.[0]?.remedy).toContain('is unresolved'), {
        timeout: 5000,
      });
      expect(daemonStatus().unverified?.[0]?.since).toBe(waiting.unverified?.[0]?.since);
      expect(inspectProcessIdentity(helper)).toBe('same');
      writeFileSync(holder.path, claimText);
      const predecessorExit = once(stimd, 'exit');
      stimd.kill('SIGKILL');
      await predecessorExit;
      await vi.waitFor(() => expect(daemonStatus().unverified).toBeUndefined(), { timeout: 10_000 });
      expect(claimed(streamId).helper).toEqual(helper);
      expect(await stopDeviceLogStream(root, 'ios', 'default', streamId)).toEqual({ stopped: true });
      expect(records().at(-1)).toMatchObject({ event: 'collector_stopped', msg: 'device log stream stopped' });
      expect(readFileSync(launches, 'utf8')).toBe('x');
    } finally {
      process.listeners('SIGTERM').find((listener) => !before.has(listener))?.('SIGTERM');
      await successor;
    }
  }, 60_000);
});
