import type { NdjsonRecord } from '../ndjson.ts';
import { probePublicHttp } from './public-http-probe.ts';

export const REMOTE_METRO_WRONG = 'STIM_REMOTE_METRO_WRONG';

const GATE_TIMEOUT_MS = 25_000;
const POLL_MS = 250;

export interface GateResult {
  ok?: true;
  failed?: true;
  code?: string;
  reason?: string;
  remedy?: string;
}

export interface GateOptions {
  origin: string;
  metroPort: number | string;
  platform: 'ios' | 'android';
  entryPoint?: string;
  readRecords: () => NdjsonRecord[];
  isProof: (record: NdjsonRecord, since: number) => boolean;
  probe?: (url: string, signal: AbortSignal) => Promise<number | null>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export function probeBundleUrl(origin: string, platform: 'ios' | 'android', entryPoint = 'index'): string {
  const entry = entryPoint.replace(/^\/+/, '').replace(/\.(?:[cm]?[jt]sx?)$/, '');
  return `${origin.replace(/\/+$/, '')}/${entry}.bundle?platform=${platform}&dev=true`;
}

export async function gateMetroOrigin({
  origin,
  metroPort,
  platform,
  entryPoint = 'index',
  readRecords,
  isProof,
  probe = probePublicHttp,
  now = Date.now,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  timeoutMs = GATE_TIMEOUT_MS,
}: GateOptions): Promise<GateResult> {
  const since = now();
  const controller = new AbortController();
  const bundleUrl = probeBundleUrl(origin, platform, entryPoint);
  let status: number | null = null;
  let pending = false;
  let request: Promise<void> = Promise.resolve();
  const startProbe = () => {
    pending = true;
    request = (async () => {
      try {
        status = await probe(bundleUrl, controller.signal);
      } catch {
        status = null;
      } finally {
        pending = false;
      }
    })();
  };
  startProbe();

  try {
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      for (const record of readRecords()) {
        if (isProof(record, since)) return { ok: true };
      }
      if (!pending && status === null) startProbe();
      await sleep(POLL_MS);
    }
  } finally {
    controller.abort();
  }

  await request;
  return {
    failed: true,
    code: REMOTE_METRO_WRONG,
    reason: describeMiss(origin, metroPort, status),
    remedy:
      `Check that ${origin} forwards to port ${metroPort} on THIS machine. ` +
      'A tunnel built for a port this workspace no longer holds will answer normally and serve a different project. ' +
      '`stim start` prints the port it reserved.',
  };
}

export function describeMiss(origin: string, metroPort: number | string, status: number | null): string {
  if (status === null) {
    return `${origin} did not answer, so it cannot be this workspace's Metro (port ${metroPort}).`;
  }
  if (status >= 500) {
    return `${origin} answered ${status}, so it reached a tunnel but not a dev server (port ${metroPort} may no longer be forwarded).`;
  }
  return `${origin} answered ${status}, but the request never reached THIS workspace's Metro on port ${metroPort} -- it is serving a different dev server.`;
}
