import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decode } from 'unique-pid';
import { captureProcessToken } from '../process-identity.ts';
import { exclusiveClaimDir, sharedClaimDir, type ClaimOwner } from '../ownership-claim.ts';

import type { StimConfig } from '../types.ts';
import type { CacheDescriptor } from '../caches.ts';
import type { EnvironmentState } from '../status.ts';
import type { IosSimRecord } from '../sim/ios.ts';
import type { AdbDevices } from '../sim/android.ts';
import type { Executor } from '../exec.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import type { MetroResolution } from '../metro.ts';
import type { BuildLockInfo } from '../engine/build-lock.ts';
import type { BuildSlotInfo } from '../engine/build-slots.ts';

// Above every kernel's pid_max (macOS 99999, Linux 2^22): a stray signal fails ESRCH instead of reaching a process.
export const IMPOSSIBLE_PID = 999999901;

export function makeConfig(overrides: Partial<StimConfig> = {}): StimConfig {
  return { version: 2, projects: {}, repos: {}, ...overrides };
}

export function makeCacheDescriptor(overrides: Partial<CacheDescriptor> = {}): CacheDescriptor {
  return {
    name: 'test cache',
    dir: '/tmp/stim-test-cache',
    prune: 'entries',
    note: 'a test cache',
    ...overrides,
  };
}

export function makeEnvironmentState(overrides: Partial<EnvironmentState> = {}): EnvironmentState {
  return { path: '/w/project', live: true, memoryMb: 0, warnings: [], ...overrides };
}

export function makeIosSim(overrides: Partial<IosSimRecord> = {}): IosSimRecord {
  return {
    udid: 'BF2A1C3D-4E5F-6071-8293-A4B5C6D7E8F9',
    name: 'stim-fixture',
    state: 'Booted',
    runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-18-0',
    deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
    available: true,
    ...overrides,
  };
}

export function makeAdbDevices(overrides: Partial<AdbDevices> = {}): AdbDevices {
  return { emulators: [], physical: [], unhealthy: [], ...overrides };
}

export function makeBuildLock(overrides: Partial<BuildLockInfo> = {}): BuildLockInfo {
  return {
    path: '/h/build-locks/ios-abc.lock',
    name: 'ios-abc.lock',
    platform: 'ios',
    key: 'abc-debug-sim',
    pid: IMPOSSIBLE_PID,
    projectRoot: '/w/project',
    startedAt: '2026-01-01T00:00:00.000Z',
    logFile: '/w/.stim/logs/build.log',
    alive: true,
    unresolved: false,
    ...overrides,
  };
}

export function makeBuildSlot(overrides: Partial<BuildSlotInfo> = {}): BuildSlotInfo {
  return {
    path: '/h/build-slots/slot-0',
    name: 'slot-0',
    index: 0,
    pid: IMPOSSIBLE_PID,
    projectRoot: '/w/project',
    startedAt: '2026-01-01T00:00:00.000Z',
    logFile: '/w/.stim/logs/build.log',
    alive: true,
    unresolved: false,
    ...overrides,
  };
}

export const makeMetroResolution = {
  identified(overrides: Partial<MetroResolution> = {}): MetroResolution {
    return { metro: { pid: 1, leader: 1, cwd: '/w/project' }, ...overrides };
  },
  missing(overrides: Partial<MetroResolution> = {}): MetroResolution {
    return { missing: true, ...overrides };
  },
  notOurs(overrides: Partial<MetroResolution> = {}): MetroResolution {
    return {
      notOurs: "pid 42 on port 8082 does not answer Metro's /status",
      kind: 'unresponsive',
      pid: 42,
      ...overrides,
    };
  },
};

export function makeWriter(overrides: Partial<NdjsonWriter> = {}): NdjsonWriter {
  const records: unknown[] = [];
  const state = { written: 0, dropped: 0, lastError: null as Error | null };
  const file = '/tmp/stim-test.ndjson';
  const writer: NdjsonWriter = {
    file,
    write(record: unknown): boolean {
      records.push(record);
      state.written += 1;
      return true;
    },
    close() {
      return { file, written: state.written, dropped: state.dropped, lastError: state.lastError };
    },
    get written() {
      return state.written;
    },
    get dropped() {
      return state.dropped;
    },
    get lastError() {
      return state.lastError;
    },
    ...overrides,
  };
  return writer;
}

export function makeExecutor(overrides: Partial<Executor> = {}): Executor {
  const base: Executor = {
    run: () => '',
    runFile: () => '',
    runQuiet: () => null,
    runFileQuiet: () => null,
    spawn: () => makeChildProcess(),
  };
  return { ...base, ...overrides };
}

export function makeChildProcess(overrides: Partial<ChildProcess> = {}): ChildProcess {
  const emitter = new EventEmitter();
  const stub = Object.assign(emitter, {
    pid: IMPOSSIBLE_PID,
    stdin: null,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    connected: false,
    killed: false,
    exitCode: null,
    signalCode: null,
    kill: () => true,
    ref() {
      return stub;
    },
    unref() {
      return stub;
    },
    send: () => true,
    disconnect: () => {},
  });
  return Object.assign(stub, overrides) as unknown as ChildProcess;
}

export function makeExitingChild(code = 0, stderr = ''): ChildProcess {
  const child = makeChildProcess();
  setImmediate(() => {
    if (stderr) child.stderr?.emit('data', Buffer.from(stderr));
    child.emit('exit', code, null);
  });
  return child;
}

export function asRequire(fn: (id: string) => unknown): NodeJS.Require {
  return fn as unknown as NodeJS.Require;
}

export function asProcessExit(fn: (code?: string | number | null) => void): typeof process.exit {
  return fn as unknown as typeof process.exit;
}

export function makeError<T extends Record<string, unknown>>(message: string, props: T = {} as T): Error & T {
  return Object.assign(new Error(message), props);
}

export function liveClaimOwner(): ClaimOwner {
  const processToken = captureProcessToken(process.pid);
  if (!processToken) throw new Error('this platform returned no process identity token');
  return { pid: process.pid, processToken };
}

// unique-pid encodes a token as `upid1.` plus base64url JSON of the identity it decodes. Rebuilding one
// is the only way to get a record for a process that is provably gone, or one whose pid was recycled.
function reshape(change: (identity: Record<string, unknown>) => Record<string, unknown>): ClaimOwner {
  const parsed = decode(liveClaimOwner().processToken);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const identity = change({ ...parsed.value });
  return {
    pid: identity.pid as number,
    processToken: 'upid1.' + Buffer.from(JSON.stringify(identity)).toString('base64url'),
  };
}

export function goneClaimOwner(pid: number = IMPOSSIBLE_PID): ClaimOwner {
  return reshape((identity) => ({ ...identity, pid }));
}

export function recycledClaimOwner(): ClaimOwner {
  return reshape((identity) => {
    const start = String(identity.startTime).split(':');
    start[0] = String(BigInt(start[0]!) + 1n);
    return { ...identity, startTime: start.join(':') };
  });
}

export function plantClaim(
  root: string,
  mode: 'exclusive' | 'shared',
  owner: ClaimOwner,
  {
    claimId = `planted-${mode}-${owner.pid}`,
    details = {},
    startedAt = new Date().toISOString(),
    child,
  }: { claimId?: string; details?: unknown; startedAt?: string; child?: unknown } = {},
): string {
  const dir = mode === 'exclusive' ? exclusiveClaimDir(root) : sharedClaimDir(root);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${claimId}.claim`);
  writeFileSync(path, JSON.stringify({ claimId, mode, owner, startedAt, details }));
  if (child !== undefined) writeFileSync(join(dir, `${claimId}.child`), JSON.stringify(child));
  return path;
}

export function writeCasToolchain(
  dir: string,
  toolchain: Record<string, unknown> = {},
): { manifest: string; binary: string } {
  const ndk = join(dir, 'ndk');
  mkdirSync(ndk, { recursive: true });
  writeFileSync(join(ndk, 'source.properties'), 'Pkg.Revision = 27.1.12297006\n');
  const binary = join(dir, 'compiler');
  writeFileSync(binary, 'test compiler bytes', { mode: 0o755 });
  const resourceDir = join(dir, 'resource');
  mkdirSync(resourceDir, { recursive: true });
  const manifest = join(dir, 'toolchain.json');
  writeFileSync(
    manifest,
    JSON.stringify({
      clang: binary,
      clangxx: binary,
      lld: binary,
      ar: binary,
      ranlib: binary,
      ndk,
      resourceDir,
      ...toolchain,
    }),
  );
  return { manifest, binary };
}
