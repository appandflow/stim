import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
import { buildMacosBundle } from '../macos/build.ts';
import { createNdjsonWriter } from '../ndjson.ts';
import * as offload from '../offload/client.ts';
import * as machines from '../offload/build-machines.ts';
import * as slots from '../engine/build-slots.ts';
import * as spawns from '../engine/spawn-claims.ts';
import { markClaimChildPending, releaseClaim, tryAcquireClaim } from '../ownership-claim.ts';
import { macosRuntimeClaim, requiredMacosRecord } from '../macos/state.ts';
import { runMacos } from '../commands/macos.ts';
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

describe('macOS build placement and promotion', () => {
  let bundle: string;
  let bin: string;
  let writer: ReturnType<typeof createNdjsonWriter>;
  let localBuilds: number;
  let previousDuringBuild: string[];
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
    writer = createNdjsonWriter(join(dir, 'build.ndjson'));
    localBuilds = 0;
    previousDuringBuild = [];
    plist = { CFBundleIdentifier: 'dev.sample', CFBundleExecutable: 'Sample' };
    buildRecord = { state: 'running', startedAt: new Date().toISOString() };
    vi.spyOn(offload, 'offloadMode').mockReturnValue('force');
    vi.spyOn(machines, 'pairedMachines').mockReturnValue([
      { machine: 'mini' } as ReturnType<typeof machines.pairedMachines>[number],
    ]);
    vi.spyOn(offload, 'chooseBuildMachine').mockResolvedValue(choice);
    vi.spyOn(offload, 'closeOffload').mockImplementation(() => {});
    vi.spyOn(slots, 'acquireBuildSlot').mockResolvedValue({ unlimited: true });
    vi.spyOn(slots, 'releaseBuildSlot').mockReturnValue(true);
    vi.spyOn(spawns, 'spawnDeclared').mockImplementation((spawn) => spawn());
    setExecutor({
      runFileQuiet: () => '27.0',
      runFile: (file: string, args: string[]) => {
        if (file === 'plutil') {
          const path = args.at(-1)!;
          return path === join(root, 'Info.plist') ? JSON.stringify(plist) : readFileSync(path, 'utf8');
        }
        if (file === '/usr/libexec/PlistBuddy') {
          writeFileSync(args.at(-1)!, JSON.stringify({ CFBundleIdentifier: bundleId, CFBundleExecutable: 'Sample' }));
        }
        if (file === 'otool') return '@executable_path/../Frameworks';
        return '';
      },
      spawn: (_file: string, args: string[]) => {
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

  const build = () =>
    buildMacosBundle({
      root,
      product: 'Sample',
      infoPlist: 'Info.plist',
      bundle,
      bundleId,
      scratch: join(dir, 'scratch'),
      writer,
      note: () => {},
      record: buildRecord,
    });
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
  function succeeds(path: string): void {
    vi.spyOn(offload, 'offloadBuild').mockResolvedValue({ ok: true, machine: 'mini', artifactPath: path } as Extract<
      offload.OffloadOutcome,
      { ok: true }
    >);
  }

  it('promotes a verified offloaded bundle without taking a local build slot and persists placement', async () => {
    succeeds(remoteBundle());
    expect(await build()).toEqual({ bundleId, offloadedTo: 'mini', offloadFallback: null });
    expect(slots.acquireBuildSlot).not.toHaveBeenCalled();
    expect(localBuilds).toBe(0);
    expect(readFileSync(join(bundle, 'Contents', 'MacOS', 'Sample'), 'utf8')).toBe('remote');
    writeWorkspaceState(root, { macos: record({ build: { ...buildRecord, state: 'ok' } }) });
    expect(readMacosRecord(root)?.build.offloadedTo).toBe('mini');
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

  it('builds locally without a fallback record when no machine is paired', async () => {
    vi.mocked(machines.pairedMachines).mockReturnValue([]);
    expect(await build()).toEqual({ bundleId, offloadedTo: null, offloadFallback: null });
    expect(offload.chooseBuildMachine).not.toHaveBeenCalled();
    expect(previousDuringBuild).toEqual(['old']);
    expect(buildRecord.offloadFallback).toBeUndefined();
  });

  it('builds locally without asking a machine when offload is off', async () => {
    vi.mocked(offload.offloadMode).mockReturnValue('off');
    expect(await build()).toEqual({ bundleId, offloadedTo: null, offloadFallback: null });
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
    vi.mocked(offload.offloadMode).mockReturnValue('off');
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
