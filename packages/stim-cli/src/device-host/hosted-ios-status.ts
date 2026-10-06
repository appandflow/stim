import { hostedIosStatus, type HostedIosPlacement, type SimulatorState } from '@stim-cli/core/state';
import { probeHostedSession, type HostedSessionProbe } from './hosted-client.ts';

export function applyHostedIosProbe(
  placement: HostedIosPlacement,
  probe: HostedSessionProbe,
  slot = 'default',
): { ios: SimulatorState; warning?: string } {
  const rerun = `stim ios --remote ${placement.machine}${slot === 'default' ? '' : ` --slot ${slot}`}`;
  const state = probe.state === 'ready' ? 'ready' : probe.state === 'stopped' ? 'stopped' : 'unverified';
  return {
    ios: {
      host: {
        ...hostedIosStatus(placement),
        state,
      },
      name: placement.device?.name ?? null,
      udid: '',
      owned: false,
      state,
    },
    ...(probe.state === 'ready'
      ? {}
      : {
          warning:
            probe.state === 'stopped'
              ? `The iOS session on ${placement.machine} stopped or no longer exists. Run ${rerun} to launch it again, or stim stop to clear the placement.`
              : `${placement.machine} could not confirm its iOS session${probe.state === 'unknown' ? (probe.notice ? `: ${probe.notice}` : '') : `: ${probe.reason}`}. The placement stays recorded; run stim stop when the host answers.`,
        }),
  };
}

export async function readHostedIosStatus(
  placements: Record<string, HostedIosPlacement>,
): Promise<Record<string, ReturnType<typeof applyHostedIosProbe>>> {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(placements).map(async ([slot, placement]) => [
        slot,
        applyHostedIosProbe(placement, await probeHostedSession(placement), slot),
      ]),
    ),
  );
}
