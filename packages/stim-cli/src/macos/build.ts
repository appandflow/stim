import { setRemoteLogSink } from '../remote-log.ts';
import { buildPlacementRecord, type PlacementCandidate } from '../placement-log.ts';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { machineCapacity, type MacosBuild } from '@stim-cli/core/state';
import { acquireBuildSlot, releaseBuildSlot } from '../engine/build-slots.ts';
import { NO_BUILD_PROGRESS, type BuildProgress } from '../engine/build-progress.ts';
import type { MacosArtifactRecipe } from '../integrations/macos-project.ts';
import type { NdjsonWriter } from '../ndjson.ts';
import {
  chooseBuildMachine,
  closeOffload,
  offloadBuild,
  buildPlacementCandidates,
  offloadPlacement,
  placementLoad,
  remotePhaseText,
  type BuildHandoff,
  type OffloadChoice,
} from '../offload/client.ts';
import { namedBuildMachine, OffloadRefusal } from '../offload/selection.ts';
import { getConcurrencyLimits } from '../workspace/config.ts';
import { macosDir } from './state.ts';

export async function buildMacosBundle({
  root,
  recipe,
  bundle,
  bundleId,
  displayName,
  scratch,
  writer,
  note,
  record,
  buildMachine,
  progress = NO_BUILD_PROGRESS,
}: {
  root: string;
  recipe: MacosArtifactRecipe;
  bundle: string;
  bundleId: string;
  displayName?: string;
  scratch: string;
  writer: NdjsonWriter;
  note: (line: string) => void;
  record?: MacosBuild;
  buildMachine: string;
  progress?: BuildProgress;
}): Promise<{
  bundleId: string;
  offloadedTo: string | null;
  offloadFallback: string | null;
  handoff: BuildHandoff | null;
}> {
  if (record) record.buildMachine = buildMachine;
  setRemoteLogSink((entry) => writer.write({ ...entry, platform: 'macos' }));
  const write = (msg: string) => {
    writer.write({ src: 'build', platform: 'macos', level: 'info', msg });
    note(msg);
  };
  let offloadFallback: string | null = null;
  let asked: PlacementCandidate[] = [];
  let failedMachine: string | undefined;
  const fallBack = (reason: string) => {
    writer.write(
      buildPlacementRecord({
        platform: 'macos',
        buildMachine,
        candidates: asked,
        event: 'placement_fallback',
        fallback: {
          code: failedMachine ? 'offload-failed' : 'no-remote-mac-took-it',
          reason,
          machine: failedMachine,
        },
      }),
    );
    if (namedBuildMachine(buildMachine)) throw new OffloadRefusal(buildMachine, reason);
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
      const { mode, machines } = buildPlacementCandidates(buildMachine);
      const here = machineCapacity();
      const placement = offloadPlacement({
        mode,
        machines: machines.length,
        here,
        unsupported: null,
        selected: buildMachine,
      });
      if (placement.offload) {
        const chosen = await chooseBuildMachine({
          projectRoot: root,
          target: recipe.offload.target(),
          mode,
          here,
          machines,
          selected: buildMachine,
          note: (line) => write(`offload: ${line}`),
          onCandidates: (each) => (asked = each),
        });
        if (typeof chosen === 'string') throw new Error(chosen);
        choice = chosen;
        failedMachine = chosen.machine;
        writer.write(
          buildPlacementRecord({
            platform: 'macos',
            buildMachine,
            candidates: asked,
            chose: { machine: chosen.machine, reason: `${placement.reason}${placementLoad(chosen)}` },
          }),
        );
        write(`placement: ${choice.machine} (${placement.reason}${placementLoad(choice)})`);
        const outcome = await offloadBuild({
          choice,
          request: recipe.offload.request(bundleId),
          stagingDir: join(staging, 'offload'),
          onPhase: (phase, line) => note(remotePhaseText(phase, line, choice!.machine)),
          onEnter: (phase) => {
            if (record && ['compile', 'build', 'prebuild', 'pods'].includes(phase)) record.builtOn = choice!.machine;
            progress.place({ host: choice!.machine, phase });
            progress.step(phase === 'fetch' ? 'install' : 'compile');
          },
          onRecord: (entry) => writer.write({ ...entry, offloadedTo: choice!.machine }),
          note: write,
        });
        progress.place(null);
        if (!outcome.ok) throw new Error(`${outcome.machine}: ${outcome.reason}`);
        progress.step('install');
        recipe.validateFetched(outcome.artifactPath, bundleId, displayName);
        promote(outcome.artifactPath);
        if (record) {
          record.offloadedTo = outcome.machine;
          record.builtOn = outcome.machine;
        }
        return { bundleId, offloadedTo: outcome.machine, offloadFallback: null, handoff: outcome.handoff ?? null };
      }
      writer.write(
        buildPlacementRecord({
          platform: 'macos',
          buildMachine,
          stays: { code: placement.code, reason: placement.reason },
        }),
      );
      write(`placement: here (${placement.reason})`);
    } catch (error) {
      fallBack(error instanceof Error ? error.message : String(error));
    } finally {
      if (choice) closeOffload(choice);
    }
    let slot: Awaited<ReturnType<typeof acquireBuildSlot>> | undefined;
    try {
      slot = await acquireBuildSlot({
        max: getConcurrencyLimits().maxBuilds,
        root,
        logFile: writer.file,
        out: note,
        waitingFor: (info) => progress.waitingFor(info, 'build-slot'),
      });
      if (record) record.builtOn = 'here';
      progress.step('compile');
      const bin = await recipe.compile({ scratch, writer, note });
      progress.step('install');
      const staged = join(staging, `${recipe.product}.app`);
      recipe.stage(bin, staged, bundleId, displayName);
      promote(staged);
      return { bundleId, offloadedTo: null, offloadFallback, handoff: null };
    } finally {
      releaseBuildSlot(slot);
    }
  } finally {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {}
  }
}
