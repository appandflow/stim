import assert from 'node:assert';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Command } from 'commander';
import { archiveWorkspace } from '../archive.ts';
import statusCommand from '../commands/status.ts';
import { recordCreatedDevice } from '../devices/created-devices.ts';
import { startBuildProgress } from '../engine/build-progress.ts';
import { deviceLeasePath, deviceLocksDir } from '../engine/device-lease.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { tryAcquireClaim, releaseClaim } from '../ownership-claim.ts';
import { captureProcessToken } from '../process-identity.ts';
import { saveConfig } from '../workspace/config.ts';
import type { ProjectRecord } from '../workspace/config.ts';
import { ensureWorkspaceStorage, workspaceLogsDir } from '../workspace/paths.ts';
import { writeWorkspaceState } from '../workspace/workspace-state.ts';
import { IMPOSSIBLE_PID, makeConfig } from './_factories.ts';

const HOST_MEMORY = 32 * 1024 ** 3;

vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  totalmem: () => HOST_MEMORY,
}));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  totalmem: () => HOST_MEMORY,
}));

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const ENVIRONMENTS = 66;
const ARCHIVES = 200;
const UNPROVISIONED = 20;

const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_DATE: iso(-86_400_000),
      GIT_COMMITTER_DATE: iso(-86_400_000),
    },
  });
}

function simulators(): string {
  const sims = Array.from({ length: 30 }, (_, i) => ({
    udid: `SIM-${String(i).padStart(3, '0')}`,
    name: `stim-env-${i} (iPhone 17 26.5)`,
    state: i % 4 === 0 ? 'Booted' : 'Shutdown',
    isAvailable: true,
    deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
  }));
  return JSON.stringify({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-5': sims } });
}

function build(platform: 'ios' | 'android', i: number, n: number): Record<string, unknown> {
  const failed = (i + n) % 5 === 0;
  const startedAt = iso(-(n + 1) * 3_600_000 - i * 60_000);
  return {
    platform,
    status: failed ? 'failed' : 'ok',
    cacheHit: n % 3 === 0 ? 'local' : false,
    cacheSkipped: false,
    durationMs: 20_000 + i * 1000 + n * 100,
    fingerprint: `fp-${i}-${n}`,
    startedAt,
    buildMachine: 'auto',
    builtOn: 'here',
    result: failed ? 'failed' : 'succeeded',
    slot: 'default',
    configuration: 'Debug',
    cacheKey: `key-${i}-${n}`,
    phases: { prepare: 400, compile: 15_000 + n, install: 900 },
    ...(failed
      ? {
          errorCode: 'STIM_BUILD_FAILED',
          diagnostics: [{ file: `src/file-${i}.swift`, line: 10 + n, message: 'cannot find type in scope' }],
        }
      : n % 3 === 0
        ? {}
        : { missReason: { kind: 'changed', categories: ['js-config'], files: [`app-${i}.json`] } }),
  };
}

function metroLog(root: string, i: number): void {
  mkdirSync(workspaceLogsDir(root), { recursive: true });
  const records = [
    { ts: NOW - 50_000, src: 'metro', level: 'error', msg: `before the marker ${i}` },
    { ts: NOW - 40_000, src: 'metro', level: 'info', msg: 'bundle built', marker: true },
    ...Array.from({ length: i % 4 }, (_, n) => ({ ts: NOW - 30_000 + n, src: 'metro', level: 'error', msg: `e${n}` })),
  ];
  writeFileSync(join(workspaceLogsDir(root), 'metro.ndjson'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function project(i: number): ProjectRecord {
  const ios = i % 3 === 0;
  const android = i % 4 === 1;
  const record: ProjectRecord = {
    label: `env-${i}`,
    metroPort: 400 + i,
    bundleId: `com.example.env${i}`,
    androidPackage: `com.example.env${i}`,
    platforms: {
      ...(ios
        ? { ios: { deviceUdid: i % 7 === 0 ? `SIM-GONE-${i}` : `SIM-${String(i % 30).padStart(3, '0')}`, owned: true } }
        : {}),
      ...(android ? { android: { avdName: `stim-env-${i}`, consolePort: 5554 + 2 * (i % 10), owned: true } } : {}),
    },
  };
  if (i % 6 === 2) {
    record.supervisor = { pid: IMPOSSIBLE_PID, port: 400 + i, startedAt: iso(-7_200_000) };
  }
  if (i % 6 === 3) {
    record.supervisor = {
      pid: process.pid,
      processToken: liveToken(),
      port: 400 + i,
      startedAt: iso(-3_600_000),
    };
  }
  if (i % 10 === 4) record.doctorRuns = { ios: { at: iso(-86_400_000), version: '1.20.0' } };
  if (i % 13 === 5) record.settings = { workspace: { hidden: true } };
  if (i % 5 === 0) {
    record.deviceSlots = {
      tablet: { ios: { deviceUdid: `SIM-${String((i + 1) % 30).padStart(3, '0')}`, owned: true } },
    };
  }
  return record;
}

function liveToken(): string {
  const token = captureProcessToken(process.pid);
  assert(token);
  return token;
}

const rootOf = (i: number) => join(realHome, 'wt', `env-${i}`);

function writeLease(platform: string, id: string, holder: string, expiresInMs: number): void {
  mkdirSync(deviceLocksDir(), { recursive: true });
  writeFileSync(
    deviceLeasePath(platform, id),
    JSON.stringify({
      version: 1,
      platform,
      id,
      deviceName: `Phone ${id}`,
      holder,
      token: `token-${id}`,
      grantedAt: iso(-1000),
      expiresAt: iso(expiresInMs),
    }),
  );
}

function touchAll(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== '.git') touchAll(path);
    utimesSync(path, NOW / 1000, NOW / 1000);
  }
  utimesSync(dir, NOW / 1000, NOW / 1000);
}

function normalize(output: string): string {
  return output
    .replaceAll(realHome, '<home>')
    .replaceAll(home, '<home>')
    .replaceAll(`"pid":${process.pid}`, '"pid":"<test-pid>"')
    .replaceAll(`pid ${process.pid}`, 'pid <test-pid>')
    .replace(/--[0-9a-f]{16}\b/g, '--<path-hash>')
    .replace(/^Archived: (\d+ workspaces), .*$/m, 'Archived: $1, <bytes>');
}

interface ArchiveBytes {
  bytes: { record: unknown; total: unknown };
}

// An archive's record size counts the bytes of its own home path, which differs between temporary directories.
function normalizeJson(output: string): string {
  const payload: {
    archived: ArchiveBytes[];
    archivedUsage: { bytes: unknown; byKind: { record: unknown } };
  } = JSON.parse(normalize(output));
  for (const archive of payload.archived) archive.bytes = { ...archive.bytes, record: '<bytes>', total: '<bytes>' };
  payload.archivedUsage.bytes = '<bytes>';
  payload.archivedUsage.byKind.record = '<bytes>';
  return JSON.stringify(payload, null, 2);
}

let home: string;
let realHome: string;
let claim: ReturnType<typeof tryAcquireClaim>['acquired'];
const zone = process.env.TZ;

beforeEach(() => {
  process.env.TZ = 'UTC';
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  home = mkdtempSync(join(tmpdir(), 'stim-parity-'));
  realHome = realpathSync(home);
  process.env.STIM_HOME = realHome;
  process.env.STIM_ARCHIVE_ENABLED = 'true';
  const listing = simulators();
  setExecutor({
    runFile: (_file, args = []) => (args.join(' ').includes('simctl list devices --json') ? listing : ''),
    runFileAsync: async (_file, args = []) => (args.join(' ').includes('simctl list devices --json') ? listing : ''),
    runQuiet: (cmd) => (cmd.includes('simctl list devices --json') ? listing : null),
    runFileQuiet: () => null,
    spawn() {
      throw new Error('spawn should not be called from status');
    },
  });
  vi.spyOn(process, 'cwd').mockReturnValue(realHome);
});

afterEach(() => {
  if (claim) releaseClaim(claim);
  claim = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetExecutor();
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  delete process.env.STIM_ARCHIVE_ENABLED;
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

function buildHome(): void {
  const repo = join(realHome, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'package.json'), '{}');
  git(repo, ['add', '.']);
  git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);

  const projects: Record<string, ProjectRecord> = {};
  for (let i = 0; i < ENVIRONMENTS + UNPROVISIONED; i++) {
    const root = rootOf(i);
    git(repo, ['worktree', 'add', '-q', '-b', `feature/env-${i}`, root]);
    if (i >= ENVIRONMENTS) continue;
    if (i % 2 === 0) writeFileSync(join(root, 'app.json'), JSON.stringify({ expo: { name: `env-${i}` } }));
    projects[root] = project(i);
  }
  for (const udid of Array.from({ length: 30 }, (_, i) => `SIM-${String(i).padStart(3, '0')}`))
    recordCreatedDevice('ios', udid);
  for (let i = 0; i < ENVIRONMENTS; i++) recordCreatedDevice('android', `stim-env-${i}`);
  saveConfig(
    makeConfig({
      projects,
      parked: {
        ios: [
          {
            udid: 'SIM-029',
            name: 'stim-parked (iPhone 17 26.5) park',
            deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
            runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
            parkedAt: iso(-600_000),
            simslimManaged: false,
          },
        ],
        android: [
          {
            udid: 'stim-parked',
            name: 'stim-parked',
            systemImage: 'system-images;android-36;google_apis;arm64-v8a',
            configuration: '[]',
            parkedAt: iso(-900_000),
          },
        ],
      },
    }),
  );

  for (const [n, root] of Object.keys(projects).entries()) {
    const history = {
      ios: Array.from({ length: n % 11 }, (_, k) => build('ios', n, k)),
      android: Array.from({ length: n % 4 }, (_, k) => build('android', n, k)),
    };
    writeWorkspaceState(root, {
      ...(history.ios[0] ? { lastIosBuild: history.ios[0] } : {}),
      ...(history.android[0] ? { lastAndroidBuild: history.android[0] } : {}),
      buildHistory: history,
      ...(n % 9 === 1 ? { warm: { phase: 'ready', at: iso(-60_000) } } : {}),
      lastUsedAt: iso(-n * 600_000),
    });
    if (n % 2 === 0) metroLog(root, n);
  }

  claim = tryAcquireClaim({ root: join(realHome, 'run.lock'), mode: 'exclusive', label: 'native-run lock' }).acquired;
  assert(claim);
  const progress = startBuildProgress({ root: rootOf(8), platform: 'ios', slot: 'default', claim });
  progress.step('compile');

  for (let a = 0; a < ARCHIVES; a++) {
    const root = join(realHome, 'removed', `old-${a}`);
    ensureWorkspaceStorage(root);
    writeWorkspaceState(root, { lastIosBuild: build('ios', a, 1), lastUsedAt: iso(-a * 3_600_000) });
    vi.setSystemTime(NOW - (ARCHIVES - a) * 60_000);
    archiveWorkspace(root, a % 3 === 0 ? 'gc' : 'worktree-remove');
  }
  vi.setSystemTime(NOW);

  writeLease('ios', 'PHONE-LIVE', rootOf(3), 600_000);
  writeLease('android', 'PHONE-EXPIRED', rootOf(4), -600_000);
  writeLease('ios', 'PHONE-OTHER', '/elsewhere/app', 60_000);
  touchAll(realHome);
}

async function status(args: string[]): Promise<string> {
  const program = new Command();
  statusCommand(program);
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((line) => void lines.push(String(line)));
  try {
    await program.parseAsync(['node', 'stim', 'status', ...args]);
  } finally {
    log.mockRestore();
  }
  return lines.join('\n');
}

// Windows paths and process identity differ from the captured POSIX payload.
test.skipIf(process.platform === 'win32')(
  'status on a realistic home prints what main printed before the status refactor',
  async () => {
    buildHome();
    const json = await status(['--json']);
    expect(json.split('\n')).toHaveLength(1);
    await expect(normalizeJson(json)).toMatchFileSnapshot('./__snapshots__/status-parity.json');
    await expect(normalize(await status([]))).toMatchFileSnapshot('./__snapshots__/status-parity.txt');
  },
  120_000,
);
