import type { StimContext } from '@stim-cli/core';
import { settingValueAt } from '../../workspace/settings.ts';
import { runCancellationSignal } from '../../engine/native-run.ts';
import type { BuildProgress } from '../../engine/build-progress.ts';
import { selectIosTarget } from './remote.ts';
import type { FailArgs } from './types.ts';

export async function installRequestedIosRuntime(
  args: Parameters<typeof selectIosTarget>[0] & {
    targetRefusal: FailArgs | null;
    runtime: string | null;
    progress: BuildProgress;
    note: (line: string) => void;
    context: StimContext;
  },
): Promise<FailArgs | null> {
  const { targetRefusal, opts, settings, physical, runtime, d, progress, note, context } = args;
  if (targetRefusal || opts.installedApp) return targetRefusal;
  const installRuntime =
    opts.installRuntime === true ||
    (!physical && runtime !== null && settingValueAt(settings, 'ios.autoInstallRuntime') === true);
  if (installRuntime) {
    const selected = selectIosTarget(args);
    if ('failure' in selected) return selected.failure;
    if (physical || selected.backend || selected.placement || selected.machine === 'auto' || !runtime) {
      return {
        code: 'STIM_BAD_ARG',
        message: 'Installing an iOS runtime requires an explicit runtime and a local or named Mac simulator target.',
        remedy:
          'Pass --runtime <version> --install-runtime with --remote local or --remote <mac>; automatic placement, eas, proxy and physical phones do not install runtimes.',
      };
    }
    const recordedRuntime = selected.recorded?.device?.runtime;
    if (recordedRuntime && recordedRuntime.replace(/^iOS /, '') !== runtime.replace(/^iOS /, ''))
      return {
        code: 'STIM_BAD_ARG',
        message: `This workspace already records iOS ${recordedRuntime.replace(/^iOS /, '')} on ${selected.machine}; run stim stop first before installing another runtime.`,
        remedy: 'Run stim stop, then retry with the requested runtime.',
      };
    const installSignal = runCancellationSignal(context) ?? context.signal;
    progress.step('install');
    if (selected.machine) progress.place({ host: selected.machine, phase: 'runtime-install' });
    try {
      const installed = selected.machine
        ? await d.installHostedIosRuntime(selected.machine, runtime, note, installSignal)
        : await d.ensureIosRuntime({ requested: runtime, signal: installSignal, operation: context, note });
      if (!installed.ok) return installed;
    } finally {
      progress.place(null);
      progress.step('prepare');
    }
  }
  return null;
}
