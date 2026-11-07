export interface MetroEvent {
  type?: string;
  level?: unknown;
  data?: unknown;
  error?: unknown;
  stack?: unknown;
  codeFrame?: unknown;
  buildID?: string;
  bundleDetails?: { platform?: string | null };
}

export interface LogRecord {
  ts: number;
  src: 'metro' | 'client';
  level: string;
  msg: string;
  event?: string;
  stack?: unknown;
  marker?: boolean;
  buildID?: string;
  platform?: string;
}

export interface NdjsonReporter {
  dir: string;
  update(event: MetroEvent): void;
  readonly drops: number;
}

export function ndjsonReporter(options?: { dir?: string }): NdjsonReporter;

export function startHeartbeat(file: string, fields?: Record<string, unknown>): void;
