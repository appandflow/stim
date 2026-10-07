import type { HostedNativePlacement, HostedIosDevice, HostedAndroidDevice } from '@stim-cli/core/state';
import type { HostedSessionProbe } from './hosted-client.ts';

export function hostedNativeProbe(
  placement: HostedNativePlacement<HostedIosDevice | HostedAndroidDevice>,
  probe: HostedSessionProbe,
  slot: string,
  platform: 'ios' | 'android',
): { state: 'ready' | 'stopped' | 'unverified'; warning?: string } {
  const label = platform === 'ios' ? 'iOS' : 'Android';
  const rerun = `stim ${platform} --remote ${placement.machine}${slot === 'default' ? '' : ` --slot ${slot}`}`;
  const state = probe.state === 'ready' ? 'ready' : probe.state === 'stopped' ? 'stopped' : 'unverified';
  return {
    state,
    ...(probe.state === 'ready'
      ? {}
      : {
          warning:
            probe.state === 'stopped'
              ? `The ${label} session on ${placement.machine} stopped or no longer exists. Run ${rerun} to launch it again, or stim stop to clear the placement.`
              : `${placement.machine} could not confirm its ${label} session${probe.state === 'unknown' ? (probe.notice ? `: ${probe.notice}` : '') : `: ${probe.reason.replace(/\.+$/, '')}`}. The placement stays recorded; run stim stop when the host answers.`,
        }),
  };
}
