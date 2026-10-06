import type { MacosAppRecord } from '@stim-cli/core/state';
import { probeHostedMacos, type HostedMacosProbe } from './hosted-macos.ts';

interface MacosStatusFacts {
  record: MacosAppRecord | null;
  warning?: string;
}

export function applyHostedMacosProbe(record: MacosAppRecord, probe: HostedMacosProbe): MacosStatusFacts {
  if (!record.host || probe.state === 'ready') return { record };
  const { machine, session } = record.host;
  if (probe.state === 'stopped') {
    return {
      record: { ...record, hostLaunched: false },
      warning: `The macOS app on ${machine} is no longer running (the host reports session ${session} stopped or no longer holds it, for example after a stim-server restart there). Run stim macos --remote ${machine} to launch it again, or stim stop to clear the placement.`,
    };
  }
  return {
    record: { ...record, hostLaunched: 'unverified' },
    warning:
      probe.state === 'unknown'
        ? `${probe.notice ?? `The host cannot confirm session ${session} on ${machine}.`} Run stim stop to reconcile it.`
        : `${machine} could not be checked (${probe.reason}), so the macOS app there is unverified. The placement stays recorded; run stim stop when the host answers.`,
  };
}

export async function readHostedMacosStatus(
  record: MacosAppRecord | null,
  options?: Parameters<typeof probeHostedMacos>[1],
): Promise<MacosStatusFacts> {
  if (!record?.host || record.supervisor || !record.hostLaunched) return { record };
  return applyHostedMacosProbe(record, await probeHostedMacos(record.host, options));
}
