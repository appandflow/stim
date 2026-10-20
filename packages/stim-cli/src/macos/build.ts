import type { StimContext } from '@stim-cli/core';
import { withDrainingCancellation } from '../engine/operation-state.ts';
import { runCancellationSignal } from '../engine/native-run.ts';
import { throwIfCancelled } from '../cancellation.ts';
import { setRemoteLogSink } from '../remote-log.ts';
import { buildPlacementRecord, type PlacementCandidate } from '../placement-log.ts';
import { existsSync, promises as fs, renameSync } from 'node:fs';
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
import { namedBuildMachine, OffloadRefusal, requireLocalBuild } from '../offload/selection.ts';
import { getConcurrencyLimits } from '../workspace/config.ts';
import { macosDir } from './state.ts';
import { reidentifyBundle } from './stage.ts';
import { validateMacosArtifactPlatform } from './artifact-platform.ts';

export async function buildMacosBundle({
  context,
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
  context: StimContext;
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
  const signal = runCancellationSignal(context) ?? context.signal;
  return withDrainingCancellation(context, signal, async () => {
    throwIfCancelled(signal, 'macOS build');
    if (record) record.buildMachine = buildMachine;
    setRemoteLogSink(context, (entry) => writer.write({ ...entry, platform: 'macos' }));
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
      requireLocalBuild(buildMachine);
      offloadFallback = reason;
      if (record) record.offloadFallback = reason;
      writer.write({ src: 'build', platform: 'macos', level: 'warn', event: 'offload_failed', msg: reason });
      write(`${reason} -> building here`);
      write(`placement: here (${reason})`);
    };
    await fs.mkdir(macosDir(root), { recursive: true });
    const staging = await fs.mkdtemp(join(macosDir(root), 'staging-'));
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
    let retainStaging = false;
    let identity: { hash: string; key: string } | null = null;
    const save = async (path: string) => {
      if (!recipe.cache || !identity) return;
      try {
        if ((await recipe.cache.identity()).hash !== identity.hash) {
          if (record) {
            delete record.fingerprint;
            delete record.cacheKey;
          }
          write('macOS inputs changed during the build; installing without caching.');
          return;
        }
        const directory = join(staging, 'cache-store');
        await fs.mkdir(directory);
        await recipe.cache.store(identity.key, path, directory);
      } catch (error) {
        if (error instanceof Error && 'reportCleanup' in error) {
          retainStaging = true;
          throw error;
        }
        throwIfCancelled(signal, 'macOS cache store');
        write(`macOS cache store skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    try {
      if (record) record.cacheHit = false;
      if (recipe.cache) {
        try {
          identity = await recipe.cache.identity();
          if (record) {
            record.fingerprint = identity.hash;
            record.cacheKey = identity.key;
          }
          const hit = await recipe.cache.restore(identity.key, join(staging, 'cache-read'));
          if (hit && (await recipe.cache.identity()).hash === identity.hash) {
            await reidentifyBundle(context, hit.bundle, bundleId, displayName);
            await recipe.validateFetched(hit.bundle, bundleId, displayName);
            throwIfCancelled(signal, 'macOS cache restore');
            promote(hit.bundle);
            if (record) {
              record.cacheHit = true;
              record.cacheSource = hit.tier;
            }
            write(`macOS cache hit (${hit.tier})`);
            return { bundleId, offloadedTo: null, offloadFallback: null, handoff: null };
          }
        } catch (error) {
          if (error instanceof Error && 'reportCleanup' in error) {
            retainStaging = true;
            throw error;
          }
          throwIfCancelled(signal, 'macOS cache lookup');
          write(`macOS cache lookup skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      let cacheOnly = false;
      try {
        const { mode, machines, localEnabled } = buildPlacementCandidates(buildMachine);
        const peer = recipe.cache?.peer?.() ?? null;
        const request = {
          ...recipe.offload.request(bundleId),
          ...(peer ? { artifactInputs: peer.inputs, cacheArtifact: peer.write } : {}),
        };
        const here = machineCapacity();
        const placement = offloadPlacement({
          mode,
          localEnabled,
          machines: machines.length,
          here,
          unsupported: null,
          selected: buildMachine,
        });
        cacheOnly = !placement.offload && placement.code === 'this-mac-free' && peer !== null;
        if (placement.offload || cacheOnly) {
          const chosen = await chooseBuildMachine({
            projectRoot: root,
            target: await recipe.offload.target(),
            mode,
            here,
            machines,
            selected: buildMachine,
            note: (line) => write(`offload: ${line}`),
            onCandidates: (each) => (asked = each),
            cacheOnly,
            ...(peer ? { swiftpmArtifact: request } : {}),
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
            request,
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
          if (outcome.cacheHit) {
            await reidentifyBundle(context, outcome.artifactPath, bundleId, displayName);
            await validateMacosArtifactPlatform(context, outcome.artifactPath, recipe.product, signal);
          }
          await recipe.validateFetched(outcome.artifactPath, bundleId, displayName);
          throwIfCancelled(signal, 'macOS build');
          promote(outcome.artifactPath);
          if (record) {
            delete record.fingerprint;
            delete record.cacheKey;
            record.offloadedTo = outcome.machine;
            record.builtOn = outcome.machine;
            record.cacheHit = outcome.cacheHit === true;
            if (outcome.cacheHit) record.cacheSource = 'peer';
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
        if (error instanceof Error && 'reportCleanup' in error) {
          retainStaging = true;
          throw error;
        }
        throwIfCancelled(signal, 'macOS build');
        if (cacheOnly) write(`placement: here (no reusable peer artifact)`);
        else fallBack(error instanceof Error ? error.message : String(error));
      } finally {
        if (choice) closeOffload(choice);
      }
      let slot: Awaited<ReturnType<typeof acquireBuildSlot>> | undefined;
      try {
        slot = await acquireBuildSlot({
          signal,
          automatic: buildMachine === 'auto',
          max: getConcurrencyLimits().maxBuilds,
          root,
          logFile: writer.file,
          out: note,
          waitingFor: (info) => progress.waitingFor(info, 'build-slot'),
        });
        requireLocalBuild(buildMachine);
        if (record) record.builtOn = 'here';
        progress.step('compile');
        const bin = await recipe.compile({ scratch, writer, note });
        progress.step('install');
        const staged = join(staging, `${recipe.product}.app`);
        await recipe.stage(bin, staged, bundleId, displayName);
        throwIfCancelled(signal, 'macOS build');
        releaseBuildSlot(slot);
        slot = undefined;
        await save(staged);
        promote(staged);
        return { bundleId, offloadedTo: null, offloadFallback, handoff: null };
      } finally {
        releaseBuildSlot(slot);
      }
    } finally {
      try {
        if (!retainStaging) await fs.rm(staging, { recursive: true, force: true });
      } catch {}
    }
  });
}
