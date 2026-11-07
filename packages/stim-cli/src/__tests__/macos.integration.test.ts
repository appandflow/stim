import { type StimContext, withAmbientContext } from '@stim-cli/core';
import { parseWorkspaceLink } from '@stim-cli/core/workspace-link';
import { testContext } from './_context.ts';
import { writeConfigSetting, loadConfig, saveConfig, upsertProject, getConfigDir } from '../workspace/config.ts';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import {
  appendFileSync,
  constants,
  promises as fs,
  copyFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  macosAppState,
  deviceHostArea,
  parseMacosRecord,
  readMacosRecord,
  readBuildHistory,
  type MacosAppRecord,
  type MacosProcess,
} from '@stim-cli/core/state';
import { type ExecOptions, getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { resolveBundleExtras, stageBundle } from '../macos/stage.ts';
import * as worktree from '../workspace/worktree.ts';
import * as stopping from '../macos/stop.ts';
import { buildMacosBundle } from '../macos/build.ts';
import * as nativeBuild from '../macos/build.ts';
import type { MacosArtifactRecipe } from '../integrations/macos-project.ts';
import { projectRegistry } from '../integrations/projects.ts';
import { planMacos } from '../macos/plan.ts';
import * as artifactCache from '../macos/artifact-cache.ts';
import { createNdjsonWriter } from '../ndjson.ts';
import * as offload from '../offload/client.ts';
import * as machines from '../offload/build-machines.ts';
import * as slots from '../engine/build-slots.ts';
import * as spawns from '../engine/spawn-claims.ts';
import { WorkspaceProcessCleanupError, workspaceProcessLockPath } from '../engine/workspace-process-lock.ts';
import { markClaimChildPending, readClaimSet, releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import * as ownership from '../ownership-claim.ts';
import { startedBy } from '../macos/instances.ts';
import { macosAppLogName, macosDir, macosProcess, macosRuntimeClaim, requiredMacosRecord } from '../macos/state.ts';
import * as owning from '../engine/spawn-owned.ts';
import { refuseDeclaredSpawns } from '../engine/spawn-claims.ts';
import * as stimdClient from '../daemon/client.ts';
import { createOwnedStreams } from '../stimd/logs/owned.ts';
import { withLocalMacosAdmission } from '../macos/admission.ts';
import { reclaimProject } from '../devices/reclaim.ts';
import { buildMacosOperation } from '../commands/macos-build.ts';
import macosCommand, { runMacos, waitForLaunchServices } from '../commands/macos.ts';
import { Command } from 'commander';
import * as nativeRun from '../engine/native-run.ts';
import { workspaceAgentDeviceDir, workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import { runStop } from '../commands/stop.ts';
import { stopMacosApp } from '../macos/stop.ts';
import { captureProcessToken, inspectProcessIdentity, waitForProcessExit } from '../process-identity.ts';
import * as processIdentity from '../process-identity.ts';
import { readWorkspaceState, writeWorkspaceState } from '../workspace/workspace-state.ts';
import { workspaceInUse } from '../workspace/in-use.ts';

let dir: string;
let root: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'stim-macos-')));
  root = join(dir, 'app');
  mkdirSync(root);
  process.env.STIM_HOME = join(dir, 'home');
});

afterEach(async () => {
  vi.spyOn(worktree, 'repoRootAsync').mockRestore();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  rmSync(dir, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

function record(patch: Partial<MacosAppRecord> = {}): MacosAppRecord {
  return {
    launchId: 'test-launch',
    arguments: [],
    product: 'Sample',
    bundle: join(root, 'Sample.app'),
    bundleId: 'dev.sample.stim.test',
    executable: join(root, 'Sample.app', 'Contents', 'MacOS', 'Sample'),
    build: { state: 'ok', startedAt: new Date().toISOString() },
    ...patch,
  };
}

async function ownedProcess(): Promise<MacosProcess> {
  const child = getExecutor().spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(child);
  await new Promise<void>((done, reject) => {
    child.once('spawn', done);
    child.once('error', reject);
  });
  const pid = child.pid!;
  const processToken = captureProcessToken(pid);
  expect(processToken).toBeTypeOf('string');
  return { pid, processToken: processToken!, startedAtMicros: 1 };
}

test.skipIf(process.platform !== 'darwin')(
  'missing macOS settings are a bad argument with a named remedy',
  async () => {
    writeFileSync(join(root, 'Package.swift'), '// swift-tools-version:6.0\n');
    await expect(runMacos(testContext(), root)).rejects.toMatchObject({
      code: 'STIM_BAD_ARG',
      message: expect.stringContaining('macos.product'),
    });
  },
);

test('malformed app ownership is a refusal, never treated as no owned app', async () => {
  writeWorkspaceState(root, { macos: { ...record(), app: { pid: 42 } } });
  expect(parseMacosRecord({ ...record(), app: { pid: 42 } })).toBeNull();
  expect(parseMacosRecord({ ...record(), host: { machine: 'mini', session: 'not-a-session' } })).toBeNull();
  expect(() => requiredMacosRecord(root)).toThrow('owner is malformed');
  await expect(stopMacosApp(root)).rejects.toThrow('owner is malformed');
  expect(workspaceInUse(root)).toContain('its macOS process owner cannot be verified');
});

test('cancelling an owned app stop retains the record and prevents SIGKILL escalation', async () => {
  const child = getExecutor().spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)"],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  children.push(child);
  const closed = once(child, 'close');
  const controller = new AbortController();
  const cancelled = new Error('cancel owned app stop');
  try {
    if (!child.stdout) throw new Error('The test process has no readiness stream.');
    await once(child.stdout, 'data');
    const pid = child.pid;
    if (!pid) throw new Error('The test process has no pid.');
    const processToken = captureProcessToken(pid);
    if (!processToken) throw new Error('The test process identity is unavailable.');
    const saved = record({ app: { pid, processToken, startedAtMicros: 1 } });
    writeWorkspaceState(root, { macos: saved });
    const kill = process.kill.bind(process);
    const signals = vi.spyOn(process, 'kill').mockImplementation((targetPid, name) => {
      const result = kill(targetPid, name);
      if (targetPid === child.pid && name === 'SIGTERM') controller.abort(cancelled);
      return result;
    });
    try {
      await expect(stopMacosApp(root, testContext({ signal: controller.signal }))).rejects.toBe(cancelled);
      expect(inspectProcessIdentity(saved.app)).toBe('same');
      expect(signals.mock.calls.filter(([targetPid, name]) => targetPid === child.pid && name === 'SIGKILL')).toEqual(
        [],
      );
      expect(readMacosRecord(root)).toEqual(saved);
    } finally {
      signals.mockRestore();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
});

test('a dead build owner does not remain a running build in status', async () => {
  const owner = await ownedProcess();
  writeWorkspaceState(root, {
    macos: record({ supervisor: owner, build: { state: 'running', startedAt: new Date().toISOString() } }),
  });
  expect(macosAppState(readMacosRecord(root))?.build.state).toBe('running');
  children.at(-1)!.kill('SIGTERM');
  expect(await waitForProcessExit(owner, 1000)).toBe(true);
  expect(macosAppState(readMacosRecord(root))?.build).toMatchObject({
    state: 'failed',
    error: expect.stringContaining('before reporting a result'),
  });
});

test('an indeterminate Windows launch keeps its pending declaration', async () => {
  const declaration = tryAcquireClaim({ root: join(dir, 'launch.lock'), mode: 'exclusive', label: 'launch' }).acquired;
  assert(declaration);
  const original = process;
  const executor = getExecutor();
  setExecutor({
    ...executor,
    runFile: () => {
      throw new Error('launcher timed out');
    },
  });
  vi.stubGlobal('process', Object.create(original, { platform: { value: 'win32' } }));
  try {
    await expect(
      owning.spawnOwned({
        file: 'fixture.exe',
        args: [],
        cwd: root,
        env: original.env,
        stdout: join(dir, 'out'),
        stderr: join(dir, 'err'),
        claim: { root: join(dir, 'runtime'), label: 'app' },
        declare: [declaration],
      }),
    ).rejects.toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE', claims: [declaration] });
    expect(JSON.parse(readFileSync(declaration.path.replace(/\.claim$/, '.child'), 'utf8'))).toMatchObject({
      record: null,
    });
  } finally {
    vi.unstubAllGlobals();
    resetExecutor();
    releaseClaim(declaration);
  }
});

test.skipIf(process.platform === 'win32')(
  'the runtime claim remains live while a launched app helper survives',
  async () => {
    const declaration = tryAcquireClaim({
      root: join(dir, 'launch.lock'),
      mode: 'exclusive',
      label: 'launch',
    }).acquired;
    assert(declaration);
    const claimRoot = macosRuntimeClaim(root);
    const logs = workspaceLogsDir(root);
    const out = join(logs, macosAppLogName('test-launch', 'out'));
    const owned = await owning.spawnOwned({
      file: process.execPath,
      args: [
        '-e',
        `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); child.on('spawn', () => setTimeout(() => process.exit(0), 300));`,
      ],
      cwd: root,
      env: process.env,
      stdout: out,
      stderr: join(logs, macosAppLogName('test-launch', 'err')),
      claim: { root: claimRoot, label: 'app' },
      declare: [declaration],
    });
    const app = { ...owned, startedAtMicros: 1 };
    writeWorkspaceState(root, { macos: record({ app, supervisor: app }) });
    const streams = createOwnedStreams(() => {});
    try {
      await streams.sync(root);
      expect(await waitForProcessExit(owned, 5000)).toBe(true);
      expect(readClaimSet(claimRoot).live.map((holder) => holder.owner.pid)).toContain(owned.pid);
      await expect(stopMacosApp(root)).rejects.toMatchObject({
        code: 'STIM_MACOS_OWNER_UNVERIFIED',
        message: expect.stringContaining('no signal was sent to that process group'),
      });
      expect(readClaimSet(claimRoot).live.map((holder) => holder.owner.pid)).toContain(owned.pid);
      appendFileSync(out, 'helper output after leader\n');
      const log = join(logs, 'macos.ndjson');
      for (
        let tries = 0;
        tries < 40 && (!existsSync(log) || !readFileSync(log, 'utf8').includes('helper output after leader'));
        tries++
      )
        await new Promise((done) => setTimeout(done, 50));
      expect(readFileSync(log, 'utf8')).toContain('helper output after leader');
      expect(readFileSync(log, 'utf8')).not.toContain('Exited Sample.');
      expect(existsSync(out)).toBe(true);
    } finally {
      streams.close();
      try {
        process.kill(-owned.pid, 'SIGKILL');
      } catch {}
      releaseClaim(owned.claim);
      releaseClaim(declaration);
    }
  },
);

test('an unresolved app-spawn claim blocks cleanup and refuses a successful stop', async () => {
  writeWorkspaceState(root, { macos: record() });
  const claim = tryAcquireClaim({ root: macosRuntimeClaim(root), mode: 'exclusive', label: 'macOS fixture' }).acquired;
  expect(claim).toBeDefined();
  try {
    markClaimChildPending(claim!);
    expect(workspaceInUse(root)).toContain('its macOS runtime claim is held');
    await expect(stopMacosApp(root)).rejects.toMatchObject({ code: 'STIM_MACOS_OWNER_UNVERIFIED' });
  } finally {
    releaseClaim(claim);
  }
});

test.skipIf(process.platform === 'win32')(
  'stimd copies the output of an app that exited before it was observed, once',
  async () => {
    const child = getExecutor().spawn(process.execPath, ['-e', 'setTimeout(() => {}, 200)'], { stdio: 'ignore' });
    children.push(child);
    await once(child, 'spawn');
    if (child.pid === undefined) throw new Error('The app fixture did not start.');
    const app = macosProcess(child.pid);
    await once(child, 'exit');
    writeWorkspaceState(root, { macos: record({ app, supervisor: app }) });
    const logs = workspaceLogsDir(root);
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, macosAppLogName('test-launch', 'out')), 'printed before the crash\n');
    writeFileSync(join(logs, macosAppLogName('test-launch', 'err')), 'fatal: missing library');
    const log = join(logs, 'macos.ndjson');
    const client = () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .map((line): Record<string, unknown> => JSON.parse(line))
            .filter((entry) => entry.src === 'client')
            .map(({ level, msg }) => [level, msg])
        : [];
    for (const stimd of [1, 2]) {
      const streams = createOwnedStreams(() => {});
      try {
        await streams.sync(root);
        for (let tries = 0; tries < 40 && client().length < 3; tries++)
          await new Promise((done) => setTimeout(done, 50));
        await new Promise((done) => setTimeout(done, stimd === 2 ? 600 : 0));
      } finally {
        streams.close();
      }
    }
    expect(client()).toEqual([
      ['info', 'printed before the crash'],
      ['warn', 'fatal: missing library'],
      ['info', 'Exited Sample.'],
    ]);
  },
);

test.skipIf(process.platform === 'win32')(
  'a rapid relaunch drains the previous app before replacing its tail',
  async () => {
    const previous = await ownedProcess();
    writeWorkspaceState(root, { macos: record({ app: previous, supervisor: previous }) });
    const logs = workspaceLogsDir(root);
    mkdirSync(logs, { recursive: true });
    const oldOutput = join(logs, macosAppLogName('test-launch', 'out'));
    writeFileSync(oldOutput, 'previous final output');
    const streams = createOwnedStreams(() => {});
    try {
      await streams.sync(root);
      children.at(-1)!.kill('SIGKILL');
      expect(await waitForProcessExit(previous, 5000)).toBe(true);
      const next = await ownedProcess();
      writeWorkspaceState(root, { macos: record({ launchId: 'next-launch', app: next, supervisor: next }) });
      writeFileSync(join(logs, macosAppLogName('next-launch', 'out')), 'new output\n');
      await streams.sync(root);
      const log = join(logs, 'macos.ndjson');
      for (
        let tries = 0;
        tries < 40 &&
        (!existsSync(log) ||
          !readFileSync(log, 'utf8').includes('new output') ||
          !readFileSync(log, 'utf8').includes('Exited Sample.'));
        tries++
      )
        await new Promise((done) => setTimeout(done, 50));
      const output = readFileSync(log, 'utf8');
      expect(output).toContain('previous final output');
      expect(output).toContain('Exited Sample.');
      expect(output).toContain('new output');
    } finally {
      streams.close();
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'workspace drain flushes the stopped app and prevents stream rediscovery',
  async () => {
    const app = await ownedProcess();
    writeWorkspaceState(root, { macos: record({ app, supervisor: app }) });
    const logs = workspaceLogsDir(root);
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, macosAppLogName('test-launch', 'out')), 'final line');
    const streams = createOwnedStreams(() => {});
    try {
      await streams.sync(root);
      expect(await streams.drain(root)).toContain('could not be verified stopped');
      children.at(-1)!.kill('SIGKILL');
      expect(await waitForProcessExit(app, 5000)).toBe(true);
      expect(await streams.drain(root)).toBeNull();
      const output = readFileSync(join(logs, 'macos.ndjson'), 'utf8');
      expect(output).toContain('final line');
      expect(output).toContain('Exited Sample.');
      rmSync(logs, { recursive: true });
      await streams.sync(root);
      expect(existsSync(logs)).toBe(false);
    } finally {
      streams.close();
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'public stop drains output written during SIGTERM before returning',
  async () => {
    const logs = workspaceLogsDir(root);
    mkdirSync(logs, { recursive: true });
    const raw = join(logs, macosAppLogName('test-launch', 'out'));
    writeFileSync(raw, '');
    const child = getExecutor().spawn(
      process.execPath,
      [
        '-e',
        `process.on('SIGTERM', () => { require('node:fs').appendFileSync(${JSON.stringify(raw)}, 'final diagnostic\\n'); process.exit(0); }); console.log('ready'); setInterval(() => {}, 1000);`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    children.push(child);
    assert(child.stdout);
    await once(child.stdout, 'data');
    if (child.pid === undefined) throw new Error('the app did not start');
    const app = macosProcess(child.pid);
    writeWorkspaceState(root, { macos: record({ app, supervisor: app }) });
    const streams = createOwnedStreams(() => {});
    const drain = vi
      .spyOn(stimdClient, 'drainOwnedMacos')
      .mockImplementation((workspace) => streams.drain(workspace, true));
    try {
      await streams.sync(root);
      expect(await stopMacosApp(root)).toBe(true);
      expect(readFileSync(join(logs, 'macos.ndjson'), 'utf8')).toContain('final diagnostic');
    } finally {
      drain.mockRestore();
      streams.close();
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'hosted drain records final output even before observer discovery',
  async () => {
    const app = await ownedProcess();
    const serverHome = process.env.STIM_HOME;
    assert(serverHome);
    const session = '12345678-1234-1234-1234-123456789abc';
    const home = join(deviceHostArea(session), 'home');
    const hostedRoot = join(home, 'macos-app');
    mkdirSync(hostedRoot, { recursive: true });
    process.env.STIM_HOME = home;
    try {
      writeWorkspaceState(hostedRoot, { macos: record({ app, supervisor: app }) });
      const logs = workspaceLogsDir(hostedRoot);
      mkdirSync(logs, { recursive: true });
      writeFileSync(join(logs, macosAppLogName('test-launch', 'out')), 'final hosted output\n');
      const child = children.at(-1);
      assert(child);
      child.kill('SIGKILL');
      expect(await waitForProcessExit(app, 5000)).toBe(true);
      process.env.STIM_HOME = serverHome;
      const streams = createOwnedStreams(() => {});
      try {
        expect(await streams.drainHosted(session)).toBeNull();
        expect(readFileSync(join(logs, 'macos.ndjson'), 'utf8')).toContain('final hosted output');
      } finally {
        streams.close();
      }
    } finally {
      process.env.STIM_HOME = serverHome;
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'a failed final checkpoint keeps the spool and does not repeat the exit line',
  async () => {
    const app = await ownedProcess();
    writeWorkspaceState(root, { macos: record({ app, supervisor: app }) });
    const logs = workspaceLogsDir(root);
    mkdirSync(logs, { recursive: true });
    const out = join(logs, macosAppLogName('test-launch', 'out'));
    writeFileSync(out, 'final output\n');
    const streams = createOwnedStreams(() => {});
    try {
      await streams.sync(root);
      children.at(-1)!.kill('SIGKILL');
      expect(await waitForProcessExit(app, 5000)).toBe(true);
      const staging = join(logs, 'macos-app.tail.json.tmp');
      mkdirSync(staging);
      expect(await streams.drain(root)).toContain('could not be verified stopped');
      expect(await streams.drain(root)).toContain('could not be verified stopped');
      expect(existsSync(out)).toBe(true);
      rmSync(staging, { recursive: true });
      expect(await streams.drain(root)).toBeNull();
      const lines = readFileSync(join(logs, 'macos.ndjson'), 'utf8')
        .trim()
        .split('\n')
        .map((line): Record<string, unknown> => JSON.parse(line));
      expect(lines.filter((line) => line.msg === 'Exited Sample.')).toHaveLength(1);
    } finally {
      streams.close();
    }
  },
);

test.skipIf(process.platform !== 'darwin')('workspace removal keeps output when stimd refuses the drain', async () => {
  const app = await ownedProcess();
  writeWorkspaceState(root, { macos: record({ app, supervisor: app }) });
  const logs = workspaceLogsDir(root);
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, macosAppLogName('test-launch', 'out')), 'raw output\n');
  writeFileSync(join(logs, 'macos.ndjson'), 'saved output\n');
  const stopDrain = vi.spyOn(stimdClient, 'drainOwnedMacos').mockResolvedValue(null);
  const drain = vi.spyOn(stimdClient, 'drainOwned').mockResolvedValue('fixture refusal');
  try {
    const result = await reclaimProject(root, { deleteOwnedDevices: false });
    expect(result.keptEntry).toBe(true);
    expect(readFileSync(join(logs, 'macos.ndjson'), 'utf8')).toContain('saved output\n');
    expect(drain).toHaveBeenCalledOnce();
  } finally {
    stopDrain.mockRestore();
    drain.mockRestore();
  }
});

test.skipIf(process.platform === 'win32')(
  'a transient output write failure is retried before the spool is removed',
  async () => {
    const app = await ownedProcess();
    writeWorkspaceState(root, { macos: record({ app, supervisor: app }) });
    const logs = workspaceLogsDir(root);
    mkdirSync(logs, { recursive: true });
    const out = join(logs, macosAppLogName('test-launch', 'out'));
    writeFileSync(out, 'retry this line\n');
    const log = join(logs, 'macos.ndjson');
    mkdirSync(log);
    const streams = createOwnedStreams(() => {});
    try {
      await streams.sync(root);
      children.at(-1)!.kill('SIGKILL');
      expect(await waitForProcessExit(app, 5000)).toBe(true);
      expect(await streams.drain(root)).toContain('could not be drained');
      expect(existsSync(out)).toBe(true);
      rmSync(log, { recursive: true });
      expect(await streams.drain(root)).toBeNull();
      const output = readFileSync(log, 'utf8');
      expect(output).toContain('retry this line');
      expect(output).toContain('Exited Sample.');
    } finally {
      streams.close();
    }
  },
);

test('a reused app PID can be finalized when its original group is gone', async () => {
  const app = { pid: 123456, processToken: 'old-app', startedAtMicros: 1 };
  writeWorkspaceState(root, { macos: record({ app, supervisor: app }) });
  const logs = workspaceLogsDir(root);
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, macosAppLogName('test-launch', 'out')), 'final output\n');
  const identity = vi.spyOn(processIdentity, 'inspectProcessIdentity').mockReturnValue('different');
  const group = vi.spyOn(ownership, 'processGroupAlive').mockReturnValue(false);
  const streams = createOwnedStreams(() => {});
  try {
    await streams.sync(root);
    expect(await streams.drain(root)).toBeNull();
    expect(readFileSync(join(logs, 'macos.ndjson'), 'utf8')).toContain('final output');
  } finally {
    streams.close();
    identity.mockRestore();
    group.mockRestore();
  }
});

test('final drain reads output written immediately before app exit', async () => {
  const app = { pid: 123456, processToken: 'last-output', startedAtMicros: 1 };
  writeWorkspaceState(root, { macos: record({ app, supervisor: app }) });
  const logs = workspaceLogsDir(root);
  mkdirSync(logs, { recursive: true });
  const out = join(logs, macosAppLogName('test-launch', 'out'));
  writeFileSync(out, 'first output\n');
  const identity = vi.spyOn(processIdentity, 'inspectProcessIdentity').mockReturnValue('same');
  const group = vi.spyOn(ownership, 'processGroupAlive').mockReturnValue(false);
  const streams = createOwnedStreams(() => {});
  try {
    await streams.sync(root);
    identity.mockReturnValueOnce('same');
    identity.mockImplementationOnce(() => {
      appendFileSync(out, 'final output\n');
      return 'gone';
    });
    expect(await streams.drain(root)).toBeNull();
    const output = readFileSync(join(logs, 'macos.ndjson'), 'utf8');
    expect(output).toContain('final output');
    expect(output.indexOf('final output')).toBeLessThan(output.indexOf('Exited Sample.'));
  } finally {
    streams.close();
    identity.mockRestore();
    group.mockRestore();
  }
});

test.skipIf(process.platform === 'win32')('stimd preserves a partial output line across a restart', async () => {
  const app = await ownedProcess();
  writeWorkspaceState(root, { macos: record({ app, supervisor: app }) });
  const logs = workspaceLogsDir(root);
  mkdirSync(logs, { recursive: true });
  const out = join(logs, macosAppLogName('test-launch', 'out'));
  const mark = join(logs, 'macos-app.tail.json');
  writeFileSync(out, 'first half ');
  const first = createOwnedStreams(() => {});
  await first.sync(root);
  for (let tries = 0; tries < 40 && !existsSync(mark); tries++) await new Promise((done) => setTimeout(done, 50));
  expect(existsSync(mark)).toBe(true);
  first.close();
  appendFileSync(out, 'second half\n');
  const second = createOwnedStreams(() => {});
  try {
    await second.sync(root);
    const log = join(logs, 'macos.ndjson');
    for (let tries = 0; tries < 40 && !existsSync(log); tries++) await new Promise((done) => setTimeout(done, 50));
    expect(readFileSync(log, 'utf8')).toContain('first half second half');
  } finally {
    second.close();
  }
});

test.skipIf(process.platform === 'win32')('stimd caps a verbose app spool and continues tailing it', async () => {
  const app = await ownedProcess();
  writeWorkspaceState(root, { macos: record({ app, supervisor: app }) });
  const logs = workspaceLogsDir(root);
  mkdirSync(logs, { recursive: true });
  const out = join(logs, macosAppLogName('test-launch', 'out'));
  writeFileSync(out, 'x'.repeat(8 * 1024 * 1024));
  const streams = createOwnedStreams(() => {});
  try {
    await streams.sync(root);
    for (let tries = 0; tries < 100 && statSync(out).size !== 0; tries++)
      await new Promise((done) => setTimeout(done, 50));
    expect(statSync(out).size).toBe(0);
    appendFileSync(out, 'after reset\n');
    const log = join(logs, 'macos.ndjson');
    for (let tries = 0; tries < 40 && (!existsSync(log) || !readFileSync(log, 'utf8').includes('after reset')); tries++)
      await new Promise((done) => setTimeout(done, 50));
    const output = readFileSync(log, 'utf8');
    expect(output).toContain('output may have been dropped');
    expect(output).toContain('after reset');
  } finally {
    streams.close();
  }
});

test.skipIf(process.platform === 'win32')('stimd recovers an interrupted spool reset', async () => {
  const app = await ownedProcess();
  writeWorkspaceState(root, { macos: record({ app, supervisor: app }) });
  const logs = workspaceLogsDir(root);
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, macosAppLogName('test-launch', 'out')), 'after reset\n');
  writeFileSync(
    join(logs, 'macos-app.tail.json'),
    JSON.stringify({
      processToken: app.processToken,
      out: 8 * 1024 * 1024,
      err: 0,
      resetting: 'out',
    }),
  );
  const streams = createOwnedStreams(() => {});
  try {
    await streams.sync(root);
    const log = join(logs, 'macos.ndjson');
    for (let tries = 0; tries < 40 && (!existsSync(log) || !readFileSync(log, 'utf8').includes('after reset')); tries++)
      await new Promise((done) => setTimeout(done, 50));
    const output = readFileSync(log, 'utf8');
    expect(output).toContain('output may have been dropped');
    expect(output).toContain('after reset');
  } finally {
    streams.close();
  }
});

test('a device-slot stop preserves the recorded macOS app and supervisor', async () => {
  const app = await ownedProcess();
  const supervisor = await ownedProcess();
  writeWorkspaceState(root, { macos: record({ app, supervisor }) });
  const result = await runStop({ root, slot: 'phone', project: null, collectors: {}, report: () => {} });
  expect(result.ok).toBe(true);
  expect(result.outcomes.macos).toBeUndefined();
  expect(inspectProcessIdentity(app)).toBe('same');
  expect(inspectProcessIdentity(supervisor)).toBe('same');
  expect(readMacosRecord(root)?.app).toEqual(app);
});

test('local app admission serializes launch registration and allows replacement at the cap', async () => {
  const other = join(dir, 'other');
  mkdirSync(other);
  upsertProject(root, {});
  upsertProject(other, {});
  writeConfigSetting({ scope: 'machine' }, 'concurrency.maxMacosApps', 1);
  writeConfigSetting({ scope: 'machine' }, 'concurrency.maxDevices', 2);
  const app = await ownedProcess();
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = withLocalMacosAdmission(root, testContext(), async () => {
    started();
    await gate;
    writeWorkspaceState(root, { macos: record({ app }) });
  });
  await entered;
  const launch = vi.fn<() => Promise<void>>(async () => {});
  const second = withLocalMacosAdmission(other, testContext(), launch).then(
    () => null,
    (error: unknown) => error,
  );
  release();
  await first;
  expect(await second).toMatchObject({ code: 'STIM_AT_CAPACITY' });
  expect(launch).not.toHaveBeenCalled();
  await withLocalMacosAdmission(root, testContext(), launch);
  expect(launch).toHaveBeenCalledOnce();
  writeConfigSetting({ scope: 'machine' }, 'concurrency.maxMacosApps', 0);
  writeConfigSetting({ scope: 'machine' }, 'concurrency.maxDevices', 0);
  await withLocalMacosAdmission(other, testContext(), launch);
  expect(launch).toHaveBeenCalledTimes(2);
  expect(inspectProcessIdentity(app)).toBe('same');
});

describe.skipIf(process.platform !== 'darwin')('unrecorded copies of the owned bundle', () => {
  function bundleCopy(script: string, directory = macosDir(root)): ChildProcess {
    const executable = join(directory, 'Sample.app', 'Contents', 'MacOS', 'Sample');
    mkdirSync(join(executable, '..'), { recursive: true });
    if (!existsSync(executable)) copyFileSync(process.execPath, executable, constants.COPYFILE_FICLONE);
    const child = getExecutor().spawn(
      executable,
      ['-e', `${script}; process.send('ready'); setInterval(() => {}, 1000)`],
      {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: {
          ...process.env,
          // Homebrew Node's @rpath libnode stays in its original prefix when the executable is copied.
          DYLD_LIBRARY_PATH: [join(dirname(process.execPath), '..', 'lib'), process.env.DYLD_LIBRARY_PATH]
            .filter(Boolean)
            .join(':'),
        },
      },
    );
    children.push(child);
    return child;
  }

  async function started(child: ChildProcess): Promise<MacosProcess> {
    await new Promise<void>((done, reject) => {
      let stderr = '';
      child.stderr?.on('data', (chunk) => {
        stderr += chunk;
      });
      const failed = (code: number | null, signal: NodeJS.Signals | null) =>
        reject(
          new Error(
            `The bundle fixture (${process.execPath}) exited before reporting readiness (${code ?? signal}): ${stderr}`,
          ),
        );
      child.once('message', () => {
        child.removeListener('exit', failed);
        done();
      });
      child.once('exit', failed);
      child.once('error', reject);
    });
    return { pid: child.pid!, processToken: captureProcessToken(child.pid!)!, startedAtMicros: 1 };
  }

  test('stop terminates every copy, escalating to SIGKILL, and only then reports success', async () => {
    const cooperative = await started(bundleCopy(''));
    const stubborn = await started(bundleCopy("process.on('SIGTERM', () => {})"));
    const bystander = await ownedProcess();
    writeWorkspaceState(root, { macos: record() });
    const inUse = workspaceInUse(root).join('\n');
    expect(inUse).toContain(`${cooperative.pid}`);
    expect(inUse).toContain(`${stubborn.pid}`);
    expect(await stopMacosApp(root)).toBe(true);
    expect(inspectProcessIdentity(cooperative)).toBe('gone');
    expect(inspectProcessIdentity(stubborn)).toBe('gone');
    expect(inspectProcessIdentity(bystander)).toBe('same');
    expect(workspaceInUse(root)).toEqual([]);
  }, 20_000);

  test('a hosted session stop ends a LaunchServices copy of an earlier attempt and spares other processes', async () => {
    const attempts = join(dir, 'session', 'apps');
    const earlier = await started(bundleCopy("process.on('SIGTERM', () => {})", join(attempts, 'earlier')));
    const current = await started(bundleCopy('', join(attempts, 'current')));
    mkdirSync(join(attempts, 'earlier.lock'));
    const bystander = await ownedProcess();
    await stopping.stopHostedBundleInstances(realpathSync(join(dir, 'session')));
    expect(inspectProcessIdentity(earlier)).toBe('gone');
    expect(inspectProcessIdentity(current)).toBe('gone');
    expect(inspectProcessIdentity(bystander)).toBe('same');
  }, 20_000);

  test('workspace removal stops an unrecorded copy before emptying the workspace', async () => {
    const copy = await started(bundleCopy(''));
    writeWorkspaceState(root, { macos: record() });
    const result = await reclaimProject(root, { deleteOwnedDevices: false });
    expect(result.keptEntry).toBe(false);
    expect(inspectProcessIdentity(copy)).toBe('gone');
    expect(existsSync(macosDir(root))).toBe(false);
  });

  test('workspace removal keeps the workspace when its macOS app cannot be stopped', async () => {
    mkdirSync(macosDir(root), { recursive: true });
    const bystander = await ownedProcess();
    writeWorkspaceState(root, { macos: record({ app: { ...bystander, processToken: 'invalid' } }) });
    const result = await reclaimProject(root, { deleteOwnedDevices: false });
    expect(result.keptEntry).toBe(true);
    expect(result.failedDevices[0]).toMatchObject({
      name: 'macOS app',
      reason: expect.stringContaining('Cannot verify'),
    });
    expect(inspectProcessIdentity(bystander)).toBe('same');
    expect(existsSync(macosDir(root))).toBe(true);
  });
});

test.skipIf(process.platform === 'win32')(
  'stopping an app ends its server and the helpers in the server group, and spares a setsid daemon and a bystander',
  async () => {
    const idle = 'setInterval(() => {}, 1000)';
    const server = `const { spawn } = require('node:child_process');
      const client = spawn(process.execPath, ['-e', ${JSON.stringify(idle)}], { stdio: 'ignore' });
      const daemon = spawn(process.execPath, ['-e', ${JSON.stringify(idle)}], { stdio: 'ignore', detached: true });
      process.stdout.write(client.pid + ' ' + daemon.pid + '\\n'); ${idle}`;
    const app = `const { spawn } = require('node:child_process');
      const s = spawn(process.execPath, ['-e', ${JSON.stringify(server)}], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
      const setuid = process.platform === 'darwin' ? spawn('/usr/bin/top', ['-l', '0', '-s', '5'], { stdio: 'ignore' }).pid : 0;
      s.stdout.on('data', (d) => process.stdout.write(s.pid + ' ' + d.toString().trim() + ' ' + setuid + '\\n')); ${idle}`;
    const supervisor = `const a = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(app)}], { stdio: ['ignore', 'pipe', 'ignore'] });
      a.stdout.on('data', (d) => process.stdout.write(a.pid + ' ' + d)); ${idle}`;
    const leader = getExecutor().spawn(process.execPath, ['-e', supervisor], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    children.push(leader);
    const pids = await new Promise<number[]>((resolve) =>
      leader.stdout?.once('data', (data: Buffer) => resolve(String(data).trim().split(' ').map(Number))),
    );
    const owned = (pid: number | undefined): MacosProcess => {
      const processToken = pid === undefined ? null : captureProcessToken(pid);
      if (pid === undefined || !processToken) throw new Error('The fixture process has no identity.');
      return { pid, processToken, startedAtMicros: 1 };
    };
    const [appPid, serverPid, clientPid, daemonPid, setuidPid] = pids;
    const supervised = owned(leader.pid);
    const [started, helper, daemon] = [owned(serverPid), owned(clientPid), owned(daemonPid)];
    const bystander = await ownedProcess();
    const warnings: string[] = [];
    try {
      writeWorkspaceState(root, { macos: record({ supervisor: supervised, app: owned(appPid) }) });
      expect(await stopMacosApp(root, testContext({ output: (_stream, text) => warnings.push(text) }))).toBe(true);
      expect(inspectProcessIdentity(started)).toBe('gone');
      expect(inspectProcessIdentity(helper)).toBe('gone');
      expect(inspectProcessIdentity(daemon)).toBe('same');
      expect(inspectProcessIdentity(bystander)).toBe('same');
      if (process.platform === 'darwin') expect(warnings.join('')).toContain(`pid ${setuidPid}`);
    } finally {
      for (const pid of [supervised.pid, ...pids].filter((each) => each > 1)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    }
  },
  30_000,
);

test.skipIf(process.platform === 'win32')(
  'the stop walk lists nothing under this process, pid 1 or an ancestor, though it has children',
  async () => {
    const idle = 'setInterval(() => {}, 1000)';
    const owner = getExecutor().spawn(
      process.execPath,
      [
        '-e',
        `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(idle)}], { stdio: 'ignore' }); process.stdout.write(c.pid + '\\n'); ${idle}`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    children.push(owner);
    const started = Number(
      await new Promise<string>((resolve) => owner.stdout?.once('data', (d) => resolve(String(d)))),
    );
    const identity = (pid: number | undefined): MacosProcess => {
      const processToken = pid === undefined ? null : captureProcessToken(pid);
      if (pid === undefined || !processToken) throw new Error('The fixture process has no identity.');
      return { pid, processToken, startedAtMicros: 1 };
    };
    try {
      await ownedProcess();
      expect((await startedBy([identity(owner.pid)])).map((each) => each.pid)).toEqual([started]);
      expect(await startedBy([identity(process.pid)])).toEqual([]);
      expect(await startedBy([identity(process.ppid)])).toEqual([]);
    } finally {
      process.kill(started, 'SIGKILL');
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'failed launch cleanup refuses an unverified child and stops a verified separate group',
  async () => {
    const idle = 'setInterval(() => {}, 1000)';
    const owner = getExecutor().spawn(
      process.execPath,
      [
        '-e',
        `const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(idle)}], { detached: true, stdio: 'ignore' }); process.stdout.write(child.pid + '\\n'); ${idle}`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    children.push(owner);
    const childPid = Number(
      await new Promise<string>((resolve) => owner.stdout?.once('data', (data) => resolve(String(data)))),
    );
    const ownerPid = owner.pid;
    assert(ownerPid);
    const ownerToken = captureProcessToken(ownerPid);
    const childToken = captureProcessToken(childPid);
    assert(ownerToken && childToken);
    const app = { pid: ownerPid, processToken: ownerToken };
    const child = { pid: childPid, processToken: childToken };
    const capture = processIdentity.captureProcessIdentity;
    const spy = vi
      .spyOn(processIdentity, 'captureProcessIdentity')
      .mockImplementation((pid) => (pid === childPid ? { ok: false, reason: 'UNAVAILABLE' } : capture(pid)));
    try {
      await expect(stopping.stopMacosChildren(app)).rejects.toThrow('Cannot verify macOS child');
      expect(inspectProcessIdentity(child)).toBe('same');
      spy.mockRestore();
      await stopping.stopMacosChildren(app);
      expect(inspectProcessIdentity(child)).toMatch(/^(gone|different)$/);
      expect(inspectProcessIdentity(app)).toBe('same');
    } finally {
      spy.mockRestore();
      if (inspectProcessIdentity(child) === 'same') process.kill(childPid, 'SIGKILL');
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'a pending cleanup declaration remains unresolved after both owners exit',
  async () => {
    const launcher = await ownedProcess();
    const app = await ownedProcess();
    const claimRoot = join(dir, 'failed-launch.claims');
    const attempt = tryAcquireClaim({ root: claimRoot, mode: 'exclusive', label: 'failed launch', owner: launcher });
    assert(attempt.acquired);
    const claim = attempt.acquired;
    try {
      markClaimChildPending(claim);
      process.kill(app.pid, 'SIGKILL');
      process.kill(launcher.pid, 'SIGKILL');
      expect(await waitForProcessExit(app, 5000)).toBe(true);
      expect(await waitForProcessExit(launcher, 5000)).toBe(true);
      const survey = readClaimSet(claimRoot);
      expect(survey.live).toEqual([]);
      expect(survey.unresolved).toHaveLength(1);
    } finally {
      for (const processRecord of [app, launcher]) {
        if (inspectProcessIdentity(processRecord) === 'same') process.kill(processRecord.pid, 'SIGKILL');
        await waitForProcessExit(processRecord, 5000);
      }
      releaseClaim(claim);
    }
  },
);

describe('macOS build placement and promotion', () => {
  let bundle: string;
  let bin: string;
  let writer: ReturnType<typeof createNdjsonWriter>;
  let localBuilds: number;
  let previousDuringBuild: string[];
  let compilerCalls: Array<{ file: string; args: string[]; cwd: string | undefined }>;
  let swiftTmpdirs: Array<string | undefined>;
  let plist: Record<string, unknown>;
  const bundleId = 'dev.sample.stim.test';
  const choice = { machine: 'mini', offer: { capacity: {} } } as offload.OffloadChoice;
  let buildRecord: MacosAppRecord['build'];

  beforeEach(() => {
    bundle = join(dir, 'Sample.app');
    mkdirSync(bundle);
    writeFileSync(join(bundle, 'previous'), 'old');
    bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'Sample'), 'local');
    writeFileSync(join(root, 'Info.plist'), '{}');
    writeFileSync(join(root, 'Package.swift'), '// swift-tools-version:6.0\n');
    writer = createNdjsonWriter(join(dir, 'build.ndjson'));
    localBuilds = 0;
    previousDuringBuild = [];
    compilerCalls = [];
    swiftTmpdirs = [];
    plist = { CFBundleIdentifier: 'dev.sample', CFBundleExecutable: 'Sample' };
    buildRecord = { state: 'running', startedAt: new Date().toISOString() };
    vi.spyOn(machines, 'pairedMachines').mockReturnValue([
      { machine: 'mini' } as ReturnType<typeof machines.pairedMachines>[number],
    ]);
    vi.spyOn(offload, 'chooseBuildMachine').mockResolvedValue(choice);
    vi.spyOn(offload, 'closeOffload').mockImplementation(() => {});
    vi.spyOn(slots, 'acquireBuildSlot').mockResolvedValue({ unlimited: true });
    vi.spyOn(slots, 'releaseBuildSlot').mockReturnValue(true);
    vi.spyOn(spawns, 'spawnDeclared').mockImplementation((_context, spawn) => spawn());
    setExecutor({
      runFileQuiet: (file) => (file === 'git' ? root : '27.0'),
      runFile: (file: string, args: string[]) => {
        if (file === 'plutil') {
          const path = args.at(-1)!;
          return path === join(root, 'Info.plist') ? JSON.stringify(plist) : readFileSync(path, 'utf8');
        }
        if (file === '/usr/libexec/PlistBuddy') {
          writeFileSync(args.at(-1)!, JSON.stringify({ CFBundleIdentifier: bundleId, CFBundleExecutable: 'Sample' }));
        }
        if (file === 'xcrun' && args[0] === 'actool')
          writeFileSync(join(args[args.indexOf('--compile') + 1]!, 'Assets.car'), 'compiled assets');
        if (file === 'otool') return '@executable_path/../Frameworks';
        return '';
      },
      spawn: (file, args, options) => {
        compilerCalls.push({ file, args, cwd: options?.cwd as string | undefined });
        swiftTmpdirs.push(options?.env?.TMPDIR);
        const child = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
        }) as unknown as ChildProcess;
        if (!args.includes('--show-bin-path')) {
          localBuilds++;
          previousDuringBuild.push(readFileSync(join(bundle, 'previous'), 'utf8'));
        }
        queueMicrotask(() => {
          (child.stdout as PassThrough).end(args.includes('--show-bin-path') ? bin : 'compiling');
          (child.stderr as PassThrough).end();
          child.emit('close', 0);
        });
        return child;
      },
    });
  });

  afterEach(() => {
    writer.close();
    resetExecutor();
    vi.restoreAllMocks();
  });

  const build = async (
    extras: {
      context?: StimContext;
      buildMachine?: string;
      resources?: unknown;
      assetCatalog?: unknown;
      displayName?: string;
      cache?: MacosArtifactRecipe['cache'];
      hostServerKey?: string;
    } = {},
  ) => {
    const selected = projectRegistry.selectMacos(root);
    if ('problem' in selected) throw new Error(selected.problem.message);
    const context = extras.context ?? testContext({ projectRoot: root, cwd: root });
    const recipe = await (
      await selected.load()
    ).prepare(context, {
      macos: {
        product: 'Sample',
        infoPlist: 'Info.plist',
        resources: extras.resources,
        assetCatalog: extras.assetCatalog,
      },
    });
    if (extras.cache) recipe.cache = extras.cache;
    return buildMacosBundle({
      context,
      root,
      recipe,
      bundle,
      bundleId,
      scratch: join(dir, 'scratch'),
      writer,
      note: () => {},
      record: buildRecord,
      buildMachine: extras.buildMachine ?? 'remote',
      hostServerKey: extras.hostServerKey,
      displayName: extras.displayName,
    });
  };
  function remoteBundle(valid = true): string {
    const fetched = join(dir, 'fetched', 'Sample.app');
    mkdirSync(join(fetched, 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(
      join(fetched, 'Contents', 'Info.plist'),
      JSON.stringify({ CFBundleIdentifier: valid ? bundleId : 'wrong.id', CFBundleExecutable: 'Sample' }),
    );
    writeFileSync(join(fetched, 'Contents', 'MacOS', 'Sample'), 'remote');
    return fetched;
  }

  describe.skipIf(process.platform !== 'darwin')('completed cache history', () => {
    test.each([
      ['build', 'local', 'local'],
      ['build', 'provider', 'remote'],
      ['launch', 'local', 'local'],
      ['launch', 'provider', 'remote'],
    ] as const)('%s retains a %s cache hit in build history', async (operation, tier, expected) => {
      writeConfigSetting({ scope: 'workspace', projectPath: root }, 'macos.product', 'Sample');
      writeConfigSetting({ scope: 'workspace', projectPath: root }, 'macos.infoPlist', 'Info.plist');
      const cached = remoteBundle();
      vi.spyOn(artifactCache, 'swiftpmArtifactCache').mockReturnValue({
        identity: async () => ({ hash: 'fingerprint', key: 'cache-key' }),
        has: async () => true,
        restore: async () => ({ bundle: cached, tier }),
        store: async () => {
          throw new Error('A hit must not be stored again');
        },
      });
      const executor = getExecutor();
      setExecutor({
        ...executor,
        runFile: (file, args, options) => {
          if (file === 'plutil' && args[0] === '-replace') {
            const path = args.at(-1) ?? '';
            const value = JSON.parse(readFileSync(path, 'utf8'));
            value[args[1] ?? ''] = args[3];
            writeFileSync(path, JSON.stringify(value));
            return '';
          }
          return executor.runFile(file, args, options);
        },
      });
      if (operation === 'launch') {
        setExecutor({
          ...getExecutor(),
          spawn: () => {
            throw new Error('Test stops before launching an app');
          },
        });
      }
      const outcome = await (
        operation === 'build'
          ? buildMacosOperation(testContext(), root, { remoteBuild: 'local' })
          : runMacos(testContext(), root, () => {}, undefined, 'local')
      ).then(
        () => 'built',
        (error: Error) => error.message,
      );
      expect(outcome).toBe(operation === 'build' ? 'built' : 'Test stops before launching an app');
      expect(localBuilds).toBe(0);
      expect(readBuildHistory(readWorkspaceState(root)).macos?.[0]).toMatchObject({
        result: 'succeeded',
        fingerprint: 'fingerprint',
        cacheKey: 'cache-key',
        cacheHit: expected,
        cacheSkipped: false,
      });
    });
  });

  test.skipIf(process.platform !== 'darwin')(
    'launches the app with the command environment and its own claim, and stimd records its output',
    async () => {
      writeConfigSetting({ scope: 'workspace', projectPath: root }, 'macos.product', 'Sample');
      writeConfigSetting({ scope: 'workspace', projectPath: root }, 'macos.infoPlist', 'Info.plist');
      writeConfigSetting({ scope: 'workspace', projectPath: root }, 'macos.arguments', [
        '-e',
        "console.log('env', process.env.STIM_BACKGROUND_LAUNCH, process.env.NSUnbufferedIO, process.env.STIM_TEST_CALLER);console.error('warned');setInterval(()=>{},1000)",
      ]);
      const cached = remoteBundle();
      copyFileSync(process.execPath, join(cached, 'Contents', 'MacOS', 'Sample'));
      chmodSync(join(cached, 'Contents', 'MacOS', 'Sample'), 0o755);
      vi.spyOn(artifactCache, 'swiftpmArtifactCache').mockReturnValue({
        identity: async () => ({ hash: 'fingerprint', key: 'cache-key' }),
        has: async () => true,
        restore: async () => ({ bundle: cached, tier: 'local' }),
        store: async () => {},
      });
      vi.stubEnv('STIM_TEST_CALLER', 'caller');
      vi.stubEnv('DYLD_LIBRARY_PATH', join(dirname(process.execPath), '..', 'lib'));
      const mocked = getExecutor();
      resetExecutor();
      const real = getExecutor();
      setExecutor({
        ...mocked,
        runFile: (file, args, options) => {
          if (file === 'plutil' && args[0] === '-replace') {
            const path = args.at(-1) ?? '';
            const value = JSON.parse(readFileSync(path, 'utf8'));
            value[args[1] ?? ''] = args[3];
            writeFileSync(path, JSON.stringify(value));
            return '';
          }
          return mocked.runFile(file, args, options);
        },
        runFileAsync: (file, args, options) =>
          file === 'lsappinfo'
            ? Promise.resolve('ASN:0x0-0x1:')
            : file === 'ps' || file === 'lsof'
              ? real.runFileAsync(file, args, options)
              : Promise.resolve().then(() => getExecutor().runFile(file, args, options)),
        spawn: (file, args, options) =>
          file === join(macosDir(root), 'Sample.app', 'Contents', 'MacOS', 'Sample')
            ? real.spawn(file, args, options)
            : mocked.spawn(file, args, options),
      });
      const streams = createOwnedStreams(() => {});
      vi.spyOn(stimdClient, 'observeOwned').mockImplementation((workspace) => streams.sync(workspace));
      vi.spyOn(stimdClient, 'drainOwnedMacos').mockImplementation((workspace) => streams.drain(workspace, true));
      let launched: MacosAppRecord | undefined;
      try {
        launched = await runMacos(testContext(), root, () => {}, undefined, 'local');
        const app = launched.app;
        if (!app) throw new Error('The launch recorded no app.');
        expect(launched.supervisor).toEqual(app);
        expect(inspectProcessIdentity(app)).toBe('same');
        expect(readMacosRecord(root)).toMatchObject({ app, supervisor: app });
        expect(readClaimSet(macosRuntimeClaim(root)).live.map((holder) => holder.owner.pid)).toEqual([app.pid]);
        const log = join(workspaceLogsDir(root), 'macos.ndjson');
        const recorded = async (msg: string) => {
          for (let tries = 0; tries < 100; tries++) {
            const lines = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
            const found = lines
              .map((line): Record<string, unknown> => JSON.parse(line))
              .find((entry) => entry.src === 'client' && entry.msg === msg);
            if (found) return found;
            await new Promise((done) => setTimeout(done, 50));
          }
          throw new Error(`macos.ndjson has no client record ${msg}`);
        };
        expect(await recorded('env 1 YES caller')).toMatchObject({ level: 'info' });
        expect(await recorded('warned')).toMatchObject({ level: 'warn' });
        await stopMacosApp(root);
        expect(inspectProcessIdentity(app)).not.toBe('same');
        expect(await recorded('Exited Sample.')).toMatchObject({ level: 'info' });
        expect(readClaimSet(macosRuntimeClaim(root)).live).toEqual([]);
      } finally {
        streams.close();
        const app = launched?.app;
        if (app && inspectProcessIdentity(app) === 'same') process.kill(app.pid, 'SIGKILL');
      }
    },
    30_000,
  );

  test.skipIf(process.platform !== 'darwin')(
    'a cancelled native run does not spawn after the final bundle probe',
    async () => {
      writeConfigSetting({ scope: 'workspace', projectPath: root }, 'macos.product', 'Sample');
      writeConfigSetting({ scope: 'workspace', projectPath: root }, 'macos.infoPlist', 'Info.plist');
      vi.spyOn(nativeBuild, 'buildMacosBundle').mockImplementation(
        async ({ bundle: targetBundle, bundleId: targetId }) => {
          mkdirSync(join(targetBundle, 'Contents', 'MacOS'), { recursive: true });
          writeFileSync(join(targetBundle, 'Contents', 'MacOS', 'Sample'), 'fixture');
          return { bundleId: targetId, offloadedTo: null, offloadFallback: null, handoff: null };
        },
      );
      const context = testContext();
      vi.spyOn(stopping, 'stopBundleInstances').mockImplementation(async () => {
        refuseDeclaredSpawns(context, 'native run cancelled');
        return false;
      });
      const spawn = vi.spyOn(owning, 'spawnOwned');
      await expect(runMacos(context, root, () => {}, undefined, 'local')).rejects.toThrow('native run cancelled');
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  test.skipIf(process.platform !== 'darwin')(
    'a cancelled native run drains an app returned by the spawn',
    async () => {
      writeConfigSetting({ scope: 'workspace', projectPath: root }, 'macos.product', 'Sample');
      writeConfigSetting({ scope: 'workspace', projectPath: root }, 'macos.infoPlist', 'Info.plist');
      vi.spyOn(nativeBuild, 'buildMacosBundle').mockImplementation(
        async ({ bundle: targetBundle, bundleId: targetId }) => {
          mkdirSync(join(targetBundle, 'Contents', 'MacOS'), { recursive: true });
          writeFileSync(join(targetBundle, 'Contents', 'MacOS', 'Sample'), 'fixture');
          return { bundleId: targetId, offloadedTo: null, offloadFallback: null, handoff: null };
        },
      );
      vi.spyOn(stopping, 'stopBundleInstances').mockResolvedValue(false);
      const context = testContext();
      const mocked = getExecutor();
      resetExecutor();
      const app = await ownedProcess();
      setExecutor(mocked);
      const owned = {
        pid: app.pid,
        processToken: app.processToken,
        claim: {
          root: 'fixture',
          path: 'fixture',
          claimId: 'fixture',
          mode: 'exclusive' as const,
          owner: app,
          startedAt: new Date().toISOString(),
          details: {},
          label: 'fixture',
        },
      };
      vi.spyOn(owning, 'spawnOwned').mockImplementation(async () => {
        refuseDeclaredSpawns(context, 'cancelled during spawn');
        return owned;
      });
      const stop = vi.spyOn(owning, 'stopOwnedProcess').mockResolvedValue(true);
      await expect(runMacos(context, root, () => {}, undefined, 'local')).rejects.toThrow('cancelled during spawn');
      expect(stop).toHaveBeenCalledWith(owned);
    },
    20_000,
  );

  test.skipIf(process.platform !== 'darwin')(
    'a cancelled native run drains an app when observer attachment finishes',
    async () => {
      writeConfigSetting({ scope: 'workspace', projectPath: root }, 'macos.product', 'Sample');
      writeConfigSetting({ scope: 'workspace', projectPath: root }, 'macos.infoPlist', 'Info.plist');
      vi.spyOn(nativeBuild, 'buildMacosBundle').mockImplementation(
        async ({ bundle: targetBundle, bundleId: targetId }) => {
          mkdirSync(join(targetBundle, 'Contents', 'MacOS'), { recursive: true });
          writeFileSync(join(targetBundle, 'Contents', 'MacOS', 'Sample'), 'fixture');
          return { bundleId: targetId, offloadedTo: null, offloadFallback: null, handoff: null };
        },
      );
      vi.spyOn(stopping, 'stopBundleInstances').mockResolvedValue(false);
      const context = testContext();
      const mocked = getExecutor();
      resetExecutor();
      const app = await ownedProcess();
      setExecutor(mocked);
      const owned = {
        pid: app.pid,
        processToken: app.processToken,
        claim: {
          root: 'fixture',
          path: 'fixture',
          claimId: 'fixture',
          mode: 'exclusive' as const,
          owner: app,
          startedAt: new Date().toISOString(),
          details: {},
          label: 'fixture',
        },
      };
      vi.spyOn(owning, 'spawnOwned').mockResolvedValue(owned);
      vi.spyOn(stimdClient, 'observeOwned').mockImplementation(async () => {
        refuseDeclaredSpawns(context, 'cancelled during observe');
        return null;
      });
      const childStop = vi.spyOn(stopping, 'stopMacosChildren').mockResolvedValue();
      const stop = vi.spyOn(owning, 'stopOwnedProcess').mockResolvedValue(true);
      await expect(runMacos(context, root, () => {}, undefined, 'local')).rejects.toThrow('cancelled during observe');
      expect(childStop).toHaveBeenCalledWith(owned);
      const stopOrder = stop.mock.invocationCallOrder[0];
      assert(stopOrder !== undefined);
      expect(childStop.mock.invocationCallOrder[0]).toBeLessThan(stopOrder);
      expect(stop).toHaveBeenCalledWith(owned);
    },
    20_000,
  );

  test.skipIf(process.platform !== 'darwin')(
    'a cancelled launch retains its app record and declared child when helper cleanup is unverified',
    async () => {
      writeConfigSetting({ scope: 'workspace', projectPath: root }, 'macos.product', 'Sample');
      writeConfigSetting({ scope: 'workspace', projectPath: root }, 'macos.infoPlist', 'Info.plist');
      vi.spyOn(nativeBuild, 'buildMacosBundle').mockImplementation(
        async ({ bundle: targetBundle, bundleId: targetId }) => {
          mkdirSync(join(targetBundle, 'Contents', 'MacOS'), { recursive: true });
          writeFileSync(join(targetBundle, 'Contents', 'MacOS', 'Sample'), 'fixture');
          return { bundleId: targetId, offloadedTo: null, offloadFallback: null, handoff: null };
        },
      );
      vi.spyOn(stopping, 'stopBundleInstances').mockResolvedValue(false);
      const context = testContext();
      const mocked = getExecutor();
      resetExecutor();
      const app = await ownedProcess();
      setExecutor(mocked);
      const owned = {
        pid: app.pid,
        processToken: app.processToken,
        claim: {
          root: 'fixture',
          path: 'fixture',
          claimId: 'fixture',
          mode: 'exclusive' as const,
          owner: app,
          startedAt: new Date().toISOString(),
          details: {},
          label: 'fixture',
        },
      };
      vi.spyOn(owning, 'spawnOwned').mockResolvedValue(owned);
      vi.spyOn(stimdClient, 'observeOwned').mockImplementation(async () => {
        refuseDeclaredSpawns(context, 'cancelled during observe');
        return null;
      });
      vi.spyOn(stopping, 'stopMacosChildren').mockRejectedValue(new Error('unverified child'));
      const stop = vi.spyOn(owning, 'stopOwnedProcess');
      let failure: unknown;
      try {
        failure = await runMacos(context, root, () => {}, undefined, 'local').catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(WorkspaceProcessCleanupError);
        assert(failure instanceof WorkspaceProcessCleanupError);
        expect(stop).not.toHaveBeenCalled();
        expect(readMacosRecord(root)?.app).toMatchObject({ pid: app.pid, processToken: app.processToken });
        expect(failure.claims.length).toBeGreaterThan(0);
        for (const claim of failure.claims) {
          const holder = readClaimSet(claim.root).live.find((entry) => entry.claimId === claim.claimId);
          expect(holder).toMatchObject({ childDeclared: true, child: null });
        }
      } finally {
        if (inspectProcessIdentity(app) === 'same') process.kill(app.pid, 'SIGKILL');
        await waitForProcessExit(app, 5000);
        if (failure instanceof WorkspaceProcessCleanupError) for (const claim of failure.claims) releaseClaim(claim);
      }
    },
    20_000,
  );

  test.skipIf(process.platform !== 'darwin')(
    'a registered app waiting for LaunchServices leaves spare admission available',
    async () => {
      const mocked = getExecutor();
      resetExecutor();
      const app = await ownedProcess();
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      writeConfigSetting({ scope: 'workspace', projectPath: root }, 'macos.product', 'Sample');
      writeConfigSetting({ scope: 'workspace', projectPath: root }, 'macos.infoPlist', 'Info.plist');
      writeConfigSetting({ scope: 'machine' }, 'concurrency.maxMacosApps', 2);
      vi.spyOn(nativeBuild, 'buildMacosBundle').mockImplementation(
        async ({ bundle: targetBundle, bundleId: targetId }) => {
          mkdirSync(workspaceLogsDir(root), { recursive: true });
          mkdirSync(join(targetBundle, 'Contents', 'MacOS'), { recursive: true });
          writeFileSync(join(targetBundle, 'Contents', 'MacOS', 'Sample'), 'fixture');
          return { bundleId: targetId, offloadedTo: null, offloadFallback: null, handoff: null };
        },
      );
      vi.spyOn(owning, 'spawnOwned').mockResolvedValue({
        pid: app.pid,
        processToken: app.processToken,
        claim: {
          root: macosRuntimeClaim(root),
          path: macosRuntimeClaim(root),
          claimId: 'fixture',
          mode: 'exclusive',
          owner: app,
          startedAt: new Date().toISOString(),
          details: {},
          label: 'macOS app',
        },
      });
      vi.spyOn(stimdClient, 'observeOwned').mockResolvedValue(null);
      setExecutor({
        ...mocked,
        runFileAsync: async (file, args, options) => {
          if (file !== 'lsappinfo') return mocked.runFile(file, args, options);
          enter();
          await gate;
          return 'ASN:0x0-0x1:';
        },
      });
      const pending = runMacos(testContext(), root, () => {}, undefined, 'local');
      try {
        await Promise.race([
          entered,
          pending.then(() => {
            throw new Error('The app returned before its LaunchServices lookup.');
          }),
        ]);
        const attempt = tryAcquireClaim({
          root: workspaceProcessLockPath(getConfigDir(), 'macos-admission', true),
          mode: 'exclusive',
          label: 'another workspace admission',
        });
        if (attempt.pending) releaseClaim(attempt.pending);
        if (attempt.acquired) releaseClaim(attempt.acquired);
        expect(attempt.acquired).toBeDefined();
        const other = join(dir, 'other');
        await expect(withLocalMacosAdmission(other, testContext(), async () => 'admitted')).resolves.toBe('admitted');
      } finally {
        release();
        await pending;
      }
      expect((await pending).app).toMatchObject({ pid: app.pid, processToken: app.processToken });
    },
  );

  it('inputs changed during compilation are installed without publishing a completed cache entry', async () => {
    const store = vi.fn<NonNullable<MacosArtifactRecipe['cache']>['store']>();
    let reads = 0;
    await build({
      buildMachine: 'local',
      cache: {
        identity: async () => ({ hash: reads++ === 0 ? 'before' : 'after', key: 'key' }),
        has: async () => false,
        restore: async () => null,
        store,
      },
    });
    expect(localBuilds).toBe(1);
    expect(readFileSync(join(bundle, 'Contents/MacOS/Sample'), 'utf8')).toBe('local');
    expect(store).not.toHaveBeenCalled();
    expect(buildRecord.cacheHit).toBe(false);
    expect(buildRecord.cacheKey).toBeUndefined();
  });

  it('an unresolved provider retains its active scratch files and refuses compilation', async () => {
    let activeFile = '';
    await expect(
      build({
        cache: {
          identity: async () => ({ hash: 'before', key: 'key' }),
          has: async () => false,
          restore: async (_key, directory) => {
            await fs.mkdir(directory, { recursive: true });
            activeFile = join(directory, 'active-download');
            writeFileSync(activeFile, 'provider still writing');
            throw Object.assign(new Error('Provider cleanup is unresolved'), {
              code: 'STIM_CLAIM_UNAVAILABLE',
              reportCleanup: true,
            });
          },
          store: async () => {},
        },
      }),
    ).rejects.toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE' });
    expect(readFileSync(activeFile, 'utf8')).toBe('provider still writing');
    expect(localBuilds).toBe(0);
    expect(slots.acquireBuildSlot).not.toHaveBeenCalled();
  });
  const handoff = {
    serverKey: 'KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKA',
    token: 'a'.repeat(64),
    sha256: 'b'.repeat(64),
  };
  function succeeds(path: string, cacheHit?: true): void {
    vi.spyOn(offload, 'offloadBuild').mockResolvedValue({
      ok: true,
      machine: 'mini',
      artifactPath: path,
      handoff,
      cacheHit,
    } as Extract<offload.OffloadOutcome, { ok: true }>);
  }

  test.skipIf(process.platform !== 'darwin')(
    'build-only replaces the previous bundle copy and leaves an existing app untouched',
    async () => {
      writeConfigSetting({ scope: 'workspace', projectPath: root }, 'macos.product', 'Sample');
      writeConfigSetting({ scope: 'workspace', projectPath: root }, 'macos.infoPlist', 'Info.plist');
      const previous = record();
      writeWorkspaceState(root, { macos: previous });
      const first = await buildMacosOperation(testContext(), root, { remoteBuild: 'local' });
      expect(parseWorkspaceLink(first.links.workspace)).toMatchObject({ platform: 'macos' });
      expect(first.build).toMatchObject({ state: 'ok', builtOn: 'here' });
      expect(readFileSync(first.executable, 'utf8')).toBe('local');
      expect(readWorkspaceState(root)?.macos).toEqual(previous);
      writeFileSync(join(bin, 'Sample'), 'edited');
      mkdirSync(join(workspaceDir(root), 'artifacts', 'ios-sibling'));
      const second = await buildMacosOperation(testContext(), root, { remoteBuild: 'local' });
      expect(readFileSync(second.executable, 'utf8')).toBe('edited');
      expect((await fs.readdir(join(workspaceDir(root), 'artifacts'))).toSorted()).toEqual(
        [basename(dirname(second.bundle)), 'ios-sibling'].toSorted(),
      );
      expect(readWorkspaceState(root)?.macos).toEqual(previous);
      expect(readWorkspaceState(root)).not.toHaveProperty('supervisor');
      expect(compilerCalls.every(({ file }) => file === 'swift')).toBe(true);
    },
  );

  it('promotes a verified offloaded bundle without taking a local build slot and persists placement', async () => {
    succeeds(remoteBundle());
    const store = vi.fn<NonNullable<MacosArtifactRecipe['cache']>['store']>();
    expect(
      await build({
        cache: {
          identity: async () => ({ hash: 'client-inputs', key: 'client-key' }),
          has: async () => false,
          restore: async () => null,
          store,
        },
      }),
    ).toEqual({ bundleId, offloadedTo: 'mini', offloadFallback: null, handoff });
    expect(slots.acquireBuildSlot).not.toHaveBeenCalled();
    expect(localBuilds).toBe(0);
    expect(readFileSync(join(bundle, 'Contents', 'MacOS', 'Sample'), 'utf8')).toBe('remote');
    expect(store).not.toHaveBeenCalled();
    expect(buildRecord.cacheKey).toBeUndefined();
    writeWorkspaceState(root, { macos: record({ build: { ...buildRecord, state: 'ok' } }) });
    expect(readMacosRecord(root)?.build.offloadedTo).toBe('mini');
  });

  describe('an app hosted on the Mac that builds it', () => {
    const nodeKey = 'NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNA';

    beforeEach(() => {
      vi.spyOn(machines, 'pairedMachines').mockReturnValue(
        machines.pairedMachines().map((each) => Object.assign({}, each, { serverKey: nodeKey })),
      );
      succeeds(remoteBundle());
    });

    it('checks a fetched peer artifact against the worker CPU instead of this Mac', async () => {
      const workerArch = process.arch === 'arm64' ? 'x64' : 'arm64';
      const architecture = workerArch === 'x64' ? 'x86_64' : 'arm64';
      const base = getExecutor();
      setExecutor({
        ...base,
        runFileAsync: async (file, args, options) => {
          if (file === 'xcrun' && args[0] === 'lipo') return architecture;
          if (file === 'xcrun' && args[0] === 'vtool') return 'platform MACOS';
          return base.runFileAsync(file, args, options);
        },
      });
      vi.mocked(offload.chooseBuildMachine).mockResolvedValue(
        Object.assign({}, choice, { offer: { capacity: {}, toolchain: { arch: workerArch } } }),
      );
      succeeds(remoteBundle(), true);
      await expect(build({ buildMachine: 'mini', hostServerKey: nodeKey })).resolves.toMatchObject({
        offloadedTo: 'mini',
      });
      succeeds(remoteBundle(), true);
      await expect(build({ buildMachine: 'mini' })).rejects.toThrow('does not match this platform and architecture');
    });
  });

  it('cancellation during fetched signature verification preserves the bundle without compiling locally', async () => {
    const controller = new AbortController();
    const context = testContext({ projectRoot: root, cwd: root, signal: controller.signal });
    const base = getExecutor();
    let verifying = false;
    let complete!: () => void;
    const gate = new Promise<void>((resolve) => {
      complete = resolve;
    });
    setExecutor({
      ...base,
      runFileAsync: async (file, args, options) => {
        if (file === 'codesign' && args[0] === '--verify') {
          verifying = true;
          await gate;
        }
        return base.runFileAsync(file, args, options);
      },
    });
    succeeds(remoteBundle());
    const operation = withAmbientContext(context, () => build({ context }));
    const observed = operation.catch((error) => {
      throw error;
    });
    observed.catch(() => {});
    try {
      await vi.waitFor(() => expect(verifying).toBe(true));
      controller.abort('SIGINT');
      complete();
      await expect(observed).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
      expect(readFileSync(join(bundle, 'previous'), 'utf8')).toBe('old');
      expect(localBuilds).toBe(0);
    } finally {
      complete();
      await observed.catch(() => {});
    }
  });

  it('automatic placement never falls back to Swift when local is excluded', async () => {
    writeConfigSetting({ scope: 'machine' }, 'remote.buildPoolDisabled', []);
    const config = loadConfig()!;
    config.remote = { ...config.remote, buildPoolDisabled: ['local'] };
    saveConfig(config);
    vi.mocked(offload.chooseBuildMachine).mockResolvedValue('mini: offline');
    await expect(build()).rejects.toMatchObject({ code: 'STIM_OFFLOAD_REFUSED' });
    expect(localBuilds).toBe(0);
    expect(slots.acquireBuildSlot).not.toHaveBeenCalled();
    expect(readFileSync(join(bundle, 'previous'), 'utf8')).toBe('old');
  });

  it.each(['no-machine', 'worker-failed', 'bad-bundle', 'verification-failed'])(
    'falls back after %s, retaining the previous bundle until local staging succeeds',
    async (failure) => {
      if (failure === 'no-machine') vi.mocked(offload.chooseBuildMachine).mockResolvedValue('no matching worker');
      if (failure === 'worker-failed')
        vi.spyOn(offload, 'offloadBuild').mockResolvedValue({ ok: false, machine: 'mini', reason: 'swift-failed' });
      if (failure === 'bad-bundle' || failure === 'verification-failed')
        succeeds(remoteBundle(failure !== 'bad-bundle'));
      if (failure === 'verification-failed') {
        const run = getExecutor().runFile;
        setExecutor({
          ...getExecutor(),
          runFile: (file: string, args: string[], opts: ExecOptions) => {
            if (file === 'codesign' && args.includes('--verify')) throw new Error('invalid signature');
            return run(file, args, opts);
          },
        });
      }
      const result = await build();
      expect(result.offloadedTo).toBeNull();
      expect(result.offloadFallback).toBeTypeOf('string');
      expect(localBuilds).toBe(1);
      expect(previousDuringBuild).toEqual(['old']);
      expect(slots.acquireBuildSlot).toHaveBeenCalledOnce();
      expect(readFileSync(join(bundle, 'Contents', 'MacOS', 'Sample'), 'utf8')).toBe('local');
      writeWorkspaceState(root, { macos: record({ build: { ...buildRecord, state: 'ok' } }) });
      expect(readMacosRecord(root)?.build.offloadFallback).toBe(result.offloadFallback);
      expect(readFileSync(writer.file, 'utf8')).toContain('offload_failed');
      expect(readFileSync(writer.file, 'utf8')).toContain('placement: here');
    },
  );

  it('a strict unpaired worker refuses before asking for an offer or running Swift', async () => {
    writeConfigSetting({ scope: 'machine' }, 'remote.machines', ['mini']);
    vi.mocked(machines.pairedMachines).mockReturnValue([]);
    await expect(build({ buildMachine: 'mini' })).rejects.toMatchObject({ code: 'STIM_OFFLOAD_REFUSED' });
    expect(offload.chooseBuildMachine).not.toHaveBeenCalled();
    expect(localBuilds).toBe(0);
    expect(slots.acquireBuildSlot).not.toHaveBeenCalled();
  });

  test.each(['invalid', 'not listed', 'not paired'])(
    'the macos setup refusal %s leaves the running app and its record untouched',
    async (reason) => {
      if (process.platform !== 'darwin') return;
      writeFileSync(join(root, 'Package.swift'), '// swift-tools-version:6.0\n');
      writeFileSync(
        join(root, '.stim.json'),
        JSON.stringify({ macos: { product: 'Sample', infoPlist: 'Info.plist' } }),
      );
      const previous = record();
      writeWorkspaceState(root, { macos: previous });
      const before = readMacosRecord(root);
      if (reason === 'not paired') {
        writeConfigSetting({ scope: 'machine' }, 'remote.machines', ['mini']);
        vi.mocked(machines.pairedMachines).mockReturnValue([]);
      }
      const stop = vi.spyOn(stopping, 'stopMacosAppHeld');
      await expect(
        runMacos(testContext(), root, () => {}, undefined, reason === 'invalid' ? '' : 'mini'),
      ).rejects.toMatchObject({
        code: reason === 'invalid' ? 'STIM_BAD_ARG' : 'STIM_OFFLOAD_REFUSED',
      });
      expect(readMacosRecord(root)).toEqual(before);
      expect(stop).not.toHaveBeenCalled();
      expect(offload.chooseBuildMachine).not.toHaveBeenCalled();
      expect(localBuilds).toBe(0);
      expect(slots.acquireBuildSlot).not.toHaveBeenCalled();
    },
  );
  test.each(['missing product', 'malformed settings', 'invalid plist', 'missing resource', 'full macOS capacity'])(
    'the selected SwiftPM operation refuses %s before stopping the previous app',
    async (reason) => {
      if (process.platform !== 'darwin') return;
      const macos = {
        product: reason === 'missing product' ? undefined : reason === 'malformed settings' ? 42 : 'Sample',
        infoPlist: 'Info.plist',
        ...(reason === 'missing resource' ? { resources: { 'icon.icns': 'missing' } } : {}),
      };
      writeFileSync(join(root, '.stim.json'), JSON.stringify({ macos }));
      if (reason === 'invalid plist') plist.SUFeedURL = 'feed';
      writeWorkspaceState(root, { macos: record() });
      if (reason === 'full macOS capacity') {
        const other = join(dir, 'other');
        mkdirSync(other);
        upsertProject(other, {});
        writeWorkspaceState(other, { macos: record({ app: macosProcess(process.pid) }) });
        writeConfigSetting({ scope: 'machine' }, 'concurrency.maxMacosApps', 1);
      }
      const before = readMacosRecord(root);
      const stop = vi.spyOn(stopping, 'stopMacosAppHeld');
      await expect(runMacos(testContext(), root, () => {})).rejects.toThrow(
        reason === 'missing product' || reason === 'malformed settings'
          ? 'macos.product'
          : reason === 'invalid plist'
            ? 'development Info.plist'
            : reason === 'full macOS capacity'
              ? 'concurrency.maxMacosApps is 1'
              : 'source does not exist',
      );
      expect(readMacosRecord(root)).toEqual(before);
      expect(stop).not.toHaveBeenCalled();
      expect(offload.chooseBuildMachine).not.toHaveBeenCalled();
      expect(slots.acquireBuildSlot).not.toHaveBeenCalled();
      expect(localBuilds).toBe(0);
    },
  );

  it('sends sources outside the package as repository-relative paths without parent segments', async () => {
    vi.spyOn(worktree, 'repoRootAsync').mockResolvedValue(dir);
    writeFileSync(join(dir, 'icon'), 'icon bytes');
    symlinkSync(join(dir, 'icon'), join(dir, 'icon-link'));
    mkdirSync(join(dir, 'Assets.xcassets'));
    const fetched = remoteBundle();
    mkdirSync(join(fetched, 'Contents', 'Resources'));
    writeFileSync(join(fetched, 'Contents', 'Resources', 'icon.icns'), 'icon bytes');
    writeFileSync(join(fetched, 'Contents', 'Resources', 'Assets.car'), 'compiled assets');
    succeeds(fetched);
    await build({ resources: { 'icon.icns': '../icon-link' }, assetCatalog: '../Assets.xcassets' });
    expect(offload.offloadBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          platform: 'macos',
          product: 'Sample',
          infoPlist: 'Info.plist',
          bundleId,
          resources: { 'icon.icns': 'icon' },
          assetCatalog: 'Assets.xcassets',
        },
      }),
    );
    expect(localBuilds).toBe(0);
  });

  it.each([
    { '../icon': 'icon' },
    { nested: 'icon', 'nested/icon': 'icon' },
    { icon: '../outside' },
    { icon: 'escape' },
    { icon: 'linked' },
  ])('refuses invalid resources before selecting a worker or compiling: %j', async (resources) => {
    writeFileSync(join(root, 'icon'), 'icon');
    writeFileSync(join(dir, 'outside'), 'outside');
    symlinkSync(join(dir, 'outside'), join(root, 'escape'));
    mkdirSync(join(root, 'linked'));
    symlinkSync(join(dir, 'outside'), join(root, 'linked', 'inner'));
    await expect(build({ resources })).rejects.toThrow(/macos.resources.*entry.*stim guide macos/);
    expect(offload.chooseBuildMachine).not.toHaveBeenCalled();
    expect(localBuilds).toBe(0);
  });

  it('drains a cancelled resource copy before cleanup and preserves the previous bundle', async () => {
    mkdirSync(join(root, 'branding'));
    writeFileSync(join(root, 'branding', 'wordmark.svg'), 'wordmark bytes');
    const controller = new AbortController();
    const context = testContext({ projectRoot: root, cwd: root, signal: controller.signal });
    const copy = fs.cp;
    let signalCopied!: () => void;
    const copied = new Promise<void>((resolve) => {
      signalCopied = resolve;
    });
    let stagedResource = '';
    let complete!: () => void;
    const gate = new Promise<void>((resolve) => {
      complete = resolve;
    });
    vi.spyOn(fs, 'cp').mockImplementation(async (source, target, options) => {
      await copy(source, target, options);
      if (source === join(root, 'branding')) {
        stagedResource = join(String(target), 'wordmark.svg');
        signalCopied();
        await gate;
      }
    });
    let settled = false;
    const operation = withAmbientContext(context, () =>
      build({ context, buildMachine: 'local', resources: { branding: 'branding' } }),
    );
    const observed = operation.finally(() => {
      settled = true;
    });
    observed.catch(() => {});
    try {
      await Promise.race([copied, observed]);
      controller.abort('SIGINT');
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(readFileSync(stagedResource, 'utf8')).toBe('wordmark bytes');
      complete();
      await expect(observed).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
      expect(readFileSync(join(bundle, 'previous'), 'utf8')).toBe('old');
      expect(existsSync(stagedResource)).toBe(false);
      expect(slots.releaseBuildSlot).toHaveBeenCalledOnce();
    } finally {
      complete();
      await observed.catch(() => {});
      vi.restoreAllMocks();
    }
  });
});

describe('macOS resource staging', () => {
  let bin: string;
  let bundle: string;
  let calls: Array<[string, string[]]>;
  let sealed: string[];
  beforeEach(() => {
    vi.spyOn(worktree, 'repoRootAsync').mockResolvedValue(root);
    bin = join(root, 'bin');
    bundle = join(dir, 'Sample.app');
    mkdirSync(bin);
    writeFileSync(join(bin, 'Sample'), 'executable');
    mkdirSync(join(bin, 'Sample_Resources.bundle'));
    writeFileSync(join(bin, 'Sample_Resources.bundle', 'swiftpm'), 'swiftpm resource');
    writeFileSync(join(root, 'Info.plist'), '{}');
    writeFileSync(join(root, 'icon'), 'icon bytes');
    mkdirSync(join(root, 'branding'));
    writeFileSync(join(root, 'branding', 'wordmark.svg'), 'wordmark bytes');
    mkdirSync(join(root, 'Assets.xcassets'));
    calls = [];
    sealed = [];
    setExecutor({
      runFile: (file, args) => {
        calls.push([file, args]);
        if (file === 'xcrun')
          writeFileSync(join(args[args.indexOf('--compile') + 1]!, 'Assets.car'), 'compiled assets');
        if (file === 'codesign' && args.at(-1) === bundle)
          sealed = ['AppIcon.icns', 'nested/branding/wordmark.svg', 'Assets.car'].filter((name) =>
            existsSync(join(bundle, 'Contents', 'Resources', name)),
          );
        if (file === 'plutil')
          return JSON.stringify({
            CFBundleIdentifier: 'dev.sample',
            CFBundleExecutable: 'Sample',
            LSMinimumSystemVersion: '14.0',
          });
        if (file === 'otool') return '@executable_path/../Frameworks';
        return 'tool output';
      },
    });
  });
  afterEach(() => {
    resetExecutor();
  });

  it('seals renamed files, directory contents and the compiled catalog in the final signature', async () => {
    const extras = resolveBundleExtras(
      root,
      root,
      { 'AppIcon.icns': 'icon', 'nested/branding': 'branding' },
      'Assets.xcassets',
    );
    await stageBundle(
      testContext({ projectRoot: root, cwd: root }),
      root,
      'Sample',
      'Info.plist',
      bin,
      bundle,
      'dev.sample.stim.test',
      extras,
    );
    expect(readFileSync(join(bundle, 'Contents', 'Resources', 'AppIcon.icns'), 'utf8')).toBe('icon bytes');
    expect(readFileSync(join(bundle, 'Contents', 'Resources', 'nested', 'branding', 'wordmark.svg'), 'utf8')).toBe(
      'wordmark bytes',
    );
    expect(readFileSync(join(bundle, 'Contents', 'Resources', 'Sample_Resources.bundle', 'swiftpm'), 'utf8')).toBe(
      'swiftpm resource',
    );
    expect(calls).toContainEqual([
      'xcrun',
      [
        'actool',
        join(root, 'Assets.xcassets'),
        '--compile',
        join(bundle, 'Contents', 'Resources'),
        '--platform',
        'macosx',
        '--minimum-deployment-target',
        '14.0',
        '--output-partial-info-plist',
        '/dev/null',
      ],
    ]);
    expect(calls.at(-1)).toEqual(['codesign', ['--force', '--sign', '-', bundle]]);
    expect(sealed).toEqual(['AppIcon.icns', 'nested/branding/wordmark.svg', 'Assets.car']);
  });

  it('refuses an actool success with no compiled catalog instead of signing an incomplete app', async () => {
    setExecutor({
      runFile: (file, args) => {
        calls.push([file, args]);
        return file === 'plutil'
          ? JSON.stringify({ CFBundleIdentifier: 'dev.sample', CFBundleExecutable: 'Sample' })
          : '';
      },
    });
    await expect(
      stageBundle(
        testContext({ projectRoot: root, cwd: root }),
        root,
        'Sample',
        'Info.plist',
        bin,
        bundle,
        'dev.sample.stim.test',
        resolveBundleExtras(root, root, {}, 'Assets.xcassets'),
      ),
    ).rejects.toThrow('actool did not produce Assets.car');
    expect(calls.filter(([file]) => file === 'codesign')).toEqual([]);
  });

  it('refuses a symlinked Info.plist before any plist is read or rewritten', async () => {
    const outside = join(dir, 'outside.plist');
    writeFileSync(outside, 'outside');
    symlinkSync(outside, join(root, 'Linked.plist'));
    await expect(
      stageBundle(
        testContext({ projectRoot: root, cwd: root }),
        root,
        'Sample',
        'Linked.plist',
        bin,
        bundle,
        'dev.sample.stim.test',
      ),
    ).rejects.toThrow(/macos.infoPlist.*stim guide macos/);
    expect(calls).toEqual([]);
    expect(existsSync(bundle)).toBe(false);
    expect(readFileSync(outside, 'utf8')).toBe('outside');
  });

  it('refuses an Info.plist reached through a symlinked directory that leaves the project', async () => {
    mkdirSync(join(dir, 'elsewhere'));
    writeFileSync(join(dir, 'elsewhere', 'Info.plist'), '{}');
    symlinkSync(join(dir, 'elsewhere'), join(root, 'config'));
    await expect(
      stageBundle(
        testContext({ projectRoot: root, cwd: root }),
        root,
        'Sample',
        'config/Info.plist',
        bin,
        bundle,
        'dev.sample.stim.test',
      ),
    ).rejects.toThrow(/macos.infoPlist/);
    expect(calls).toEqual([]);
  });
});

test.skipIf(process.platform !== 'darwin')(
  'macos launch output reports workspace agent-device state for local and hosted apps',
  async () => {
    writeFileSync(join(root, 'Package.swift'), '// swift-tools-version:6.0\n');
    writeFileSync(join(root, '.stim.json'), JSON.stringify({ macos: { product: 'Sample', infoPlist: 'Info.plist' } }));
    writeFileSync(join(root, 'Info.plist'), '{}');
    setExecutor({
      runFileQuiet: () => null,
      runFile: (file) =>
        file === 'git' ? '' : JSON.stringify({ CFBundleIdentifier: 'dev.sample', CFBundleExecutable: 'Sample' }),
    });
    const launch = vi.spyOn(nativeRun, 'withNativeBuildRun');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      for (const hosted of [false, true]) {
        const app = record(
          hosted
            ? {
                host: {
                  machine: 'mini',
                  session: '12345678-1234-1234-1234-123456789abc',
                  appSlot: 3,
                  appAttempt: 'attempt',
                  bundleId: 'dev.sample.hosted3',
                  agent: { driver: 'none', setting: 'hosting.agentDriver' },
                },
              }
            : {},
        );
        launch.mockResolvedValue(app);
        stdout.mockClear();
        const program = new Command();
        macosCommand(program);
        await program.parseAsync(['node', 'stim', 'macos', '--json', ...(hosted ? ['--remote', 'mini'] : [])]);
        expect(stdout).toHaveBeenCalledOnce();
        const payload = JSON.parse(stdout.mock.calls[0]![0]);
        expect(payload.agentDevice).toEqual({ stateDir: workspaceAgentDeviceDir(root) });
        expect(payload.platform).toBe('macos');
        expect(payload.host).toEqual(app.host);
        expect(payload.product).toBe('Sample');
        expect(existsSync(workspaceAgentDeviceDir(root))).toBe(false);
        stdout.mockClear();
        const plain = new Command();
        macosCommand(plain);
        await plain.parseAsync(['node', 'stim', 'macos']);
        expect(stdout).toHaveBeenCalledWith(
          expect.stringContaining(`AGENT_DEVICE_STATE_DIR=${workspaceAgentDeviceDir(root)}`),
        );
      }
    } finally {
      launch.mockRestore();
      cwd.mockRestore();
      stdout.mockRestore();
    }
  },
);

describe.skipIf(process.platform !== 'darwin')('read-only macOS plans', () => {
  beforeEach(() => {
    writeFileSync(join(root, 'Package.swift'), '// swift-tools-version:6.0\n');
    writeFileSync(join(root, 'Info.plist'), '{}');
    writeFileSync(join(root, '.stim.json'), JSON.stringify({ macos: { product: 'Sample', infoPlist: 'Info.plist' } }));
    setExecutor({
      runFileQuiet: () => null,
      runFile: (file) => {
        if (file !== 'plutil') throw new Error(`Plan tried to run ${file}`);
        return JSON.stringify({ CFBundleIdentifier: 'dev.sample', CFBundleExecutable: 'Sample' });
      },
      spawn: () => {
        throw new Error('Plan tried to spawn a build or app');
      },
    });
  });
  afterEach(() => resetExecutor());

  it('validates packaging without creating state, acquiring build slots or contacting workers', async () => {
    const slot = vi.spyOn(slots, 'acquireBuildSlot');
    const worker = vi.spyOn(offload, 'chooseBuildMachine');
    const plan = await planMacos(testContext({ projectRoot: root, cwd: root }), root, 'local');
    expect(plan).toMatchObject({
      platform: 'macos',
      product: 'Sample',
      buildMachine: 'local',
      fingerprint: null,
      cacheHit: false,
      outcome: null,
      expectedMs: null,
    });
    expect(existsSync(process.env.STIM_HOME!)).toBe(false);
    expect(slot).not.toHaveBeenCalled();
    expect(worker).not.toHaveBeenCalled();
  });

  it('propagates cache ownership refusals instead of planning a cache miss', async () => {
    const refusal = Object.assign(new Error('Cache validation cleanup is unresolved'), {
      code: 'STIM_CLAIM_UNAVAILABLE',
      reportCleanup: true,
    });
    const cache = vi.spyOn(artifactCache, 'swiftpmArtifactCache').mockReturnValue({
      identity: async () => ({ hash: 'fingerprint', key: 'key' }),
      has: async () => {
        throw refusal;
      },
      restore: async () => null,
      store: async () => {},
    });
    try {
      await expect(planMacos(testContext({ projectRoot: root, cwd: root }), root, 'local')).rejects.toBe(refusal);
    } finally {
      cache.mockRestore();
    }
  });

  it('refuses a missing declared resource and an unconfigured named build machine', async () => {
    writeFileSync(
      join(root, '.stim.json'),
      JSON.stringify({
        macos: { product: 'Sample', infoPlist: 'Info.plist', resources: { 'icon.icns': 'missing' } },
      }),
    );
    await expect(planMacos(testContext({ projectRoot: root, cwd: root }), root, 'local')).rejects.toThrow(
      'source does not exist',
    );
    await expect(planMacos(testContext({ projectRoot: root, cwd: root }), root, 'missing-mini')).rejects.toThrow(
      'not listed in remote.machines',
    );
    expect(existsSync(process.env.STIM_HOME!)).toBe(false);
  });

  it('prints exactly one JSON plan or typed refusal without launching', async () => {
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const previousExit = process.exitCode;
    try {
      const program = new Command();
      macosCommand(program);
      await program.parseAsync(['macos', '--plan', '--json', '--remote-build', 'local'], { from: 'user' });
      expect(stdout).toHaveBeenCalledTimes(1);
      expect(JSON.parse(stdout.mock.calls[0]![0])).toMatchObject({ platform: 'macos', buildMachine: 'local' });
      stdout.mockClear();
      await program.parseAsync(['macos', '--plan', '--json', '--remote', 'mini'], { from: 'user' });
      expect(stdout).toHaveBeenCalledTimes(1);
      expect(JSON.parse(stdout.mock.calls[0]![0])).toMatchObject({
        code: 'STIM_BAD_ARG',
        message: expect.stringContaining('--remote'),
      });
      expect(process.exitCode).toBe(1);
      expect(existsSync(process.env.STIM_HOME!)).toBe(false);
      cwd.mockReturnValue(dir);
      stdout.mockClear();
      await program.parseAsync(['macos', '--plan', '--json'], { from: 'user' });
      expect(stdout).toHaveBeenCalledTimes(1);
      expect(JSON.parse(stdout.mock.calls[0]![0])).toMatchObject({
        code: 'STIM_BAD_ARG',
        message: 'Run stim macos from the Swift Package directory.',
      });
      stdout.mockClear();
      await expect(program.parseAsync(['macos'], { from: 'user' })).rejects.toThrow(
        'Run stim macos from the Swift Package directory.',
      );
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      process.exitCode = previousExit;
      cwd.mockRestore();
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});

describe('waitForLaunchServices', () => {
  afterEach(() => resetExecutor());

  test('returns once lsappinfo lists the recorded pid for the bundle', async () => {
    const calls: string[][] = [];
    let listed = false;
    setExecutor({
      runFileAsync: async (_file: string, args: string[]) => {
        calls.push(args);
        const out = listed ? 'ASN:0x0-0x1:' : '';
        listed = true;
        return out;
      },
    });
    const app = { pid: 4242, processToken: 't', startedAtMicros: 1 };
    await expect(waitForLaunchServices(record({ app }), Date.now() + 5_000)).resolves.toBe('listed');
    expect(calls).toEqual([
      ['find', 'bundleid=dev.sample.stim.test', 'pid=4242'],
      ['find', 'bundleid=dev.sample.stim.test', 'pid=4242'],
    ]);
  });

  test('skips a hosted launch, which has no local pid', async () => {
    const runFileAsync = vi.fn<() => Promise<string>>();
    setExecutor({ runFileAsync });
    const host = {
      machine: 'mini',
      session: '12345678-1234-1234-1234-123456789abc',
      appSlot: 3,
      appAttempt: 'attempt',
      bundleId: 'dev.sample.hosted3',
      agent: { driver: 'none' as const, setting: 'hosting.agentDriver' as const },
    };
    await expect(waitForLaunchServices(record({ host }), Date.now() + 5_000)).resolves.toBe('skipped');
    expect(runFileAsync).not.toHaveBeenCalled();
  });
});
