import chalk from 'chalk';
import { exitCli, runProcessOperation } from '../cli-operation.ts';
import { restoreLightenedDependencies } from '../workspace/lightened.ts';
import { withDrainingCancellation } from '../engine/operation-state.ts';
import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import { phaseLine, stepTimer } from '../command-output.ts';
import type { StartError, StartFacts } from '../stimd/metro/start-facts.ts';
import { type WorkspaceLinks, workspaceLinkLine, workspaceLinks } from '../devices/stim-desktop.ts';
import { getProject, releaseMetroPort, upsertProject, withConfigLockAsync } from '../workspace/config.ts';
import { getExecutor } from '../exec.ts';
import { listeningPidsAsync, pidExists, processCwds, resolveProjectMetro } from '../metro.ts';
import { captureProcessToken, inspectProcessIdentity, type ProcessRecord } from '../process-identity.ts';
import { resolveSupervisorTarget, type SupervisorStateRecord } from '../stimd/metro/ownership.ts';
import type { MetroResolution } from '../metro.ts';
import { IDLE_STOP_KEY, queryLogs, trace } from '@stim-cli/core/state';
import { levelRank } from '../ndjson.ts';
import { ensureWorkspaceStorage, workspaceLogsDir, workspaceAgentDeviceDir } from '../workspace/paths.ts';
import { createPortProbe, isMetroRunning, reserveMetroPort } from '../ports.ts';
import { PORT_INSPECTION_REMEDY, PortInspectionError } from '../listening-ports.ts';
import { projectProblem, detectIsExpo, findProjectRoot, NO_PROJECT_REFUSAL } from '../workspace/project.ts';
import { detectAppIds } from '../workspace/app-id.ts';
import { remoteCliInvocation } from '../engine/node-cli.ts';
import { writeAgentDeviceBootHook } from '../engine/agent-device.ts';
import { MODE_BARE, MODE_COMMAND, MODE_EXPO, clearManagedMetroTunnel, readMetroTunnel } from '../stimd/metro/state.ts';
import {
  clearWorkspaceStateKeys,
  readWorkspaceState,
  recordWorkspaceUse,
  writeWorkspaceState,
  updateWorkspaceStateAsync,
  withWorkspaceStateLockAsync,
} from '../workspace/workspace-state.ts';
import {
  WorkspaceProcessCleanupError,
  workspaceProcessLockError,
  withWorkspaceProcessLock,
} from '../engine/workspace-process-lock.ts';
import {
  clearClaimChild,
  markClaimChildPending,
  processGroupAlive,
  setClaimChild,
  type ClaimHandle,
} from '../ownership-claim.ts';
import { stopOwnedMetroForReset } from '../stimd/metro/cache-reset.ts';
import { ensureMetroThroughStimd } from '../daemon/client.ts';
import {
  publicUrlSetting,
  ngrokUrlSetting,
  metroPortSetting,
  metroCommandSetting,
  metroCommandSettingError,
  metroTunnelSettingError,
  remoteAndroidSetting,
  cacheProviderSettingError,
  remoteIosSetting,
  resolveAndroidLayout,
  resolveIosProjectDir,
  resolveProjectSettingsAsync,
  SETTING_SHAPE_REMEDY,
  settingShapeErrors,
  tunnelModeSetting,
  inertSettingWarning,
  unknownSettingKeys,
  type ProjectSettingsContext,
  type SettingsObject,
} from '../workspace/settings.ts';
import { detectProviders, planMetroReach, type ManagedProvider } from '../engine/metro-reach.ts';
import {
  startTunnelSequence,
  stopTunnel,
  withManagedRemoteWorktreeLock,
  withManagedTunnelLock,
  type StartTunnelSequenceOptions,
  type StartTunnelSequenceResult,
  type TunnelRecord,
} from '../engine/tunnel.ts';
import type { ReclaimObserver } from '../stimd/passes/budget.ts';
import { diskFloorGate } from '../daemon/floor.ts';
import { cancellableSleep, throwIfCancelled } from '../cancellation.ts';
import { groupExitBudgetMs } from '../process-group-exit.ts';
import { ambientContext, ambientEnv } from '@stim-cli/core';

const DEFAULT_WAIT_SECONDS = 60;
const POLL_MS = 500;
const LOG_TAIL_LINES = 5;
const ERROR_EVIDENCE_RECORDS = 8;

async function resolveStartupMetro(port: number, root: string): Promise<MetroResolution> {
  const signal = ambientContext()?.signal;
  throwIfCancelled(signal, 'Metro startup');
  const result = await resolveProjectMetro(port, root, {
    pidsOf: (candidate) => listeningPidsAsync(candidate, process.platform, signal),
    cwdOf: async (pid) => (await processCwds([pid], signal)).get(pid) ?? null,
    probe: (candidate) => isMetroRunning(candidate, signal),
  });
  throwIfCancelled(signal, 'Metro startup');
  return result;
}

function waitForStartup(ms: number): Promise<void> {
  return cancellableSleep(ms, { signal: ambientContext()?.signal, what: 'Metro startup' });
}

function writeNote(line: string): void {
  console.error(line);
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
  root,
  port,
  supervisor,
  logsDir,
  alreadyRunning,
}: {
  port: number;
  supervisor?: Pick<LiveSupervisor, 'pid' | 'mode'> | null;
  logsDir: string;
  root?: string;
  alreadyRunning?: unknown;
}): StartFacts {
  return {
    port,
    supervisorPid: supervisor?.pid ?? null,
    mode: supervisor?.mode ?? null,
    logsDir,
    ...(root ? { agentDevice: { stateDir: workspaceAgentDeviceDir(root) } } : {}),
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
  providers(mode: Parameters<typeof detectProviders>[1]): ManagedProvider[];
  startTunnelSequence(options: StartTunnelSequenceOptions): Promise<StartTunnelSequenceResult>;
  isTunnelAlive(pid: number, processToken?: string | null): boolean;
  writeTunnelRecord(root: string, patch: Parameters<typeof writeWorkspaceState>[1]): unknown;
  stopTunnel(record: TunnelRecord): ReturnType<typeof stopTunnel>;
  ensureMetro: typeof ensureMetroThroughStimd;
  withWorktreeLock: typeof withManagedRemoteWorktreeLock;
  withTunnelLock: typeof withManagedTunnelLock;
  clearTunnelRecord(root: string, record: TunnelRecord): unknown;
  diskFloorGate: typeof diskFloorGate;
  platform: NodeJS.Platform;
}

function providersOnPath(mode: Parameters<typeof detectProviders>[1]): ManagedProvider[] {
  return detectProviders((bin) => {
    try {
      return Boolean(getExecutor().findExecutable(bin));
    } catch {
      return false;
    }
  }, mode);
}

const DEFAULT_START_DEPS: StartCommandDeps = {
  providers: providersOnPath,
  startTunnelSequence,
  isTunnelAlive: (pid, processToken) =>
    processToken === undefined ? pidExists(pid) : inspectProcessIdentity({ pid, processToken }) === 'same',
  writeTunnelRecord: (root, patch) => updateWorkspaceStateAsync(root, (state) => ({ ...state, ...patch })),
  stopTunnel,
  ensureMetro: ensureMetroThroughStimd,
  withWorktreeLock: withManagedRemoteWorktreeLock,
  withTunnelLock: withManagedTunnelLock,
  clearTunnelRecord: (root, record) => withWorkspaceStateLockAsync(root, () => clearManagedMetroTunnel(root, record)),
  diskFloorGate,
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
      "Start this workspace's dev server, run by this home's stimd, and wait until it verifies as this project's. " +
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
        exitCode = 1,
      }: {
        code: string;
        message: string;
        remedy?: string | null;
        lines?: string[];
        exitCode?: number;
      }): never => {
        note(chalk.red(message));
        for (const line of lines) note(chalk.dim(`  ${line}`));
        if (remedy) note(chalk.dim(remedy));
        note(chalk.red(`failed: ${code}`));
        if (json) {
          console.log(JSON.stringify(startError({ code, message, remedy })));
        }
        exitCli(exitCode);
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
      const lightened = (await runProcessOperation(root, (context) => restoreLightenedDependencies(root, context)))
        .value;
      if (lightened) return fail(lightened);
      const problem = projectProblem(root, 'dev-server');
      if (problem) {
        return fail({
          code: 'STIM_NO_PROJECT',
          message: problem.message,
          remedy: problem.remedy,
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

      const { context: settingsContext, settings } = await resolveProjectSettingsAsync(root);
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
        note(chalk.yellow(inertSettingWarning(settings, key)));
      }
      const cacheProviderError = cacheProviderSettingError(settings);
      if (cacheProviderError) note(chalk.yellow(`Warning: ${cacheProviderError} No cache provider is used.`));
      const { value: result, interrupted } = await runProcessOperation(root, (context) =>
        withDrainingCancellation(context, context.signal, async () => {
          try {
            return await startDevServer(
              {
                root,
                settings,
                settingsContext,
                waitSeconds,
                remote: Boolean(opts.remote),
                resetCache: Boolean(opts.resetCache),
                out,
                note,
              },
              d,
            );
          } catch (error) {
            if (!(error instanceof Error) || !('code' in error) || error.code !== 'STIM_CANCELLED') throw error;
            return {
              ok: false as const,
              error: startError({ code: 'STIM_CANCELLED', message: error.message }),
              lines: [],
            };
          }
        }),
      );
      if (!result.ok) return fail({ ...result.error, lines: result.lines, exitCode: interrupted ?? 1 });
      report({
        json,
        out,
        facts: result.facts,
        waited: result.waited,
        links: await workspaceLinks(root),
      });
      if (interrupted !== null) exitCli(interrupted);
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

class MetroPortRace extends StartRefusal {
  readonly port: number;
  constructor(refusal: StartRefusalArgs, port: number) {
    super(refusal);
    this.port = port;
  }
}

const PORT_RACE_ATTEMPTS = 3;

function portBindRace(lines: readonly string[], port: number): boolean {
  const bind = new RegExp(`EADDRINUSE\\b.*:${port}\\b`);
  return lines.some((line) => bind.test(line));
}

export interface StartDevServerRequest {
  onReclaim?: ReclaimObserver;
  root: string;
  settings: SettingsObject;
  settingsContext: ProjectSettingsContext;
  waitSeconds?: number;
  remote?: boolean;
  resetCache?: boolean;
  /** The Mac a hosted Expo dev client will run on; a new port must be free there too. */
  hostedPorts?: HostedMetroPorts;
  out: (line: string) => void;
  note: (line: string) => void;
}

export interface HostedMetroPorts {
  machine: string;
  free: (port: number) => Promise<boolean>;
  busy: (port: number) => StartError;
}

export type StartDevServerResult =
  | { ok: true; facts: StartFacts; waited: string }
  | { ok: false; error: StartError; lines: string[]; retainedClaimRoots?: string[] };

export async function startDevServer(
  {
    root,
    settings,
    settingsContext,
    waitSeconds = DEFAULT_WAIT_SECONDS,
    remote: remoteFlag = false,
    resetCache = false,
    hostedPorts,
    onReclaim,
    out,
    note,
  }: StartDevServerRequest,
  overrides: Partial<StartCommandDeps> = {},
): Promise<StartDevServerResult> {
  const d = { ...DEFAULT_START_DEPS, ...overrides };
  const operationSignal = ambientContext()?.signal;
  throwIfCancelled(operationSignal, 'Metro startup');
  const waitTimer = stepTimer();
  const fail = (refusal: StartRefusalArgs): never => {
    throw new StartRefusal(refusal);
  };
  const isExpo = detectIsExpo(root);
  const metroCommand = metroCommandSetting(settings);
  const serverMode = metroCommand ? MODE_COMMAND : isExpo ? MODE_EXPO : MODE_BARE;
  const expoServer = serverMode === MODE_EXPO;
  const worktreeRoot = settingsContext.repoRoot ?? root;
  const run = async (): Promise<StartFacts> => {
    const settingError = metroTunnelSettingError(settings);
    if (settingError) {
      return fail({
        code: 'STIM_BAD_ARG',
        message: settingError,
        remedy: 'Set metro.tunnel to "ngrok" and metro.ngrokUrl to an HTTPS URL, or remove metro.ngrokUrl.',
      });
    }
    if (metroCommand && d.platform === 'win32') {
      return fail({
        code: 'STIM_BAD_ARG',
        message:
          'metro.command is not supported on Windows: Stim cannot read a process working directory there, so it cannot prove the Metro a wrapper starts belongs to this app.',
        remedy: 'Remove metro.command on Windows, or run this app from macOS or Linux.',
      });
    }
    if (metroCommand && resetCache) {
      return fail({
        code: 'STIM_BAD_ARG',
        message: '--reset-cache cannot reach a dev server started by metro.command; Stim does not know its reset flag.',
        remedy:
          "Add the command's own cache-reset flag to metro.command (for React Native, --reset-cache), then run stim stop and stim start.",
      });
    }
    const commandError = metroCommandSettingError(settings);
    if (commandError) {
      return fail({
        code: 'STIM_BAD_ARG',
        message: commandError,
        remedy:
          'Set metro.command to the argv that starts the dev server, e.g. ["npx", "react-native", "start", "--port", "{port}"], or remove it.',
      });
    }
    const remote =
      remoteFlag ||
      remoteIosSetting(settings)?.kind === 'backend' ||
      remoteAndroidSetting(settings)?.kind === 'backend';
    const tunnelMode = tunnelModeSetting(settings) ?? 'auto';
    const publicUrl = publicUrlSetting(settings);
    const tunnel = wantsExpoOwnTunnel({
      isExpo: expoServer,
      remote,
      mode: tunnelMode,
      publicUrl,
    });
    if (tunnel) note(chalk.dim("note   requesting an Expo tunnel for this workspace's dev server"));

    const managedRemote = remote && !tunnel && !publicUrl && tunnelMode !== 'off';
    const runStart = async (claim: ClaimHandle, tunnelClaim: ClaimHandle): Promise<StartFacts> => {
      const claims = [claim, tunnelClaim];
      const appIds = await detectAppIds(
        root,
        resolveIosProjectDir(settings, root).dir,
        resolveAndroidLayout(settings, root, settingsContext.repoRoot ?? root).moduleDir,
        {
          context: ambientContext(),
          run: async (file, args, options) => {
            for (const held of claims) markClaimChildPending(held);
            let child: ChildProcess | undefined;
            let identity: ProcessRecord | undefined;
            let output = '';
            let failure: { error: unknown } | undefined;
            try {
              const invocation = remoteCliInvocation(file, args, 'expo');
              output = await getExecutor().runFileAsync(invocation.file, invocation.args, {
                ...options,
                cwd: root,
                containProcessTree: true,
                signal: operationSignal ?? new AbortController().signal,
                onSpawn: (spawned) => {
                  child = spawned;
                  if (!spawned.pid) return;
                  const processToken = captureProcessToken(spawned.pid);
                  if (!processToken) throw new Error('Cannot record the Expo config process identity.');
                  identity = { pid: spawned.pid, processToken };
                  for (const held of claims) setClaimChild(held, identity);
                },
              });
            } catch (error) {
              failure = { error };
            }
            const pid = child?.pid;
            if (pid) {
              const alive = () =>
                d.platform === 'win32'
                  ? !identity || inspectProcessIdentity(identity) !== 'gone'
                  : processGroupAlive(pid);
              const deadline = Date.now() + groupExitBudgetMs();
              while (alive() && Date.now() < deadline) await cancellableSleep(25);
              if (alive())
                throw new WorkspaceProcessCleanupError(
                  claims,
                  `Could not confirm cleanup of Expo config process ${pid}.`,
                  'Inspect and stop the Expo config process and its helpers before retrying.',
                );
            }
            for (const held of claims) clearClaimChild(held);
            if (failure) throw failure.error;
            return output;
          },
        },
      );
      await withConfigLockAsync(() => {
        upsertProject(root, {
          bundleId: appIds.bundleId ?? undefined,
          androidPackage: appIds.androidPackage ?? undefined,
          isExpo,
        });
      }, operationSignal);

      const gateBudget = async () => {
        const budget = await d.diskFloorGate({ root, note, env: ambientEnv(), signal: operationSignal, onReclaim });
        if (budget.refusal) return fail(budget.refusal);
      };
      if (resetCache) {
        await gateBudget();
        const pin = metroPortSetting(settings, ambientEnv());
        if (pin.port !== null || pin.error) {
          const pinCheck = await resolveWorkspaceMetroPort(root, settings, note, 'start', false);
          if (typeof pinCheck !== 'number') return fail(pinCheck);
        }
        try {
          await stopOwnedMetroForReset(root, operationSignal);
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
      const metroOutput = join(logsDir, 'metro.stderr.log');
      const port = await resolvePort(root, settings, note, fail, hostedPorts);
      let publicOrigin = remote ? publicUrl : null;
      let resolution = await resolveStartupMetro(port, root);
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
      let tunnelPending: WorkspaceProcessCleanupError | null = null;
      const metro: { request: MetroRequest | null } = { request: null };

      const startMetro = (origin: string | null): MetroRequest => {
        const cancel = new AbortController();
        const request: MetroRequest = { since: Date.now(), answer: undefined, cancel };
        void (async () => {
          try {
            request.answer = await d.ensureMetro(
              { root, port, tunnel, publicOrigin: origin, resetCache },
              waitSeconds * 1000 + METRO_ANSWER_SLACK_MS,
              ambientContext(),
              operationSignal ? AbortSignal.any([operationSignal, cancel.signal]) : cancel.signal,
            );
          } catch {
            request.answer = null;
          }
        })();
        metro.request = request;
        out(chalk.dim(phaseLine('metro', `starting on port ${port} (${serverMode})`)));
        return request;
      };

      const attempt = async (): Promise<StartFacts> => {
        if (remote && !tunnel && !publicUrl && tunnelMode !== 'off') {
          const available = d.providers(tunnelMode);
          const plan = planMetroReach({ mode: tunnelMode, metroPort: port, publicUrl, isExpo: expoServer, available });
          if ('failed' in plan) {
            return fail({ code: 'STIM_REMOTE_METRO_UNREACHABLE', message: plan.failed, remedy: plan.remedy });
          }
          if ('start' in plan) {
            const candidates: readonly ManagedProvider[] =
              tunnelMode === 'auto' ? available.filter((provider) => provider !== 'tailscale') : [plan.start];
            const expectedStableUrl = ngrokUrlSetting(settings);
            let acquisition: ManagedTunnelAcquisition;
            try {
              acquisition = await (async (): Promise<ManagedTunnelAcquisition> => {
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
                  if (!d.isTunnelAlive(recorded.pid, recorded.processToken))
                    return {
                      failed: {
                        code: 'STIM_REMOTE_START_REQUIRED',
                        message: `The recorded ${recorded.provider} tunnel pid ${recorded.pid} no longer has its recorded process identity.`,
                        remedy: 'Run `stim stop`, resolve any ownership refusal, then retry `stim start --remote`.',
                      },
                    };
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
                  const currentResolution = await resolveStartupMetro(port, root);
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

                  throwIfCancelled(operationSignal, 'Metro tunnel startup');
                  for (const held of claims) markClaimChildPending(held);
                  tunnelPending = new WorkspaceProcessCleanupError(
                    claims,
                    'A new managed Metro tunnel could not be recorded or confirmed stopped.',
                    'Inspect and stop the tunnel with its provider tooling before retrying.',
                  );
                  const started = await d.startTunnelSequence({
                    claims,
                    signal: operationSignal,
                    providers: candidates,
                    port,
                    ngrokUrl: expectedStableUrl,
                    requireReachable: false,
                  });
                  if ('failed' in started) {
                    if (started.cleanupFailed) {
                      tunnelPending = new WorkspaceProcessCleanupError(
                        claims,
                        started.reason,
                        'Stop the tunnel with its provider tooling before retrying.',
                      );
                      throw tunnelPending;
                    }
                    for (const held of claims) clearClaimChild(held);
                    tunnelPending = null;
                    throwIfCancelled(operationSignal, 'Metro tunnel startup');
                    return {
                      failed: {
                        code: 'STIM_REMOTE_METRO_UNREACHABLE',
                        message: `Could not start a managed Metro tunnel for port ${port}.`,
                        remedy: started.reason,
                      },
                    };
                  }
                  for (const held of claims)
                    setClaimChild(held, { pid: started.pid, processToken: started.processToken });
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
                    await d.writeTunnelRecord(root, {
                      metroTunnel: {
                        kind: 'managed',
                        ...record,
                      },
                    });
                    const stored = readMetroTunnel(root);
                    if (
                      stored?.kind !== 'managed' ||
                      stored.pid !== record.pid ||
                      stored.processToken !== record.processToken ||
                      stored.port !== record.port ||
                      stored.provider !== record.provider ||
                      stored.url !== record.url
                    ) {
                      throw new Error('The workspace did not retain this tunnel ownership record.');
                    }
                    for (const held of claims) clearClaimChild(held);
                    tunnelPending = null;
                  } catch (err) {
                    const recordError = err instanceof Error ? err.message : String(err);
                    const stopped = await started.cleanup();
                    if (stopped.status === 'stopped') {
                      for (const held of claims) clearClaimChild(held);
                      tunnelPending = null;
                    } else {
                      tunnelPending = new WorkspaceProcessCleanupError(
                        claims,
                        `Could not record the managed Metro tunnel: ${recordError}`,
                        `Cleanup failed. Unmanaged pid ${record.pid} may still be running: ${stopped.reason ?? 'unknown error'}`,
                      );
                    }
                    return {
                      failed: {
                        code: 'STIM_REMOTE_METRO_UNREACHABLE',
                        message: `Could not record the managed Metro tunnel: ${recordError}`,
                        remedy:
                          stopped.status === 'failed'
                            ? `Cleanup failed. Unmanaged pid ${record.pid} may still be running: ${stopped.reason ?? 'unknown error'}`
                            : 'The tunnel process was stopped. Fix the workspace write error, then retry `stim start --remote`.',
                      },
                    };
                  }
                  tracking = { record, startedHere: true };
                }

                const currentResolution = await resolveStartupMetro(port, root);
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
                    await d.clearTunnelRecord(root, tracking.record);
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

                if (!d.isTunnelAlive(tracking.record.pid, tracking.record.processToken)) {
                  if (tracking.startedHere && startedCleanup) {
                    const stopped = await startedCleanup();
                    if (stopped.status === 'failed') {
                      return {
                        failed: {
                          code: 'STIM_REMOTE_METRO_UNREACHABLE',
                          message: `The managed ${tracking.record.provider} tunnel is no longer verified running before supervisor startup.`,
                          remedy: `Cleanup failed. Unmanaged pid ${tracking.record.pid} may still be running: ${stopped.reason ?? 'unknown error'}. The tunnel record remains available to \`stim stop\`.`,
                        },
                      };
                    }
                  }
                  await d.clearTunnelRecord(root, tracking.record);
                  return {
                    failed: {
                      code: 'STIM_REMOTE_METRO_UNREACHABLE',
                      message: `The managed ${tracking.record.provider} tunnel is no longer verified running before supervisor startup.`,
                      remedy: 'Retry `stim start --remote`.',
                    },
                  };
                }

                startMetro(tracking.record.url);
                return { origin: tracking.record.url, tunnel: tracking };
              })();
            } catch (err) {
              if (err instanceof WorkspaceProcessCleanupError) throw err;
              throwIfCancelled(operationSignal, 'Metro startup');
              if (err instanceof Error && 'code' in err && err.code === 'STIM_CANCELLED') throw err;
              return fail({
                code: 'STIM_REMOTE_METRO_UNREACHABLE',
                message: `Could not start the managed Metro tunnel: ${(err as Error)?.message || err}`,
                remedy: 'Retry `stim start --remote` after the other start command finishes.',
              });
            }
            if ('failed' in acquisition) {
              return fail(acquisition.failed);
            }
            publicOrigin = acquisition.origin;
            managedTunnel = acquisition.tunnel;
            if (managedTunnel.record.provider === 'tailscale') {
              note(phaseLine('lan', `tailnet-only Metro: ${publicOrigin}`));
            }
            resolution = await resolveStartupMetro(port, root);
            supervisor = liveSupervisor({ state: readWorkspaceState(root), project: getProject(root), port });
          }
        }

        const managedTunnelExited = () =>
          managedTunnel !== null && !d.isTunnelAlive(managedTunnel.record.pid, managedTunnel.record.processToken);
        const failExitedManagedTunnel = async (): Promise<never> => {
          const tracked = managedTunnel as ManagedTunnelTracking;
          const record = tracked.record;
          const stopped = tracked.startedHere ? await d.stopTunnel(record) : { status: 'missing' as const };
          if (stopped.status !== 'failed') await d.clearTunnelRecord(root, record);
          return fail({
            code: 'STIM_REMOTE_METRO_UNREACHABLE',
            message: `The managed ${record.provider} tunnel is no longer verified running before the dev server became ready.`,
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

        const heldByStimd = async (): Promise<void> => {
          if (!supervisor) return;
          const answer = await d.ensureMetro(
            { root, port, tunnel, publicOrigin },
            waitSeconds * 1000 + METRO_ANSWER_SLACK_MS,
            ambientContext(),
            operationSignal,
          );
          if (answer === null)
            fail({
              code: 'STIM_DAEMON_UNAVAILABLE',
              message: `The Stim daemon did not answer for the dev server on port ${port}.`,
              remedy: 'Run `stim doctor`, then retry `stim start`.',
            });
          else if (answer.op === 'error') fail(metroRefusal(answer, port));
        };

        if (!metro.request && resolution.metro) {
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
          await withWorkspaceStateLockAsync(
            root,
            () => clearWorkspaceStateKeys(root, [IDLE_STOP_KEY]),
            operationSignal,
          );
          await heldByStimd();
          return startFacts({ root, port, supervisor, logsDir, alreadyRunning: true });
        }

        if (!metro.request && supervisor) {
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
              lines: logTailLines(metroOutput),
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
          await heldByStimd();
          return startFacts({ root, port, supervisor, logsDir, alreadyRunning: true });
        }

        if (managedTunnelExited()) return failExitedManagedTunnel();
        const request = metro.request ?? startMetro(publicOrigin);
        const refused = () => request.answer === null || request.answer?.op === 'error';

        const healthy = await waitForMetro({
          root,
          port,
          seconds: waitSeconds,
          aborted: () => refused() || managedTunnelExited(),
        });

        if (!healthy) {
          if (managedTunnelExited()) return failExitedManagedTunnel();
          const answer = request.answer;
          if (answer === null)
            return fail({
              code: 'STIM_DAEMON_UNAVAILABLE',
              message: `The Stim daemon did not answer the request to start the dev server on port ${port}.`,
              remedy: 'Run `stim doctor`, then retry `stim start`.',
            });
          const exited = answer?.op === 'error' && answer.code === 'metro-exited';
          if (answer?.op === 'error' && !exited) return fail(metroRefusal(answer, port));
          const lines = failureEvidence({ logFile: metroOutput, logsDir, sinceTs: request.since });
          const failure: StartRefusalArgs = exited
            ? {
                code: 'STIM_SUPERVISOR_EXITED',
                message: `The dev server exited before it came up on port ${port}.`,
                lines,
                remedy: 'Fix the error above and run `stim start` again; `stim logs --errors` has the full records.',
              }
            : {
                code: 'STIM_METRO_TIMEOUT',
                message: `The dev server did not answer on port ${port} within ${waitSeconds}s.`,
                lines,
                remedy:
                  'Stim stops a dev server that has not answered when this command ends. Read `stim logs --errors`, then retry with a longer --wait.',
              };
          const retryable = exited && !remote && metroPortSetting(settings, ambientEnv()).port === null;
          if (retryable && portBindRace(failure.lines ?? [], port)) throw new MetroPortRace(failure, port);
          return fail(failure);
        }

        if (managedTunnelExited()) return failExitedManagedTunnel();
        const metroGone = () =>
          refused() || !liveSupervisor({ state: readWorkspaceState(root), project: getProject(root), port });

        if (tunnel) {
          const tunnelReady = await waitForExpoTunnel({ root, seconds: waitSeconds, aborted: metroGone });
          if (!tunnelReady) {
            const gone = metroGone();
            return fail({
              code: gone ? 'STIM_SUPERVISOR_EXITED' : 'STIM_METRO_TIMEOUT',
              message: gone
                ? `The dev server exited before the Expo tunnel became ready on port ${port}.`
                : `Expo did not report a tunnel URL within ${waitSeconds}s.`,
              remedy: 'Run `stim stop`, then `stim start --remote`.',
            });
          }
        }

        supervisor = liveSupervisor({ state: readWorkspaceState(root), project: getProject(root), port });
        const answer = supervisor ? request.answer : await answered(request);
        if (answer?.op === 'error')
          return fail({
            code: 'STIM_SUPERVISOR_EXITED',
            message: `The dev server on port ${port} stopped as it became ready.`,
            lines: failureEvidence({ logFile: metroOutput, logsDir, sinceTs: request.since }),
            remedy: 'Fix the error above and run `stim start` again; `stim logs --errors` has the full records.',
          });
        const foreign = answer?.op === 'metro' && (answer.state === 'foreign' || answer.state === 'supervisor');
        if (!supervisor && !foreign) {
          return fail({
            code: 'STIM_SUPERVISOR_EXITED',
            message: 'The dev server answered before its ownership could be verified.',
            remedy: 'Run `stim status` and `stim logs --errors`, then retry `stim start`.',
          });
        }
        return startFacts({ root, port, supervisor, logsDir, alreadyRunning: foreign });
      };
      const outcome = await attempt().then(
        (facts) => ({ facts }),
        (error: unknown) => ({ error }),
      );
      metro.request?.cancel.abort();
      const cleanup = tunnelPending as WorkspaceProcessCleanupError | null;
      if (cleanup) {
        if ('error' in outcome && outcome.error instanceof StartRefusal) {
          cleanup.message = `${outcome.error.message} ${cleanup.message}`;
          cleanup.cause = outcome.error;
        }
        throw cleanup;
      }
      if ('error' in outcome) throw outcome.error;
      return outcome.facts;
    };

    const runStartRetryingPortRace = async (claim: ClaimHandle, tunnelClaim: ClaimHandle): Promise<StartFacts> => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await runStart(claim, tunnelClaim);
        } catch (error) {
          if (!(error instanceof MetroPortRace)) throw error;
          if (attempt === PORT_RACE_ATTEMPTS) {
            throw new StartRefusal({
              ...error.refusal,
              remedy: `Another process took port ${error.port} after Stim reserved it, ${PORT_RACE_ATTEMPTS} times in a row. Run \`stim start\` again; it reserves a free port.`,
            });
          }
          await withConfigLockAsync(() => releaseMetroPort(root, error.port), operationSignal);
          note(chalk.yellow(`Port ${error.port} was taken by another process while the dev server started.`));
          note(chalk.dim('Reserving another port and starting again.'));
        }
      }
    };

    const startLocked = async () => {
      try {
        return await d.withTunnelLock(
          root,
          (tunnelClaim) =>
            withWorkspaceProcessLock(
              dirname(workspaceLogsDir(root)),
              'metro-start',
              (claim) => runStartRetryingPortRace(claim, tunnelClaim),
              {
                external: true,
                signal: operationSignal,
              },
            ),
          { signal: operationSignal },
        );
      } catch (error) {
        if (error instanceof WorkspaceProcessCleanupError || error instanceof StartRefusal) throw error;
        throwIfCancelled(operationSignal, 'Metro startup');
        if (workspaceProcessLockError(error) === 'refused')
          return fail({
            code: 'STIM_WORKTREE_REMOVAL_IN_PROGRESS',
            message: `The workspace at ${root} is being removed.`,
            remedy: 'Retry `stim start` after workspace removal finishes.',
          });
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
      return await d.withWorktreeLock(worktreeRoot, startLocked, { signal: operationSignal });
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
    try {
      writeAgentDeviceBootHook(root);
    } catch (error) {
      note(chalk.yellow(`Could not write agent-device's boot hook: ${error instanceof Error ? error.message : error}`));
    }
    return { ok: true, facts, waited: waitTimer() };
  } catch (error) {
    if (error instanceof WorkspaceProcessCleanupError) {
      return {
        ok: false,
        error: startError(error),
        lines: error.cause instanceof StartRefusal ? (error.cause.refusal.lines ?? []) : [],
        retainedClaimRoots: [...new Set(error.claims.map((claim) => claim.root))],
      };
    }
    if (!(error instanceof StartRefusal)) throw error;
    return { ok: false, error: startError(error.refusal), lines: error.refusal.lines ?? [] };
  }
}

async function resolvePort(
  root: string,
  settings: SettingsObject,
  note: (line: string) => void,
  fail: (refusal: StartRefusalArgs) => never,
  hostedPorts?: HostedMetroPorts,
): Promise<number> {
  const result = await resolveWorkspaceMetroPort(root, settings, note, 'start', true, hostedPorts);
  return typeof result === 'number' ? result : fail(result);
}

export async function resolveWorkspaceMetroPort(
  root: string,
  settings: SettingsObject,
  note: (line: string) => void,
  command: 'start' | 'web',
  reserve = true,
  hostedPorts?: HostedMetroPorts,
): Promise<number | StartError> {
  const setting = metroPortSetting(settings, ambientEnv());
  if (setting.error) return { code: 'STIM_BAD_ARG', message: setting.error, remedy: SETTING_SHAPE_REMEDY };
  const pinned = setting.port;
  const project = getProject(root);
  const recorded = project?.metroPort;
  if (pinned === null && command === 'web') return recorded ?? (await reservePort(root, null));
  if (recorded) {
    const supervisor = resolveSupervisorTarget({
      state: readWorkspaceState(root)?.supervisor,
      record: project.supervisor,
      reservedPort: recorded,
    });
    if (supervisor.status !== 'none' && supervisor.status !== 'stale') {
      if (pinned === null || recorded === pinned) return recorded;
      if (supervisor.status === 'unverified') {
        return {
          code: 'STIM_BAD_ARG',
          message: `Cannot move this workspace's Metro to metro.port ${pinned}: ${supervisor.reason}.`,
          remedy: `Stop that supervisor with the tool that started it, then retry, or restore metro.port to ${recorded}. Stim leaves unverified processes alone.`,
        };
      }
      return {
        code: 'STIM_BAD_ARG',
        message: `This workspace's dev server is running on port ${recorded}, and metro.port pins it to ${pinned}.`,
        remedy: 'Run `stim stop`, then retry, or unset or restore metro.port.',
      };
    }
  }
  if (pinned !== null) {
    const held = await resolveStartupMetro(pinned, root);
    if (held.notOurs) {
      return {
        code: 'STIM_BAD_ARG',
        message: `Port ${pinned} is held by something else (${held.notOurs}), and metro.port pins this workspace's Metro to it.`,
        remedy: 'Stop the process on that port, or set another metro.port.',
      };
    }
    if (hostedPorts && !held.metro && !(await hostedPorts.free(pinned))) return hostedPorts.busy(pinned);
    if (recorded === pinned) return recorded;
  } else if (recorded) {
    const held = await resolveStartupMetro(recorded, root);
    const hostBusy =
      !held.notOurs && hostedPorts && !held.metro && !(await hostedPorts.free(recorded)) ? hostedPorts.machine : null;
    if (!held.notOurs && !hostBusy) return recorded;
    const fresh = await reservePort(root, null, hostedPorts);
    if (typeof fresh === 'number' && fresh !== recorded) {
      note(
        chalk.yellow(
          hostBusy
            ? `Port ${recorded} is in use on ${hostBusy}, where an Expo dev client loads its bundle from this workspace's Metro port.`
            : `Port ${recorded} is held by something else (${held.notOurs}).`,
        ),
      );
      note(chalk.dim(`Reserved port ${fresh} for this project instead.`));
    }
    return fresh;
  }
  if (!reserve && pinned !== null) return pinned;
  return reservePort(root, pinned, hostedPorts);
}

async function reservePort(
  root: string,
  pinned: number | null,
  hostedPorts?: HostedMetroPorts,
): Promise<number | StartError> {
  const local = hostedPorts && createPortProbe();
  const isFree = local && (async (port: number) => (await local(port)) && (await hostedPorts.free(port)));
  try {
    return await reserveMetroPort(root, undefined, isFree, pinned, ambientContext()?.signal);
  } catch (error) {
    throwIfCancelled(ambientContext()?.signal, 'Metro startup');
    if (error instanceof PortInspectionError) {
      return { code: error.code, message: error.reason, remedy: PORT_INSPECTION_REMEDY };
    }
    return {
      code: 'STIM_BAD_ARG',
      message: (error as Error).message,
      remedy: 'Give each workspace its own metro.port, in the workspace layer or the environment.',
    };
  }
}

async function waitForMetro({
  root,
  port,
  seconds,
  aborted = () => false,
  probe = resolveStartupMetro,
}: {
  root: string;
  port: number;
  seconds: number;
  aborted?: () => boolean;
  probe?: (port: number, root: string) => Promise<MetroResolution>;
}): Promise<boolean> {
  return trace.spanAsync(
    'wait for metro',
    async () => {
      const deadline = Date.now() + seconds * 1000;
      while (Date.now() < deadline) {
        const resolution = await probe(port, root);
        if (resolution.metro) return true;
        if (aborted()) return false;
        await waitForStartup(POLL_MS);
      }
      const last = await probe(port, root);
      return Boolean(last.metro);
    },
    { port },
  );
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
    await waitForStartup(POLL_MS);
  }
  return !aborted() && readMetroTunnel(root)?.kind === 'expo';
}

function logTailLines(logFile: string): string[] {
  return [...readLogTail(logFile), `Metro output: ${logFile}`];
}

interface MetroRequest {
  since: number;
  /** stimd's answer once it came: null when none did, undefined while it is pending. */
  answer: Record<string, unknown> | null | undefined;
  cancel: AbortController;
}

const METRO_ANSWER_SLACK_MS = 10_000;

const ANSWER_AFTER_READY_MS = 2_000;

/** stimd's answer, which follows Metro's readiness by one probe, or null when it does not come within 2 s. */
async function answered(request: MetroRequest): Promise<Record<string, unknown> | null> {
  for (const deadline = Date.now() + ANSWER_AFTER_READY_MS; request.answer === undefined && Date.now() < deadline;)
    await waitForStartup(50);
  return request.answer ?? null;
}

/** The start refusal for stimd's refusal to run the workspace's Metro. */
function metroRefusal(answer: Record<string, unknown>, port: number): StartRefusalArgs {
  const message = typeof answer.message === 'string' ? answer.message : 'stimd did not start the dev server';
  if (typeof answer.code === 'string' && answer.code.startsWith('STIM_'))
    return {
      code: answer.code,
      message,
      remedy: typeof answer.remedy === 'string' ? answer.remedy : null,
    };
  return {
    code: 'STIM_SUPERVISOR_EXITED',
    message: `Stim could not start the dev server on port ${port}: ${message}.`,
    remedy: 'Run `stim status` and `stim logs --errors`, then retry `stim start`.',
  };
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
  const tail = readLogTail(logFile);
  const lines = tail.length > 0 ? [...tail, `Metro output: ${logFile}`] : [];
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
  links,
}: {
  json: boolean;
  out: (line: string) => void;
  facts: StartFacts;
  waited: string;
  links: WorkspaceLinks | undefined;
}): void {
  if (json) {
    console.log(JSON.stringify({ ...facts, ...(links ? { links } : {}) }));
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
  if (facts.agentDevice)
    out(chalk.dim(phaseLine('agent-device', `AGENT_DEVICE_STATE_DIR=${facts.agentDevice.stateDir}`)));
  if (links) console.error(chalk.dim(workspaceLinkLine(links)));
}
