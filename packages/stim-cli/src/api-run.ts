import { type StimContext, withAmbientContext } from '@stim-cli/core';
import { processOperation, type ProcessOperation } from './cli-operation.ts';
import { buildAndroidOperation } from './commands/android/build.ts';
import { runAndroidOperation } from './commands/android.ts';
import { buildIosOperation } from './commands/ios/build.ts';
import { runIosOperation } from './commands/ios.ts';
import { buildMacosOperation } from './commands/macos-build.ts';
import { runMacos } from './commands/macos.ts';
import { runWeb } from './commands/web.ts';
import type { FailArgs } from './commands/ios/types.ts';
import { StimError } from './api.ts';
import type { StimFailure, WorkerRequest, WorkerResponse } from './api/types.ts';
import { refuseRelativeStimPaths } from './workspace/config.ts';
import { workspaceLogsDir } from './workspace/paths.ts';

async function dispatch(
  context: StimContext,
  { projectRoot: root, ...request }: WorkerRequest & { projectRoot: string },
): Promise<WorkerResponse> {
  let directory: string | undefined;
  try {
    refuseRelativeStimPaths();
    directory = workspaceLogsDir(root);
    if (request.operation === 'build') {
      switch (request.options.platform) {
        case 'ios':
          return {
            ok: true,
            result: { platform: 'ios', facts: await buildIosOperation(context, root, request.options) },
          };
        case 'android':
          return {
            ok: true,
            result: { platform: 'android', facts: await buildAndroidOperation(context, root, request.options) },
          };
        case 'macos':
          return {
            ok: true,
            result: { platform: 'macos', facts: await buildMacosOperation(context, root, request.options) },
          };
        default:
          throw new StimError({ code: 'STIM_BAD_ARG', message: 'Unknown Stim build platform.' });
      }
    }
    const options = request.options;
    switch (options.platform) {
      case 'ios': {
        let error: FailArgs | undefined;
        const result = await runIosOperation(context, root, options, {}, (failure) => {
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
        const result = await runAndroidOperation(context, root, options);
        if (!result.ok || !result.facts)
          throw new StimError({
            code: result.error?.code ?? 'STIM_RUN_FAILED',
            message: result.error?.message ?? 'The Android run failed.',
            remedy: result.error?.remedy,
          });
        return { ok: true, result: { platform: 'android', facts: result.facts } };
      }
      case 'macos': {
        const record = await runMacos(context, root, console.error, undefined, options.remoteBuild);
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

let operation: ProcessOperation | undefined;

function interrupt(): void {
  if (operation) operation.cancel('SIGINT');
  else process.exit(130);
}

process.once('disconnect', interrupt);
process.on('message', async (request: (WorkerRequest & { projectRoot: string }) | { operation: 'cancel' }) => {
  if (request.operation === 'cancel') return interrupt();
  operation = processOperation(request.projectRoot);
  operation.listen();
  const { context } = operation;
  const response = await withAmbientContext(context, () => dispatch(context, request));
  process.send?.(response, () => process.exit(response.ok ? 0 : 1));
});
