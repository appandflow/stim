import type { NdjsonWriter } from '../ndjson.ts';
import type { SettingsObject } from '../workspace/settings.ts';

export interface ServerExitInfo {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  reason?: string;
  error?: Error;
}

export interface ServerHandle {
  close(): Promise<void> | void;
  onExit?(cb: (info?: ServerExitInfo | null) => void): void;
  serverPid?: number | null;
}

export type ServerStarter = (opts: {
  root: string;
  port: number;
  logsDir: string;
  writer?: NdjsonWriter | null;
  tunnel?: boolean;
  resetCache?: boolean;
  onTunnelUrl?: ((url: string) => void) | null;
  settings?: SettingsObject;
}) => Promise<ServerHandle>;
