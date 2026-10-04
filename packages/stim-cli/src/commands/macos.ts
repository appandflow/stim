import { createHash, randomUUID } from 'node:crypto';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { LOG_ROTATE_BYTES } from '@stim-cli/core';
import { readMacosRecord, type MacosAppRecord } from '@stim-cli/core/state';
import { withNativeBuildRun } from '../engine/native-run.ts';
import { acquireBuildSlot, releaseBuildSlot } from '../engine/build-slots.ts';
import { spawnDeclared } from '../engine/spawn-claims.ts';
import { withWorkspaceProcessLock } from '../engine/workspace-process-lock.ts';
import { getExecutor } from '../exec.ts';
import { inspectProcessIdentity } from '../process-identity.ts';
import { macosDir, macosLogFile, macosProcess } from '../macos/state.ts';
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

function stageBundle(root: string, product: string, infoPlist: string, bin: string, bundle: string): string {
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
  const bundleId = `${plist.CFBundleIdentifier}.stim.${createHash('sha256').update(root).digest('hex').slice(0, 12)}`;
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

export async function runMacos(root: string, note: (line: string) => void = console.error): Promise<MacosAppRecord> {
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
          await stopMacosAppHeld(root);
          upsertProject(root, {});
          recordWorkspaceUse(root);
          const owner = macosProcess(process.pid);
          const started = Date.now();
          const bundle = join(macosDir(root), `${macos.product}.app`);
          const scratch = join(macosDir(root), 'build');
          const record: MacosAppRecord = {
            product: macos.product!,
            bundle,
            bundleId: '',
            executable: join(bundle, 'Contents', 'MacOS', macos.product!),
            launchId: randomUUID(),
            arguments: macos.arguments ?? [],
            supervisor: owner,
            build: { state: 'running', startedAt: new Date(started).toISOString() },
          };
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
            const args = [
              'build',
              '-c',
              'debug',
              '--product',
              record.product,
              '--scratch-path',
              scratch,
              '--jobs',
              '2',
            ];
            await tool(root, args, writer, note);
            const bin = await tool(
              root,
              ['build', '-c', 'debug', '--scratch-path', scratch, '--show-bin-path'],
              writer,
              () => {},
              true,
            );
            record.bundleId = stageBundle(root, record.product, macos.infoPlist!, bin, bundle);
            record.bundle = realpathSync(bundle);
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
        },
        { external: true, declareSpawns: true, ownerPurpose: 'build and launch macOS app' },
      );
    },
    { write: note },
  );
}

export default function macosCommand(program: Command): void {
  program
    .command('macos')
    .description('Build and launch an owned Swift Package macOS Debug app.')
    .option('--json', 'print one launch payload; build output goes to stderr')
    .action(async (options: { json?: boolean }) => {
      const root = findProjectRoot(process.cwd());
      if (!root) throw new Error('Run stim macos from the Swift Package directory.');
      const record = await runMacos(root);
      if (options.json) console.log(JSON.stringify({ platform: 'macos', ...record }));
      else console.log(`Started ${record.product} (pid ${record.app?.pid}).`);
    });
}
