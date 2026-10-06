import { createHash } from 'node:crypto';

export function readAccessTicket(): { ticket: string; ticketHash: string } | undefined {
  const ticket = process.env.STIM_ACCESS_TICKET?.trim();
  return ticket ? { ticket, ticketHash: createHash('sha256').update(ticket).digest('hex') } : undefined;
}
