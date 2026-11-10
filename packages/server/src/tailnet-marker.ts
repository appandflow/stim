import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { serverDir, writeJson } from './registry.ts';

/**
 * `server/tailnet.json` records that this machine uses the tailnet, and why, so the net thread loads the Tailscale
 * transport at every start from then on. It is written once and never removed.
 */
export function tailnetMarkerFile(): string {
  return join(serverDir(), 'tailnet.json');
}

export function hasTailnetMarker(): boolean {
  return existsSync(tailnetMarkerFile());
}

export function markTailnet(reason: string): void {
  if (hasTailnetMarker()) return;
  mkdirSync(serverDir(), { recursive: true, mode: 0o700 });
  writeJson(tailnetMarkerFile(), { since: new Date().toISOString(), reason });
}
