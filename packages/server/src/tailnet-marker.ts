import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { serverDir, writeJson } from './registry.ts';

/**
 * `server/tailnet.json` records that this machine uses the tailnet, and why, so the net thread loads the Tailscale
 * transport at every start from then on. Stim never removes it, and a start that finds a pairing, an approved client
 * or a serve route in this home writes it again.
 */
export function tailnetMarkerFile(server: string = serverDir()): string {
  return join(server, 'tailnet.json');
}

export function hasTailnetMarker(): boolean {
  return existsSync(tailnetMarkerFile());
}

/** Writes the marker into `server`, the server directory of the Stim home that uses the tailnet. */
export function markTailnet(reason: string, server: string = serverDir()): void {
  if (existsSync(tailnetMarkerFile(server))) return;
  mkdirSync(server, { recursive: true, mode: 0o700 });
  writeJson(tailnetMarkerFile(server), { since: new Date().toISOString(), reason });
}
