import { queryJsonLogs } from '@stim-cli/core/state';
import { buildAndroidOperation } from './commands/android/build.ts';
import { runAndroidOperation } from './commands/android.ts';
import { runIosOperation } from './commands/ios.ts';
import { runMacos } from './commands/macos.ts';
import { stopWorkspaceNow } from './commands/stop.ts';
import { runWeb } from './commands/web.ts';
import type { FailArgs } from './commands/ios/types.ts';
import { StimError } from './api.ts';
import type { StimFailure, WorkerRequest, WorkerResponse } from './api/types.ts';
import { refuseRelativeStimPaths } from './workspace/config.ts';
import { workspaceLogsDir } from './workspace/paths.ts';

async function dispatch({
  projectRoot: root,
  ...request
}: WorkerRequest & { projectRoot: string }): Promise<WorkerResponse> {
  let directory: string | undefined;
  try {
    refuseRelativeStimPaths();
    directory = workspaceLogsDir(root);
    if (request.operation === 'diagnostics') {
      const { tail = 200, errors = false } = request.options;
      return {
        ok: true,
        result: {
          directory,
          records: tail === 0 ? [] : queryJsonLogs({ dir: directory, tail, errorsOnly: errors }),
        },
      };
    }
    if (request.operation === 'stop') {
      const result = await stopWorkspaceNow({
        root,
        slot: request.options.slot,
      });
      if ('refusal' in result) throw new StimError({ ...result.refusal, details: result.remote });
      return { ok: true, result };
    }
    if (request.operation === 'build') {
      if (request.options.platform !== 'android')
        throw new StimError({ code: 'STIM_BAD_ARG', message: 'Unknown Stim build platform.' });
      return { ok: true, result: { platform: 'android', facts: await buildAndroidOperation(root, request.options) } };
    }
    const options = request.options;
    switch (options.platform) {
      case 'ios': {
        let error: FailArgs | undefined;
        const result = await runIosOperation(root, options, {}, (failure) => {
          error = failure;
        });
        if (!result)
          throw new StimError({
            code: error?.code ?? 'STIM_RUN_FAILED',
            message: error?.message ?? 'The iOS run failed.',
            remedy: error?.remedy,
            details: error,
          });
        return { ok: true, result: { platform: 'ios', facts: result.facts } };
      }
      case 'android': {
        const result = await runAndroidOperation(root, options);
        if (!result.ok || !result.facts)
          throw new StimError({
            code: result.error?.code ?? 'STIM_RUN_FAILED',
            message: result.error?.message ?? 'The Android run failed.',
            remedy: result.error?.remedy,
          });
        return { ok: true, result: { platform: 'android', facts: result.facts } };
      }
      case 'macos': {
        const record = await runMacos(root, console.error, undefined, options.remoteBuild);
        return {
          ok: true,
          result: {
            platform: 'macos',
            facts: {
              product: record.product,
              bundle: record.bundle,
              bundleId: record.bundleId,
              executable: record.executable,
              pid: record.app?.pid ?? null,
              launched: record.app !== undefined,
              build: record.build,
              logs: { dir: directory },
            },
          },
        };
      }
      case 'web': {
        const result = await runWeb({ root, headed: options.headed ?? false, note: console.error });
        if (!result.ok) throw new StimError(result.error);
        return { ok: true, result: { platform: 'web', facts: result.facts } };
      }
      default:
        throw new StimError({ code: 'STIM_BAD_ARG', message: 'Unknown Stim platform.' });
    }
  } catch (error) {
    const failure = error as Partial<StimFailure>;
    return {
      ok: false,
      error: {
        code: failure.code ?? 'STIM_RUN_FAILED',
        message: error instanceof Error ? error.message : String(error),
        remedy: failure.remedy ?? null,
        details: { logs: directory, cause: failure.details },
      },
    };
  }
}

function interrupt(): void {
  if (!process.emit('SIGINT')) process.exit(130);
}

process.once('disconnect', interrupt);
process.on('message', async (request: (WorkerRequest & { projectRoot: string }) | { operation: 'cancel' }) => {
  if (request.operation === 'cancel') return interrupt();
  const response = await dispatch(request);
  process.send?.(response, () => process.exit(response.ok ? 0 : 1));
});
