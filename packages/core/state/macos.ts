import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceName } from '../index.ts';
import { readJsonObject } from './json-file.ts';
import { inspectProcessIdentity } from '../process-identity.ts';
import { parseHostedMacosPlacement, type HostedMacosPlacement } from './hosted-macos.ts';
import { readWorkspaceState } from './workspace-state.ts';

export interface MacosProcess {
  pid: number;
  processToken: string;
  startedAtMicros: number;
}

export interface MacosBuild {
  state: 'running' | 'ok' | 'failed';
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string;
  errorCode?: string;
  buildMachine?: string;
  builtOn?: string;
  offloadedTo?: string;
  offloadFallback?: string;
}

export interface MacosAppRecord {
  launchId: string;
  arguments: string[];
  product: string;
  bundle: string;
  bundleId: string;
  executable: string;
  build: MacosBuild;
  supervisor?: MacosProcess;
  app?: MacosProcess;
  /** Set when `stim macos --host` reserved a session on another Mac; the app then has no local process. */
  host?: HostedMacosPlacement;
  /** Host launch evidence: true for a live app; status can override it in memory after probing the session. */
  hostLaunched?: boolean | 'unverified';
}

export interface MacosAppState extends MacosAppRecord {
  state: 'running' | 'orphaned' | 'stopped' | 'unverified';
}

function processRecord(value: unknown): MacosProcess | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { pid, processToken, startedAtMicros } = value as Record<string, unknown>;
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || typeof processToken !== 'string') return undefined;
  if (!Number.isSafeInteger(startedAtMicros) || (startedAtMicros as number) <= 0) return undefined;
  return { pid: pid as number, processToken, startedAtMicros: startedAtMicros as number };
}

export function parseMacosRecord(value: unknown): MacosAppRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const {
    launchId,
    arguments: args,
    product,
    bundle,
    bundleId,
    executable,
    build,
    supervisor,
    app,
    host,
    hostLaunched,
  } = value as Record<string, unknown>;
  if (typeof launchId !== 'string' || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) return null;
  if ([product, bundle, bundleId, executable].some((field) => typeof field !== 'string')) return null;
  if (!build || typeof build !== 'object') return null;
  const b = build as Record<string, unknown>;
  if (!['running', 'ok', 'failed'].includes(String(b.state)) || typeof b.startedAt !== 'string') return null;
  if ((app !== undefined && !processRecord(app)) || (supervisor !== undefined && !processRecord(supervisor)))
    return null;
  const placement = host === undefined ? undefined : parseHostedMacosPlacement(host);
  if (
    placement === null ||
    (hostLaunched !== undefined && typeof hostLaunched !== 'boolean' && hostLaunched !== 'unverified')
  )
    return null;
  return {
    launchId,
    arguments: args as string[],
    product: product as string,
    bundle: bundle as string,
    bundleId: bundleId as string,
    executable: executable as string,
    build: {
      state: b.state as MacosBuild['state'],
      startedAt: b.startedAt,
      ...(typeof b.finishedAt === 'string' ? { finishedAt: b.finishedAt } : {}),
      ...(typeof b.durationMs === 'number' ? { durationMs: b.durationMs } : {}),
      ...(typeof b.error === 'string' ? { error: b.error } : {}),
      ...(typeof b.buildMachine === 'string' ? { buildMachine: b.buildMachine } : {}),
      ...(typeof b.builtOn === 'string' ? { builtOn: b.builtOn } : {}),
      ...(typeof b.errorCode === 'string' ? { errorCode: b.errorCode } : {}),
      ...(typeof b.offloadedTo === 'string' ? { offloadedTo: b.offloadedTo } : {}),
      ...(typeof b.offloadFallback === 'string' ? { offloadFallback: b.offloadFallback } : {}),
    },
    ...(processRecord(supervisor) ? { supervisor: processRecord(supervisor) } : {}),
    ...(processRecord(app) ? { app: processRecord(app) } : {}),
    ...(placement ? { host: placement } : {}),
    ...(hostLaunched !== undefined ? { hostLaunched: hostLaunched as boolean | 'unverified' } : {}),
  };
}

export function readMacosRecord(root: string): MacosAppRecord | null {
  return parseMacosRecord(readWorkspaceState(root)?.macos);
}

export function readHostedMacosApp(home: string): MacosAppRecord | null {
  try {
    const root = realpathSync(join(home, 'macos-app'));
    return parseMacosRecord(readJsonObject(join(home, 'workspaces', workspaceName(root), 'state.json'))?.macos);
  } catch {
    return null;
  }
}

export function macosAppState(record: MacosAppRecord | null): MacosAppState | null {
  if (!record) return null;
  const app = record.app ? inspectProcessIdentity(record.app) : 'gone';
  const supervisor = record.supervisor ? inspectProcessIdentity(record.supervisor) : 'gone';
  const interrupted = record.build.state === 'running' && (supervisor === 'gone' || supervisor === 'different');
  return {
    ...record,
    ...(interrupted
      ? {
          build: {
            ...record.build,
            state: 'failed' as const,
            error: 'The build process exited before reporting a result.',
          },
        }
      : {}),
    state: record.host
      ? record.supervisor || !record.hostLaunched
        ? 'stopped'
        : record.hostLaunched === true
          ? 'running'
          : 'unverified'
      : app === 'unknown' || supervisor === 'unknown'
        ? 'unverified'
        : app === 'same'
          ? supervisor === 'same'
            ? 'running'
            : 'orphaned'
          : 'stopped',
  };
}
