import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { machineCapacity, type MacosBuild } from '@stim-cli/core/state';
import { acquireBuildSlot, releaseBuildSlot } from '../engine/build-slots.ts';
import { spawnDeclared } from '../engine/spawn-claims.ts';
import { getExecutor } from '../exec.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import { pairedMachines } from '../offload/build-machines.ts';
import {
  chooseBuildMachine,
  closeOffload,
  offloadBuild,
  offloadMode,
  offloadPlacement,
  placementLoad,
  remotePhaseText,
  type OffloadChoice,
} from '../offload/client.ts';
import { macosToolchain } from '../offload/toolchain.ts';
import { getConcurrencyLimits } from '../workspace/config.ts';
import { logLines } from './run.ts';
import { macosDir } from './state.ts';
import { stageBundle, validateInfoPlist } from './stage.ts';

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

export async function buildMacosBundle({
  root,
  product,
  infoPlist,
  bundle,
  bundleId,
  scratch,
  writer,
  note,
  record,
}: {
  root: string;
  product: string;
  infoPlist: string;
  bundle: string;
  bundleId: string;
  scratch: string;
  writer: NdjsonWriter;
  note: (line: string) => void;
  record?: MacosBuild;
}): Promise<{ bundleId: string; offloadedTo: string | null; offloadFallback: string | null }> {
  validateInfoPlist(root, product, infoPlist);
  const write = (msg: string) => {
    writer.write({ src: 'build', platform: 'macos', level: 'info', msg });
    note(msg);
  };
  let offloadFallback: string | null = null;
  const fallBack = (reason: string) => {
    offloadFallback = reason;
    if (record) record.offloadFallback = reason;
    writer.write({ src: 'build', platform: 'macos', level: 'warn', event: 'offload_failed', msg: reason });
    write(`${reason} -> building here`);
    write(`placement: here (${reason})`);
  };
  mkdirSync(macosDir(root), { recursive: true });
  const staging = mkdtempSync(join(macosDir(root), 'staging-'));
  const promote = (path: string) => {
    const backup = join(staging, 'previous.app');
    const previous = existsSync(bundle);
    if (previous) renameSync(bundle, backup);
    try {
      renameSync(path, bundle);
    } catch (error) {
      if (previous) renameSync(backup, bundle);
      throw error;
    }
  };
  let choice: OffloadChoice | null = null;
  try {
    try {
      const mode = offloadMode();
      const machines = pairedMachines();
      const here = machineCapacity();
      const placement = offloadPlacement({ mode, machines: machines.length, here, unsupported: null });
      if (placement.offload) {
        const chosen = await chooseBuildMachine({
          projectRoot: root,
          target: { platform: 'macos', local: macosToolchain() },
          mode,
          here,
          machines,
          note: (line) => write(`offload: ${line}`),
        });
        if (typeof chosen === 'string') throw new Error(chosen);
        choice = chosen;
        write(`placement: ${choice.machine} (${placement.reason}${placementLoad(choice)})`);
        const outcome = await offloadBuild({
          choice,
          request: { platform: 'macos', product, infoPlist: relative(root, resolve(root, infoPlist)), bundleId },
          stagingDir: join(staging, 'offload'),
          onPhase: (phase, line) => note(remotePhaseText(phase, line, choice!.machine)),
          onEnter: () => {},
          onRecord: (entry) => writer.write({ ...entry, offloadedTo: choice!.machine }),
          note: write,
        });
        if (!outcome.ok) throw new Error(`${outcome.machine}: ${outcome.reason}`);
        const executable = join(outcome.artifactPath, 'Contents', 'MacOS', product);
        const plist = JSON.parse(
          getExecutor().runFile('plutil', [
            '-convert',
            'json',
            '-o',
            '-',
            join(outcome.artifactPath, 'Contents', 'Info.plist'),
          ]),
        );
        if (plist.CFBundleIdentifier !== bundleId || plist.CFBundleExecutable !== product || !existsSync(executable))
          throw new Error('The fetched macOS bundle does not match the requested identity and executable.');
        getExecutor().runFile('codesign', ['--verify', '--strict', outcome.artifactPath]);
        promote(outcome.artifactPath);
        if (record) record.offloadedTo = outcome.machine;
        return { bundleId, offloadedTo: outcome.machine, offloadFallback: null };
      }
      write(`placement: here (${placement.reason})`);
    } catch (error) {
      fallBack(error instanceof Error ? error.message : String(error));
    } finally {
      if (choice) closeOffload(choice);
    }
    let slot: Awaited<ReturnType<typeof acquireBuildSlot>> | undefined;
    try {
      slot = await acquireBuildSlot({ max: getConcurrencyLimits().maxBuilds, root, logFile: writer.file, out: note });
      await tool(
        root,
        ['build', '-c', 'debug', '--product', product, '--scratch-path', scratch, '--jobs', '2'],
        writer,
        note,
      );
      const bin = await tool(
        root,
        ['build', '-c', 'debug', '--scratch-path', scratch, '--show-bin-path'],
        writer,
        () => {},
        true,
      );
      const staged = join(staging, `${product}.app`);
      stageBundle(root, product, infoPlist, bin, staged, bundleId);
      promote(staged);
      return { bundleId, offloadedTo: null, offloadFallback };
    } finally {
      releaseBuildSlot(slot);
    }
  } finally {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {}
  }
}
