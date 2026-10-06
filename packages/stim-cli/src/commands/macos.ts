import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { LOG_ROTATE_BYTES } from '@stim-cli/core';
import { readMacosRecord, validHostedAppArguments, type MacosAppRecord } from '@stim-cli/core/state';
import { connectHost, placeHostedMacos } from '../device-host/hosted-macos.ts';
import { withNativeBuildRun } from '../engine/native-run.ts';
import { spawnDeclared } from '../engine/spawn-claims.ts';
import { withWorkspaceProcessLock } from '../engine/workspace-process-lock.ts';
import { getExecutor } from '../exec.ts';
import { inspectProcessIdentity } from '../process-identity.ts';
import { macosDir, macosLogFile, macosProcess, requiredMacosRecord } from '../macos/state.ts';
import { buildMacosBundle } from '../macos/build.ts';
import type { BuildHandoff } from '../offload/client.ts';
import { validateInfoPlist } from '../macos/stage.ts';
import { stopMacosAppHeld } from '../macos/stop.ts';
import { createNdjsonWriter } from '../ndjson.ts';
import { resolveBuildPlacement, parseBuildMachineOption } from '../offload/selection.ts';
import { spawnEntry } from '../spawn-entry.ts';
import { upsertProject } from '../workspace/config.ts';
import { ensureWorkspaceStorage, workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import { findProjectRoot } from '../workspace/project.ts';
import { resolveSettings, settingShapeErrors, SETTING_SHAPE_REMEDY } from '../workspace/settings.ts';
import { recordWorkspaceUse, writeWorkspaceState } from '../workspace/workspace-state.ts';
import { gitCommonDir, repoRoot } from '../workspace/worktree.ts';

/**
 * Builds the Debug app and launches it here, or with `remote` on that approved hosting Mac. A named host never falls
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
      new Error(
        'stim macos --remote takes a hosting Mac name from hosting.machines; macOS has no eas or proxy backend.',
      ),
      { code: 'STIM_BAD_ARG' },
    );
  if (backend === 'auto')
    throw Object.assign(
      new Error(
        'stim macos --remote auto is not available yet: automatic placement has not shipped. Name a hosting Mac from hosting.machines.',
      ),
      { code: 'STIM_BAD_ARG' },
    );
  if (process.platform !== 'darwin') throw new Error('stim macos requires a Mac with Swift installed.');
  root = realpathSync(root);
  if (!existsSync(join(root, 'Package.swift')))
    throw new Error('Run stim macos from the directory containing Package.swift.');
  const settings = resolveSettings({ projectPath: root, gitCommonDir: gitCommonDir(root), repoRoot: repoRoot(root) });
  const [shape] = settingShapeErrors(settings);
  if (shape) throw new Error(`${shape} ${SETTING_SHAPE_REMEDY}`);
  const selected = resolveBuildPlacement(buildMachineFlag);
  if (selected.failure) throw Object.assign(new Error(selected.failure.message), selected.failure);
  const buildMachine = selected.selected;
  const macos = settings.macos as
    | { product?: string; infoPlist?: string; arguments?: string[]; resources?: unknown; assetCatalog?: unknown }
    | undefined;
  if (!macos?.product || !macos.infoPlist) {
    throw Object.assign(
      new Error('Set macos.product and macos.infoPlist explicitly in .stim.json. See stim guide macos.'),
      { code: 'STIM_BAD_ARG' },
    );
  }
  ensureWorkspaceStorage(root);
  return withNativeBuildRun(
    root,
    { command: 'macos', platform: 'macos' },
    async () => {
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
          if (remote && !validHostedAppArguments(macos.arguments ?? []))
            throw new Error(
              'macos.arguments is too large for a hosted app: at most 32 arguments of 1024 characters (8192 in total), without NUL or line breaks.',
            );
          if (remote) (await connectHost(remote)).connection.close();
          if (!previous?.host) await stopMacosAppHeld(root);
          upsertProject(root, {});
          recordWorkspaceUse(root);
          const bundle = join(macosDir(root), `${macos.product}.app`);
          const record: MacosAppRecord = {
            product: macos.product!,
            bundle,
            bundleId: '',
            executable: join(bundle, 'Contents', 'MacOS', macos.product!),
            launchId: randomUUID(),
            arguments: macos.arguments ?? [],
            supervisor: macosProcess(process.pid),
            build: { state: 'running', startedAt: new Date().toISOString(), buildMachine },
            ...(previous?.host ? { host: previous.host, hostLaunched: previous.hostLaunched ?? false } : {}),
          };
          const handoff = await buildBundle(root, macos.infoPlist!, record, remote !== undefined, note, macos);
          if (!remote) return launchHere(root, record);
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
              arguments: macos.arguments ?? [],
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
            return placed;
          } catch (error) {
            write({ supervisor: undefined, ...(placement ? { host: placement, hostLaunched: false } : {}) });
            throw error;
          } finally {
            connection.connection.close();
          }
        },
        { external: true, declareSpawns: true, ownerPurpose: 'build and launch macOS app' },
      );
    },
    { write: note },
  );
}

async function buildBundle(
  root: string,
  infoPlist: string,
  record: MacosAppRecord,
  hosted: boolean,
  note: (line: string) => void,
  extras: { resources?: unknown; assetCatalog?: unknown },
): Promise<BuildHandoff | null> {
  const started = Date.parse(record.build.startedAt);
  const scratch = join(macosDir(root), 'build');
  writeWorkspaceState(root, { macos: record });
  const writer = createNdjsonWriter(macosLogFile(root), { maxBytes: LOG_ROTATE_BYTES });
  try {
    const { bundleId: base } = validateInfoPlist(root, record.product, infoPlist);
    const bundleId = hosted ? base : `${base}.stim.${createHash('sha256').update(root).digest('hex').slice(0, 12)}`;
    const built = await buildMacosBundle({
      root,
      product: record.product,
      infoPlist,
      bundle: record.bundle,
      bundleId,
      scratch,
      writer,
      note,
      record: record.build,
      buildMachine: record.build.buildMachine!,
      resources: extras.resources,
      assetCatalog: extras.assetCatalog,
    });
    record.bundleId = built.bundleId;
    record.bundle = realpathSync(record.bundle);
    record.executable = realpathSync(join(record.bundle, 'Contents', 'MacOS', record.product));
    record.build = {
      ...record.build,
      state: 'ok',
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    };
    writeWorkspaceState(root, { macos: record });
    return built.handoff;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writer.write({ src: 'build', platform: 'macos', level: 'error', msg: message });
    writeWorkspaceState(root, {
      macos: {
        ...record,
        supervisor: undefined,
        build: {
          ...record.build,
          state: 'failed',
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          error: message,
          ...('code' in Object(error) && typeof (error as { code?: unknown }).code === 'string'
            ? { errorCode: (error as { code: string }).code }
            : {}),
        },
      },
    });
    throw error;
  } finally {
    writer.close();
  }
}

async function launchHere(root: string, record: MacosAppRecord): Promise<MacosAppRecord> {
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

function launchPayload(record: MacosAppRecord): Record<string, unknown> {
  if (!record.host) return { platform: 'macos', ...record };
  const { product, launchId, build, host } = record;
  return { platform: 'macos', product, launchId, build, host };
}

export default function macosCommand(program: Command): void {
  program
    .command('macos')
    .description('Build and launch an owned Swift Package macOS Debug app.')
    .option(
      '--build-machine <value>',
      'Build on auto, local, or one named machine; a name refuses without fallback',
      parseBuildMachineOption,
    )
    .option('--json', 'print one launch payload; build output goes to stderr')
    .option('--remote <machine>', 'run it on this approved hosting Mac from hosting.machines')
    .action(async (options: { json?: boolean; remote?: string; buildMachine?: string }) => {
      const root = findProjectRoot(process.cwd());
      if (!root) throw new Error('Run stim macos from the Swift Package directory.');
      const record = await runMacos(root, console.error, options.remote, options.buildMachine).catch((error) => {
        const remedy = (error as { remedy?: unknown }).remedy;
        if (typeof remedy === 'string') console.error(`remedy: ${remedy}`);
        throw error;
      });
      if (options.json) console.log(JSON.stringify(launchPayload(record)));
      else if (record.host)
        console.log(
          `Started ${record.product} on ${record.host.machine} as ${record.host.bundleId}${record.hostLaunched === true ? '' : ' (launch not confirmed)'}.`,
        );
      else console.log(`Started ${record.product} (pid ${record.app?.pid}).`);
    });
}
