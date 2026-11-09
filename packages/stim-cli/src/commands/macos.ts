import { createHash, randomUUID } from 'node:crypto';
import { closeSync, openSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { phaseLine } from '../command-output.ts';
import { LOG_ROTATE_BYTES, ambientEnv, type StimContext } from '@stim-cli/core';
import { processContext, runProcessOperation } from '../cli-operation.ts';
import {
  placementWord,
  validHostedAppArguments,
  validRunId,
  type MacosAppRecord,
  type MacosBuild,
  type MacosProcess,
} from '@stim-cli/core/state';
import { automaticDevicePlacement, devicePlacementLine } from '../device-host/auto-placement.ts';
import { connectHost, placeHostedMacos } from '../device-host/hosted-macos.ts';
import {
  NO_BUILD_PROGRESS,
  recordBuildPhase,
  recordFinishedBuild,
  startBuildProgress,
  tapBuildLog,
  type BuildProgress,
} from '../engine/build-progress.ts';
import { errorRemedy } from '../engine/build-ledger.ts';
import { runCancellationSignal, withNativeBuildRun } from '../engine/native-run.ts';
import { spawnDeclared } from '../engine/spawn-claims.ts';
import { clearClaimChild } from '../ownership-claim.ts';
import { sameProcessRecord } from '../process-identity.ts';
import { withWorkspaceProcessLock, WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';
import { operationState } from '../engine/operation-state.ts';
import { getExecutor } from '../exec.ts';
import { cancellableSleep } from '../cancellation.ts';
import { macosDir, macosLogFile, macosProcess, requiredMacosRecord } from '../macos/state.ts';
import { workspaceAppName } from '../macos/app-name.ts';
import { assertLocalMacosCapacity, peekLocalMacosCapacity, withLocalMacosAdmission } from '../macos/admission.ts';
import { buildMacosBundle } from '../macos/build.ts';
import { planMacos } from '../macos/plan.ts';
import { waitForMacosRegistration } from '../macos/registration.ts';
import type { BuildHandoff } from '../offload/client.ts';
import type { MacosArtifactRecipe } from '../integrations/macos-project.ts';
import { projectRegistry } from '../integrations/projects.ts';
import {
  stopBundleInstances,
  stopMacosAppHeld,
  stopProcesses as stopMacosProcesses,
  SUPERVISOR_EXIT_MS,
} from '../macos/stop.ts';
import { startedBy } from '../macos/instances.ts';
import { createNdjsonWriter } from '../ndjson.ts';
import { resolveBuildPlacement, parseBuildMachineOption } from '../build-placement.ts';
import { spawnEntry } from '../spawn-entry.ts';
import { upsertProject, withConfigLockAsync } from '../workspace/config.ts';
import {
  ensureWorkspaceStorageAsync,
  workspaceDir,
  workspaceLogsDir,
  workspaceAgentDeviceDir,
} from '../workspace/paths.ts';
import { findProjectRoot } from '../workspace/project.ts';
import {
  resolveProjectSettingsAsync,
  settingShapeErrors,
  settingValueAt,
  SETTING_SHAPE_REMEDY,
} from '../workspace/settings.ts';
import { recordWorkspaceUseAsync, writeWorkspaceStateAsync } from '../workspace/workspace-state.ts';

/**
 * Builds the Debug app and launches it where `remoteFlag` or `macos.remote` says: here, on one named approved remote
 * Mac with no fallback, or on the Mac an automatic placement word chooses. A recorded hosted app keeps its Mac.
 */
export async function runMacos(
  context: StimContext,
  root: string,
  note: (line: string) => void = console.error,
  remoteFlag?: string,
  buildMachineFlag?: string,
): Promise<MacosAppRecord> {
  refuseDeviceBackend(remoteFlag);
  if (process.platform !== 'darwin') throw new Error('stim macos requires a Mac with Swift installed.');
  root = realpathSync(root);
  const operation = projectRegistry.selectMacos(root);
  if ('problem' in operation)
    throw Object.assign(new Error(operation.problem.message), {
      code: 'STIM_NO_PROJECT',
      remedy: operation.problem.remedy,
    });
  const { settings } = await resolveProjectSettingsAsync(root, {
    env: context.env,
    signal: runCancellationSignal(context) ?? context.signal,
  });
  const [shape] = settingShapeErrors(settings);
  if (shape) throw new Error(`${shape} ${SETTING_SHAPE_REMEDY}`);
  const selected = resolveBuildPlacement(buildMachineFlag);
  if (selected.failure) throw Object.assign(new Error(selected.failure.message), selected.failure);
  const buildMachine = selected.selected;
  const configured = settingValueAt(settings, 'macos.remote');
  const requested = remoteFlag ?? (typeof configured === 'string' ? configured : undefined);
  refuseDeviceBackend(requested);
  const macos = await (await operation.load()).prepare(context, settings);
  await ensureWorkspaceStorageAsync(root, context.signal);
  return withNativeBuildRun(
    context,
    root,
    { command: 'macos', platform: 'macos' },
    async (claim) => {
      const progress = startBuildProgress({ root, platform: 'macos', slot: 'default', claim, note });
      return withWorkspaceProcessLock(
        workspaceDir(root),
        'macos-launch',
        async () => {
          const previous = requiredMacosRecord(root);
          const remote = await macosHost({
            context,
            requested,
            previous,
            root,
            buildMachine,
            note,
            signal: context.signal,
          });
          if (previous?.host && previous.host.machine !== remote) {
            throw new Error(
              `This workspace's macOS app runs on ${previous.host.machine}. Run stim stop first, then stim macos${remote ? ` --remote ${remote}` : ''}.`,
            );
          }
          if (remote && !validHostedAppArguments(macos.arguments))
            throw new Error(
              'macos.arguments is too large for a hosted app: at most 32 arguments of 1024 characters (8192 in total), without NUL or line breaks.',
            );
          let hostServerKey: string | undefined;
          if (remote) {
            const probe = await connectHost(remote);
            hostServerKey = probe.credential.serverKey;
            probe.connection.close();
          }
          if (!remote) await assertLocalMacosCapacity(root, context);
          if (!previous?.host) await stopMacosAppHeld(root);
          await withConfigLockAsync(() => upsertProject(root, {}));
          await recordWorkspaceUseAsync(root, new Date(), context.env, context.cwd, context.signal);
          const bundle = join(macosDir(root), `${macos.product}.app`);
          const record: MacosAppRecord = {
            product: macos.product,
            bundle,
            bundleId: '',
            executable: join(bundle, 'Contents', 'MacOS', macos.product),
            launchId: randomUUID(),
            ...(validRunId(context.runId) ? { runId: context.runId } : {}),
            arguments: macos.arguments,
            supervisor: macosProcess(process.pid),
            build: { state: 'running', startedAt: new Date().toISOString(), buildMachine },
            ...(previous?.host ? { host: previous.host, hostLaunched: previous.hostLaunched ?? false } : {}),
          };
          const handoff = await buildBundle(
            context,
            root,
            macos,
            record,
            remote !== undefined,
            hostServerKey,
            note,
            progress,
          );
          progress.step('launch');
          const launched = (): void => {
            try {
              recordBuildPhase(root, 'macos', record.build.startedAt, 'launch', progress.durations().launch ?? 0);
            } catch (error) {
              note(`The launch time could not be recorded in the build history: ${(error as Error)?.message || error}`);
            }
          };
          if (!remote) {
            // https://github.com/appandflow/stim/issues/4483: capacity can fill during compilation; builds stay parallel without an app reservation.
            const { record: here, deadline } = await withLocalMacosAdmission(root, context, () =>
              launchHere(context, root, record),
            );
            try {
              const runSignal = runCancellationSignal(context);
              const signal = runSignal ? AbortSignal.any([context.signal, runSignal]) : context.signal;
              if ((await waitForLaunchServices(here, deadline, signal)) === 'timeout')
                note(
                  'macOS LaunchServices does not list the app yet. agent-device open may start a second copy; wait and check lsappinfo.',
                );
              signal.throwIfAborted();
              const refusal = operationState(context).refusal;
              if (refusal !== null) throw new Error(refusal);
              launched();
              return here;
            } catch (error) {
              await cleanupFailedMacosLaunch(context, root, record, here.supervisor, here.app, error);
              throw error;
            }
          }
          const connection = await connectHost(remote);
          const write = (patch: Partial<MacosAppRecord>) =>
            writeWorkspaceStateAsync(root, { macos: { ...record, ...patch } });
          let placement = record.host;
          try {
            const run = await placeHostedMacos(connection, {
              root,
              bundle: record.bundle,
              bundleId: record.bundleId,
              handoff,
              arguments: macos.arguments,
              recorded: previous?.host,
              reserved: (reserved) => {
                placement = reserved;
                return write({ host: reserved, hostLaunched: false });
              },
              note,
            });
            const placed: MacosAppRecord = {
              ...record,
              supervisor: undefined,
              arguments: run.arguments,
              host: run.placement,
              hostLaunched: run.launched,
            };
            await writeWorkspaceStateAsync(root, { macos: placed });
            launched();
            return placed;
          } catch (error) {
            await write({ supervisor: undefined, ...(placement ? { host: placement, hostLaunched: false } : {}) });
            throw error;
          } finally {
            connection.connection.close();
          }
        },
        { external: true, declareSpawnsFor: context, ownerPurpose: 'build and launch macOS app' },
      ).finally(() => progress.clear());
    },
    { write: note },
  );
}

function refuseDeviceBackend(requested: string | undefined): void {
  if (requested !== undefined && ['eas', 'proxy'].includes(requested.trim().toLowerCase()))
    throw Object.assign(
      new Error(
        'stim macos --remote and macos.remote take local, auto, remote, remote-only or a remote Mac name from remote.machines; macOS has no eas or proxy backend.',
      ),
      { code: 'STIM_BAD_ARG' },
    );
}

async function macosHost({
  context,
  requested,
  previous,
  root,
  buildMachine,
  note,
  signal,
}: {
  context: StimContext;
  requested: string | undefined;
  previous: MacosAppRecord | null | undefined;
  root: string;
  buildMachine: string;
  note: (line: string) => void;
  signal: AbortSignal;
}): Promise<string | undefined> {
  if (requested === undefined) return undefined;
  const word = placementWord(requested);
  if (word === 'local') return undefined;
  if (word === null) return requested.trim();
  if (previous?.host) return previous.host.machine;
  const placed = await automaticDevicePlacement(
    {
      root,
      slot: 'default',
      platform: 'macos',
      placement: word,
      selectors: {},
      buildMachine,
      noWait: false,
      onWait: (line) => note(phaseLine('placement:', line)),
      signal,
    },
    word === 'auto' ? { peek: () => peekLocalMacosCapacity(root, context) } : {},
  );
  note(phaseLine('placement:', devicePlacementLine(placed.placement, placed.skipped)));
  return placed.placement.decision === 'hosted' ? placed.placement.machine : undefined;
}

async function buildBundle(
  context: StimContext,
  root: string,
  recipe: MacosArtifactRecipe,
  record: MacosAppRecord,
  hosted: boolean,
  hostServerKey: string | undefined,
  note: (line: string) => void,
  progress: BuildProgress = NO_BUILD_PROGRESS,
): Promise<BuildHandoff | null> {
  const started = Date.parse(record.build.startedAt);
  const scratch = join(macosDir(root), 'build');
  await writeWorkspaceStateAsync(root, { macos: record });
  const writer = tapBuildLog(createNdjsonWriter(macosLogFile(root), { maxBytes: LOG_ROTATE_BYTES }), progress);
  try {
    const base = recipe.bundleId;
    const bundleId = hosted ? base : `${base}.stim.${createHash('sha256').update(root).digest('hex').slice(0, 12)}`;
    const displayName = workspaceAppName(root, record.product);
    const built = await buildMacosBundle({
      context,
      root,
      recipe,
      bundle: record.bundle,
      bundleId,
      displayName,
      scratch,
      writer,
      note,
      progress,
      record: record.build,
      buildMachine: record.build.buildMachine!,
      hostServerKey,
    });
    record.bundleId = built.bundleId;
    record.displayName = displayName;
    record.bundle = realpathSync(record.bundle);
    record.executable = realpathSync(join(record.bundle, 'Contents', 'MacOS', record.product));
    record.build = {
      ...record.build,
      state: 'ok',
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    };
    await writeWorkspaceStateAsync(root, { macos: record });
    recordMacosBuild(root, record.build, progress.steps());
    return built.handoff;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writer.write({ src: 'build', platform: 'macos', level: 'error', msg: message });
    const build: MacosBuild = {
      ...record.build,
      state: 'failed',
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      error: message,
      ...('code' in Object(error) && typeof (error as { code?: unknown }).code === 'string'
        ? { errorCode: (error as { code: string }).code }
        : {}),
    };
    await writeWorkspaceStateAsync(root, { macos: { ...record, supervisor: undefined, build } });
    recordMacosBuild(root, build, progress.steps(), errorRemedy(error));
    throw error;
  } finally {
    writer.close();
  }
}

function recordMacosBuild(root: string, build: MacosBuild, compileSteps: number | null, remedy?: string): void {
  recordFinishedBuild(root, {
    platform: 'macos',
    status: build.state === 'ok' ? 'ok' : 'failed',
    configuration: 'Debug',
    fingerprint: build.fingerprint ?? null,
    cacheKey: build.cacheKey ?? null,
    cacheHit: build.cacheHit ? (build.cacheSource === 'provider' ? 'remote' : 'local') : false,
    cacheSkipped: !build.cacheKey,
    durationMs: build.durationMs,
    startedAt: build.startedAt,
    errorCode: build.errorCode,
    buildMachine: build.buildMachine,
    builtOn: build.builtOn,
    offloadedTo: build.offloadedTo,
    offloadFallback: build.offloadFallback,
    ...(compileSteps === null ? {} : { compileSteps }),
    ...(build.error ? { ledger: { message: build.error, remedy } } : {}),
  });
}

const LAUNCH_SERVICES_CALL_MS = 2_000;

export async function waitForLaunchServices(
  record: MacosAppRecord,
  deadline: number,
  signal?: AbortSignal,
): Promise<'listed' | 'timeout' | 'skipped'> {
  if (record.host || !record.app) return 'skipped';
  const args = ['find', `bundleid=${record.bundleId}`, `pid=${record.app.pid}`];
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const out = await getExecutor()
      .runFileAsync('lsappinfo', args, { timeoutMs: LAUNCH_SERVICES_CALL_MS, signal })
      .catch((error: unknown) => {
        if (error instanceof WorkspaceProcessCleanupError || (error instanceof Error && 'reportCleanup' in error))
          throw error;
        return '';
      });
    signal?.throwIfAborted();
    if (out.includes('ASN:')) return 'listed';
    await cancellableSleep(100, { signal, what: 'LaunchServices' });
  }
  return 'timeout';
}

async function launchHere(
  context: StimContext,
  root: string,
  record: MacosAppRecord,
): Promise<{ record: MacosAppRecord; deadline: number }> {
  await stopBundleInstances(root);
  const fd = openSync(join(workspaceLogsDir(root), 'macos-supervisor.log'), 'a');
  const claims = [...operationState(context).declaring];
  let child;
  let supervisor: MacosProcess | undefined;
  try {
    try {
      child = spawnDeclared(context, () =>
        getExecutor().spawn(process.execPath, [spawnEntry('macos-run'), root, record.launchId], {
          cwd: root,
          detached: true,
          stdio: ['ignore', fd, fd, 'ipc'],
          env: { ...ambientEnv(), STIM_BACKGROUND_LAUNCH: '1' },
        }),
      );
      if (child.pid !== undefined) supervisor = macosProcess(child.pid);
      child.unref();
    } finally {
      closeSync(fd);
    }
    const deadline = Date.now() + 20_000;
    const current = await waitForMacosRegistration(root, record.launchId, child, deadline, (registered) => {
      if (!supervisor || !sameProcessRecord(registered.supervisor, supervisor))
        throw new Error('The macOS launch supervisor changed before handoff.');
      for (const claim of claims) clearClaimChild(claim);
    });
    if (current) return { record: current, deadline };
    throw new Error('The macOS app did not register. See macos-supervisor.log in the workspace logs.');
  } catch (error) {
    if (!supervisor && child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      const failure = new WorkspaceProcessCleanupError(
        [...operationState(context).declaring],
        'Could not drain the failed macOS launch: the spawned macOS supervisor identity could not be verified.',
        'Verify that the workspace supervisor and app have stopped before retrying.',
      );
      failure.cause = error;
      throw failure;
    }
    await cleanupFailedMacosLaunch(context, root, record, supervisor, undefined, error);
    throw error;
  }
}

async function cleanupFailedMacosLaunch(
  context: StimContext,
  root: string,
  record: MacosAppRecord,
  supervisor: MacosProcess | undefined,
  app: MacosProcess | undefined,
  error: unknown,
): Promise<void> {
  try {
    const started = await startedBy([supervisor, app].filter((each) => each !== undefined));
    if (supervisor && supervisor.pid !== app?.pid) await stopMacosProcesses([supervisor], SUPERVISOR_EXIT_MS);
    if (app) await stopMacosProcesses([app]);
    await stopMacosProcesses(started);
    await stopBundleInstances(root);
    await writeWorkspaceStateAsync(root, { macos: { ...record, supervisor: undefined, app: undefined } });
  } catch (cleanupError) {
    const failure = new WorkspaceProcessCleanupError(
      [...operationState(context).declaring],
      `Could not drain the failed macOS launch: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      'Verify that the workspace supervisor and app have stopped before retrying.',
    );
    failure.cause = new AggregateError([error, cleanupError], 'The macOS launch and its cleanup failed.');
    throw failure;
  }
}

function launchPayload(root: string, record: MacosAppRecord): Record<string, unknown> {
  const agentDevice = { stateDir: workspaceAgentDeviceDir(root) };
  if (!record.host) return { agentDevice, platform: 'macos', ...record };
  const { product, displayName, launchId, build, host } = record;
  return { agentDevice, platform: 'macos', product, displayName, launchId, build, host };
}

export default function macosCommand(program: Command): void {
  program
    .command('macos')
    .description('Build and launch an owned Swift Package macOS Debug app.')
    .option(
      '--remote-build <value>',
      'Build on local, auto, remote (remote machines first), remote-only (never here), or one named machine; a name refuses without fallback',
      parseBuildMachineOption,
    )
    .option('--json', 'print one launch or plan payload; build output goes to stderr')
    .option('--plan', 'validate the next SwiftPM Debug build without building or launching')
    .option(
      '--remote <placement>',
      'run it here (local), on the Mac a placement word chooses (auto, remote, remote-only), or on one approved remote Mac from remote.machines',
    )
    .action(async (options: { json?: boolean; plan?: boolean; remote?: string; remoteBuild?: string }) => {
      const root = findProjectRoot(process.cwd());
      if (options.plan) {
        try {
          if (!root) throw new Error('Run stim macos from the Swift Package directory.');
          if (options.remote !== undefined)
            throw Object.assign(new Error('--remote selects a launch host and does not apply to --plan.'), {
              code: 'STIM_BAD_ARG',
            });
          const plan = await planMacos(processContext(root, new AbortController().signal), root, options.remoteBuild);
          if (options.json) console.log(JSON.stringify(plan));
          else {
            console.log(phaseLine('plan', `macos ${plan.product}: SwiftPM Debug build, then stage and launch`));
            console.log(phaseLine('build', `selection: ${plan.buildMachine}; worker availability is not checked`));
            console.log(phaseLine('expect', 'unknown: SwiftPM determines incremental work when the build runs'));
          }
        } catch (error) {
          const failure = {
            code: (error as { code?: string }).code ?? 'STIM_BAD_ARG',
            message: error instanceof Error ? error.message : String(error),
            remedy: (error as { remedy?: string }).remedy ?? 'Check the macOS project settings in stim guide macos.',
          };
          console.error(failure.message);
          if (options.json) console.log(JSON.stringify(failure));
          process.exitCode = 1;
        }
        return;
      }
      if (!root) throw new Error('Run stim macos from the Swift Package directory.');
      const { value: record } = await runProcessOperation(root, (context) =>
        runMacos(context, root, console.error, options.remote, options.remoteBuild),
      ).catch((error) => {
        const remedy = (error as { remedy?: unknown }).remedy;
        if (typeof remedy === 'string') console.error(`remedy: ${remedy}`);
        throw error;
      });
      if (options.json) console.log(JSON.stringify(launchPayload(root, record)));
      else if (record.host)
        console.log(
          `Started ${record.product} on ${record.host.machine} as ${record.host.bundleId}${record.hostLaunched === true ? '' : ' (launch not confirmed)'}.`,
        );
      else console.log(`Started ${record.product} (pid ${record.app?.pid}).`);
      if (!options.json)
        console.log(phaseLine('agent-device', `AGENT_DEVICE_STATE_DIR=${workspaceAgentDeviceDir(root)}`));
    });
}
