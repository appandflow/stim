import { createHash, randomUUID } from 'node:crypto';
import { closeSync, openSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { phaseLine } from '../command-output.ts';
import { LOG_ROTATE_BYTES } from '@stim-cli/core';
import { readMacosRecord, validHostedAppArguments, type MacosAppRecord, type MacosBuild } from '@stim-cli/core/state';
import { connectHost, placeHostedMacos } from '../device-host/hosted-macos.ts';
import {
  NO_BUILD_PROGRESS,
  recordBuildPhase,
  recordFinishedBuild,
  startBuildProgress,
  tapBuildLog,
  type BuildProgress,
} from '../engine/build-progress.ts';
import { withNativeBuildRun } from '../engine/native-run.ts';
import { spawnDeclared } from '../engine/spawn-claims.ts';
import { withWorkspaceProcessLock } from '../engine/workspace-process-lock.ts';
import { getExecutor } from '../exec.ts';
import { inspectProcessIdentity } from '../process-identity.ts';
import { macosDir, macosLogFile, macosProcess, requiredMacosRecord } from '../macos/state.ts';
import { workspaceAppName } from '../macos/app-name.ts';
import { buildMacosBundle } from '../macos/build.ts';
import { planMacos } from '../macos/plan.ts';
import type { BuildHandoff } from '../offload/client.ts';
import type { MacosArtifactRecipe } from '../integrations/macos-project.ts';
import { projectRegistry } from '../integrations/projects.ts';
import { stopBundleInstances, stopMacosAppHeld } from '../macos/stop.ts';
import { createNdjsonWriter } from '../ndjson.ts';
import { resolveBuildPlacement, parseBuildMachineOption } from '../offload/selection.ts';
import { spawnEntry } from '../spawn-entry.ts';
import { upsertProject } from '../workspace/config.ts';
import { ensureWorkspaceStorage, workspaceDir, workspaceLogsDir, workspaceAgentDeviceDir } from '../workspace/paths.ts';
import { findProjectRoot } from '../workspace/project.ts';
import { resolveProjectSettings, settingShapeErrors, SETTING_SHAPE_REMEDY } from '../workspace/settings.ts';
import { recordWorkspaceUse, writeWorkspaceState } from '../workspace/workspace-state.ts';

/**
 * Builds the Debug app and launches it here, or with `remote` on that approved remote Mac. A named host never falls
 * back to a local launch.
 */
export async function runMacos(
  root: string,
  note: (line: string) => void = console.error,
  remote?: string,
  buildMachineFlag?: string,
): Promise<MacosAppRecord> {
  const backend = remote?.trim().toLowerCase();
  if (backend === 'eas' || backend === 'proxy')
    throw Object.assign(
      new Error('stim macos --remote takes a remote Mac name from remote.machines; macOS has no eas or proxy backend.'),
      { code: 'STIM_BAD_ARG' },
    );
  if (backend === 'auto')
    throw Object.assign(
      new Error(
        'stim macos --remote auto is not available yet: automatic placement has not shipped. Name a hosting Mac from remote.machines.',
      ),
      { code: 'STIM_BAD_ARG' },
    );
  if (process.platform !== 'darwin') throw new Error('stim macos requires a Mac with Swift installed.');
  root = realpathSync(root);
  const operation = projectRegistry.selectMacos(root);
  if ('problem' in operation)
    throw Object.assign(new Error(operation.problem.message), {
      code: 'STIM_NO_PROJECT',
      remedy: operation.problem.remedy,
    });
  const { settings } = resolveProjectSettings(root);
  const [shape] = settingShapeErrors(settings);
  if (shape) throw new Error(`${shape} ${SETTING_SHAPE_REMEDY}`);
  const selected = resolveBuildPlacement(buildMachineFlag);
  if (selected.failure) throw Object.assign(new Error(selected.failure.message), selected.failure);
  const buildMachine = selected.selected;
  const macos = (await operation.load()).prepare(settings);
  ensureWorkspaceStorage(root);
  return withNativeBuildRun(
    root,
    { command: 'macos', platform: 'macos' },
    async (claim) => {
      const progress = startBuildProgress({ root, platform: 'macos', slot: 'default', claim, note });
      return withWorkspaceProcessLock(
        workspaceDir(root),
        'macos-launch',
        async () => {
          const previous = requiredMacosRecord(root);
          if (previous?.host && previous.host.machine !== remote) {
            throw new Error(
              `This workspace's macOS app runs on ${previous.host.machine}. Run stim stop first, then stim macos${remote ? ` --remote ${remote}` : ''}.`,
            );
          }
          if (remote && !validHostedAppArguments(macos.arguments))
            throw new Error(
              'macos.arguments is too large for a hosted app: at most 32 arguments of 1024 characters (8192 in total), without NUL or line breaks.',
            );
          if (remote) (await connectHost(remote)).connection.close();
          if (!previous?.host) await stopMacosAppHeld(root);
          upsertProject(root, {});
          recordWorkspaceUse(root);
          const bundle = join(macosDir(root), `${macos.product}.app`);
          const record: MacosAppRecord = {
            product: macos.product,
            bundle,
            bundleId: '',
            executable: join(bundle, 'Contents', 'MacOS', macos.product),
            launchId: randomUUID(),
            arguments: macos.arguments,
            supervisor: macosProcess(process.pid),
            build: { state: 'running', startedAt: new Date().toISOString(), buildMachine },
            ...(previous?.host ? { host: previous.host, hostLaunched: previous.hostLaunched ?? false } : {}),
          };
          const handoff = await buildBundle(root, macos, record, remote !== undefined, note, progress);
          progress.step('launch');
          const launched = (): void => {
            try {
              recordBuildPhase(root, 'macos', record.build.startedAt, 'launch', progress.durations().launch ?? 0);
            } catch (error) {
              note(`The launch time could not be recorded in the build history: ${(error as Error)?.message || error}`);
            }
          };
          if (!remote) {
            const here = await launchHere(root, record);
            launched();
            return here;
          }
          const connection = await connectHost(remote);
          const write = (patch: Partial<MacosAppRecord>) =>
            writeWorkspaceState(root, { macos: { ...record, ...patch } });
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
                write({ host: reserved, hostLaunched: false });
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
            writeWorkspaceState(root, { macos: placed });
            launched();
            return placed;
          } catch (error) {
            write({ supervisor: undefined, ...(placement ? { host: placement, hostLaunched: false } : {}) });
            throw error;
          } finally {
            connection.connection.close();
          }
        },
        { external: true, declareSpawns: true, ownerPurpose: 'build and launch macOS app' },
      ).finally(() => progress.clear());
    },
    { write: note },
  );
}

async function buildBundle(
  root: string,
  recipe: MacosArtifactRecipe,
  record: MacosAppRecord,
  hosted: boolean,
  note: (line: string) => void,
  progress: BuildProgress = NO_BUILD_PROGRESS,
): Promise<BuildHandoff | null> {
  const started = Date.parse(record.build.startedAt);
  const scratch = join(macosDir(root), 'build');
  writeWorkspaceState(root, { macos: record });
  const writer = tapBuildLog(createNdjsonWriter(macosLogFile(root), { maxBytes: LOG_ROTATE_BYTES }), progress);
  try {
    const base = recipe.bundleId;
    const bundleId = hosted ? base : `${base}.stim.${createHash('sha256').update(root).digest('hex').slice(0, 12)}`;
    const displayName = workspaceAppName(root, record.product);
    const built = await buildMacosBundle({
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
    writeWorkspaceState(root, { macos: record });
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
    writeWorkspaceState(root, { macos: { ...record, supervisor: undefined, build } });
    recordMacosBuild(root, build, progress.steps());
    throw error;
  } finally {
    writer.close();
  }
}

function recordMacosBuild(root: string, build: MacosBuild, compileSteps: number | null): void {
  recordFinishedBuild(root, {
    platform: 'macos',
    status: build.state === 'ok' ? 'ok' : 'failed',
    configuration: 'Debug',
    fingerprint: null,
    cacheKey: null,
    cacheHit: false,
    cacheSkipped: false,
    durationMs: build.durationMs,
    startedAt: build.startedAt,
    errorCode: build.errorCode,
    buildMachine: build.buildMachine,
    builtOn: build.builtOn,
    offloadedTo: build.offloadedTo,
    offloadFallback: build.offloadFallback,
    ...(compileSteps === null ? {} : { compileSteps }),
  });
}

async function launchHere(root: string, record: MacosAppRecord): Promise<MacosAppRecord> {
  await stopBundleInstances(root);
  const fd = openSync(join(workspaceLogsDir(root), 'macos-supervisor.log'), 'a');
  let child;
  try {
    child = spawnDeclared(() =>
      getExecutor().spawn(process.execPath, [spawnEntry('macos-run'), root, record.launchId], {
        cwd: root,
        detached: true,
        stdio: ['ignore', fd, fd],
        env: { ...process.env, STIM_BACKGROUND_LAUNCH: '1' },
      }),
    );
    child.unref();
  } finally {
    closeSync(fd);
  }
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const current = readMacosRecord(root);
    if (
      current?.launchId === record.launchId &&
      current.app &&
      current.supervisor &&
      inspectProcessIdentity(current.app) === 'same' &&
      inspectProcessIdentity(current.supervisor) === 'same'
    )
      return current;
    if (child.exitCode !== null || child.signalCode !== null) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('The macOS app did not register. See macos-supervisor.log in the workspace logs.');
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
      'Build on auto, local, or one named machine; a name refuses without fallback',
      parseBuildMachineOption,
    )
    .option('--json', 'print one launch or plan payload; build output goes to stderr')
    .option('--plan', 'validate the next SwiftPM Debug build without building or launching')
    .option('--remote <machine>', 'run it on this approved remote Mac from remote.machines')
    .action(async (options: { json?: boolean; plan?: boolean; remote?: string; remoteBuild?: string }) => {
      const root = findProjectRoot(process.cwd());
      if (options.plan) {
        try {
          if (!root) throw new Error('Run stim macos from the Swift Package directory.');
          if (options.remote !== undefined)
            throw Object.assign(new Error('--remote selects a launch host and does not apply to --plan.'), {
              code: 'STIM_BAD_ARG',
            });
          const plan = planMacos(root, options.remoteBuild);
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
      const record = await runMacos(root, console.error, options.remote, options.remoteBuild).catch((error) => {
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
