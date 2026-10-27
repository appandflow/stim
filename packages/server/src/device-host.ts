import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { connect, type AddressInfo } from 'node:net';
import {
  withDirLock,
  createMetroBridge,
  createMetroLinks,
  type MetroBridge,
  type MetroLink,
  type MetroLinks,
} from '@stim-cli/core';
import {
  clearClaimChild,
  ClaimRefusedError,
  markClaimChildPending,
  processGroupAlive,
  releaseClaim,
  setClaimChild,
  tryAcquireClaim,
  type ClaimHandle,
} from '@stim-cli/core/ownership-claim';
import { captureProcessIdentity, inspectProcessIdentity, type ProcessRecord } from '@stim-cli/core/process-identity';
import {
  assertHostedDeviceLedger,
  createDebugLog,
  type DebugLog,
  deviceHostArea,
  HOSTED_PARKED_CANDIDATES,
  deviceHostRoot,
  getConcurrencyLimits,
  getParkedMax,
  getPlatformDeviceLimits,
  hostedIdleStopHours,
  isJsonObject,
  parseHostedPlatformDevice,
  hostedDeviceId,
  hostedMemoryRefusal,
  hostedMacosBundleId,
  HOSTED_MACOS_APP_SLOTS,
  loadConfig,
  parseHostedRequest,
  readHostedDevice,
  readHostedDeviceLedger,
  readHostedMacosApp,
  macosAppState,
  readJsonObject,
  readHostedSessions,
  parseHostedOfferRequest,
  maxLoadPerCore,
  parseHostedNativeOffer,
  parseHostedLocalPlatformCounts,
  hostedAppAttempt,
  hostedMacosLogsDir,
  hostedNativeLogsDir,
  parseHostedAppOffer,
  parseHostedLogsCursor,
  readHostedApp,
  readHostedAppMetadata,
  readHostedNativeLogsCheckpoint,
  readLogsSince,
  type HostedAppDelivery,
  type HostedAppLaunch,
  type HostedAppRecord,
  type HostedDeviceRequest,
  type HostedDeviceSession,
  type HostedLocalPlatformCounts,
  type HostedDeviceOffer,
  type HostedIosDevice,
  type HostedAndroidDevice,
  type HostedMacosDevice,
  type MacosAppState,
  DEVICE_HOST_LIMITS,
  hostedWorkerSettleMs,
  type DeviceHostLimits,
} from '@stim-cli/core/state';
import { readDeviceHostClients, writeJson } from './registry.ts';
import { readHostedSessionRows } from './hosted-sessions.ts';
import { takeHostedInputClaim } from './hosted-input.ts';
import { planHostedIdleStops } from './hosted-idle.ts';
import { adbPath } from './frame-helper.ts';
import type { Methods, ProtocolError } from './protocol.ts';
import { appDelivery, offerHostedApp, chunkHostedApp, changeHostedApp, handOverHostedApp } from './hosted-app.ts';
import type { HostedAgentHost } from './agent-driver.ts';

interface WorkerRun {
  done: Promise<{ value: unknown; settled: boolean; notice?: string }>;
  cancel: () => void;
}

interface OwnedSession {
  claim: ClaimHandle;
  adopting?: boolean;
  imagePhase?: boolean;
  reachedReady?: boolean;
  run?: WorkerRun;
  data?: Promise<void>;
  logs?: { started: number; more: boolean; run?: WorkerRun; pending?: Promise<void> };
  stopping?: Promise<void>;
  installing?: { attempt: string; done: Promise<void> };
  app?: HostedAppRecord;
  installedAttempt?: string;
  metro?: {
    bridge: MetroBridge;
    ready: Promise<number>;
    clientMetroPort?: number;
    port?: number;
    closing?: boolean;
  };
  links?: MetroLinks;
  viewer?: { close: () => Promise<void> };
}

export interface DeviceHostOptions {
  worker: string;
  env: NodeJS.ProcessEnv;
  allowed: (client: string) => boolean;
  /** Whether `client` has an authenticated connection now; without it no client counts as gone. */
  connected?: (client: string) => boolean;
  /** Issues and revokes session-scoped agent control for installed hosted apps. */
  agents: Pick<HostedAgentHost, 'appRunning' | 'appStopped' | 'access'>;
  /** Takes the native app a build on this machine retained under `handoff`, when `client` may have it, or says why not. */
  builtBundle?: (client: string, handoff: string, sha256: string) => { bundle: string; release: () => void } | string;
  limits?: Partial<DeviceHostLimits>;
}

type HostedViewTarget = { home: string; claim: ClaimHandle } & (
  | { platform: 'ios'; session: HostedDeviceSession & { device: HostedIosDevice } }
  | { platform: 'android'; session: HostedDeviceSession & { device: HostedAndroidDevice } }
  | {
      platform: 'macos';
      session: HostedDeviceSession & { device: HostedMacosDevice };
      app: MacosAppState & { app: NonNullable<MacosAppState['app']> };
    }
);

type Answer = { result: HostedDeviceSession } | { error: ProtocolError };
type AppAnswer<T> = { result: T } | { error: ProtocolError };
const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const refused = (code: ProtocolError['code'], message: string): { error: ProtocolError } => ({
  error: { code, message },
});

function hostedDeviceExclusions(records: HostedDeviceSession[]) {
  return records.flatMap((record) => {
    if (record.platform !== 'ios' || record.state === 'stopped') return [];
    const udids = new Set<string>();
    if (record.device) udids.add(hostedDeviceId(record.device));
    try {
      for (const udid of readHostedDeviceLedger(join(deviceHostArea(record.id), 'home'))?.ios ?? []) udids.add(udid);
    } catch {}
    return [...udids].map((key) => ({ platform: 'ios' as const, key }));
  });
}

function occupiedBy(records: HostedDeviceSession[], platform: HostedDeviceSession['platform']): number {
  return records.filter(
    (record) => record.state !== 'stopped' && (record.platform === 'macos') === (platform === 'macos'),
  ).length;
}

const capacityUnknown = (why: string) => `Hosted device capacity is unknown: ${why}`;

const HOSTED_PLATFORM_CAPS = {
  ios: { setting: 'concurrency.maxIosDevices', label: 'iOS', noun: 'iOS simulator' },
  android: { setting: 'concurrency.maxAndroidDevices', label: 'Android', noun: 'Android emulator' },
  macos: { setting: 'concurrency.maxMacosApps', label: 'macOS', noun: 'macOS app' },
} as const;

const used = (limit: { hosted: number; local: number | null }) => limit.hosted + (limit.local ?? 0);

/**
 * What a hosted reservation on `platform` must fit: the platform's own cap `cap` and the shared `max`, where macOS apps
 * fill a pool of their own against `max`. `local` counts the host's own simulators and emulators, absent where they are
 * not counted. `full` names the first limit with no room, the platform's before the shared one.
 */
function hostedCapacity(
  records: HostedDeviceSession[],
  platform: HostedDeviceSession['platform'],
  max: number,
  cap: number,
  local: HostedLocalPlatformCounts | undefined,
): { running: number; available: number | null; full: string | null } {
  const macos = platform === 'macos';
  const localTotal = local ? local.ios + local.android : 0;
  const pool = occupiedBy(records, platform);
  const limits: { setting: string; label: string; noun: string; hosted: number; local: number | null; max: number }[] =
    [];
  if (cap > 0)
    limits.push({
      ...HOSTED_PLATFORM_CAPS[platform],
      hosted: records.filter((record) => record.state !== 'stopped' && record.platform === platform).length,
      local: macos ? null : (local?.[platform] ?? 0),
      max: cap,
    });
  if (max > 0)
    limits.push({
      setting: 'concurrency.maxDevices',
      label: macos ? 'macOS' : 'device',
      noun: macos ? 'macOS app' : 'device',
      hosted: pool,
      local: macos ? null : localTotal,
      max,
    });
  const full = limits.find((limit) => used(limit) >= limit.max);
  return {
    running: pool + (macos ? 0 : localTotal),
    available: limits.length ? Math.max(0, Math.min(...limits.map((limit) => limit.max - used(limit)))) : null,
    full: full
      ? `Hosted ${full.label} capacity is full: ${full.local === null ? full.hosted : `${full.hosted} hosted + ${full.local} local`} of ${full.max} ${full.noun} reservations are occupied (${full.setting}), including unresolved sessions.`
      : null,
  };
}

/** macOS lets 127.0.0.1 bind beside a wildcard listener and takes its loopback traffic, so probe by connecting. */
function loopbackAccepts(port: number): Promise<boolean> {
  const accepts = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = connect({ host, port });
      const done = (open: boolean) => {
        socket.destroy();
        resolve(open);
      };
      socket.setTimeout(1000, () => done(true));
      socket.once('connect', () => done(true));
      socket.once('error', (error: NodeJS.ErrnoException) =>
        done(!['ECONNREFUSED', 'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'ENETUNREACH'].includes(error.code ?? '')),
      );
    });
  return Promise.all([accepts('127.0.0.1'), accepts('::1')]).then((open) => open.includes(true));
}

/** Owns hosted reservations, not build jobs or viewer connections. Native work runs in the packaged CLI child. */
export class DeviceHost {
  private readonly owned = new Map<string, OwnedSession>();
  private readonly revoked = new Set<string>();
  private readonly probes = new Map<WorkerRun, string>();
  private closed = false;
  private lastIdleSweep: number | undefined;
  private clientActive = new Set<string>();
  private clientsSeen = new Set<string>();
  private readonly idleKept = new Map<string, string>();
  private reconciling?: Promise<void>;
  private draining: string | null = null;
  private readonly limits: DeviceHostLimits;
  private readonly debug: DebugLog;

  private readonly options: DeviceHostOptions;

  constructor(options: DeviceHostOptions) {
    this.options = options;
    this.debug = createDebugLog('server', { env: options.env });
    this.limits = { ...DEVICE_HOST_LIMITS, ...options.limits };
  }

  private transaction<T>(fn: (records: HostedDeviceSession[]) => T): T {
    const root = deviceHostRoot();
    return withDirLock(
      `${root}.lock`,
      () => {
        if (!existsSync(root)) {
          readHostedSessions();
          mkdirSync(root, { recursive: true, mode: 0o700 });
          writeJson(join(root, 'sessions.json'), { version: 1, sessions: [] });
        }
        const records = readHostedSessions();
        const result = fn(records);
        writeJson(join(root, 'sessions.json'), { version: 1, sessions: records });
        return result;
      },
      { ensureParent: () => mkdirSync(join(root, '..'), { recursive: true, mode: 0o700 }) },
    );
  }

  private change(id: string, update: (record: HostedDeviceSession) => void): void {
    this.transaction((records) => {
      const record = records.find((each) => each.id === id);
      if (!record) throw new Error('Hosted session journal no longer contains this reservation.');
      update(record);
    });
  }

  private acquire(record: HostedDeviceSession): OwnedSession {
    const existing = this.owned.get(record.id);
    if (existing) return existing;
    const attempt = tryAcquireClaim({
      root: join(deviceHostRoot(), `${record.id}.claims`),
      mode: 'exclusive',
      label: 'hosted device session',
      details: { session: record.id, client: record.client },
    });
    if (attempt.pending) releaseClaim(attempt.pending);
    if (!attempt.acquired)
      throw new Error(`Hosted session is held by another process: ${join(deviceHostRoot(), `${record.id}.claims`)}`);
    try {
      releaseClaim(takeHostedInputClaim(attempt.acquired));
      releaseClaim(this.takeLogsClaim(attempt.acquired));
    } catch (error) {
      releaseClaim(attempt.acquired);
      throw error;
    }
    const owned = { claim: attempt.acquired };
    this.owned.set(record.id, owned);
    return owned;
  }

  async offer(client: string, params: unknown): Promise<AppAnswer<HostedDeviceOffer>> {
    if (this.closed || !this.options.allowed(client))
      return refused('forbidden', 'Current device-host approval is required.');
    const request = parseHostedOfferRequest(params);
    if (!request) return refused('bad-request', 'offer needs a platform and valid optional selectors.');
    try {
      const max = getConcurrencyLimits({ env: this.options.env }).maxDevices;
      const cap = getPlatformDeviceLimits({ env: this.options.env })[request.platform];
      const counted = request.platform !== 'macos' && (max > 0 || cap > 0);
      const recordsBefore = readHostedSessions();
      const result = await this.probe(client, {
        mode: 'offer',
        ...request,
        ...(counted ? { exclude: hostedDeviceExclusions(recordsBefore) } : {}),
      });
      if (this.closed || !this.options.allowed(client))
        return refused('forbidden', 'Current device-host approval is required.');
      if (!result.settled || result.notice) throw new Error(result.notice ?? 'Hosted offer worker did not settle.');
      const native = parseHostedNativeOffer(result.value);
      if (!native || native.platform !== request.platform) throw new Error('Invalid native hosted offer.');
      const records = readHostedSessions();
      const local = counted
        ? (native.resources.localPlatforms ?? { unknown: 'Host local device count is unavailable.' })
        : undefined;
      const capacity = hostedCapacity(
        records,
        request.platform,
        max,
        cap,
        local && 'unknown' in local ? undefined : local,
      );
      let declined =
        this.draining ??
        (loadConfig()?.server?.devicesPaused === true
          ? 'Hosted sessions are paused; resume with stim settings set server.devicesPaused false'
          : null) ??
        native.declined ??
        hostedMemoryRefusal(native.resources.memoryPressure);
      if (request.platform === 'android' || request.platform === 'macos') {
        try {
          if (request.platform === 'android') reserveAndroidPort(records);
          else reserveMacosSlot(records);
        } catch (error) {
          declined = (error as Error).message;
        }
      }
      if (local && 'unknown' in local) declined = capacityUnknown(local.unknown);
      else if (capacity.full) declined = capacity.full;
      const resources = { ...native.resources, maxLoadPerCore: maxLoadPerCore() };
      delete resources.localPlatforms;
      return {
        result: {
          ...native,
          resources,
          declined,
          capacity: {
            running: capacity.running,
            max,
            available: local && 'unknown' in local ? 0 : capacity.available,
            ...(local !== undefined ? { local: 'unknown' in local ? local : local.ios + local.android } : {}),
          },
        },
      };
    } catch (error) {
      return refused('action-failed', (error as Error).message);
    }
  }

  private async probe(client: string, input: object): Promise<Awaited<WorkerRun['done']>> {
    const probe = this.runWorker({
      cwd: dirname(this.options.worker),
      env: this.options.env,
      input,
      timeoutMs: this.limits.offerMs,
      maxOutputBytes: 32_768,
    });
    this.probes.set(probe, client);
    try {
      return await probe.done;
    } finally {
      this.probes.delete(probe);
    }
  }

  async reserve(client: string, params: unknown): Promise<Answer> {
    if (this.closed || !this.options.allowed(client))
      return refused('forbidden', 'Current device-host approval is required.');
    const request = parseHostedRequest(params);
    if (!request)
      return refused(
        'bad-request',
        'reserve needs an iOS, Android or macOS workspace, slot, attempt and valid optional selectors.',
      );
    let start: HostedDeviceSession | null = null;
    try {
      const max = getConcurrencyLimits({ env: this.options.env }).maxDevices;
      const cap = getPlatformDeviceLimits({ env: this.options.env })[request.platform];
      const recordsBefore = readHostedSessions();
      const candidate = await this.parkedCandidate(client, request, recordsBefore);
      if (this.closed || !this.options.allowed(client))
        return refused('forbidden', 'Current device-host approval is required.');
      let local: HostedLocalPlatformCounts | { unknown: string } = { ios: 0, android: 0 };
      if (
        (max > 0 || cap > 0) &&
        request.platform !== 'macos' &&
        !recordsBefore.some((record) => record.client === client && record.attempt === request.attempt)
      ) {
        const probe = await this.probe(client, { mode: 'count', exclude: hostedDeviceExclusions(recordsBefore) });
        if (this.closed || !this.options.allowed(client))
          return refused('forbidden', 'Current device-host approval is required.');
        local =
          probe.settled && !probe.notice
            ? (parseHostedLocalPlatformCounts(probe.value) ?? { unknown: 'Host local device count is unavailable.' })
            : { unknown: probe.notice ?? 'Host local device count worker did not settle.' };
      }
      const result = this.transaction((records) => {
        const retry = records.find((record) => record.client === client && record.attempt === request.attempt);
        if (retry) {
          if (!sameRequest(retry, request)) throw new Error('This attempt already names a different reservation.');
          return this.observed(retry);
        }
        const occupied = records.find(
          (record) =>
            record.client === client &&
            record.workspace === request.workspace &&
            record.platform === request.platform &&
            record.slot === request.slot &&
            record.state !== 'stopped',
        );
        if (occupied)
          throw new Error(`This workspace slot already has session ${occupied.id}; attach or stop it first.`);
        if (this.draining) throw new Error(`This Mac takes no new hosted sessions: ${this.draining}.`);
        if (loadConfig()?.server?.devicesPaused === true)
          throw new Error('Hosted sessions are paused; resume with stim settings set server.devicesPaused false.');
        if ('unknown' in local) throw new Error(capacityUnknown(local.unknown));
        const { full } = hostedCapacity(records, request.platform, max, cap, local);
        if (full) throw new Error(full);
        const adopted =
          candidate &&
          records.find(
            (record) =>
              record.id === candidate.id &&
              record.state === 'stopped' &&
              record.parked &&
              record.client === client &&
              !this.owned.has(record.id) &&
              !this.revoked.has(record.id),
          );
        let adoption: OwnedSession | undefined;
        if (adopted) {
          try {
            adoption = this.acquire(adopted);
          } catch {}
          if (adoption) {
            const owned = adoption;
            try {
              const home = join(deviceHostArea(adopted.id), 'home');
              const ledger = readHostedDeviceLedger(home);
              if (
                !ledger ||
                !adopted.device ||
                !ledger[request.platform === 'android' ? 'android' : 'ios'].includes(hostedDeviceId(adopted.device))
              ) {
                this.release(adopted.id, owned);
                adoption = undefined;
              } else
                rmSync(hostedNativeLogsDir(home, request.platform === 'android' ? 'android' : 'ios'), {
                  recursive: true,
                  force: true,
                });
            } catch (error) {
              this.release(adopted.id, owned);
              throw error;
            }
          }
        }
        if (adopted && adoption) {
          const consolePort = request.platform === 'android' ? reserveAndroidPort(records) : undefined;
          const owned = adoption;
          owned.adopting = true;
          for (const key of [
            'deviceType',
            'runtime',
            'systemImage',
            'deviceProfile',
            'parked',
            'notice',
            'appAttempt',
            'agent',
            'metroPort',
            'clientMetroPort',
            'clientAbsentMs',
            'idleStop',
          ] as const)
            delete adopted[key];
          Object.assign(adopted, request, { state: 'preparing', createdAt: new Date().toISOString() });
          if (consolePort !== undefined) {
            adopted.consolePort = consolePort;
            adopted.device = {
              ...(adopted.device as HostedAndroidDevice),
              consolePort,
              serial: `emulator-${consolePort}`,
            };
          }
          start = adopted;
          return adopted;
        }
        const record: HostedDeviceSession = {
          ...request,
          id: randomUUID(),
          client,
          state: 'preparing',
          device: null,
          createdAt: new Date().toISOString(),
          ...(request.platform === 'android' ? { consolePort: reserveAndroidPort(records) } : {}),
          ...(request.platform === 'macos' ? { appSlot: reserveMacosSlot(records) } : {}),
        };
        this.acquire(record);
        records.push(record);
        start = record;
        return record;
      });
      if (start) void this.prepare(start).catch((error: unknown) => this.failed(start!.id, error));
      return { result };
    } catch (error) {
      return refused('device-busy', (error as Error).message);
    }
  }

  private async parkedCandidate(
    client: string,
    request: HostedDeviceRequest,
    records: HostedDeviceSession[],
  ): Promise<HostedDeviceSession | null> {
    if (
      request.platform === 'macos' ||
      this.parkedMax(request.platform) === 0 ||
      records.some((record) => record.client === client && record.attempt === request.attempt)
    )
      return null;
    const candidates = records
      .filter(
        (record) =>
          record.state === 'stopped' &&
          record.parked &&
          record.client === client &&
          record.platform === request.platform &&
          !this.owned.has(record.id) &&
          !this.revoked.has(record.id),
      )
      .toSorted((a, b) => a.parked!.at.localeCompare(b.parked!.at))
      .slice(0, HOSTED_PARKED_CANDIDATES);
    for (const record of candidates) {
      if (this.closed || !this.options.allowed(client)) break;
      if (this.owned.has(record.id)) continue;
      let owned: OwnedSession;
      try {
        owned = this.acquire(record);
      } catch {
        continue;
      }
      let unusable = false;
      try {
        const home = join(deviceHostArea(record.id), 'home');
        const run = this.runWorker({
          cwd: home,
          env: { ...this.options.env, STIM_HOME: home },
          input: { ...request, session: record.id, mode: 'inspect' },
          timeoutMs: this.limits.offerMs,
          maxOutputBytes: 16_384,
        });
        owned.run = run;
        const outcome = await run.done;
        if (outcome.settled && !outcome.notice && isJsonObject(outcome.value)) {
          if (outcome.value.state === 'compatible') return record;
          unusable = outcome.value.state === 'unusable';
        }
      } catch (error) {
        process.stderr.write(
          `Hosted session ${record.id} inspection failed: ${(error as Error).message.replace(/[\r\n]+/g, ' ')}\n`,
        );
      } finally {
        this.release(record.id, owned);
        if (!this.options.allowed(client)) await this.retire(record);
      }
      if (unusable) await this.retire(record);
    }
    return null;
  }

  private parkedMax(platform: 'ios' | 'android'): number {
    try {
      return getParkedMax(platform, { env: this.options.env }).max;
    } catch {
      return 0;
    }
  }

  private observed(record: HostedDeviceSession): HostedDeviceSession {
    const observed = { ...record };
    delete observed.parked;
    if (record.state !== 'stopped' && !this.owned.has(record.id))
      return {
        ...observed,
        state: 'unknown',
        notice:
          'The previous session owner is not attached to this server. Explicit stop must reconcile the retained device before another reservation.',
      };
    return observed;
  }

  attach(client: string, params: unknown): Answer {
    if (!this.options.allowed(client)) return refused('forbidden', 'Current device-host approval is required.');
    if (!isJsonObject(params) || (typeof params.session !== 'string' && typeof params.attempt !== 'string'))
      return refused('bad-request', 'attach needs session or attempt.');
    try {
      const record = readHostedSessions().find(
        (each) =>
          each.client === client &&
          (typeof params.session === 'string' ? each.id === params.session : each.attempt === params.attempt),
      );
      return record
        ? { result: this.observed(record) }
        : refused('unknown-session', 'This client has no such hosted session.');
    } catch (error) {
      return refused('action-failed', (error as Error).message);
    }
  }

  sessions(): AppAnswer<Methods['device-host.sessions']['result']> {
    try {
      return {
        result: {
          sessions: readHostedSessionRows(
            readHostedSessions().map((record) => Object.assign(record, { state: this.observed(record).state })),
            readDeviceHostClients(),
          ),
        },
      };
    } catch (error) {
      return refused('action-failed', (error as Error).message);
    }
  }

  stopForPerson(session: string): AppAnswer<Methods['device-host.sessions.stop']['result']> {
    try {
      const record = readHostedSessions().find((each) => each.id === session);
      if (!record) return refused('unknown-session', 'No such hosted session.');
      this.beginStop(record);
      return { result: { id: record.id, state: record.state === 'stopped' ? 'stopped' : 'stopping' } };
    } catch (error) {
      return refused('action-failed', (error as Error).message);
    }
  }

  stop(client: string, params: unknown): Answer {
    if (!this.options.allowed(client)) return refused('forbidden', 'Current device-host approval is required.');
    if (!isJsonObject(params) || typeof params.session !== 'string')
      return refused('bad-request', 'stop needs session.');
    try {
      const record = readHostedSessions().find((each) => each.client === client && each.id === params.session);
      if (!record) return refused('unknown-session', 'This client has no such hosted session.');
      this.beginStop(record);
      return { result: this.observed({ ...record, state: record.state === 'stopped' ? 'stopped' : 'stopping' }) };
    } catch (error) {
      return refused('action-failed', (error as Error).message);
    }
  }

  async metroOpen(client: string, params: unknown): Promise<AppAnswer<{ port: number }>> {
    if (!this.options.allowed(client)) return refused('forbidden', 'Current device-host approval is required.');
    if (isJsonObject(params) && ('gatewayPort' in params || 'secret' in params))
      return refused(
        'protocol-unsupported',
        'This stim-server carries Metro over connections the client opens, and this Stim is too old for that. Update stim on this machine, then retry.',
      );
    if (
      !isJsonObject(params) ||
      typeof params.session !== 'string' ||
      (params.clientMetroPort !== undefined &&
        (typeof params.clientMetroPort !== 'number' ||
          !Number.isInteger(params.clientMetroPort) ||
          params.clientMetroPort < 1 ||
          params.clientMetroPort > 65535))
    )
      return refused('bad-request', 'Metro needs its session and, when given, a client Metro port.');
    try {
      const record = readHostedSessions().find((each) => each.client === client && each.id === params.session);
      if (!record || record.state !== 'ready' || this.closed || !this.owned.has(record.id))
        throw new Error('Only a ready session attached to this owner can open Metro.');
      if (record.platform !== 'ios' && record.platform !== 'android')
        throw new Error('Hosted Metro supports iOS and Android sessions only.');
      if (record.platform === 'android' && typeof params.clientMetroPort !== 'number')
        return refused('bad-request', 'Android Metro needs the client Metro port.');
      const owned = this.owned.get(record.id)!;
      if (owned.stopping || (record.platform === 'android' && (owned.installing || owned.data)))
        throw new Error('This hosted session has a native operation in progress.');
      if (owned.metro) {
        if (owned.metro.closing) throw new Error('This session Metro bridge is closing.');
        if (owned.metro.clientMetroPort !== params.clientMetroPort)
          throw new Error('Close this session Metro bridge before changing its client Metro port.');
        const port = await owned.metro.ready;
        await this.restoreAndroidMetro(record, owned);
        return { result: { port } };
      }
      const devClientPort = record.platform === 'ios' ? (params.clientMetroPort as number | undefined) : undefined;
      const bridge = createMetroBridge((owned.links ??= createMetroLinks()));
      const inUse = () =>
        Object.assign(
          new Error(
            `Port ${devClientPort} is in use on the hosting Mac, and an Expo dev client loads its bundle from the client's Metro port.`,
          ),
          { code: 'device-busy' as const },
        );
      const ready = (async () => {
        if (devClientPort !== undefined && (await loopbackAccepts(devClientPort))) throw inUse();
        return new Promise<number>((resolve, reject) => {
          bridge.server.once('error', (error: NodeJS.ErrnoException) =>
            reject(devClientPort !== undefined && error.code === 'EADDRINUSE' ? inUse() : error),
          );
          bridge.server.listen(devClientPort ?? record.metroPort ?? 0, '127.0.0.1', () =>
            resolve((bridge.server.address() as AddressInfo).port),
          );
        });
      })();
      const metro: NonNullable<OwnedSession['metro']> = {
        bridge,
        ready,
        clientMetroPort: params.clientMetroPort as number | undefined,
      };
      owned.metro = metro;
      try {
        const port = await ready;
        if (owned.stopping || this.closed || !this.options.allowed(client))
          throw new Error('The session lost its Metro approval while opening.');
        this.change(record.id, (current) => {
          current.metroPort = port;
          if (record.platform === 'android') current.clientMetroPort = params.clientMetroPort as number;
        });
        metro.port = port;
        await this.restoreAndroidMetro(record, owned);
        return { result: { port } };
      } catch (error) {
        await bridge.close();
        if (owned.metro === metro) delete owned.metro;
        throw error;
      }
    } catch (error) {
      return refused(
        (error as { code?: unknown }).code === 'device-busy' ? 'device-busy' : 'action-failed',
        (error as Error).message,
      );
    }
  }

  private async restoreAndroidMetro(record: HostedDeviceSession, owned: OwnedSession): Promise<void> {
    const attempt = owned.installedAttempt ?? record.appAttempt;
    if (record.platform !== 'android' || !attempt) return;
    if (owned.stopping || owned.installing || owned.data)
      throw new Error('This hosted session has a native operation in progress.');
    const app = readHostedAppMetadata(record.id, attempt);
    if (app.state !== 'installed' || app.mode !== 'development') return;
    const run = this.run(record, owned, 'reverse', attempt);
    owned.run = run;
    const done = (async () => {
      const outcome = await run.done;
      const device = isJsonObject(outcome.value) ? parseHostedPlatformDevice(outcome.value.device, 'android') : null;
      if (
        !outcome.settled ||
        outcome.notice ||
        !isJsonObject(outcome.value) ||
        outcome.value.state !== 'ready' ||
        !device ||
        !record.device ||
        hostedDeviceId(device) !== hostedDeviceId(record.device) ||
        !('avdName' in device) ||
        !('avdName' in record.device) ||
        device.serial !== record.device.serial ||
        device.consolePort !== record.consolePort
      ) {
        const error = new Error(
          outcome.notice ??
            (isJsonObject(outcome.value) && typeof outcome.value.notice === 'string'
              ? outcome.value.notice
              : 'Hosted Android Metro restore was not established.'),
        );
        if (!outcome.settled && !owned.stopping) this.failed(record.id, error);
        throw error;
      }
    })();
    const settled = done.catch(() => {});
    owned.data = settled;
    try {
      await done;
      if (owned.stopping || this.closed || !this.options.allowed(record.client))
        throw new Error('The session lost its Metro approval while restoring.');
    } finally {
      if (owned.data === settled) delete owned.data;
    }
  }

  /** Names the ports a new dev-client bridge could not bind, apart from this client's own dev-client bridges. */
  async metroPorts(client: string, params: unknown): Promise<AppAnswer<{ busy: number[] }>> {
    if (this.closed || !this.options.allowed(client))
      return refused('forbidden', 'Current device-host approval is required.');
    if (
      !isJsonObject(params) ||
      !Array.isArray(params.ports) ||
      params.ports.length > 256 ||
      params.ports.some((port) => typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)
    )
      return refused('bad-request', 'Metro ports needs at most 256 TCP ports.');
    try {
      const ports = [...new Set(params.ports as number[])];
      const sessions = new Set(readHostedSessions().flatMap((record) => (record.client === client ? [record.id] : [])));
      const own = new Set(
        [...this.owned].flatMap(([id, { metro }]) =>
          sessions.has(id) && metro?.port !== undefined && metro.port === metro.clientMetroPort ? [metro.port] : [],
        ),
      );
      const busy: number[] = [];
      const queue = ports.filter((port) => !own.has(port));
      await Promise.all(
        Array.from({ length: 16 }, async () => {
          for (let port = queue.shift(); port !== undefined; port = queue.shift())
            if (await loopbackAccepts(port)) busy.push(port);
        }),
      );
      return { result: { busy: busy.toSorted((a, b) => a - b) } };
    } catch (error) {
      return refused('action-failed', (error as Error).message);
    }
  }

  async metroClose(client: string, params: unknown): Promise<AppAnswer<{ port: null }>> {
    if (!this.options.allowed(client)) return refused('forbidden', 'Current device-host approval is required.');
    if (!isJsonObject(params) || typeof params.session !== 'string')
      return refused('bad-request', 'Metro close needs a session.');
    try {
      const record = readHostedSessions().find((each) => each.client === client && each.id === params.session);
      if (!record) return refused('unknown-session', 'This client has no such hosted session.');
      const owned = this.owned.get(record.id);
      if (owned?.installing || owned?.data)
        throw new Error('Wait for this session native launch before closing its Metro bridge.');
      if (owned) await this.closeMetro(owned);
      return { result: { port: null } };
    } catch (error) {
      return refused('action-failed', (error as Error).message);
    }
  }

  /** Holds a connection the client opened as an idle link that the session's Metro bridge pairs with one stream. */
  metroLink(client: string, params: unknown, link: MetroLink): AppAnswer<Record<string, never>> {
    if (this.closed || !this.options.allowed(client))
      return refused('forbidden', 'Current device-host approval is required.');
    if (!isJsonObject(params) || typeof params.session !== 'string')
      return refused('bad-request', 'A Metro link needs a session.');
    try {
      const record = readHostedSessions().find((each) => each.client === client && each.id === params.session);
      if (!record) return refused('unknown-session', 'This client has no such hosted session.');
      const owned = this.owned.get(record.id);
      if (record.state !== 'ready' || !owned || owned.stopping)
        throw new Error('Only a ready session attached to this owner can link Metro.');
      if (record.platform !== 'ios' && record.platform !== 'android')
        throw new Error('Hosted Metro supports iOS and Android sessions only.');
      if (!(owned.links ??= createMetroLinks()).add(link)) throw new Error('This session Metro bridge is closing.');
      return { result: {} };
    } catch (error) {
      return refused('action-failed', error instanceof Error ? error.message : String(error));
    }
  }

  metroUnlink(link: MetroLink): void {
    for (const owned of this.owned.values()) owned.links?.remove(link);
  }

  private async closeMetro(owned: OwnedSession): Promise<void> {
    owned.links?.close();
    delete owned.links;
    const metro = owned.metro;
    if (!metro) return;
    metro.closing = true;
    await metro.ready.catch(() => {});
    await metro.bridge.close();
    if (owned.metro === metro) delete owned.metro;
  }

  viewTarget(client: string, session: string, probeRunning = false): HostedViewTarget {
    if (this.closed || !this.options.allowed(client)) throw new Error('Current device-host approval is required.');
    const record = readHostedSessions().find((each) => each.client === client && each.id === session);
    const owned = this.owned.get(session);
    if (!record || record.state !== 'ready' || !record.device || !owned)
      throw new Error(
        'Only a ready session attached to this server can be viewed. Explicit stop must reconcile a lost owner.',
      );
    if (owned.stopping || owned.data || owned.installing)
      throw new Error('This hosted session has a native operation in progress.');
    const home = join(deviceHostArea(record.id), 'home');
    if (record.platform === 'android') {
      if (!('serial' in record.device)) throw new Error('The device record no longer matches this session.');
      assertHostedDeviceLedger(home, record.device.avdName, 'android');
      const device = readHostedDevice(home, 'android');
      if (
        device.serial !== record.device.serial ||
        device.avdName !== record.device.avdName ||
        device.systemImage !== record.device.systemImage ||
        device.architecture !== record.device.architecture
      )
        throw new Error('The hosted Android device identity changed.');
      const adb = (args: string[]) =>
        execFileSync(adbPath(this.options.env), ['-s', device.serial, ...args], {
          env: this.options.env,
          encoding: 'utf8',
          timeout: 2000,
          killSignal: 'SIGKILL',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
      if (
        probeRunning &&
        (adb(['emu', 'avd', 'name']).split('\n')[0]?.trim() !== device.avdName ||
          adb(['shell', 'getprop', 'ro.product.cpu.abi']) !== device.architecture)
      )
        throw new Error('The hosted Android device identity or running ABI changed.');
      return { platform: 'android', session: { ...record, device: record.device }, home, claim: owned.claim };
    }
    if (record.platform === 'macos') {
      if (!('appSlot' in record.device) || record.device.appSlot !== record.appSlot)
        throw new Error('The device record no longer matches this session.');
      assertHostedDeviceLedger(home, `macos-${record.appSlot}`, 'macos');
      const device = readHostedDevice(home, 'macos');
      if (
        device.appSlot !== record.device.appSlot ||
        device.architecture !== record.device.architecture ||
        device.macosVersion !== record.device.macosVersion
      )
        throw new Error('The device record no longer matches this session.');
      const app = macosAppState(readHostedMacosApp(home));
      if (!app || app.state !== 'running' || !app.app) throw new Error('The hosted macOS app is not running.');
      const foreign = new Error('The macOS app does not belong to this hosted session.');
      let attempt: string;
      try {
        const bundle = realpathSync(app.bundle);
        attempt = basename(dirname(bundle));
        const executable = relative(bundle, realpathSync(app.executable));
        if (
          !hostedAppAttempt(attempt) ||
          bundle !== join(realpathSync(join(deviceHostArea(record.id), 'apps')), attempt, 'App.app') ||
          !executable ||
          executable === '..' ||
          executable.startsWith(`..${sep}`) ||
          isAbsolute(executable)
        )
          throw foreign;
      } catch {
        throw foreign;
      }
      let receipt;
      try {
        receipt = readHostedAppMetadata(record.id, attempt);
      } catch {
        throw foreign;
      }
      if (receipt.state !== 'installed') throw new Error('The hosted macOS app is not installed.');
      if (
        app.bundleId !== hostedMacosBundleId(receipt.bundleId, device.appSlot) ||
        app.bundleId !== readJsonObject(join(home, 'hosted-macos-app.json'))?.bundleId
      )
        throw foreign;
      return {
        platform: 'macos',
        session: { ...record, device: record.device },
        home,
        claim: owned.claim,
        app: { ...app, app: app.app },
      };
    }
    if (!('udid' in record.device)) throw new Error('The device record no longer matches this session.');
    assertHostedDeviceLedger(home, record.device.udid);
    if (readHostedDevice(home).udid !== record.device.udid)
      throw new Error('The device record no longer matches this session.');
    return { platform: 'ios', session: { ...record, device: record.device }, home, claim: owned.claim };
  }

  bindView(client: string, session: string, close: () => Promise<void>): () => void {
    this.viewTarget(client, session);
    const owned = this.owned.get(session)!;
    if (owned.viewer) throw new Error('This hosted session already has a viewer pool.');
    const viewer = { close };
    owned.viewer = viewer;
    return () => {
      if (owned.viewer === viewer) delete owned.viewer;
    };
  }

  private async closeView(owned: OwnedSession): Promise<void> {
    const viewer = owned.viewer;
    if (!viewer) return;
    await viewer.close();
    if (owned.viewer === viewer) delete owned.viewer;
  }

  private appSession(client: string, params: unknown): HostedDeviceSession {
    if (!isJsonObject(params) || typeof params.session !== 'string' || !hostedAppAttempt(params.attempt))
      throw new Error('App requests need a session and app attempt.');
    const record = readHostedSessions().find((each) => each.client === client && each.id === params.session);
    if (!record) throw new Error('This client has no such hosted session.');
    return record;
  }

  appOffer(client: string, params: unknown): AppAnswer<Methods['device-host.app.offer']['result']> {
    if (!this.options.allowed(client)) return refused('forbidden', 'Current device-host approval is required.');
    const offer = parseHostedAppOffer(params);
    if (!offer)
      return refused(
        'bad-request',
        'App offers need a bounded normalized bundle manifest, bundleId, development, release or process mode and, optionally, at most 32 arguments of 1024 characters (8192 in total) without NUL or line breaks.',
      );
    try {
      const record = this.appSession(client, offer);
      if (offer.mode === 'process' && record.platform === 'macos')
        throw new Error('Process-mode app offers require a hosted iOS or Android session.');
      if (record.platform !== 'macos' && offer.arguments !== undefined)
        throw new Error('App arguments are supported only for hosted macOS sessions.');
      if (record.platform === 'macos') {
        if (offer.mode !== 'release' || offer.devClientScheme !== undefined)
          throw new Error('Hosted macOS apps require release mode without a development client scheme.');
        if (offer.bundleId.startsWith('com.apple.'))
          throw new Error('Hosted macOS apps cannot use a com.apple. bundle identity.');
        if (hostedMacosBundleId(offer.bundleId, record.appSlot!).length + '.plist'.length > 255)
          throw new Error('The hosted macOS bundle identity exceeds 249 characters for its preferences plist.');
      }
      if (record.state !== 'ready' || this.closed || !this.owned.has(record.id))
        throw new Error(
          'Only a ready session attached to this server accepts an app. Explicit stop must reconcile a lost owner.',
        );
      const owned = this.acquire(record);
      if (owned.stopping || owned.data || (owned.installing && owned.installing.attempt !== offer.attempt))
        throw new Error('This hosted session already has a native operation in progress.');
      if (
        record.appAttempt &&
        record.appAttempt !== offer.attempt &&
        readHostedApp(record.id, record.appAttempt).state === 'receiving'
      )
        throw new Error('Complete the current app transfer or stop this hosted session before offering another app.');
      const result = offerHostedApp(offer);
      this.change(record.id, (current) => {
        current.appAttempt = offer.attempt;
      });
      return { result };
    } catch (error) {
      return refused('action-failed', (error as Error).message);
    }
  }

  async appChunk(client: string, params: unknown): Promise<AppAnswer<{ offset: number }>> {
    if (!this.options.allowed(client)) return refused('forbidden', 'Current device-host approval is required.');
    try {
      const record = this.appSession(client, params);
      if (record.state !== 'ready' || this.closed || !this.owned.has(record.id))
        throw new Error(
          'Only a ready session attached to this server receives an app. Explicit stop must reconcile a lost owner.',
        );
      const owned = this.acquire(record);
      if (owned.stopping) throw new Error('This hosted session is stopping.');
      const attempt = (params as { attempt: string }).attempt;
      if (owned.app?.attempt !== attempt || !owned.app.files.length) owned.app = readHostedApp(record.id, attempt);
      return { result: await chunkHostedApp(owned.app, params) };
    } catch (error) {
      return refused('action-failed', (error as Error).message);
    }
  }

  async appHandoff(client: string, params: unknown): Promise<AppAnswer<{ files: number; bytes: number }>> {
    if (!this.options.allowed(client)) return refused('forbidden', 'Current device-host approval is required.');
    const build = isJsonObject(params) && isJsonObject(params.build) ? params.build : null;
    if (!build || !sha256(build.handoff) || !sha256(build.sha256))
      return refused('bad-request', 'App handoffs need a build handoff token and the artifact sha256.');
    try {
      const record = this.appSession(client, params);
      const attempt = (params as { attempt: string }).attempt;
      if (record.state !== 'ready' || this.closed || !this.owned.has(record.id) || record.appAttempt !== attempt)
        throw new Error(
          'Only the current app attempt of a ready session attached to this server receives an app. Explicit stop must reconcile a lost owner.',
        );
      const owned = this.acquire(record);
      if (owned.stopping || owned.data || owned.installing)
        throw new Error('This hosted session already has a native operation in progress.');
      const app = readHostedApp(record.id, attempt);
      if (app.state !== 'receiving' || !app.files.length)
        throw new Error('Send the app manifest before handing over a build.');
      if (
        record.platform === 'android' &&
        (app.files.length !== 1 || app.files[0]?.path !== 'App.apk' || app.files[0]?.kind !== 'file')
      )
        throw new Error('Hosted Android handoff requires a single file entry named App.apk.');
      const taken =
        this.options.builtBundle?.(client, build.handoff, build.sha256) ?? 'This server hands over no builds.';
      if (typeof taken === 'string') throw new Error(taken);
      const transfer = handOverHostedApp(app, taken.bundle, record.platform);
      owned.data = transfer.then(
        () => undefined,
        () => undefined,
      );
      try {
        return { result: await transfer };
      } finally {
        delete owned.data;
        taken.release();
      }
    } catch (error) {
      return refused('action-failed', (error as Error).message);
    }
  }

  appAttach(client: string, params: unknown): AppAnswer<HostedAppLaunch> {
    if (!this.options.allowed(client)) return refused('forbidden', 'Current device-host approval is required.');
    try {
      const record = this.appSession(client, params);
      const app = readHostedAppMetadata(record.id, (params as { attempt: string }).attempt);
      const result: HostedAppLaunch = appDelivery(app);
      if (app.state === 'installed' && record.state === 'ready') {
        const access = this.options.agents.access(record.id);
        result.agent = access?.grant ?? { driver: 'none' };
        if (access?.notice) result.notice = access.notice;
      }
      if (app.state === 'installing' && this.owned.get(record.id)?.installing?.attempt !== app.attempt) {
        result.state = 'unknown';
        result.notice = 'The install owner is unavailable. Stop this hosted session before retrying.';
      }
      return { result };
    } catch (error) {
      return refused('action-failed', (error as Error).message);
    }
  }

  /** Captured app logs remain readable from the isolated home after the session stops. */
  async logsQuery(client: string, params: unknown): Promise<AppAnswer<Methods['device-host.logs.query']['result']>> {
    if (this.closed || !this.options.allowed(client))
      return refused('forbidden', 'Current device-host approval is required.');
    const cursor = isJsonObject(params) && params.cursor !== undefined ? parseHostedLogsCursor(params.cursor) : {};
    if (!isJsonObject(params) || typeof params.session !== 'string' || !cursor)
      return refused('bad-request', 'logs.query needs a session and, optionally, a cursor from a previous result.');
    try {
      const record = readHostedSessions().find((each) => each.client === client && each.id === params.session);
      if (!record) return refused('unknown-session', 'This client has no such hosted session.');
      const home = join(deviceHostArea(record.id), 'home');
      const dir = record.platform === 'macos' ? hostedMacosLogsDir(home) : hostedNativeLogsDir(home, record.platform);
      const saved = dir ? readLogsSince(dir, cursor) : { records: [], cursor, more: false };
      const owned = this.owned.get(record.id);
      const attempt = owned?.installedAttempt ?? record.appAttempt;
      if (
        record.platform !== 'macos' &&
        record.state === 'ready' &&
        attempt &&
        readHostedAppMetadata(record.id, attempt).state === 'installed' &&
        !saved.more
      ) {
        if (!owned) throw new Error('The hosted log owner is unavailable. Stop this session before retrying.');
        if (!owned.stopping && !owned.installing) {
          const delay = owned.logs && !owned.logs.pending ? Math.max(0, owned.logs.started + 3000 - Date.now()) : 0;
          if (!delay || owned.logs?.more) {
            if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
            if (this.owned.get(record.id) === owned && !owned.stopping && !owned.installing)
              await this.collectLogs(record, owned);
          }
        }
      }
      const page = dir ? readLogsSince(dir, cursor) : saved;
      return {
        result: {
          ...page,
          more:
            page.more || (record.state === 'ready' && !owned?.stopping && !owned?.installing && !!owned?.logs?.more),
          ...(record.platform !== 'macos'
            ? { checkpoint: readHostedNativeLogsCheckpoint(home, record.platform)?.until }
            : {}),
        },
      };
    } catch (error) {
      return refused('action-failed', (error as Error).message);
    }
  }

  private takeLogsClaim(session: ClaimHandle): ClaimHandle {
    const root = `${session.root}.logs`;
    const attempt = tryAcquireClaim({ root, mode: 'exclusive', label: 'hosted logs', details: session.details });
    if (attempt.pending) releaseClaim(attempt.pending);
    if (!attempt.acquired)
      throw new ClaimRefusedError({
        root,
        claimPath: attempt.held?.path ?? root,
        reason: 'a hosted log worker still holds it',
        label: 'hosted logs',
      });
    return attempt.acquired;
  }

  private collectLogs(record: HostedDeviceSession, owned: OwnedSession, final = false): Promise<void> {
    if (owned.logs?.pending) return owned.logs.pending;
    const attempt = owned.installedAttempt ?? record.appAttempt;
    if (record.platform === 'macos' || !attempt || readHostedAppMetadata(record.id, attempt).state !== 'installed')
      return Promise.resolve();
    const claim = this.takeLogsClaim(owned.claim);
    const logs = (owned.logs = { started: Date.now(), more: false } as NonNullable<OwnedSession['logs']>);
    try {
      const run = (logs.run = this.run(record, owned, 'logs', attempt, claim, final));
      logs.pending = run.done.then((outcome) => {
        if (outcome.settled) {
          releaseClaim(claim);
          delete logs.pending;
          delete logs.run;
        }
        if (
          !outcome.settled ||
          outcome.notice ||
          !isJsonObject(outcome.value) ||
          typeof outcome.value.more !== 'boolean'
        )
          throw new Error(outcome.notice ?? 'Hosted native log collection did not finish.');
        logs.more = outcome.value.more;
        return undefined;
      });
      return logs.pending;
    } catch (error) {
      releaseClaim(claim);
      throw error;
    }
  }

  private async settleLogs(owned: OwnedSession): Promise<void> {
    const run = owned.logs?.run;
    if (!run) return;
    run.cancel();
    await owned.logs?.pending?.catch(() => {});
    if (!(await run.done).settled)
      throw new Error('The log worker group is unresolved. Its claim and device were retained.');
  }

  appLaunch(client: string, params: unknown): AppAnswer<HostedAppLaunch> {
    if (!this.options.allowed(client)) return refused('forbidden', 'Current device-host approval is required.');
    try {
      const record = this.appSession(client, params);
      if (record.state !== 'ready' || this.closed || !this.owned.has(record.id))
        throw new Error(
          'Only a ready session attached to this server can install an app. Explicit stop must reconcile a lost owner.',
        );
      const owned = this.acquire(record);
      const app = readHostedAppMetadata(record.id, (params as { attempt: string }).attempt);
      if (app.state !== 'receiving') return this.appAttach(client, params);
      if (owned.stopping || owned.data || owned.installing)
        throw new Error('This hosted session already has a native operation in progress.');
      if (owned.metro && (!owned.metro.port || owned.metro.closing))
        throw new Error('This session Metro bridge is opening or closing.');
      if (offerHostedApp(app).missing.length) throw new Error('The app manifest still has missing content.');
      if (
        (record.platform === 'macos') !==
        readHostedApp(record.id, app.attempt).files.some((file) => file.path === 'Contents/Info.plist')
      )
        throw new Error('The app manifest must include Contents/Info.plist only for macOS sessions.');
      const result = appDelivery(
        changeHostedApp(record.id, app.attempt, (current) => {
          current.state = 'installing';
        }),
      );
      const done = this.install(record, owned, app.attempt).finally(() => {
        delete owned.installing;
      });
      owned.installing = { attempt: app.attempt, done };
      return { result };
    } catch (error) {
      return refused('action-failed', (error as Error).message);
    }
  }

  private async install(record: HostedDeviceSession, owned: OwnedSession, attempt: string): Promise<void> {
    try {
      if (record.platform !== 'macos' || this.options.agents.access(record.id))
        await this.stopAgent(
          record.id,
          record.platform !== 'macos',
          record.platform === 'ios'
            ? (record.device as HostedIosDevice | null)?.udid
            : record.platform === 'android' && record.device
              ? {
                  serial: (record.device as HostedAndroidDevice).serial,
                  avdName: (record.device as HostedAndroidDevice).avdName,
                }
              : undefined,
        );
      await this.closeView(owned);
      await this.settleLogs(owned);
      if (owned.stopping || this.closed || !this.options.allowed(record.client)) return;
      releaseClaim(takeHostedInputClaim(owned.claim));
      const run = this.run(record, owned, 'install', attempt);
      owned.run = run;
      const outcome = await run.done;
      const value = outcome.value;
      const installed =
        !owned.stopping &&
        this.options.allowed(record.client) &&
        !outcome.notice &&
        outcome.settled &&
        isJsonObject(value) &&
        value.state === 'installed' &&
        parseHostedPlatformDevice(value.device, record.platform) !== null &&
        record.device !== null &&
        hostedDeviceId(parseHostedPlatformDevice(value.device, record.platform)!) === hostedDeviceId(record.device) &&
        (value.launched === true || value.launched === 'unverified');
      if (installed) owned.installedAttempt = attempt;
      if (
        installed &&
        (record.platform !== 'macos' ||
          (typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0))
      )
        await this.startAgent(record, attempt, value.pid as number);
      const app = changeHostedApp(record.id, attempt, (current) => {
        current.state = installed ? 'installed' : 'unknown';
        current.launched = installed ? (value as { launched: HostedAppDelivery['launched'] }).launched : null;
        if (installed) delete current.notice;
        else
          current.notice =
            outcome.notice ??
            (isJsonObject(value) && typeof value.notice === 'string'
              ? value.notice
              : 'The install or launch outcome is unresolved; stop this hosted session before retrying.');
      });
      if (!installed && !owned.stopping)
        this.change(record.id, (current) => {
          current.state = 'unknown';
          current.notice = app.notice;
        });
    } catch (error) {
      if (!owned.stopping) this.failed(record.id, error);
      try {
        changeHostedApp(record.id, attempt, (current) => {
          current.state = 'unknown';
          current.launched = null;
          current.notice = (error as Error).message;
        });
      } catch (journalError) {
        process.stderr.write(`Hosted app ${record.id} remains unresolved: ${(journalError as Error).message}\n`);
      }
    }
  }

  private async startAgent(record: HostedDeviceSession, attempt: string, pid: number): Promise<void> {
    try {
      await this.options.agents.appRunning({
        client: record.client,
        session: record.id,
        ...(record.platform === 'ios'
          ? {
              bundleId: readHostedAppMetadata(record.id, attempt).bundleId,
              udid: (record.device as HostedIosDevice).udid,
            }
          : record.platform === 'android'
            ? {
                bundleId: readHostedAppMetadata(record.id, attempt).bundleId,
                serial: (record.device as HostedAndroidDevice).serial,
                avdName: (record.device as HostedAndroidDevice).avdName,
              }
            : {
                bundleId: hostedMacosBundleId(readHostedAppMetadata(record.id, attempt).bundleId, record.appSlot!),
                pid,
              }),
      });
    } catch (error) {
      process.stderr.write(`Hosted agent control did not start: ${(error as Error).message}\n`);
    }
  }

  private stopAgent(
    session: string,
    strict = false,
    device?: string | { serial: string; avdName: string },
  ): Promise<void> {
    return this.options.agents.appStopped(session, device).catch((error: unknown) => {
      if (strict) throw error;
      process.stderr.write(`Hosted agent control did not stop: ${(error as Error).message}\n`);
    });
  }

  private async prepare(record: HostedDeviceSession): Promise<void> {
    const owned = this.owned.get(record.id)!;
    if (!this.options.allowed(record.client) || this.closed) {
      this.beginStop(record);
      return;
    }
    if (record.platform === 'android' && !owned.adopting && record.systemImage) {
      const image = this.runWorker({
        cwd: dirname(this.options.worker),
        env: this.options.env,
        input: { mode: 'image', systemImage: record.systemImage },
        claim: owned.claim,
        timeoutMs: this.limits.imageInstallMs,
        maxOutputBytes: 16_384,
      });
      owned.run = image;
      owned.imagePhase = true;
      const installed = await image.done;
      if (owned.stopping) return;
      if (
        !installed.settled ||
        installed.notice ||
        !isJsonObject(installed.value) ||
        installed.value.state !== 'ready'
      ) {
        const value = installed.value;
        this.change(record.id, (current) => {
          current.state = installed.settled ? 'stopped' : 'unknown';
          current.notice =
            installed.notice ??
            (isJsonObject(value) && typeof value.notice === 'string'
              ? value.notice
              : 'The Android system image install did not finish.');
          if (current.state === 'stopped') this.release(record.id, owned);
        });
        return;
      }
      if (!this.options.allowed(record.client) || this.closed) {
        this.beginStop(record);
        return;
      }
      delete owned.imagePhase;
    }
    const run = this.run(record, owned, owned.adopting ? 'adopt' : 'prepare');
    owned.run = run;
    const outcome = await run.done;
    if (owned.stopping) return;
    const value = outcome.value;
    const device = isJsonObject(value) ? parseHostedPlatformDevice(value.device, record.platform) : null;
    if (outcome.settled && isJsonObject(value) && value.state === 'ready' && device) {
      const home = join(deviceHostArea(record.id), 'home');
      assertSessionDevice(record, device);
      assertHostedDeviceLedger(home, hostedDeviceId(device), record.platform);
      if (hostedDeviceId(readHostedDevice(home, record.platform)) !== hostedDeviceId(device))
        throw new Error('The worker result does not match its persisted device.');
    }
    this.change(record.id, (current) => {
      current.device = device;
      if (
        owned.adopting &&
        record.platform === 'android' &&
        device &&
        'avdName' in device &&
        device.avdName === `stim-hosted-${record.id}` &&
        isJsonObject(value) &&
        value.state === 'unknown'
      )
        current.consolePort = device.consolePort;
      current.state =
        !outcome.notice && outcome.settled && isJsonObject(value) && value.state === 'ready' && device
          ? 'ready'
          : !outcome.notice && outcome.settled && isJsonObject(value) && value.state === 'stopped'
            ? 'stopped'
            : 'unknown';
      if (current.state === 'ready') owned.reachedReady = true;
      if (current.state === 'unknown')
        current.notice =
          outcome.notice ??
          (isJsonObject(value) && typeof value.notice === 'string'
            ? value.notice
            : 'Preparation outcome is unresolved; stop this session before retrying.');
      else if (isJsonObject(value) && typeof value.notice === 'string') current.notice = value.notice;
      if (current.state === 'stopped') this.release(record.id, owned);
    });
    if (!this.options.allowed(record.client) || this.closed)
      this.beginStop(readHostedSessions().find((each) => each.id === record.id)!);
  }

  private beginStop(record: HostedDeviceSession): void {
    if (record.state === 'stopped') return;
    const owned = this.acquire(record);
    if (owned.stopping) return;
    const agentStop = this.stopAgent(
      record.id,
      record.platform !== 'macos',
      record.platform === 'ios'
        ? (record.device as HostedIosDevice | null)?.udid
        : record.platform === 'android' && record.device
          ? {
              serial: (record.device as HostedAndroidDevice).serial,
              avdName: (record.device as HostedAndroidDevice).avdName,
            }
          : undefined,
    );
    void this.closeMetro(owned).catch((error: unknown) => this.failed(record.id, error));
    void this.closeView(owned).catch((error: unknown) => this.failed(record.id, error));
    this.change(record.id, (current) => {
      current.state = 'stopping';
    });
    owned.stopping = this.finishStop(record, owned, agentStop)
      .catch((error: unknown) => this.failed(record.id, error))
      .finally(() => {
        delete owned.stopping;
      });
  }

  private async finishStop(record: HostedDeviceSession, owned: OwnedSession, agentStop: Promise<void>): Promise<void> {
    if (record.platform !== 'macos') await agentStop;
    const home = join(deviceHostArea(record.id), 'home');
    let healthy = owned.reachedReady === true && record.state === 'ready';
    owned.run?.cancel();
    await this.closeMetro(owned);
    await this.closeView(owned);
    await owned.data;
    await this.settleLogs(owned);
    releaseClaim(takeHostedInputClaim(owned.claim));
    if (owned.run) {
      owned.run.cancel();
      const outcome = await owned.run.done;
      const value = outcome.value;
      healthy &&=
        !outcome.notice &&
        outcome.settled &&
        isJsonObject(value) &&
        (value.state === 'ready' || value.state === 'installed');
      if (!outcome.settled)
        throw new Error('The prior worker group is unresolved. Its claim and device were retained.');
      if (
        (owned.imagePhase || (isJsonObject(value) && value.state === 'stopped' && value.device === null)) &&
        !existsSync(join(home, 'hosted-device.json')) &&
        !existsSync(join(home, 'created-devices.json'))
      ) {
        this.change(record.id, (current) => {
          current.state = 'stopped';
          current.device = null;
          if (isJsonObject(value) && typeof value.notice === 'string') current.notice = value.notice;
          else delete current.notice;
        });
        this.release(record.id, owned);
        return;
      }
    } else if (
      record.platform === 'android' &&
      record.state === 'preparing' &&
      !existsSync(join(home, 'hosted-device.json')) &&
      !existsSync(join(home, 'created-devices.json'))
    ) {
      this.change(record.id, (current) => {
        current.state = 'stopped';
        current.device = null;
      });
      this.release(record.id, owned);
      return;
    }
    const device = readHostedDevice(home, record.platform);
    assertSessionDevice(record, device);
    if (record.device && hostedDeviceId(record.device) !== hostedDeviceId(device))
      throw new Error('The device record no longer matches this session.');
    this.change(record.id, (current) => {
      current.device = device;
    });
    try {
      await this.collectLogs(record, owned, true);
    } catch (error) {
      process.stderr.write(`Could not collect final hosted native logs: ${(error as Error).message}\n`);
    }
    await this.settleLogs(owned);
    if (
      (record.platform === 'ios' || record.platform === 'android') &&
      healthy &&
      record.device &&
      this.parkedMax(record.platform) > 0 &&
      this.options.allowed(record.client) &&
      !this.revoked.has(record.id)
    ) {
      let run: WorkerRun | undefined;
      try {
        run = this.run(record, owned, 'park');
      } catch {}
      if (run) {
        owned.run = run;
        const outcome = await run.done;
        if (!outcome.settled)
          throw new Error('The park worker group is unresolved. Its claim and device were retained.');
        const parked = isJsonObject(outcome.value) && parseHostedPlatformDevice(outcome.value.device, record.platform);
        if (
          !outcome.notice &&
          isJsonObject(outcome.value) &&
          outcome.value.state === 'parked' &&
          parked &&
          hostedDeviceId(parked) === hostedDeviceId(device) &&
          this.options.allowed(record.client) &&
          !this.revoked.has(record.id)
        ) {
          this.change(record.id, (current) => {
            current.state = 'stopped';
            current.parked = { at: new Date().toISOString() };
            delete current.notice;
          });
          this.release(record.id, owned);
          await this.evictParked().catch((error: unknown) => {
            process.stderr.write(
              `Hosted parking eviction failed: ${(error as Error).message.replace(/[\r\n]+/g, ' ')}\n`,
            );
          });
          return;
        }
      }
    }
    const run = this.run(record, owned, 'stop');
    owned.run = run;
    const outcome = await run.done;
    const stopped =
      !outcome.notice &&
      outcome.settled &&
      isJsonObject(outcome.value) &&
      outcome.value.state === 'stopped' &&
      parseHostedPlatformDevice(outcome.value.device, record.platform) !== null &&
      hostedDeviceId(parseHostedPlatformDevice(outcome.value.device, record.platform)!) === hostedDeviceId(device);
    this.change(record.id, (current) => {
      current.state = stopped ? 'stopped' : 'unknown';
      if (stopped) delete current.notice;
      else
        current.notice =
          outcome.notice ??
          (isJsonObject(outcome.value) && typeof outcome.value.notice === 'string'
            ? outcome.value.notice
            : 'Shutdown could not be verified. The reservation and device records were retained.');
    });
    if (stopped) this.release(record.id, owned);
  }

  private failed(id: string, error: unknown): void {
    try {
      this.change(id, (record) => {
        record.state = 'unknown';
        record.notice = (error as Error).message;
      });
    } catch (journalError) {
      process.stderr.write(`Hosted session ${id} remains unresolved: ${(journalError as Error).message}\n`);
    }
  }

  private release(id: string, owned: OwnedSession): void {
    if (releaseClaim(owned.claim)) this.owned.delete(id);
  }

  revoke(): void {
    for (const [probe, client] of this.probes) if (!this.options.allowed(client)) probe.cancel();
    try {
      for (const record of readHostedSessions()) {
        if (this.options.allowed(record.client) || this.revoked.has(record.id)) continue;
        this.revoked.add(record.id);
        if (record.state === 'stopped') {
          if (record.parked) void this.retire(record);
          continue;
        }
        try {
          this.beginStop(record);
        } catch (error) {
          this.failed(record.id, error);
        }
      }
    } catch (error) {
      for (const [id, owned] of this.owned) {
        owned.run?.cancel();
        owned.logs?.run?.cancel();
        void this.stopAgent(id);
        void this.closeMetro(owned).catch((closeError: unknown) => {
          process.stderr.write(`Hosted Metro close failed: ${(closeError as Error).message}\n`);
        });
        void this.closeView(owned).catch((closeError: unknown) => {
          process.stderr.write(`Hosted view close failed: ${(closeError as Error).message}\n`);
        });
      }
      process.stderr.write(`Hosted device revocation could not read its journal: ${(error as Error).message}\n`);
    }
  }

  active(): number {
    return this.owned.size;
  }

  clientSeen(client: string): void {
    this.clientsSeen.add(client);
  }

  clientActed(session: string): void {
    this.clientActive.add(session);
  }

  /**
   * Stops each ready session whose client has been gone for maintenance.idleStopHours, through the stop a person
   * uses. A session with work in flight or a claim that is not provably free stays.
   */
  sweepIdle(): void {
    if (this.closed) return;
    const now = Date.now();
    const elapsedMs = this.lastIdleSweep === undefined ? 0 : now - this.lastIdleSweep;
    this.lastIdleSweep = now;
    const active = this.clientActive;
    this.clientActive = new Set();
    const seen = this.clientsSeen;
    this.clientsSeen = new Set();
    try {
      const setting = hostedIdleStopHours(this.options.env);
      if ('invalid' in setting) this.logIdleKept('setting', `${setting.invalid}; hosted sessions are not idle-stopped`);
      const windowMs = 'hours' in setting ? setting.hours * 3_600_000 : 0;
      const live = this.options.connected ?? (() => true);
      const connected = (client: string) => live(client) || seen.has(client);
      const records = readHostedSessions();
      const plan = planHostedIdleStops({
        sessions: records,
        connected,
        active,
        elapsedMs,
        windowMs,
        unresolved: (id) => this.idleUnresolved(id),
        foreign: (id) => this.ownedElsewhere(id),
      });
      if (plan.updates.length)
        this.transaction((current) => {
          for (const { id, absentMs } of plan.updates) {
            const record = current.find((each) => each.id === id);
            if (!record) continue;
            if (absentMs === null) delete record.clientAbsentMs;
            else record.clientAbsentMs = absentMs;
          }
        });
      for (const { id, reason } of plan.kept) this.logIdleKept(id, reason);
      for (const { id, reason } of plan.stops) this.stopIdle(id, reason);
      const due = new Set([...plan.kept, ...plan.stops].map(({ id }) => id));
      for (const id of this.idleKept.keys())
        if (id !== 'setting' && id !== 'journal' && !due.has(id)) this.idleKept.delete(id);
      this.idleKept.delete('journal');
      if (!('invalid' in setting)) this.idleKept.delete('setting');
    } catch (error) {
      this.logIdleKept(
        'journal',
        `hosted idle check could not use the journal: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private logIdleKept(key: string, reason: string): void {
    if (this.idleKept.get(key) === reason) return;
    this.idleKept.set(key, reason);
    process.stderr.write(
      `Hosted session ${key === 'setting' || key === 'journal' ? '' : `${key} `}kept: ${reason.replace(/[\r\n]+/g, ' ')}\n`,
    );
  }

  private ownedElsewhere(id: string): boolean {
    if (this.owned.has(id)) return false;
    try {
      const attempt = tryAcquireClaim({
        root: join(deviceHostRoot(), `${id}.claims`),
        mode: 'exclusive',
        label: 'hosted device session',
        details: { session: id },
      });
      if (attempt.pending) releaseClaim(attempt.pending);
      if (!attempt.acquired) return true;
      releaseClaim(attempt.acquired);
      return false;
    } catch {
      return false;
    }
  }

  private idleUnresolved(id: string): string | null {
    const owned = this.owned.get(id);
    if (!owned) return null;
    if (owned.stopping || owned.data || owned.installing) return 'it has a native operation in progress';
    try {
      releaseClaim(takeHostedInputClaim(owned.claim));
    } catch (error) {
      return `its native input is not provably finished (${error instanceof Error ? error.message : String(error)})`;
    }
    return null;
  }

  private stopIdle(id: string, reason: string): void {
    try {
      const record = readHostedSessions().find((each) => each.id === id);
      if (!record || record.state !== 'ready') return;
      this.beginStop(record);
      this.change(id, (current) => {
        current.idleStop = { at: new Date().toISOString(), reason };
        delete current.clientAbsentMs;
      });
      process.stderr.write(`Hosted session ${id} stopped: ${reason}\n`);
    } catch (error) {
      this.logIdleKept(id, error instanceof Error ? error.message : String(error));
    }
  }

  drain(reason: string | null): void {
    this.draining = reason;
  }

  reconcileStopped(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return (this.reconciling ??= this.retireStopped().finally(() => {
      this.reconciling = undefined;
    }));
  }

  private async evictParked(): Promise<void> {
    for (const platform of ['ios', 'android'] as const) {
      const max = this.parkedMax(platform);
      const records: HostedDeviceSession[] = [];
      for (const record of readHostedSessions()) {
        if (record.platform !== platform || record.state !== 'stopped' || !record.parked) continue;
        const ledger = readHostedDeviceLedger(join(deviceHostArea(record.id), 'home'));
        if (ledger && ledger[platform].length === 0) {
          this.change(record.id, (current) => {
            if (current.state === 'stopped' && current.parked?.at === record.parked?.at) delete current.parked;
          });
        } else records.push(record);
      }
      records.sort((a, b) => a.parked!.at.localeCompare(b.parked!.at));
      for (const record of records.slice(0, Math.max(0, records.length - max))) await this.retire(record);
    }
  }

  private async retireStopped(): Promise<void> {
    for (const record of readHostedSessions()) {
      if (record.state !== 'stopped' || !record.parked || record.platform === 'macos') continue;
      try {
        const ledger = readHostedDeviceLedger(join(deviceHostArea(record.id), 'home'));
        if (ledger && ledger[record.platform].length === 0)
          this.change(record.id, (current) => {
            if (current.state === 'stopped') delete current.parked;
          });
      } catch (error) {
        process.stderr.write(
          `Hosted session ${record.id} reconciliation failed: ${(error as Error).message.replace(/[\r\n]+/g, ' ')}\n`,
        );
      }
    }
    await this.evictParked();
    for (const record of readHostedSessions()) {
      if (this.closed) break;
      if (record.state !== 'stopped' || record.parked || record.platform === 'macos' || this.owned.has(record.id))
        continue;
      await this.retire(record);
    }
  }

  private async retire(record: HostedDeviceSession): Promise<void> {
    let owned: OwnedSession | undefined;
    let settled = true;
    try {
      if (this.owned.has(record.id)) return;
      const home = join(deviceHostArea(record.id), 'home');
      const ledger = readHostedDeviceLedger(home);
      if (!ledger || (!ledger.ios.length && !ledger.android.length && !ledger.web.length)) {
        if (record.parked)
          this.change(record.id, (each) => {
            if (each.state === 'stopped' && each.parked?.at === record.parked?.at) delete each.parked;
          });
        return;
      }
      try {
        owned = this.acquire(record);
      } catch {
        return;
      }
      const current = readHostedSessions().find((each) => each.id === record.id);
      if (current?.state !== 'stopped' || current.parked?.at !== record.parked?.at) return;
      const device = readHostedDevice(home, record.platform);
      assertSessionDevice(record, device);
      if (record.device && hostedDeviceId(record.device) !== hostedDeviceId(device))
        throw new Error('The device record no longer matches this session.');
      const run = this.run(record, owned, 'stop');
      owned.run = run;
      const outcome = await run.done;
      settled = outcome.settled;
      const result = isJsonObject(outcome.value) ? outcome.value : null;
      const stopped = result && parseHostedPlatformDevice(result.device, record.platform);
      if (
        outcome.notice ||
        !outcome.settled ||
        result?.state !== 'stopped' ||
        !stopped ||
        hostedDeviceId(stopped) !== hostedDeviceId(device)
      )
        throw new Error(
          outcome.notice ??
            (typeof result?.notice === 'string' ? result.notice : 'Hosted device retirement could not be verified.'),
        );
      if (record.parked)
        this.change(record.id, (each) => {
          delete each.parked;
        });
    } catch (error) {
      process.stderr.write(
        `Hosted session ${record.id} retirement failed: ${(error as Error).message.replace(/[\r\n]+/g, ' ')}\n`,
      );
    } finally {
      if (owned && settled) this.release(record.id, owned);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const probe of this.probes.keys()) probe.cancel();
    await Promise.all([...this.owned.values()].map((owned) => this.closeMetro(owned)));
    await Promise.all([...this.owned.values()].map((owned) => this.closeView(owned)));
    try {
      for (const record of readHostedSessions()) {
        if (!this.owned.has(record.id)) continue;
        try {
          this.beginStop(record);
        } catch (error) {
          this.failed(record.id, error);
        }
      }
    } catch {
      for (const [id, owned] of this.owned) {
        owned.run?.cancel();
        owned.logs?.run?.cancel();
        void this.stopAgent(id);
      }
    }
    await Promise.all([...this.owned.values()].map((owned) => owned.stopping ?? owned.run?.done));
    await Promise.all([...this.probes.keys()].map((probe) => probe.done));
    await this.reconciling?.catch(() => {});
  }

  private run(
    record: HostedDeviceSession,
    owned: OwnedSession,
    mode: 'prepare' | 'stop' | 'install' | 'logs' | 'reverse' | 'park' | 'adopt',
    attempt?: string,
    claim: ClaimHandle = owned.claim,
    finalLogs = false,
  ): WorkerRun {
    const home = join(deviceHostArea(record.id), 'home');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    return this.runWorker({
      cwd: home,
      env: { ...this.options.env, STIM_HOME: home },
      input: {
        mode,
        platform: record.platform,
        deviceType: record.deviceType,
        runtime: record.runtime,
        systemImage: record.systemImage,
        deviceProfile: record.deviceProfile,
        consolePort: record.consolePort,
        appSlot: record.appSlot,
        session: record.id,
        since: mode === 'logs' ? Date.parse(record.createdAt) : undefined,
        final: mode === 'logs' && finalLogs,
        attempt,
        metroPort: mode === 'install' || mode === 'reverse' ? owned.metro?.port : undefined,
        clientMetroPort: mode === 'install' || mode === 'reverse' ? owned.metro?.clientMetroPort : undefined,
      },
      claim,
      timeoutMs:
        mode === 'stop' || mode === 'park'
          ? this.limits.stopMs
          : mode === 'logs'
            ? this.limits.logsMs
            : this.limits.prepareMs,
      maxOutputBytes: 16_384,
    });
  }

  private runWorker(options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    input: object;
    claim?: ClaimHandle;
    timeoutMs: number;
    maxOutputBytes: number;
  }): WorkerRun {
    if (options.claim) markClaimChildPending(options.claim);
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [this.options.worker], {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      if (options.claim) clearClaimChild(options.claim);
      throw error;
    }
    const started = performance.now();
    const mode = 'mode' in options.input && typeof options.input.mode === 'string' ? options.input.mode : undefined;
    const diagnostic = (event: string, fields: Record<string, unknown> = {}) =>
      this.debug.log(`device-host.worker.${event}`, {
        mode,
        workerPid: child.pid,
        ms: Math.round(performance.now() - started),
        ...fields,
      });
    diagnostic('start', { timeoutMs: options.timeoutMs });
    let identity: ProcessRecord | null = null;
    const output: Buffer[] = [];
    let outputBytes = 0;
    let stderr = '';
    let notice: string | undefined;
    let finished = false;
    let cancelling = false;
    let closed = false;
    let killTimer: NodeJS.Timeout | undefined;
    let finishTimer: NodeJS.Timeout | undefined;
    let groupTimer: NodeJS.Timeout | undefined;
    let settle!: (result: { value: unknown; settled: boolean; notice?: string }) => void;
    const done = new Promise<{ value: unknown; settled: boolean; notice?: string }>((resolve) => {
      settle = resolve;
    });
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(finishTimer);
      clearTimeout(groupTimer);
      const groupAlive = closed && child.pid ? processGroupAlive(child.pid) : null;
      const settled = closed && groupAlive !== true;
      diagnostic('settled', { closed, groupAlive, settled, cancelling });
      if (settled && options.claim) clearClaimChild(options.claim);
      let value: unknown = null;
      try {
        value = JSON.parse(Buffer.concat(output).toString('utf8'));
      } catch {
        notice ??= stderr.trim() || 'Hosted worker returned no valid result.';
      }
      if (!settled) {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
        child.unref();
      }
      settle({ value, settled, ...(notice ? { notice } : {}) });
    };
    const signal = (name: NodeJS.Signals) => {
      if (!child.pid || !identity) return;
      const status = inspectProcessIdentity(identity);
      // POSIX Process ID Reuse keeps the leader's PID reserved while its process group survives.
      // https://pubs.opengroup.org/onlinepubs/009696699/basedefs/xbd_chap04.html#tag_04_12
      if (status !== 'same' && status !== 'gone') return;
      try {
        process.kill(-child.pid, name);
      } catch {}
    };
    const cancel = (reason = 'requested') => {
      if (finished || cancelling) return;
      cancelling = true;
      diagnostic('cancel', { reason });
      notice ??= 'Hosted worker was cancelled or exceeded its deadline.';
      signal('SIGTERM');
      killTimer = setTimeout(() => signal('SIGKILL'), this.limits.killGraceMs);
      finishTimer = setTimeout(finish, hostedWorkerSettleMs(this.limits));
    };
    const finishGroup = () => {
      if (finished) return;
      if (!child.pid || !processGroupAlive(child.pid)) finish();
      else {
        cancel('group-after-close');
        groupTimer = setTimeout(finishGroup, 25);
      }
    };
    const timer = setTimeout(() => cancel('deadline'), options.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (outputBytes + chunk.length > options.maxOutputBytes) {
        notice = 'Hosted worker output exceeded its bound.';
        cancel('output-bound');
      } else {
        output.push(chunk);
        outputBytes += chunk.length;
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    child.stdin?.on('error', () => cancel('stdin-error'));
    child.once('error', (error) => {
      diagnostic('error', { code: (error as NodeJS.ErrnoException).code });
      notice = error.message;
      closed = true;
      finishGroup();
    });
    child.once('close', (code, closeSignal) => {
      diagnostic('close', { code, signal: closeSignal });
      if (code !== 0) notice ??= stderr.trim() || `Hosted worker exited ${code}.`;
      closed = true;
      finishGroup();
    });
    const captured = child.pid === undefined ? null : captureProcessIdentity(child.pid);
    if (!captured?.ok || child.pid === undefined) {
      notice = 'The worker process identity could not be captured; no native request was sent.';
      child.kill('SIGKILL');
      cancel('identity-unavailable');
    } else {
      identity = { pid: child.pid, processToken: captured.token };
      try {
        if (options.claim) setClaimChild(options.claim, identity);
        child.stdin?.end(JSON.stringify(options.input));
      } catch (error) {
        notice = (error as Error).message;
        cancel('request-write');
      }
    }
    return { done, cancel };
  }
}

function sameRequest(a: HostedDeviceRequest, b: HostedDeviceRequest): boolean {
  return (
    a.workspace === b.workspace &&
    a.slot === b.slot &&
    a.platform === b.platform &&
    a.deviceType === b.deviceType &&
    a.runtime === b.runtime &&
    a.systemImage === b.systemImage &&
    a.deviceProfile === b.deviceProfile
  );
}

function reserveAndroidPort(records: HostedDeviceSession[]): number {
  const ports = new Set(
    records
      .filter((record) => record.platform === 'android' && record.state !== 'stopped')
      .map((record) => record.consolePort),
  );
  for (const project of Object.values(loadConfig()?.projects ?? {})) {
    for (const platforms of [project.platforms, ...Object.values(project.deviceSlots ?? {})]) {
      if (typeof platforms?.android?.consolePort === 'number') ports.add(platforms.android.consolePort);
    }
  }
  for (let port = 5554; port <= 5584; port += 2) if (!ports.has(port)) return port;
  throw new Error('All supported hosted Android console ports are reserved. Attach or stop an existing session.');
}

function reserveMacosSlot(records: HostedDeviceSession[]): number {
  const slots = new Set(
    records
      .filter((record) => record.platform === 'macos' && record.state !== 'stopped')
      .map((record) => record.appSlot),
  );
  for (let slot = 1; slot <= HOSTED_MACOS_APP_SLOTS; slot++) if (!slots.has(slot)) return slot;
  throw new Error('All hosted macOS app slots are reserved. Attach or stop an existing session.');
}

function assertSessionDevice(record: HostedDeviceSession, device: NonNullable<HostedDeviceSession['device']>): void {
  if (record.platform === 'macos' && (!('appSlot' in device) || device.appSlot !== record.appSlot))
    throw new Error('The macOS worker app slot does not match its reserved session.');
  if (
    record.platform === 'android' &&
    (!('avdName' in device) ||
      device.consolePort !== record.consolePort ||
      device.avdName !== `stim-hosted-${record.id}`)
  ) {
    throw new Error('The Android worker device does not match its reserved session and console port.');
  }
}
