import { createHash, randomUUID } from 'node:crypto';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { LOG_ROTATE_BYTES } from '@stim-cli/core';
import { readMacosRecord, type MacosAppRecord } from '@stim-cli/core/state';
import { connectHost, placeHostedMacos } from '../device-host/hosted-macos.ts';
import { withNativeBuildRun } from '../engine/native-run.ts';
import { acquireBuildSlot, releaseBuildSlot } from '../engine/build-slots.ts';
import { spawnDeclared } from '../engine/spawn-claims.ts';
import { withWorkspaceProcessLock } from '../engine/workspace-process-lock.ts';
import { getExecutor } from '../exec.ts';
import { inspectProcessIdentity } from '../process-identity.ts';
import { macosDir, macosLogFile, macosProcess, requiredMacosRecord } from '../macos/state.ts';
import { logLines } from '../macos/run.ts';
import { stopMacosAppHeld } from '../macos/stop.ts';
import { createNdjsonWriter, type NdjsonWriter } from '../ndjson.ts';
import { spawnEntry } from '../spawn-entry.ts';
import { getConcurrencyLimits, upsertProject } from '../workspace/config.ts';
import { ensureWorkspaceStorage, workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import { findProjectRoot } from '../workspace/project.ts';
import { resolveSettings, settingShapeErrors, SETTING_SHAPE_REMEDY } from '../workspace/settings.ts';
import { recordWorkspaceUse, writeWorkspaceState } from '../workspace/workspace-state.ts';
import { gitCommonDir, repoRoot } from '../workspace/worktree.ts';

async function tool(
  root: string,
  args: string[],
  writer: NdjsonWriter,
  note: (line: string) => void,
  capture = false,
): Promise<string> {
  const child = spawnDeclared(() =>
    getExecutor().spawn('swift', args, { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }),
  );
  let stdout = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    if (capture) stdout += chunk.toString('utf8');
  });
  const write = (msg: string) => {
    writer.write({ src: 'build', platform: 'macos', level: 'debug', msg });
    note(msg);
  };
  if (child.stdout) logLines(child.stdout, write);
  if (child.stderr) logLines(child.stderr, write);
  await new Promise<void>((done, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? done() : reject(new Error(`swift ${args[0]} failed (${code}). See stim logs --source build.`)),
    );
  });
  return stdout.trim();
}

function stageBundle(
  root: string,
  product: string,
  infoPlist: string,
  bin: string,
  bundle: string,
  hosted: boolean,
): string {
  const exec = getExecutor();
  const plist = JSON.parse(
    exec.runFile('plutil', ['-convert', 'json', '-o', '-', realpathSync(resolve(root, infoPlist))]),
  );
  if (typeof plist.CFBundleIdentifier !== 'string' || plist.CFBundleExecutable !== product) {
    throw new Error('macos.infoPlist must name a CFBundleIdentifier and the selected product as CFBundleExecutable.');
  }
  if (plist.CFBundleURLTypes || plist.SUFeedURL) {
    throw new Error('Use a development Info.plist without shared URL schemes or an update feed.');
  }
  const bundleId = hosted
    ? plist.CFBundleIdentifier
    : `${plist.CFBundleIdentifier}.stim.${createHash('sha256').update(root).digest('hex').slice(0, 12)}`;
  rmSync(bundle, { recursive: true, force: true });
  const contents = join(bundle, 'Contents');
  mkdirSync(join(contents, 'MacOS'), { recursive: true });
  mkdirSync(join(contents, 'Resources'), { recursive: true });
  mkdirSync(join(contents, 'Frameworks'), { recursive: true });
  const executable = join(contents, 'MacOS', product);
  cpSync(join(bin, product), executable);
  cpSync(resolve(root, infoPlist), join(contents, 'Info.plist'));
  exec.runFile('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleIdentifier ${bundleId}`, join(contents, 'Info.plist')]);
  for (const entry of readdirSync(bin)) {
    if (entry.endsWith('.framework')) {
      const target = join(contents, 'Frameworks', entry);
      cpSync(join(bin, entry), target, { recursive: true, dereference: false, verbatimSymlinks: true });
      exec.runFile('codesign', ['--force', '--sign', '-', target]);
    } else if (entry.endsWith('.bundle'))
      cpSync(join(bin, entry), join(contents, 'Resources', entry), { recursive: true });
  }
  const frameworkPath = '@executable_path/../Frameworks';
  if (!exec.runFile('otool', ['-l', executable]).includes(frameworkPath)) {
    exec.runFile('install_name_tool', ['-add_rpath', frameworkPath, executable]);
  }
  exec.runFile('codesign', ['--force', '--sign', '-', bundle]);
  return bundleId;
}

/**
 * Builds the Debug app and launches it here, or with `host` on that approved hosting Mac. A named host never falls
 * back to a local launch.
 */
export async function runMacos(
  root: string,
  note: (line: string) => void = console.error,
  host?: string,
): Promise<MacosAppRecord> {
  if (process.platform !== 'darwin') throw new Error('stim macos requires a Mac with Swift installed.');
  root = realpathSync(root);
  if (!existsSync(join(root, 'Package.swift')))
    throw new Error('Run stim macos from the directory containing Package.swift.');
  ensureWorkspaceStorage(root);
  const settings = resolveSettings({ projectPath: root, gitCommonDir: gitCommonDir(root), repoRoot: repoRoot(root) });
  const [shape] = settingShapeErrors(settings);
  if (shape) throw new Error(`${shape} ${SETTING_SHAPE_REMEDY}`);
  const macos = settings.macos as { product?: string; infoPlist?: string; arguments?: string[] } | undefined;
  if (!macos?.product || !macos.infoPlist) {
    throw new Error('Set macos.product and macos.infoPlist explicitly. See stim guide macos.');
  }
  return withNativeBuildRun(
    root,
    { command: 'macos', platform: 'macos' },
    async () => {
      return withWorkspaceProcessLock(
        workspaceDir(root),
        'macos-launch',
        async () => {
          const previous = requiredMacosRecord(root);
          if (previous?.host && previous.host.machine !== host) {
            throw new Error(
              `This workspace's macOS app runs on ${previous.host.machine}. Run stim stop first, then stim macos${host ? ` --host ${host}` : ''}.`,
            );
          }
          if (host) (await connectHost(host)).connection.close();
          if (host && macos.arguments?.length) note('macos.arguments are not passed to a hosted app.');
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
            build: { state: 'running', startedAt: new Date().toISOString() },
            ...(previous?.host ? { host: previous.host, hostLaunched: previous.hostLaunched ?? false } : {}),
          };
          await buildBundle(root, macos.infoPlist!, record, host !== undefined, note);
          if (!host) return launchHere(root, record);
          const connection = await connectHost(host);
          const write = (patch: Partial<MacosAppRecord>) =>
            writeWorkspaceState(root, { macos: { ...record, ...patch } });
          let placement = record.host;
          try {
            const run = await placeHostedMacos(connection, {
              root,
              bundle: record.bundle,
              bundleId: record.bundleId,
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
): Promise<void> {
  const started = Date.parse(record.build.startedAt);
  const scratch = join(macosDir(root), 'build');
  writeWorkspaceState(root, { macos: record });
  const writer = createNdjsonWriter(macosLogFile(root), { maxBytes: LOG_ROTATE_BYTES });
  let slot: Awaited<ReturnType<typeof acquireBuildSlot>> | undefined;
  try {
    slot = await acquireBuildSlot({
      max: getConcurrencyLimits().maxBuilds,
      root,
      logFile: writer.file,
      out: note,
    });
    const args = ['build', '-c', 'debug', '--product', record.product, '--scratch-path', scratch, '--jobs', '2'];
    await tool(root, args, writer, note);
    const bin = await tool(
      root,
      ['build', '-c', 'debug', '--scratch-path', scratch, '--show-bin-path'],
      writer,
      () => {},
      true,
    );
    record.bundleId = stageBundle(root, record.product, infoPlist, bin, record.bundle, hosted);
    record.bundle = realpathSync(record.bundle);
    record.executable = realpathSync(join(record.bundle, 'Contents', 'MacOS', record.product));
    record.build = {
      ...record.build,
      state: 'ok',
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    };
    writeWorkspaceState(root, { macos: record });
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
        },
      },
    });
    throw error;
  } finally {
    releaseBuildSlot(slot);
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
        env: process.env,
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
    .option('--json', 'print one launch payload; build output goes to stderr')
    .option('--host <machine>', 'run it on this approved hosting Mac from hosting.machines')
    .action(async (options: { json?: boolean; host?: string }) => {
      const root = findProjectRoot(process.cwd());
      if (!root) throw new Error('Run stim macos from the Swift Package directory.');
      const record = await runMacos(root, console.error, options.host);
      if (options.json) console.log(JSON.stringify(launchPayload(record)));
      else if (record.host)
        console.log(
          `Started ${record.product} on ${record.host.machine} as ${record.host.bundleId}${record.hostLaunched === true ? '' : ' (launch not confirmed)'}.`,
        );
      else console.log(`Started ${record.product} (pid ${record.app?.pid}).`);
    });
}
