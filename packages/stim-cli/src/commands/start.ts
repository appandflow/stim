import chalk from 'chalk';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Command } from 'commander';
import { phaseLine, stepTimer } from '../command-output.ts';
import type { StartError, StartFacts } from '../supervisor/start-facts.ts';
import { getProject, upsertProject } from '../workspace/config.ts';
import { getExecutor } from '../exec.ts';
import { pidExists, resolveProjectMetro, signalProcessTree } from '../metro.ts';
import { captureProcessToken, inspectProcessIdentity } from '../process-identity.ts';
import { resolveSupervisorTarget, type SupervisorStateRecord } from '../supervisor/ownership.ts';
import type { MetroResolution } from '../metro.ts';
import { IDLE_STOP_KEY, queryLogs } from '@stim-cli/core/state';
import { levelRank } from '../ndjson.ts';
import { ensureWorkspaceStorage, supervisorLogFile, workspaceLogsDir } from '../workspace/paths.ts';
import { reserveMetroPort } from '../ports.ts';
import {
  appProjectProblem,
  detectAndroidPackage,
  detectBundleId,
  detectIsExpo,
  findProjectRoot,
  NO_PROJECT_REFUSAL,
} from '../workspace/project.ts';
import { clearManagedMetroTunnel, readMetroTunnel } from '../supervisor/state.ts';
import {
  clearWorkspaceStateKeys,
  readWorkspaceState,
  recordWorkspaceUse,
  writeWorkspaceState,
} from '../workspace/workspace-state.ts';
import { CACHE_PROVIDER_ENV, cacheProviderEnv } from '@stim-cli/cache';
import { workspaceProcessLockError, withWorkspaceProcessLock } from '../engine/workspace-process-lock.ts';
import { stopOwnedMetroForReset } from '../supervisor/cache-reset.ts';
import { spawnEntry } from '../spawn-entry.ts';
import { windowsLauncherArgs } from '../detached-entry.ts';
import {
  publicUrlSetting,
  ngrokUrlSetting,
  metroIdleStopMinutesSetting,
  metroTunnelSettingError,
  remoteAndroidSetting,
  cacheProviderSettingError,
  remoteIosSetting,
  resolveCacheProviderConfig,
  resolveSettings,
  SETTING_SHAPE_REMEDY,
  settingShapeErrors,
  tunnelModeSetting,
  unknownSettingKeys,
} from '../workspace/settings.ts';
import { detectProviders, planMetroReach, PUBLIC_METRO_ENV, type ManagedProvider } from '../engine/metro-reach.ts';
import {
  startTunnelSequence,
  stopTunnel,
  terminateChild,
  withManagedRemoteWorktreeLock,
  withManagedTunnelLock,
  type StartTunnelSequenceOptions,
  type StartTunnelSequenceResult,
  type TerminableChild,
  type TunnelRecord,
} from '../engine/tunnel.ts';
import { gitCommonDir, repoRoot } from '../workspace/worktree.ts';
import { budgetGate, type ReclaimedStep } from '../budget.ts';

const DEFAULT_WAIT_SECONDS = 60;
const POLL_MS = 500;
const LOG_TAIL_LINES = 5;
const ERROR_EVIDENCE_RECORDS = 8;

function writeNote(line: string): void {
  console.error(line);
}

export function supervisorEntry(): string {
  return spawnEntry('supervisor-run');
}

interface WaitResult {
  seconds?: number;
  error?: string;
}

export function wantsExpoOwnTunnel({
  isExpo,
  remote,
  mode,
  publicUrl,
}: {
  isExpo: boolean;
  remote: boolean;
  mode: string;
  publicUrl?: string | null;
}): boolean {
  return remote && isExpo && !publicUrl && mode === 'expo';
}

export function parseWait(value: unknown): WaitResult {
  if (value === undefined || value === null) return { seconds: DEFAULT_WAIT_SECONDS };
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { error: `Invalid --wait value ${JSON.stringify(value)}. Pass a number of seconds, e.g. --wait 90.` };
  }
  return { seconds };
}

interface SupervisorCandidate {
  processToken?: unknown;
  pid?: unknown;
  port?: unknown;
  mode?: unknown;
  startedAt?: unknown;
}

interface LiveSupervisor {
  pid: number;
  port: number;
  mode: string | null;
  startedAt: string | null;
}

interface ChildExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export function liveSupervisor({
  state,
  project,
  port,
  isAlive = pidExists,
  inspectIdentity = inspectProcessIdentity,
}: {
  state?: { supervisor?: SupervisorCandidate | null } | null;
  project?: { supervisor?: SupervisorCandidate | null } | null;
  port?: number;
  isAlive?: (pid: number) => boolean;
  inspectIdentity?: typeof inspectProcessIdentity;
} = {}): LiveSupervisor | null {
  const target = resolveSupervisorTarget({
    state: state?.supervisor as SupervisorStateRecord | undefined,
    record: project?.supervisor as SupervisorStateRecord | undefined,
    reservedPort: port,
    isAlive,
    inspectIdentity,
  });
  return target.status === 'ours' && target.port === port
    ? { pid: target.pid!, port: target.port!, mode: target.mode ?? null, startedAt: target.startedAt ?? null }
    : null;
}

export function startFacts({
  port,
  supervisor,
  logsDir,
  alreadyRunning,
}: {
  port: number;
  supervisor?: Pick<LiveSupervisor, 'pid' | 'mode'> | null;
  logsDir: string;
  alreadyRunning?: unknown;
}): StartFacts {
  return {
    port,
    supervisorPid: supervisor?.pid ?? null,
    mode: supervisor?.mode ?? null,
    logsDir,
    alreadyRunning: Boolean(alreadyRunning),
  };
}

function startError({
  code,
  message,
  remedy = null,
}: {
  code: string;
  message: string;
  remedy?: string | null;
}): StartError {
  return { code, message, remedy: remedy ?? null };
}

export function tailLines(text: unknown, n: number = LOG_TAIL_LINES): string[] {
  const lines = String(text || '')
    .split('\n')
    .filter((l) => l.trim() !== '');
  return lines.slice(-n);
}

export function readLogTail(file: string, n: number = LOG_TAIL_LINES): string[] {
  try {
    return tailLines(readFileSync(file, 'utf-8'), n);
  } catch {
    return [];
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export default function startCommand(program: Command): void {
  registerStart(program);
}

interface StartOptions {
  json?: boolean;
  wait?: string;
  remote?: boolean;
  resetCache?: boolean;
}

interface StartCommandDeps {
  providers(): ManagedProvider[];
  startTunnelSequence(options: StartTunnelSequenceOptions): Promise<StartTunnelSequenceResult>;
  isTunnelAlive(pid: number): boolean;
  writeTunnelRecord(root: string, patch: Parameters<typeof writeWorkspaceState>[1]): unknown;
  stopTunnel(record: TunnelRecord): ReturnType<typeof stopTunnel>;
  writeSupervisorRecord(root: string, patch: Parameters<typeof writeWorkspaceState>[1]): unknown;
  terminateSupervisorChild(child: SupervisorProcess): Promise<boolean>;
  withWorktreeLock: typeof withManagedRemoteWorktreeLock;
  withTunnelLock: typeof withManagedTunnelLock;
  clearTunnelRecord(root: string, record: TunnelRecord): void;
  budgetGate: typeof budgetGate;
  platform: NodeJS.Platform;
}

/** The spawned supervisor, or on win32 the stand-in for the one the launcher recorded. */
export interface SupervisorProcess extends TerminableChild {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  unref(): void;
}

function recordedSupervisorProcess(pid: number | undefined): SupervisorProcess {
  return Object.assign(new EventEmitter(), {
    pid,
    stdout: null,
    stderr: null,
    kill: (signal: NodeJS.Signals | number = 'SIGTERM') =>
      pid !== undefined && signalProcessTree(pid, typeof signal === 'number' ? 'SIGTERM' : signal),
    unref() {},
  });
}

const RECORDED_SUPERVISOR_WAIT_MS = 15_000;

function providersOnPath(): ManagedProvider[] {
  return detectProviders((bin) => {
    try {
      return Boolean(getExecutor().findExecutable(bin));
    } catch {
      return false;
    }
  });
}

const DEFAULT_START_DEPS: StartCommandDeps = {
  providers: providersOnPath,
  startTunnelSequence,
  isTunnelAlive: pidExists,
  writeTunnelRecord: writeWorkspaceState,
  stopTunnel,
  writeSupervisorRecord: writeWorkspaceState,
  terminateSupervisorChild: (child) =>
    terminateChild(child, {
      alreadyExited: false,
      timeoutMs: 1_000,
      now: Date.now,
      sleep,
      isAlive: pidExists,
    }),
  withWorktreeLock: withManagedRemoteWorktreeLock,
  withTunnelLock: withManagedTunnelLock,
  clearTunnelRecord: clearManagedMetroTunnel,
  budgetGate,
  platform: process.platform,
};

interface ManagedTunnelFailure {
  code: string;
  message: string;
  remedy: string;
}

interface ManagedTunnelTracking {
  record: TunnelRecord;
  startedHere: boolean;
}

type ManagedTunnelAcquisition = { origin: string; tunnel: ManagedTunnelTracking } | { failed: ManagedTunnelFailure };

function normalizeManagedTunnelUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function registerStart(program: Command, overrides: Partial<StartCommandDeps> = {}): void {
  const d = { ...DEFAULT_START_DEPS, ...overrides };
  program
    .command('start')
    .description(
      "Start this workspace's dev server under a detached supervisor and wait until it verifies as this project's. " +
        'Idempotent: a healthy dev server on the reserved port is a no-op. Structured logs land in the global workspace logs directory.',
    )
    .option('--json', 'Emit the facts as a single JSON line on stdout; every other line goes to stderr')
    .option('--wait <seconds>', `How long to wait for the dev server to answer (default ${DEFAULT_WAIT_SECONDS})`)
    .option('--remote', 'Prepare the dev server for a remote device')
    .option('--reset-cache', "Restart owned Metro and clear this app's Metro caches")
    .action(async (opts: StartOptions) => {
      const json = Boolean(opts.json);
      const out = (line: string) => {
        if (json) console.error(line);
        else console.log(line);
      };
      const note = writeNote;
      const fail = ({
        code,
        message,
        remedy = null,
        lines = [],
        reclaimed = [],
      }: {
        code: string;
        message: string;
        remedy?: string | null;
        lines?: string[];
        reclaimed?: ReclaimedStep[];
      }): never => {
        note(chalk.red(message));
        for (const line of lines) note(chalk.dim(`  ${line}`));
        if (remedy) note(chalk.dim(remedy));
        note(chalk.red(`failed: ${code}`));
        if (json) {
          console.log(
            JSON.stringify({ ...startError({ code, message, remedy }), ...(reclaimed.length ? { reclaimed } : {}) }),
          );
        }
        process.exit(1);
      };

      const wait = parseWait(opts.wait);
      if (wait.error) {
        return fail({
          code: 'STIM_BAD_ARG',
          message: wait.error,
          remedy: 'Pass a whole number of seconds, e.g. --wait 90.',
        });
      }
      const waitSeconds = wait.seconds as number;

      const root = findProjectRoot(process.cwd());
      if (!root) {
        return fail(NO_PROJECT_REFUSAL);
      }
      const projectProblem = appProjectProblem(root);
      if (projectProblem) {
        return fail({
          code: 'STIM_NO_PROJECT',
          message: projectProblem.message,
          remedy: projectProblem.remedy,
        });
      }

      try {
        ensureWorkspaceStorage(root);
      } catch (error) {
        return fail({
          code: (error as Error & { code?: string })?.code || 'STIM_WORKSPACE_STATE',
          message: `Could not prepare this workspace's Stim state: ${(error as Error)?.message || error}`,
          remedy:
            'Check that STIM_HOME is writable and has free space. An EPERM on a directory you can write is a sandbox: allow writes to STIM_HOME, or run Stim with the sandbox disabled (`stim guide errors sandbox`).',
        });
      }
      recordWorkspaceUse(root);

      const settingsContext = {
        projectPath: root,
        gitCommonDir: gitCommonDir(root),
        repoRoot: repoRoot(root) ?? root,
      };
      const settings = resolveSettings(settingsContext);
      const [shapeError, ...moreShapeErrors] = settingShapeErrors(settings);
      if (shapeError) {
        return fail({
          code: 'STIM_BAD_ARG',
          message: shapeError,
          lines: moreShapeErrors,
          remedy: SETTING_SHAPE_REMEDY,
        });
      }
      for (const key of unknownSettingKeys(settings)) {
        note(chalk.yellow(`Warning: setting "${key}" is not read by Stim and will be ignored.`));
      }
      const cacheProviderError = cacheProviderSettingError(settings);
      if (cacheProviderError) note(chalk.yellow(`Warning: ${cacheProviderError} No cache provider is used.`));
      const result = await startDevServer(
        {
          root,
          settings,
          waitSeconds,
          remote: Boolean(opts.remote),
          resetCache: Boolean(opts.resetCache),
          out,
          note,
        },
        d,
      );
      if (!result.ok) return fail({ ...result.error, lines: result.lines, reclaimed: result.reclaimed });
      report({ json, out, facts: result.facts, waited: result.waited, reclaimed: result.reclaimed });
    });
}

interface StartRefusalArgs {
  code: string;
  message: string;
  remedy?: string | null;
  lines?: string[];
}

class StartRefusal extends Error {
  readonly refusal: StartRefusalArgs;
  constructor(refusal: StartRefusalArgs) {
    super(refusal.message);
    this.refusal = refusal;
  }
}

export interface StartDevServerRequest {
  root: string;
  settings: ReturnType<typeof resolveSettings>;
  waitSeconds?: number;
  remote?: boolean;
  resetCache?: boolean;
  out: (line: string) => void;
  note: (line: string) => void;
}

export type StartDevServerResult =
  | { ok: true; facts: StartFacts; waited: string; reclaimed: ReclaimedStep[] }
  | { ok: false; error: StartError; lines: string[]; reclaimed: ReclaimedStep[] };

export async function startDevServer(
  {
    root,
    settings,
    waitSeconds = DEFAULT_WAIT_SECONDS,
    remote: remoteFlag = false,
    resetCache = false,
    out,
    note,
  }: StartDevServerRequest,
  overrides: Partial<StartCommandDeps> = {},
): Promise<StartDevServerResult> {
  const d = { ...DEFAULT_START_DEPS, ...overrides };
  const waitTimer = stepTimer();
  let reclaimed: ReclaimedStep[] = [];
  const fail = (refusal: StartRefusalArgs): never => {
    throw new StartRefusal(refusal);
  };
  const isExpo = detectIsExpo(root);
  const worktreeRoot = repoRoot(root) ?? root;
  const cacheProvider = resolveCacheProviderConfig({
    projectPath: root,
    gitCommonDir: gitCommonDir(root),
    repoRoot: worktreeRoot,
  });
  const run = async (): Promise<StartFacts> => {
    const settingError = metroTunnelSettingError(settings);
    if (settingError) {
      return fail({
        code: 'STIM_BAD_ARG',
        message: settingError,
        remedy: 'Set metro.tunnel to "ngrok" and metro.ngrokUrl to an HTTPS URL, or remove metro.ngrokUrl.',
      });
    }
    const remote = remoteFlag || remoteIosSetting(settings) !== null || remoteAndroidSetting(settings) !== null;
    const tunnelMode = tunnelModeSetting(settings) ?? 'auto';
    const publicUrl = publicUrlSetting(settings);
    const tunnel = wantsExpoOwnTunnel({
      isExpo,
      remote,
      mode: tunnelMode,
      publicUrl,
    });
    if (tunnel) note(chalk.dim("note   requesting an Expo tunnel for this workspace's dev server"));

    const managedRemote = remote && !tunnel && !publicUrl && tunnelMode !== 'off';
    const runStart = async (): Promise<StartFacts> => {
      upsertProject(root, {
        bundleId: detectBundleId(root) ?? undefined,
        androidPackage: detectAndroidPackage(root) ?? undefined,
        isExpo,
      });

      const gateBudget = async () => {
        const budget = await d.budgetGate({ root, note });
        reclaimed = budget.reclaimed;
        if (budget.refusal) return fail(budget.refusal);
      };
      if (resetCache) {
        await gateBudget();
        try {
          await stopOwnedMetroForReset(root);
        } catch (error) {
          const failure = error as Error & { code?: string; remedy?: string };
          return fail({
            code: failure.code ?? 'STIM_WORKSPACE_STATE',
            message: failure.message,
            remedy: failure.remedy,
          });
        }
        note(phaseLine('cache', "clearing this app's Metro transform and file-map caches; devices preserved"));
      }

      const logsDir = workspaceLogsDir(root);
      const logFile = supervisorLogFile(root);
      const port = await resolvePort(root, note);
      let publicOrigin = remote ? publicUrl : null;
      let resolution = await resolveProjectMetro(port, root);
      let supervisor = liveSupervisor({ state: readWorkspaceState(root), project: getProject(root), port });
      const recordedTarget = resolveSupervisorTarget({
        state: readWorkspaceState(root)?.supervisor,
        record: getProject(root)?.supervisor,
        reservedPort: port,
      });
      if (recordedTarget.status === 'unverified') {
        return fail({
          code: 'STIM_SUPERVISOR_EXITED',
          message: `Cannot reuse or replace the recorded supervisor: ${recordedTarget.reason}.`,
          remedy:
            'Stop it with the tool that started it, then retry `stim start`. Stim leaves unverified processes alone.',
        });
      }
      if (!resetCache && !resolution.metro && !supervisor) await gateBudget();
      let managedTunnel: ManagedTunnelTracking | null = null;
      let spawnedChild: SupervisorProcess | null = null;
      let spawnedTs: number | null = null;
      let childExit: ChildExitInfo | null = null;

      const spawnDirect = (supervisorArgs: string[], childEnv: NodeJS.ProcessEnv): SupervisorProcess => {
        const fd = openSync(logFile, 'a');
        const child = getExecutor().spawn(process.execPath, supervisorArgs, {
          cwd: root,
          detached: true,
          stdio: ['ignore', fd, fd],
          env: childEnv,
        });
        child.unref?.();
        child.on?.('exit', (code, signal) => {
          childExit = { code, signal };
        });
        child.on?.('error', (err) => {
          childExit = { code: null, signal: null, error: err };
        });
        return child;
      };

      const recordedSupervisorPid = async (since: number): Promise<number | null> => {
        const deadline = Date.now() + RECORDED_SUPERVISOR_WAIT_MS;
        while (Date.now() < deadline) {
          const record = readWorkspaceState(root)?.supervisor as SupervisorStateRecord | undefined;
          if (
            record?.pid &&
            record.port === port &&
            Date.parse(String(record.startedAt)) >= since &&
            pidExists(record.pid)
          )
            return record.pid;
          await sleep(25);
        }
        return null;
      };

      // See windowsLauncherArgs: the direct child is a PowerShell process that exits once the
      // supervisor is started, so liveness comes from the record the supervisor writes.
      const spawnThroughWindowsShell = async (
        supervisorArgs: string[],
        childEnv: NodeJS.ProcessEnv,
      ): Promise<SupervisorProcess> => {
        const [entry, ...args] = supervisorArgs as [string, ...string[]];
        const launcher = windowsLauncherArgs({ entry, args, cwd: root, logFile });
        const since = Date.now();
        const shell = getExecutor().spawn(launcher.file, launcher.args, {
          cwd: root,
          stdio: ['ignore', 'ignore', 'pipe'],
          env: { ...childEnv, ...launcher.env },
          windowsHide: true,
        });
        const stderr: string[] = [];
        shell.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
        const exit = await new Promise<ChildExitInfo>((resolve) => {
          shell.on?.('close', (code, signal) => resolve({ code, signal }));
          shell.on?.('error', (error) => resolve({ code: null, signal: null, error }));
        });
        const launcherFailed = exit.code !== 0 || exit.error;
        const pid = launcherFailed ? null : await recordedSupervisorPid(since);
        if (pid === null) {
          const reason = launcherFailed
            ? `the supervisor launcher exited (${exit.error ? exit.error.message : `code ${exit.code}`})`
            : `the supervisor did not record itself within ${RECORDED_SUPERVISOR_WAIT_MS / 1000}s`;
          appendFileSync(logFile, `Stim start: ${reason}.\n${stderr.join('')}`);
          childExit = { code: exit.code, signal: exit.signal, ...(exit.error ? { error: exit.error } : {}) };
        }
        return recordedSupervisorProcess(pid ?? undefined);
      };

      const spawnSupervisor = async (origin: string | null): Promise<SupervisorProcess> => {
        mkdirSync(logsDir, { recursive: true });
        spawnedTs = Date.now();
        const supervisorArgs = [
          supervisorEntry(),
          '--root',
          root,
          '--port',
          String(port),
          ...(tunnel ? ['--tunnel'] : []),
          ...(resetCache ? ['--reset-cache'] : []),
          '--idle-stop-minutes',
          String(metroIdleStopMinutesSetting(settings)),
        ];
        const childEnv: NodeJS.ProcessEnv = {
          ...process.env,
          ...(origin ? { [PUBLIC_METRO_ENV]: origin, EXPO_PACKAGER_PROXY_URL: origin } : {}),
        };
        childEnv[CACHE_PROVIDER_ENV] = cacheProviderEnv(cacheProvider);
        const child =
          d.platform === 'win32'
            ? await spawnThroughWindowsShell(supervisorArgs, childEnv)
            : spawnDirect(supervisorArgs, childEnv);
        out(
          chalk.dim(
            phaseLine(
              'metro',
              `starting on port ${port} (${isExpo ? 'expo-child' : 'bare-inproc'}, supervisor pid ${child.pid})`,
            ),
          ),
        );
        spawnedChild = child;
        return child;
      };

      const waitForSupervisorHandoff = async (child: SupervisorProcess): Promise<LiveSupervisor | null> => {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const found = liveSupervisor({ state: readWorkspaceState(root), project: getProject(root), port });
          if (found?.pid === child.pid) return found;
          if (childExit !== null || (child.pid ? !pidExists(child.pid) : true)) return null;
          await sleep(25);
        }
        return null;
      };

      if (remote && !tunnel && !publicUrl && tunnelMode !== 'off') {
        const available = d.providers();
        const plan = planMetroReach({ mode: tunnelMode, metroPort: port, publicUrl, isExpo, available });
        if ('failed' in plan) {
          return fail({ code: 'STIM_REMOTE_METRO_UNREACHABLE', message: plan.failed, remedy: plan.remedy });
        }
        if ('start' in plan) {
          const candidates: readonly ManagedProvider[] = tunnelMode === 'auto' ? available : [plan.start];
          const expectedStableUrl = ngrokUrlSetting(settings);
          let acquisition: ManagedTunnelAcquisition;
          try {
            acquisition = await d.withTunnelLock(root, async () => {
              let tracking: ManagedTunnelTracking;
              let startedCleanup: (() => Promise<{ status: 'stopped' | 'failed'; reason?: string }>) | null = null;
              const recorded = readMetroTunnel(root);
              if (recorded?.kind === 'managed' && d.isTunnelAlive(recorded.pid)) {
                if (!recorded.processToken) {
                  return {
                    failed: {
                      code: 'STIM_REMOTE_START_REQUIRED',
                      message: 'The recorded managed Metro tunnel has no process identity token.',
                      remedy:
                        'Inspect the process, stop it with the provider tooling, remove the stale metroTunnel state, and retry.',
                    },
                  };
                }
                const reusable =
                  recorded.port === port &&
                  candidates.includes(recorded.provider) &&
                  (!expectedStableUrl || normalizeManagedTunnelUrl(recorded.url) === expectedStableUrl);
                if (!reusable) {
                  return {
                    failed: {
                      code: 'STIM_REMOTE_START_REQUIRED',
                      message: `A different managed Metro tunnel is already running for this workspace.`,
                      remedy: 'Run `stim stop`, then `stim start --remote`.',
                    },
                  };
                }
                tracking = {
                  record: {
                    provider: recorded.provider,
                    pid: recorded.pid,
                    url: normalizeManagedTunnelUrl(recorded.url),
                    port: recorded.port,
                    startedAt: recorded.startedAt,
                    processToken: recorded.processToken,
                    logFile: recorded.logFile,
                  },
                  startedHere: false,
                };
              } else {
                const currentResolution = await resolveProjectMetro(port, root);
                const currentSupervisor = liveSupervisor({
                  state: readWorkspaceState(root),
                  project: getProject(root),
                  port,
                });
                if (currentResolution.metro || currentSupervisor) {
                  return {
                    failed: {
                      code: 'STIM_REMOTE_START_REQUIRED',
                      message: `The dev server on port ${port} is local-only and cannot gain a managed tunnel while it is running.`,
                      remedy: 'Run `stim stop`, then `stim start --remote`.',
                    },
                  };
                }

                const started = await d.startTunnelSequence({
                  providers: candidates,
                  port,
                  ngrokUrl: expectedStableUrl,
                  requireReachable: false,
                });
                if ('failed' in started) {
                  return {
                    failed: {
                      code: 'STIM_REMOTE_METRO_UNREACHABLE',
                      message: `Could not start a managed Metro tunnel for port ${port}.`,
                      remedy: started.reason,
                    },
                  };
                }
                const record: TunnelRecord = {
                  provider: started.provider,
                  pid: started.pid,
                  url: normalizeManagedTunnelUrl(started.url),
                  port,
                  startedAt: new Date().toISOString(),
                  processToken: started.processToken,
                  logFile: started.logFile,
                };
                startedCleanup = started.cleanup;
                try {
                  d.writeTunnelRecord(root, {
                    metroTunnel: {
                      kind: 'managed',
                      ...record,
                    },
                  });
                } catch (err) {
                  const stopped = await started.cleanup();
                  return {
                    failed: {
                      code: 'STIM_REMOTE_METRO_UNREACHABLE',
                      message: `Could not record the managed Metro tunnel: ${(err as Error)?.message || err}`,
                      remedy:
                        stopped.status === 'failed'
                          ? `Cleanup failed. Unmanaged pid ${record.pid} may still be running: ${stopped.reason ?? 'unknown error'}`
                          : 'The tunnel process was stopped. Fix the workspace write error, then retry `stim start --remote`.',
                    },
                  };
                }
                tracking = { record, startedHere: true };
              }

              const currentResolution = await resolveProjectMetro(port, root);
              const currentSupervisor = liveSupervisor({
                state: readWorkspaceState(root),
                project: getProject(root),
                port,
              });
              if (currentResolution.metro || currentSupervisor) {
                if (tracking.startedHere && startedCleanup) {
                  const stopped = await startedCleanup();
                  if (stopped.status === 'failed') {
                    return {
                      failed: {
                        code: 'STIM_REMOTE_START_REQUIRED',
                        message: `The dev server on port ${port} started before the managed tunnel was ready.`,
                        remedy: `Tunnel cleanup failed for pid ${tracking.record.pid}: ${stopped.reason ?? 'unknown error'}. The tunnel record remains available to \`stim stop\`.`,
                      },
                    };
                  }
                  d.clearTunnelRecord(root, tracking.record);
                  return {
                    failed: {
                      code: 'STIM_REMOTE_START_REQUIRED',
                      message: `The dev server on port ${port} started before the managed tunnel was ready.`,
                      remedy: 'Run `stim stop`, then `stim start --remote`.',
                    },
                  };
                }
                return { origin: tracking.record.url, tunnel: tracking };
              }

              if (!d.isTunnelAlive(tracking.record.pid)) {
                if (tracking.startedHere && startedCleanup) {
                  const stopped = await startedCleanup();
                  if (stopped.status === 'failed') {
                    return {
                      failed: {
                        code: 'STIM_REMOTE_METRO_UNREACHABLE',
                        message: `The managed ${tracking.record.provider} tunnel exited before the supervisor started.`,
                        remedy: `Cleanup failed. Unmanaged pid ${tracking.record.pid} may still be running: ${stopped.reason ?? 'unknown error'}. The tunnel record remains available to \`stim stop\`.`,
                      },
                    };
                  }
                }
                d.clearTunnelRecord(root, tracking.record);
                return {
                  failed: {
                    code: 'STIM_REMOTE_METRO_UNREACHABLE',
                    message: `The managed ${tracking.record.provider} tunnel exited before the supervisor started.`,
                    remedy: 'Retry `stim start --remote`.',
                  },
                };
              }

              let child: SupervisorProcess;
              try {
                child = await spawnSupervisor(tracking.record.url);
              } catch (err) {
                return {
                  failed: {
                    code: 'STIM_SUPERVISOR_EXITED',
                    message: `Could not spawn the dev server supervisor: ${(err as Error)?.message || err}`,
                    remedy: 'Fix the spawn error, then retry `stim start --remote`.',
                  },
                };
              }
              const handoffRecord = {
                pid: child.pid as number,
                processToken: child.pid ? captureProcessToken(child.pid) : null,
                port,
                mode: isExpo ? 'expo-child' : 'bare-inproc',
                startedAt: new Date(spawnedTs ?? Date.now()).toISOString(),
              };
              try {
                d.writeSupervisorRecord(root, { supervisor: handoffRecord });
              } catch {
                const handedOff = await waitForSupervisorHandoff(child);
                if (!handedOff) {
                  const stopped = await d.terminateSupervisorChild(child);
                  return {
                    failed: {
                      code: 'STIM_SUPERVISOR_EXITED',
                      message: `Could not record supervisor pid ${child.pid ?? 'unknown'} before releasing the managed start lock.`,
                      remedy: stopped
                        ? 'The supervisor process was stopped. Retry `stim start --remote`.'
                        : `Cleanup failed. Unmanaged supervisor pid ${child.pid ?? 'unknown'} may still be running. Stop it before retrying.`,
                    },
                  };
                }
              }
              return { origin: tracking.record.url, tunnel: tracking };
            });
          } catch (err) {
            return fail({
              code: 'STIM_REMOTE_METRO_UNREACHABLE',
              message: `Could not acquire the managed Metro tunnel lock: ${(err as Error)?.message || err}`,
              remedy: 'Retry `stim start --remote` after the other start command finishes.',
            });
          }
          if ('failed' in acquisition) {
            return fail(acquisition.failed);
          }
          publicOrigin = acquisition.origin;
          managedTunnel = acquisition.tunnel;
          resolution = await resolveProjectMetro(port, root);
          supervisor = liveSupervisor({ state: readWorkspaceState(root), project: getProject(root), port });
        }
      }

      const managedTunnelExited = () => managedTunnel !== null && !d.isTunnelAlive(managedTunnel.record.pid);
      const failExitedManagedTunnel = async (): Promise<never> => {
        const tracked = managedTunnel as ManagedTunnelTracking;
        const record = tracked.record;
        const stopped = tracked.startedHere ? await d.stopTunnel(record) : { status: 'missing' as const };
        if (stopped.status !== 'failed') d.clearTunnelRecord(root, record);
        return fail({
          code: 'STIM_REMOTE_METRO_UNREACHABLE',
          message: `The managed ${record.provider} tunnel exited before the dev server became ready.`,
          remedy:
            stopped.status === 'failed'
              ? `The tunnel cleanup also failed: ${stopped.reason ?? 'unknown error'}. Run \`stim stop\`, then retry.`
              : 'Run `stim stop`, then `stim start --remote`.',
        });
      };

      const requireExpoTunnel = () => {
        if (tunnel && (!supervisor || readMetroTunnel(root)?.kind !== 'expo')) {
          fail({
            code: 'STIM_REMOTE_START_REQUIRED',
            message: `The Expo dev server on port ${port} is local-only and cannot gain a tunnel while it is running.`,
            remedy: 'Run `stim stop`, then `stim start --remote`.',
          });
        }
      };

      if (!spawnedChild && resolution.metro) {
        if (managedTunnelExited()) return failExitedManagedTunnel();
        if (tunnel && supervisor) {
          const tunnelReady = await waitForExpoTunnel({
            root,
            seconds: waitSeconds,
            aborted: () => !liveSupervisor({ state: readWorkspaceState(root), project: getProject(root), port }),
          });
          if (!tunnelReady) {
            const stillLive = liveSupervisor({
              state: readWorkspaceState(root),
              project: getProject(root),
              port,
            });
            return fail({
              code: 'STIM_REMOTE_START_REQUIRED',
              message: stillLive
                ? `The Expo dev server on port ${port} is local-only and cannot gain a tunnel while it is running.`
                : `The Expo dev server on port ${port} stopped before its tunnel became ready.`,
              remedy: stillLive ? 'Run `stim stop`, then `stim start --remote`.' : 'Run `stim start --remote` again.',
            });
          }
          supervisor = liveSupervisor({ state: readWorkspaceState(root), project: getProject(root), port });
        }
        requireExpoTunnel();
        if (!supervisor) {
          note(chalk.dim(`A dev server for this project already answers on port ${port}, started outside Stim.`));
          note(chalk.dim('Leaving it alone: Stim will not start a second bundler over a working one.'));
        }
        if (managedTunnelExited()) return failExitedManagedTunnel();
        clearWorkspaceStateKeys(root, [IDLE_STOP_KEY]);
        return startFacts({ port, supervisor, logsDir, alreadyRunning: true });
      }

      if (!spawnedChild && supervisor) {
        note(
          chalk.dim(
            `Supervisor pid ${supervisor.pid} is already running for this workspace; waiting for it to answer on port ${port}...`,
          ),
        );
        const healthy = await waitForMetro({
          root,
          port,
          seconds: waitSeconds,
          aborted: managedTunnel ? managedTunnelExited : undefined,
        });
        if (!healthy) {
          if (managedTunnelExited()) return failExitedManagedTunnel();
          return fail({
            code: 'STIM_METRO_TIMEOUT',
            message: `Supervisor pid ${supervisor.pid} did not serve port ${port} within ${waitSeconds}s.`,
            lines: logTailLines(logFile),
            remedy: 'Run `stim stop` to halt it, then `stim start` again.',
          });
        }
        if (tunnel) {
          const tunnelReady = await waitForExpoTunnel({
            root,
            seconds: waitSeconds,
            aborted: () => !liveSupervisor({ state: readWorkspaceState(root), project: getProject(root), port }),
          });
          if (!tunnelReady) {
            const stillLive = liveSupervisor({
              state: readWorkspaceState(root),
              project: getProject(root),
              port,
            });
            return fail({
              code: 'STIM_REMOTE_START_REQUIRED',
              message: stillLive
                ? `The Expo dev server on port ${port} is local-only and cannot gain a tunnel while it is running.`
                : `The Expo dev server on port ${port} stopped before its tunnel became ready.`,
              remedy: stillLive ? 'Run `stim stop`, then `stim start --remote`.' : 'Run `stim start --remote` again.',
            });
          }
        }
        supervisor =
          liveSupervisor({ state: readWorkspaceState(root), project: getProject(root), port }) ||
          (tunnel ? null : supervisor);
        requireExpoTunnel();
        if (managedTunnelExited()) return failExitedManagedTunnel();
        return startFacts({ port, supervisor, logsDir, alreadyRunning: true });
      }

      if (managedTunnelExited()) return failExitedManagedTunnel();
      const child = spawnedChild ?? (await spawnSupervisor(publicOrigin));
      const attemptStartedTs = spawnedTs ?? Date.now();

      const healthy = await waitForMetro({
        root,
        port,
        seconds: waitSeconds,
        aborted: () => childExit !== null || (child.pid ? !pidExists(child.pid) : false) || managedTunnelExited(),
      });

      if (!healthy) {
        if (managedTunnelExited()) return failExitedManagedTunnel();
        const gone = childExit !== null || (child.pid ? !pidExists(child.pid) : false);
        const exitInfo = childExit as ChildExitInfo | null;
        const how = exitInfo
          ? exitInfo.signal
            ? `signal ${exitInfo.signal}`
            : `code ${exitInfo.code}`
          : 'without being observed';
        return fail(
          gone
            ? {
                code: 'STIM_SUPERVISOR_EXITED',
                message: `The supervisor exited (${how}) before the dev server came up on port ${port}.`,
                lines: failureEvidence({ logFile, logsDir, sinceTs: attemptStartedTs }),
                remedy: 'Fix the error above and run `stim start` again; `stim logs --errors` has the full records.',
              }
            : {
                code: 'STIM_METRO_TIMEOUT',
                message: `The dev server did not answer on port ${port} within ${waitSeconds}s.`,
                lines: failureEvidence({ logFile, logsDir, sinceTs: attemptStartedTs }),
                remedy: 'It may still be starting. Run `stim stop` to halt it, or `stim logs` to follow along.',
              },
        );
      }

      if (managedTunnelExited()) return failExitedManagedTunnel();

      if (tunnel) {
        const tunnelReady = await waitForExpoTunnel({
          root,
          seconds: waitSeconds,
          aborted: () => childExit !== null || (child.pid ? !pidExists(child.pid) : false),
        });
        if (!tunnelReady) {
          const gone = childExit !== null || (child.pid ? !pidExists(child.pid) : false);
          return fail({
            code: gone ? 'STIM_SUPERVISOR_EXITED' : 'STIM_METRO_TIMEOUT',
            message: gone
              ? `The supervisor exited before the Expo tunnel became ready on port ${port}.`
              : `Expo did not report a tunnel URL within ${waitSeconds}s.`,
            remedy: 'Run `stim stop`, then `stim start --remote`.',
          });
        }
      }

      supervisor = liveSupervisor({ state: readWorkspaceState(root), project: getProject(root), port }) || {
        pid: child.pid as number,
        port,
        mode: null,
        startedAt: null,
      };
      return startFacts({ port, supervisor, logsDir, alreadyRunning: false });
    };

    const startLocked = async () => {
      try {
        return await withWorkspaceProcessLock(dirname(workspaceLogsDir(root)), 'metro-start', runStart, {
          external: true,
        });
      } catch (error) {
        if (workspaceProcessLockError(error) !== 'timeout') throw error;
        return fail({
          code: 'STIM_METRO_TIMEOUT',
          message: 'Another Metro start or reset is still running for this app.',
          remedy: 'Wait for it to finish, then retry `stim start`.',
        });
      }
    };
    if (!managedRemote) return startLocked();
    try {
      return await d.withWorktreeLock(worktreeRoot, startLocked);
    } catch (err) {
      const lockError = workspaceProcessLockError(err);
      if (lockError === 'refused') {
        return fail({
          code: 'STIM_WORKTREE_REMOVAL_IN_PROGRESS',
          message: `The worktree at ${worktreeRoot} is being removed.`,
          remedy: 'Retry `stim start --remote` after `stim worktree remove` finishes.',
        });
      }
      if (lockError === 'timeout') {
        return fail({
          code: 'STIM_REMOTE_METRO_UNREACHABLE',
          message: `Could not acquire the managed remote worktree lock: ${(err as Error)?.message || err}`,
          remedy: 'Retry `stim start --remote` after the other remote start command finishes.',
        });
      }
      throw err;
    }
  };
  try {
    const facts = await run();
    return { ok: true, facts, waited: waitTimer(), reclaimed };
  } catch (error) {
    if (!(error instanceof StartRefusal)) throw error;
    return { ok: false, error: startError(error.refusal), lines: error.refusal.lines ?? [], reclaimed };
  }
}

async function resolvePort(root: string, note: (line: string) => void): Promise<number> {
  const project = getProject(root);
  const recorded = project?.metroPort;
  if (!recorded) return await reserveMetroPort(root);
  const supervisor = resolveSupervisorTarget({
    state: readWorkspaceState(root)?.supervisor,
    record: project.supervisor,
    reservedPort: recorded,
  });
  if (supervisor.status !== 'none' && supervisor.status !== 'stale') return recorded;
  const held = await resolveProjectMetro(recorded, root);
  if (!held.notOurs) return recorded;
  const fresh = await reserveMetroPort(root);
  if (fresh !== recorded) {
    note(chalk.yellow(`Port ${recorded} is held by something else (${held.notOurs}).`));
    note(chalk.dim(`Reserved port ${fresh} for this project instead.`));
  }
  return fresh;
}

async function waitForMetro({
  root,
  port,
  seconds,
  aborted = () => false,
  probe = resolveProjectMetro,
}: {
  root: string;
  port: number;
  seconds: number;
  aborted?: () => boolean;
  probe?: (port: number, root: string) => Promise<MetroResolution>;
}): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const resolution = await probe(port, root);
    if (resolution.metro) return true;
    if (aborted()) return false;
    await sleep(POLL_MS);
  }
  const last = await probe(port, root);
  return Boolean(last.metro);
}

async function waitForExpoTunnel({
  root,
  seconds,
  aborted = () => false,
}: {
  root: string;
  seconds: number;
  aborted?: () => boolean;
}): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (aborted()) return false;
    if (readMetroTunnel(root)?.kind === 'expo') return true;
    await sleep(POLL_MS);
  }
  return !aborted() && readMetroTunnel(root)?.kind === 'expo';
}

function logTailLines(logFile: string): string[] {
  return [...readLogTail(logFile), `Supervisor log: ${logFile}`];
}

export function failureEvidence({
  logFile,
  logsDir,
  sinceTs,
}: {
  logFile: string;
  logsDir: string;
  sinceTs: number;
}): string[] {
  const supTail = readLogTail(logFile);
  const lines = supTail.length > 0 ? [...supTail, `Supervisor log: ${logFile}`] : [];
  let errors: ReturnType<typeof queryLogs> = [];
  let all: ReturnType<typeof queryLogs> = [];
  try {
    all = queryLogs({ dir: logsDir });
    errors = all.filter((record) => levelRank(record.level) >= levelRank('error'));
  } catch {}
  const since = (rs: ReturnType<typeof queryLogs>) =>
    rs.filter((r) => typeof r.ts === 'number' && r.ts >= sinceTs).slice(-ERROR_EVIDENCE_RECORDS);
  let recent = since(errors);
  const fellBack = recent.length === 0;
  if (fellBack) recent = since(all);
  for (const r of recent) {
    lines.push(`${String(r.src ?? '?')}: ${String(r.msg ?? '').split('\n')[0] ?? ''}`);
  }
  if (recent.length > 0) lines.push(fellBack ? 'Full records: `stim logs`' : 'Full records: `stim logs --errors`');
  return lines;
}

function report({
  json,
  out,
  facts,
  waited,
  reclaimed,
}: {
  json: boolean;
  out: (line: string) => void;
  facts: StartFacts;
  waited: string;
  reclaimed: ReclaimedStep[];
}): void {
  if (json) {
    console.log(JSON.stringify(reclaimed.length ? { ...facts, reclaimed } : facts));
    return;
  }
  const who = facts.supervisorPid
    ? `supervisor pid ${facts.supervisorPid}${facts.mode ? ` (${facts.mode})` : ''}`
    : 'started outside Stim';
  out(
    chalk.green(
      `OK: dev server on port ${facts.port}, ${who}${facts.alreadyRunning ? ' (already running)' : ''} ${waited}`,
    ),
  );
  out(chalk.dim(phaseLine('logs', facts.logsDir)));
}
