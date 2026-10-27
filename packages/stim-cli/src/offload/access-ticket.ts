import { ambientEnv } from '@stim-cli/core';
import { decodeSecret } from '@stim-cli/core/noise-session';

/** The setup ticket in `STIM_ACCESS_TICKET`, which Stim Desktop's Add Machine flow sets, or undefined. */
export function readAccessTicket(): string | undefined {
  const ticket = ambientEnv().STIM_ACCESS_TICKET?.trim();
  return ticket && decodeSecret(ticket) ? ticket : undefined;
}

export function readHostPermissions(
  value: unknown,
): { name: string; screenRecording: boolean; accessibility: boolean } | undefined {
  const host = value as { name?: unknown; screenRecording?: unknown; accessibility?: unknown } | null;
  return host &&
    typeof host.name === 'string' &&
    typeof host.screenRecording === 'boolean' &&
    typeof host.accessibility === 'boolean'
    ? { name: host.name, screenRecording: host.screenRecording, accessibility: host.accessibility }
    : undefined;
}
