import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { MacosBuild } from '@stim-cli/core/state';
import { phaseLine } from '../command-output.ts';
import { recordFinishedBuild, startBuildProgress, tapBuildLog } from '../engine/build-progress.ts';
import { runCancellationSignal, withNativeBuildRun } from '../engine/native-run.ts';
import { projectRegistry } from '../integrations/projects.ts';
import { buildMacosBundle } from '../macos/build.ts';
import { macosDir } from '../macos/state.ts';
import { createNdjsonWriter } from '../ndjson.ts';
import { resolveBuildPlacement } from '../offload/selection.ts';
import { ensureWorkspaceStorage, workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import { resolveProjectSettings, settingShapeErrors, SETTING_SHAPE_REMEDY } from '../workspace/settings.ts';
import { getProject, upsertProject } from '../workspace/config.ts';
import { recordWorkspaceUse } from '../workspace/workspace-state.ts';

export interface MacosBuildOptions {
  remoteBuild?: string;
}

export interface MacosBuildFacts {
  product: string;
  /** Owned copy, retained with this workspace until explicitly removed. */
  bundle: string;
  bundleId: string;
  executable: string;
  build: MacosBuild;
  logs: { dir: string };
}

const note = (line: string) => console.error(line);

export async function buildMacosOperation(root: string, options: MacosBuildOptions): Promise<MacosBuildFacts> {
  if (process.platform !== 'darwin') throw new Error('Building a macOS app requires a Mac with Swift installed.');
  root = realpathSync(root);
  const selected = projectRegistry.selectMacos(root);
  if ('problem' in selected)
    throw Object.assign(new Error(selected.problem.message), {
      code: 'STIM_NO_PROJECT',
      remedy: selected.problem.remedy,
    });
  const { settings } = resolveProjectSettings(root);
  const [shape] = settingShapeErrors(settings);
  if (shape) throw Object.assign(new Error(`${shape} ${SETTING_SHAPE_REMEDY}`), { code: 'STIM_BAD_ARG' });
  const placement = resolveBuildPlacement(options.remoteBuild);
  if (placement.failure) throw Object.assign(new Error(placement.failure.message), placement.failure);
  const recipe = (await selected.load()).prepare(settings);
  ensureWorkspaceStorage(root);
  return withNativeBuildRun(
    root,
    { command: 'build', platform: 'macos' },
    async (claim) => {
      if (!getProject(root)) upsertProject(root, {});
      recordWorkspaceUse(root);
      const started = Date.now();
      const progress = startBuildProgress({ root, platform: 'macos', slot: 'default', claim, note });
      const logs = workspaceLogsDir(root);
      const writer = tapBuildLog(
        createNdjsonWriter(join(logs, 'build-artifact-macos.ndjson'), { truncate: true }),
        progress,
      );
      const build: MacosBuild = {
        state: 'running',
        startedAt: new Date(started).toISOString(),
        buildMachine: placement.selected,
      };
      let directory: string | undefined;
      let succeeded = false;
      try {
        const artifacts = join(workspaceDir(root), 'artifacts');
        mkdirSync(artifacts, { recursive: true });
        directory = mkdtempSync(join(artifacts, 'macos-'));
        const bundle = join(directory, `${recipe.product}.app`);
        await buildMacosBundle({
          root,
          recipe,
          bundle,
          bundleId: recipe.bundleId,
          scratch: join(macosDir(root), 'build'),
          writer,
          note,
          progress,
          record: build,
          buildMachine: placement.selected,
        });
        if (runCancellationSignal()?.aborted)
          throw Object.assign(new Error('The macOS build was cancelled.'), { code: 'STIM_CANCELLED' });
        const executable = realpathSync(join(bundle, 'Contents', 'MacOS', recipe.product));
        build.state = 'ok';
        succeeded = true;
        return { product: recipe.product, bundle, bundleId: recipe.bundleId, executable, build, logs: { dir: logs } };
      } catch (error) {
        const failure = runCancellationSignal()?.aborted
          ? Object.assign(new Error('The macOS build was cancelled.'), { code: 'STIM_CANCELLED', cause: error })
          : error;
        build.state = 'failed';
        build.error = failure instanceof Error ? failure.message : String(failure);
        build.errorCode = (failure as { code?: string }).code;
        throw failure;
      } finally {
        build.finishedAt = new Date().toISOString();
        build.durationMs = Date.now() - started;
        try {
          recordFinishedBuild(
            root,
            {
              platform: 'macos',
              status: build.state,
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
              compileSteps: progress.steps(),
            },
            { artifactOnly: true },
          );
        } catch (error) {
          note(phaseLine('state', `could not record the build: ${(error as Error)?.message || error}`));
        } finally {
          if (!succeeded && directory) rmSync(directory, { recursive: true, force: true });
          writer.close();
          progress.clear();
        }
      }
    },
    { write: note },
  );
}
