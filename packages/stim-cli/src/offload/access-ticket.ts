import { createHash } from 'node:crypto';

export function readAccessTicket(): { ticket: string; ticketHash: string } | undefined {
  const ticket = process.env.STIM_ACCESS_TICKET?.trim();
  return ticket && /^[A-Za-z0-9_-]{43}$/.test(ticket)
    ? { ticket, ticketHash: createHash('sha256').update(ticket).digest('hex') }
    : undefined;
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
