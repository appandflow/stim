import { writeConfigSetting, loadConfig, saveConfig } from '../workspace/config.ts';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import {
  constants,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  macosAppState,
  parseMacosRecord,
  readMacosRecord,
  type MacosAppRecord,
  type MacosProcess,
} from '@stim-cli/core/state';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { resolveBundleExtras, stageBundle } from '../macos/stage.ts';
import * as worktree from '../workspace/worktree.ts';
import * as stopping from '../macos/stop.ts';
import { buildMacosBundle } from '../macos/build.ts';
import { projectRegistry } from '../integrations/projects.ts';
import { planMacos } from '../macos/plan.ts';
import { createNdjsonWriter } from '../ndjson.ts';
import * as offload from '../offload/client.ts';
import * as machines from '../offload/build-machines.ts';
import * as slots from '../engine/build-slots.ts';
import * as spawns from '../engine/spawn-claims.ts';
import { markClaimChildPending, releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import { macosDir, macosRuntimeClaim, requiredMacosRecord } from '../macos/state.ts';
import { bundleCandidates, lsofNamesBundleExecutable } from '../macos/instances.ts';
import { reclaimProject } from '../devices/reclaim.ts';
import macosCommand, { runMacos } from '../commands/macos.ts';
import { Command } from 'commander';
import * as nativeRun from '../engine/native-run.ts';
import { workspaceAgentDeviceDir } from '../workspace/paths.ts';
import { runStop } from '../commands/stop.ts';
import { stopMacosApp } from '../macos/stop.ts';
import { captureProcessToken, inspectProcessIdentity, waitForProcessExit } from '../process-identity.ts';
import { findCommandWorkspace, findProjectRoot } from '../workspace/project.ts';
import { writeWorkspaceState } from '../workspace/workspace-state.ts';
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

test('a Swift package inside a monorepo keeps its own command workspace', () => {
  writeFileSync(join(dir, 'package.json'), '{"name":"monorepo"}');
  writeFileSync(join(root, 'Package.swift'), '// swift-tools-version:6.0\n');
  const nested = join(root, 'Sources');
  mkdirSync(nested);
  expect(findProjectRoot(nested)).toBe(root);
  expect(findCommandWorkspace(nested)).toBe(root);
});

test.skipIf(process.platform !== 'darwin')(
  'missing macOS settings are a bad argument with a named remedy',
  async () => {
    writeFileSync(join(root, 'Package.swift'), '// swift-tools-version:6.0\n');
    await expect(runMacos(root)).rejects.toMatchObject({
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

test('stop refuses an unverifiable owner without touching a live unrelated process', async () => {
  const bystander = await ownedProcess();
  writeWorkspaceState(root, { macos: record({ app: { ...bystander, processToken: 'invalid' } }) });
  await expect(stopMacosApp(root)).rejects.toThrow('Cannot verify macOS owner');
  expect(inspectProcessIdentity(bystander)).toBe('same');
  expect(readMacosRecord(root)?.app?.processToken).toBe('invalid');
});

test('stop terminates only the recorded app and keeps another app alive', async () => {
  const app = await ownedProcess();
  const bystander = await ownedProcess();
  writeWorkspaceState(root, { macos: record({ app }) });
  expect(macosAppState(readMacosRecord(root))?.state).toBe('orphaned');
  expect(await stopMacosApp(root)).toBe(true);
  expect(await waitForProcessExit(app, 1000)).toBe(true);
  expect(inspectProcessIdentity(bystander)).toBe('same');
  expect(macosAppState(readMacosRecord(root))?.state).toBe('stopped');
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

test('bundle instances are the executables of app bundles directly in the workspace macos directory', () => {
  const dirs = ['/home/workspaces/app--1/macos', '/private/home/workspaces/app--1/macos'];
  const ps = [
    '  101 /home/workspaces/app--1/macos/Sample.app/Contents/MacOS/Sample',
    '  102 /private/home/workspaces/app--1/macos/My App.app/Contents/MacOS/My App',
    '  103 /home/workspaces/app--2/macos/Sample.app/Contents/MacOS/Sample',
    '  104 /home/workspaces/app--1/macos/build/debug/Sample',
    '  105 /home/workspaces/app--1/macos/Sample.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper',
    '  106 /home/workspaces/app--1/mac',
    '  107 /Applications/Sample.app/Contents/MacOS/Sample',
  ].join('\n');
  expect(bundleCandidates(ps, dirs)).toEqual([101, 102]);
  const lsof = (executable: string) => `p101\nftxt\nn${executable}\nftxt\nn/usr/lib/dyld\n`;
  expect(lsofNamesBundleExecutable(lsof(`${dirs[1]}/Sample.app/Contents/MacOS/Sample`), dirs)).toBe(true);
  expect(lsofNamesBundleExecutable(lsof('/bin/sleep'), dirs)).toBe(false);
});

describe.skipIf(process.platform !== 'darwin')('unrecorded copies of the owned bundle', () => {
  function bundleCopy(script: string): ChildProcess {
    const executable = join(macosDir(root), 'Sample.app', 'Contents', 'MacOS', 'Sample');
    mkdirSync(join(executable, '..'), { recursive: true });
    if (!existsSync(executable)) copyFileSync(process.execPath, executable, constants.COPYFILE_FICLONE);
    const child = getExecutor().spawn(executable, ['-e', `${script}; setInterval(() => {}, 1000)`], {
      stdio: 'ignore',
    });
    children.push(child);
    return child;
  }

  async function started(child: ChildProcess): Promise<MacosProcess> {
    await new Promise<void>((done, reject) => {
      child.once('spawn', done);
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

describe('macOS build placement and promotion', () => {
  let bundle: string;
  let bin: string;
  let writer: ReturnType<typeof createNdjsonWriter>;
  let localBuilds: number;
  let previousDuringBuild: string[];
  let compilerCalls: Array<{ file: string; args: string[]; cwd: string | undefined }>;
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
    plist = { CFBundleIdentifier: 'dev.sample', CFBundleExecutable: 'Sample' };
    buildRecord = { state: 'running', startedAt: new Date().toISOString() };
    writeConfigSetting({ scope: 'machine' }, 'remote.buildMode', 'force');
    vi.spyOn(machines, 'pairedMachines').mockReturnValue([
      { machine: 'mini' } as ReturnType<typeof machines.pairedMachines>[number],
    ]);
    vi.spyOn(offload, 'chooseBuildMachine').mockResolvedValue(choice);
    vi.spyOn(offload, 'closeOffload').mockImplementation(() => {});
    vi.spyOn(slots, 'acquireBuildSlot').mockResolvedValue({ unlimited: true });
    vi.spyOn(slots, 'releaseBuildSlot').mockReturnValue(true);
    vi.spyOn(spawns, 'spawnDeclared').mockImplementation((spawn) => spawn());
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
    extras: { buildMachine?: string; resources?: unknown; assetCatalog?: unknown; displayName?: string } = {},
  ) => {
    const selected = projectRegistry.selectMacos(root);
    if ('problem' in selected) throw new Error(selected.problem.message);
    const recipe = (await selected.load()).prepare({
      macos: {
        product: 'Sample',
        infoPlist: 'Info.plist',
        resources: extras.resources,
        assetCatalog: extras.assetCatalog,
      },
    });
    return buildMacosBundle({
      root,
      recipe,
      bundle,
      bundleId,
      scratch: join(dir, 'scratch'),
      writer,
      note: () => {},
      record: buildRecord,
      buildMachine: extras.buildMachine ?? 'auto',
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
  const handoff = { nodeId: 'nMini', token: 'a'.repeat(64), sha256: 'b'.repeat(64) };
  function succeeds(path: string): void {
    vi.spyOn(offload, 'offloadBuild').mockResolvedValue({
      ok: true,
      machine: 'mini',
      artifactPath: path,
      handoff,
    } as Extract<offload.OffloadOutcome, { ok: true }>);
  }

  it('promotes a verified offloaded bundle without taking a local build slot and persists placement', async () => {
    succeeds(remoteBundle());
    expect(await build()).toEqual({ bundleId, offloadedTo: 'mini', offloadFallback: null, handoff });
    expect(slots.acquireBuildSlot).not.toHaveBeenCalled();
    expect(localBuilds).toBe(0);
    expect(readFileSync(join(bundle, 'Contents', 'MacOS', 'Sample'), 'utf8')).toBe('remote');
    writeWorkspaceState(root, { macos: record({ build: { ...buildRecord, state: 'ok' } }) });
    expect(readMacosRecord(root)?.build.offloadedTo).toBe('mini');
  });

  it('names an offloaded bundle and re-signs it before verifying', async () => {
    const calls: Array<[string, string[]]> = [];
    const base = getExecutor();
    setExecutor({
      ...base,
      runFile: (file: string, args: string[]) => {
        calls.push([file, args]);
        return base.runFile(file, args);
      },
    });
    const fetched = remoteBundle();
    succeeds(fetched);
    await build({ displayName: 'Sample \u00b7 wt' });
    const infoPlist = join(fetched, 'Contents', 'Info.plist');
    const order = calls.map(([file, args]) => `${file} ${args[0]}`);
    expect(calls).toContainEqual([
      'plutil',
      ['-replace', 'CFBundleDisplayName', '-string', 'Sample \u00b7 wt', infoPlist],
    ]);
    expect(calls).toContainEqual(['plutil', ['-replace', 'CFBundleName', '-string', 'Sample \u00b7 wt', infoPlist]]);
    expect(order.indexOf('codesign --force')).toBeGreaterThan(order.lastIndexOf('plutil -replace'));
    expect(order.indexOf('codesign --verify')).toBeGreaterThan(order.indexOf('codesign --force'));
  });

  it('automatic placement never falls back to Swift when local is excluded', async () => {
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
          runFile: (file: string, args: string[]) => {
            if (file === 'codesign' && args.includes('--verify')) throw new Error('invalid signature');
            return run(file, args);
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

  it.each(['unreachable', 'approval-pending', 'forbidden', 'incompatible', 'busy', 'disk too low'])(
    'a named worker refusal %s starts no Swift compiler or local slot',
    async (reason) => {
      writeConfigSetting({ scope: 'machine' }, 'remote.machines', ['mini', 'other']);
      vi.mocked(offload.chooseBuildMachine).mockResolvedValue(`mini: ${reason}`);
      writeConfigSetting({ scope: 'machine' }, 'remote.buildMode', 'off');
      await expect(build({ buildMachine: 'mini' })).rejects.toMatchObject({
        code: 'STIM_OFFLOAD_REFUSED',
        message: expect.stringContaining(reason),
      });
      expect(localBuilds).toBe(0);
      expect(slots.acquireBuildSlot).not.toHaveBeenCalled();
      expect(buildRecord).toMatchObject({ buildMachine: 'mini' });
      expect(buildRecord.builtOn).toBeUndefined();
      expect(offload.chooseBuildMachine).toHaveBeenCalledWith(
        expect.objectContaining({ selected: 'mini', machines: [expect.objectContaining({ machine: 'mini' })] }),
      );
    },
  );

  it.each(['swift-failed', 'sync failed', 'start: busy', 'fetch: digest mismatch'])(
    'a failed strict remote build %s never starts swift locally',
    async (reason) => {
      writeConfigSetting({ scope: 'machine' }, 'remote.machines', ['mini']);
      vi.spyOn(offload, 'offloadBuild').mockResolvedValue({ ok: false, machine: 'mini', reason });
      await expect(build({ buildMachine: 'mini' })).rejects.toMatchObject({
        code: 'STIM_OFFLOAD_REFUSED',
        message: expect.stringContaining(reason),
      });
      expect(localBuilds).toBe(0);
      expect(slots.acquireBuildSlot).not.toHaveBeenCalled();
      expect(readFileSync(join(bundle, 'previous'), 'utf8')).toBe('old');
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

  it('local overrides force placement and persists actual compilation', async () => {
    await build({ buildMachine: 'local' });
    expect(offload.chooseBuildMachine).not.toHaveBeenCalled();
    expect(localBuilds).toBe(1);
    expect(buildRecord).toMatchObject({ buildMachine: 'local', builtOn: 'here' });
    expect(compilerCalls).toEqual([
      {
        file: 'swift',
        args: ['build', '-c', 'debug', '--product', 'Sample', '--scratch-path', join(dir, 'scratch'), '--jobs', '2'],
        cwd: root,
      },
      {
        file: 'swift',
        args: ['build', '-c', 'debug', '--scratch-path', join(dir, 'scratch'), '--show-bin-path'],
        cwd: root,
      },
    ]);
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
      await expect(runMacos(root, () => {}, undefined, reason === 'invalid' ? '' : 'mini')).rejects.toMatchObject({
        code: reason === 'invalid' ? 'STIM_BAD_ARG' : 'STIM_OFFLOAD_REFUSED',
      });
      expect(readMacosRecord(root)).toEqual(before);
      expect(stop).not.toHaveBeenCalled();
      expect(offload.chooseBuildMachine).not.toHaveBeenCalled();
      expect(localBuilds).toBe(0);
      expect(slots.acquireBuildSlot).not.toHaveBeenCalled();
    },
  );
  test.each(['missing product', 'malformed settings', 'invalid plist', 'missing resource'])(
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
      const before = readMacosRecord(root);
      const stop = vi.spyOn(stopping, 'stopMacosAppHeld');
      await expect(runMacos(root, () => {})).rejects.toThrow(
        reason === 'missing product' || reason === 'malformed settings'
          ? 'macos.product'
          : reason === 'invalid plist'
            ? 'development Info.plist'
            : 'source does not exist',
      );
      expect(readMacosRecord(root)).toEqual(before);
      expect(stop).not.toHaveBeenCalled();
      expect(offload.chooseBuildMachine).not.toHaveBeenCalled();
      expect(slots.acquireBuildSlot).not.toHaveBeenCalled();
      expect(localBuilds).toBe(0);
    },
  );

  it.each(['icon.icns', 'Assets.car'])('falls back when an older worker omits declared %s', async (missing) => {
    writeFileSync(join(root, 'icon'), 'icon bytes');
    mkdirSync(join(root, 'Assets.xcassets'));
    succeeds(remoteBundle());
    const result = await build(
      missing === 'Assets.car' ? { assetCatalog: 'Assets.xcassets' } : { resources: { 'icon.icns': 'icon' } },
    );
    expect(result.offloadedTo).toBeNull();
    expect(result.offloadFallback).toContain(missing);
    expect(localBuilds).toBe(1);
    const copied =
      missing === 'Assets.car' ? null : readFileSync(join(bundle, 'Contents', 'Resources', missing), 'utf8');
    expect(copied).toBe(missing === 'Assets.car' ? null : 'icon bytes');
  });

  it('sends sources outside the package as repository-relative paths without parent segments', async () => {
    vi.spyOn(worktree, 'repoRoot').mockReturnValue(dir);
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
    { '': 'icon' },
    { 'nested//icon': 'icon' },
    { 'nested/./icon': 'icon' },
    { 'nested/../icon': 'icon' },
    { ['a'.repeat(1025)]: 'icon' },
    { ['bad\0icon']: 'icon' },
    { '../icon': 'icon' },
    { '/icon': 'icon' },
    { nested: 'icon', 'nested/icon': 'icon' },
    { ICON: 'icon', icon: 'icon' },
    { icon: 'absent' },
    { icon: '../outside' },
    { icon: 'escape' },
    { icon: 'linked' },
    { icon: '..' },
    { icon: 7 },
    Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`icon${i}`, 'icon'])),
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

  it('refuses an absolute source even when it is inside the repository', async () => {
    writeFileSync(join(root, 'icon'), 'icon bytes');
    await expect(build({ resources: { 'icon.icns': join(root, 'icon') } })).rejects.toThrow('relative path');
    expect(offload.chooseBuildMachine).not.toHaveBeenCalled();
    expect(localBuilds).toBe(0);
  });

  it('refuses a resource that would overwrite the compiled catalog before any compile', async () => {
    writeFileSync(join(root, 'icon'), 'icon');
    mkdirSync(join(root, 'Assets.xcassets'));
    await expect(build({ resources: { 'Assets.car': 'icon' }, assetCatalog: 'Assets.xcassets' })).rejects.toThrow(
      'collides',
    );
    expect(offload.chooseBuildMachine).not.toHaveBeenCalled();
    expect(localBuilds).toBe(0);
  });

  it('builds locally without a fallback record when no machine is paired', async () => {
    vi.mocked(machines.pairedMachines).mockReturnValue([]);
    expect(await build()).toEqual({ bundleId, offloadedTo: null, offloadFallback: null, handoff: null });
    expect(offload.chooseBuildMachine).not.toHaveBeenCalled();
    expect(previousDuringBuild).toEqual(['old']);
    expect(buildRecord.offloadFallback).toBeUndefined();
  });

  it('builds locally without asking a machine when offload is off', async () => {
    writeConfigSetting({ scope: 'machine' }, 'remote.buildMode', 'off');
    expect(await build()).toEqual({ bundleId, offloadedTo: null, offloadFallback: null, handoff: null });
    expect(offload.chooseBuildMachine).not.toHaveBeenCalled();
    expect(localBuilds).toBe(1);
  });

  it.each([
    [{ CFBundleExecutable: 'Sample' }, 'must name'],
    [{ CFBundleIdentifier: 'dev.sample', CFBundleExecutable: 'Other' }, 'must name'],
    [
      { CFBundleIdentifier: 'dev.sample', CFBundleExecutable: 'Sample', CFBundleURLTypes: [] },
      'development Info.plist',
    ],
    [{ CFBundleIdentifier: 'dev.sample', CFBundleExecutable: 'Sample', SUFeedURL: 'feed' }, 'development Info.plist'],
  ])('rejects an invalid development plist before machine selection or local compilation', async (invalid, message) => {
    plist = invalid;
    await expect(build()).rejects.toThrow(message);
    expect(offload.chooseBuildMachine).not.toHaveBeenCalled();
    expect(slots.acquireBuildSlot).not.toHaveBeenCalled();
    expect(existsSync(join(bundle, 'previous'))).toBe(true);
  });

  it('refuses a plist changed by the local build before replacing the previous bundle', async () => {
    writeConfigSetting({ scope: 'machine' }, 'remote.buildMode', 'off');
    const spawn = getExecutor().spawn;
    setExecutor({
      ...getExecutor(),
      spawn: (...args: Parameters<typeof spawn>) => {
        plist.SUFeedURL = 'feed';
        return spawn(...args);
      },
    });
    await expect(build()).rejects.toThrow('development Info.plist');
    expect(readFileSync(join(bundle, 'previous'), 'utf8')).toBe('old');
  });

  it('preserves the previous bundle if local signing fails after an offload refusal', async () => {
    vi.mocked(offload.chooseBuildMachine).mockResolvedValue('no matching worker');
    const run = getExecutor().runFile;
    setExecutor({
      ...getExecutor(),
      runFile: (file: string, args: string[]) => {
        if (file === 'codesign') throw new Error('signing failed');
        return run(file, args);
      },
    });
    await expect(build()).rejects.toThrow('signing failed');
    expect(readFileSync(join(bundle, 'previous'), 'utf8')).toBe('old');
    expect(slots.releaseBuildSlot).toHaveBeenCalledOnce();
  });
});

describe('macOS resource staging', () => {
  let bin: string;
  let bundle: string;
  let calls: Array<[string, string[]]>;
  let sealed: string[];
  beforeEach(() => {
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

  it('seals renamed files, directory contents and the compiled catalog in the final signature', () => {
    const extras = resolveBundleExtras(
      root,
      root,
      { 'AppIcon.icns': 'icon', 'nested/branding': 'branding' },
      'Assets.xcassets',
    );
    stageBundle(root, 'Sample', 'Info.plist', bin, bundle, 'dev.sample.stim.test', extras);
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

  it('names the copy before the final signature and leaves the source plist alone', () => {
    stageBundle(
      root,
      'Sample',
      'Info.plist',
      bin,
      bundle,
      'dev.sample.stim.test',
      { resources: {} },
      'Sample \u00b7 wt',
    );
    const plist = join(bundle, 'Contents', 'Info.plist');
    const names = calls.filter(([file, args]) => file === 'plutil' && args[0] === '-replace').map(([, args]) => args);
    expect(names).toEqual([
      ['-replace', 'CFBundleDisplayName', '-string', 'Sample \u00b7 wt', plist],
      ['-replace', 'CFBundleName', '-string', 'Sample \u00b7 wt', plist],
    ]);
    expect(calls.at(-1)).toEqual(['codesign', ['--force', '--sign', '-', bundle]]);
    expect(readFileSync(join(root, 'Info.plist'), 'utf8')).toBe('{}');
  });

  it('compiles assets when the development plist does not declare a minimum OS', () => {
    setExecutor({
      runFile: (file, args) => {
        calls.push([file, args]);
        if (file === 'xcrun')
          writeFileSync(join(args[args.indexOf('--compile') + 1]!, 'Assets.car'), 'compiled assets');
        return file === 'plutil'
          ? JSON.stringify({ CFBundleIdentifier: 'dev.sample', CFBundleExecutable: 'Sample' })
          : '@executable_path/../Frameworks';
      },
    });
    stageBundle(
      root,
      'Sample',
      'Info.plist',
      bin,
      bundle,
      'dev.sample.stim.test',
      resolveBundleExtras(root, root, {}, 'Assets.xcassets'),
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
        '--output-partial-info-plist',
        '/dev/null',
      ],
    ]);
  });

  it('refuses an actool success with no compiled catalog instead of signing an incomplete app', () => {
    setExecutor({
      runFile: (file, args) => {
        calls.push([file, args]);
        return file === 'plutil'
          ? JSON.stringify({ CFBundleIdentifier: 'dev.sample', CFBundleExecutable: 'Sample' })
          : '';
      },
    });
    expect(() =>
      stageBundle(
        root,
        'Sample',
        'Info.plist',
        bin,
        bundle,
        'dev.sample.stim.test',
        resolveBundleExtras(root, root, {}, 'Assets.xcassets'),
      ),
    ).toThrow('actool did not produce Assets.car');
    expect(calls.filter(([file]) => file === 'codesign')).toEqual([]);
  });

  it.each(['Sample_Resources.bundle', 'Sample_Resources.bundle/icon'])(
    'refuses %s instead of overwriting SwiftPM resources',
    (destination) => {
      const extras = resolveBundleExtras(root, root, { [destination]: 'icon' });
      expect(() => stageBundle(root, 'Sample', 'Info.plist', bin, bundle, 'dev.sample.stim.test', extras)).toThrow(
        'collides',
      );
      expect(existsSync(bundle)).toBe(false);
    },
  );

  it.each(['icon', 'branding', 'absent.xcassets'])('refuses an invalid asset catalog %s', (source) => {
    expect(() => resolveBundleExtras(root, root, {}, source)).toThrow(/macos.assetCatalog.*stim guide macos/);
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
      runFile: () => JSON.stringify({ CFBundleIdentifier: 'dev.sample', CFBundleExecutable: 'Sample' }),
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

  it('validates packaging without creating state, acquiring build slots or contacting workers', () => {
    const slot = vi.spyOn(slots, 'acquireBuildSlot');
    const worker = vi.spyOn(offload, 'chooseBuildMachine');
    const plan = planMacos(root, 'local');
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

  it('refuses a missing declared resource and an unconfigured named build machine', () => {
    writeFileSync(
      join(root, '.stim.json'),
      JSON.stringify({
        macos: { product: 'Sample', infoPlist: 'Info.plist', resources: { 'icon.icns': 'missing' } },
      }),
    );
    expect(() => planMacos(root, 'local')).toThrow('source does not exist');
    expect(() => planMacos(root, 'missing-mini')).toThrow('not listed in remote.machines');
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
