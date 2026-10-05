import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { isIP, type AddressInfo } from 'node:net';
import { withDirLock, createMetroBridge, type MetroBridge } from '@stim-cli/core';
import {
  clearClaimChild,
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
  deviceHostArea,
  deviceHostRoot,
  getConcurrencyLimits,
  isJsonObject,
  parseHostedPlatformDevice,
  hostedDeviceId,
  hostedMacosBundleId,
  HOSTED_MACOS_APP_SLOTS,
  loadConfig,
  parseHostedRequest,
  readHostedDevice,
  readHostedMacosApp,
  macosAppState,
  readJsonObject,
  readHostedSessions,
  parseHostedOfferRequest,
  parseHostedNativeOffer,
  hostedAppAttempt,
  hostedMacosLogsDir,
  parseHostedAppOffer,
  parseHostedLogsCursor,
  readHostedApp,
  readHostedAppMetadata,
  readLogsSince,
  type HostedAppDelivery,
  type HostedAppLaunch,
  type HostedAppRecord,
  type HostedDeviceRequest,
  type HostedDeviceSession,
  type HostedDeviceOffer,
  type HostedIosDevice,
  type HostedMacosDevice,
  type MacosAppState,
} from '@stim-cli/core/state';
import { writeJson } from './registry.ts';
import { takeHostedInputClaim } from './hosted-input.ts';
import type { Methods, ProtocolError } from './protocol.ts';
import { appDelivery, offerHostedApp, chunkHostedApp, changeHostedApp } from './hosted-app.ts';
import type { HostedAgentHost } from './agent-driver.ts';

export interface DeviceHostLimits {
  prepareMs: number;
  offerMs: number;
  stopMs: number;
  killGraceMs: number;
}

interface WorkerRun {
  done: Promise<{ value: unknown; settled: boolean; notice?: string }>;
  cancel: () => void;
}

interface OwnedSession {
  claim: ClaimHandle;
  run?: WorkerRun;
  stopping?: Promise<void>;
  installing?: { attempt: string; done: Promise<void> };
  app?: HostedAppRecord;
  metro?: {
    bridge: MetroBridge;
    ready: Promise<number>;
    peer: string;
    gatewayPort: number;
    secret: string;
    port?: number;
    closing?: boolean;
  };
  viewer?: { close: () => Promise<void> };
}

export interface DeviceHostOptions {
  worker: string;
  env: NodeJS.ProcessEnv;
  allowed: (client: string) => boolean;
  /** Issues and revokes the agent control that hosted macOS apps hand their client. */
  agents: Pick<HostedAgentHost, 'appRunning' | 'appStopped' | 'access'>;
  limits?: Partial<DeviceHostLimits>;
}

type HostedViewTarget = { home: string; claim: ClaimHandle } & (
  | { platform: 'ios'; session: HostedDeviceSession & { device: HostedIosDevice } }
  | {
      platform: 'macos';
      session: HostedDeviceSession & { device: HostedMacosDevice };
      app: MacosAppState & { app: NonNullable<MacosAppState['app']> };
    }
);

type Answer = { result: HostedDeviceSession } | { error: ProtocolError };
type AppAnswer<T> = { result: T } | { error: ProtocolError };
const refused = (code: ProtocolError['code'], message: string): { error: ProtocolError } => ({
  error: { code, message },
});

/** Owns hosted reservations, not build jobs or viewer connections. Native work runs in the packaged CLI child. */
export class DeviceHost {
  private readonly owned = new Map<string, OwnedSession>();
  private readonly revoked = new Set<string>();
  private readonly probes = new Map<WorkerRun, string>();
  private closed = false;
  private readonly limits: DeviceHostLimits;

  private readonly options: DeviceHostOptions;

  constructor(options: DeviceHostOptions) {
    this.options = options;
    this.limits = { prepareMs: 5 * 60_000, offerMs: 30_000, stopMs: 90_000, killGraceMs: 5000, ...options.limits };
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
      readHostedSessions();
      const probe = this.runWorker({
        cwd: dirname(this.options.worker),
        env: this.options.env,
        input: { mode: 'offer', ...request },
        timeoutMs: this.limits.offerMs,
        maxOutputBytes: 32_768,
      });
      this.probes.set(probe, client);
      let result: Awaited<WorkerRun['done']>;
      try {
        result = await probe.done;
      } finally {
        this.probes.delete(probe);
      }
      if (this.closed || !this.options.allowed(client))
        return refused('forbidden', 'Current device-host approval is required.');
      if (!result.settled || result.notice) throw new Error(result.notice ?? 'Hosted offer worker did not settle.');
      const native = parseHostedNativeOffer(result.value);
      if (!native || native.platform !== request.platform) throw new Error('Invalid native hosted offer.');
      const records = readHostedSessions();
      const running = records.filter((record) => record.state !== 'stopped').length;
      const max = getConcurrencyLimits({ env: this.options.env }).maxDevices;
      let declined =
        native.declined ??
        (native.resources.memoryPressure !== 'normal' ? 'Host memory pressure is unknown or elevated.' : null);
      if (max > 0 && running >= max)
        declined = 'All configured hosted device reservations are occupied, including unresolved sessions.';
      if (request.platform === 'android' || request.platform === 'macos') {
        try {
          if (request.platform === 'android') reserveAndroidPort(records);
          else reserveMacosSlot(records);
        } catch (error) {
          declined = (error as Error).message;
        }
      }
      return {
        result: {
          ...native,
          declined,
          capacity: { running, max, available: max > 0 ? Math.max(0, max - running) : null },
        },
      };
    } catch (error) {
      return refused('action-failed', (error as Error).message);
    }
  }

  reserve(client: string, params: unknown): Answer {
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
        const max = getConcurrencyLimits({ env: this.options.env }).maxDevices;
        if (max > 0 && records.filter((record) => record.state !== 'stopped').length >= max)
          throw new Error('All configured hosted device reservations are occupied, including unresolved sessions.');
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

  private observed(record: HostedDeviceSession): HostedDeviceSession {
    if (record.state !== 'stopped' && !this.owned.has(record.id))
      return {
        ...record,
        state: 'unknown',
        notice:
          'The previous session owner is not attached to this server. Explicit stop must reconcile the retained device before another reservation.',
      };
    return { ...record };
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

  stop(client: string, params: unknown): Answer {
    if (!this.options.allowed(client)) return refused('forbidden', 'Current device-host approval is required.');
    if (!isJsonObject(params) || typeof params.session !== 'string')
      return refused('bad-request', 'stop needs session.');
    try {
      const record = readHostedSessions().find((each) => each.client === client && each.id === params.session);
      if (!record) return refused('unknown-session', 'This client has no such hosted session.');
      this.beginStop(record);
      return { result: { ...record, state: record.state === 'stopped' ? 'stopped' : 'stopping' } };
    } catch (error) {
      return refused('action-failed', (error as Error).message);
    }
  }

  async metroOpen(client: string, params: unknown, peer: string | null): Promise<AppAnswer<{ port: number }>> {
    if (!this.options.allowed(client)) return refused('forbidden', 'Current device-host approval is required.');
    if (
      !isJsonObject(params) ||
      typeof params.session !== 'string' ||
      !peer ||
      !isIP(peer) ||
      typeof params.gatewayPort !== 'number' ||
      !Number.isInteger(params.gatewayPort) ||
      params.gatewayPort < 1 ||
      params.gatewayPort > 65535 ||
      typeof params.secret !== 'string' ||
      !/^[a-f0-9]{64}$/.test(params.secret)
    )
      return refused(
        'bad-request',
        'Metro needs its session, client gateway port and 256-bit secret on a tailnet connection.',
      );
    try {
      const record = readHostedSessions().find((each) => each.client === client && each.id === params.session);
      if (!record || record.state !== 'ready' || this.closed || !this.owned.has(record.id))
        throw new Error('Only a ready session attached to this owner can open Metro.');
      if (record.platform !== 'ios') throw new Error('Hosted Metro currently supports iOS sessions only.');
      const owned = this.owned.get(record.id)!;
      if (owned.stopping) throw new Error('This hosted session is stopping.');
      if (owned.metro) {
        if (owned.metro.closing) throw new Error('This session Metro bridge is closing.');
        if (
          owned.metro.peer !== peer ||
          owned.metro.gatewayPort !== params.gatewayPort ||
          owned.metro.secret !== params.secret
        )
          throw new Error('Close this session Metro bridge before replacing its gateway.');
        return { result: { port: await owned.metro.ready } };
      }
      const bridge = createMetroBridge({ peer, gatewayPort: params.gatewayPort, secret: params.secret });
      const ready = new Promise<number>((resolve, reject) => {
        bridge.server.once('error', reject);
        bridge.server.listen(record.metroPort ?? 0, '127.0.0.1', () =>
          resolve((bridge.server.address() as AddressInfo).port),
        );
      });
      const metro: NonNullable<OwnedSession['metro']> = {
        bridge,
        ready,
        peer,
        gatewayPort: params.gatewayPort,
        secret: params.secret,
      };
      owned.metro = metro;
      try {
        const port = await ready;
        if (owned.stopping || this.closed || !this.options.allowed(client))
          throw new Error('The session lost its Metro approval while opening.');
        this.change(record.id, (current) => {
          current.metroPort = port;
        });
        metro.port = port;
        return { result: { port } };
      } catch (error) {
        await bridge.close();
        if (owned.metro === metro) delete owned.metro;
        throw error;
      }
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
      if (owned?.installing) throw new Error('Wait for this session native launch before closing its Metro bridge.');
      if (owned) await this.closeMetro(owned);
      return { result: { port: null } };
    } catch (error) {
      return refused('action-failed', (error as Error).message);
    }
  }

  private async closeMetro(owned: OwnedSession): Promise<void> {
    const metro = owned.metro;
    if (!metro) return;
    metro.closing = true;
    await metro.ready.catch(() => {});
    await metro.bridge.close();
    if (owned.metro === metro) delete owned.metro;
  }

  viewTarget(client: string, session: string): HostedViewTarget {
    if (this.closed || !this.options.allowed(client)) throw new Error('Current device-host approval is required.');
    const record = readHostedSessions().find((each) => each.client === client && each.id === session);
    const owned = this.owned.get(session);
    if (!record || record.state !== 'ready' || !record.device || !owned)
      throw new Error(
        'Only a ready session attached to this server can be viewed. Explicit stop must reconcile a lost owner.',
      );
    if (record.platform !== 'ios' && record.platform !== 'macos')
      throw new Error('Hosted view and input support iOS and macOS sessions only.');
    if (owned.stopping || owned.installing) throw new Error('This hosted session has a native operation in progress.');
    const home = join(deviceHostArea(record.id), 'home');
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
          executable.startsWith('../') ||
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
        'App offers need a bounded normalized bundle manifest, bundleId, development or release mode and, optionally, at most 32 arguments of 1024 characters (8192 in total) without NUL or line breaks.',
      );
    try {
      const record = this.appSession(client, offer);
      if (record.platform !== 'macos' && offer.arguments !== undefined)
        throw new Error('App arguments are supported only for hosted macOS sessions.');
      if (record.platform === 'macos') {
        if (offer.mode === 'development' || offer.devClientScheme !== undefined)
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
      if (owned.stopping || (owned.installing && owned.installing.attempt !== offer.attempt))
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

  appAttach(client: string, params: unknown): AppAnswer<HostedAppLaunch> {
    if (!this.options.allowed(client)) return refused('forbidden', 'Current device-host approval is required.');
    try {
      const record = this.appSession(client, params);
      const app = readHostedAppMetadata(record.id, (params as { attempt: string }).attempt);
      const result: HostedAppLaunch = appDelivery(app);
      if (record.platform === 'macos' && app.state === 'installed' && record.state === 'ready') {
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

  /** The hosted macOS app's captured logs, also after its session stopped; the isolated home keeps them. */
  logsQuery(client: string, params: unknown): AppAnswer<Methods['device-host.logs.query']['result']> {
    if (this.closed || !this.options.allowed(client))
      return refused('forbidden', 'Current device-host approval is required.');
    const cursor = isJsonObject(params) && params.cursor !== undefined ? parseHostedLogsCursor(params.cursor) : {};
    if (!isJsonObject(params) || typeof params.session !== 'string' || !cursor)
      return refused('bad-request', 'logs.query needs a session and, optionally, a cursor from a previous result.');
    try {
      const record = readHostedSessions().find((each) => each.client === client && each.id === params.session);
      if (!record) return refused('unknown-session', 'This client has no such hosted session.');
      if (record.platform !== 'macos') throw new Error('Hosted logs support macOS sessions only.');
      const dir = hostedMacosLogsDir(join(deviceHostArea(record.id), 'home'));
      return { result: dir ? readLogsSince(dir, cursor) : { records: [], cursor, more: false } };
    } catch (error) {
      return refused('action-failed', (error as Error).message);
    }
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
      if (owned.stopping || owned.installing)
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
      if (record.platform === 'macos' && this.options.agents.access(record.id)) await this.stopAgent(record.id);
      await this.closeView(owned);
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
      if (installed && record.platform === 'macos' && Number.isSafeInteger(value.pid) && (value.pid as number) > 0)
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
        bundleId: hostedMacosBundleId(readHostedAppMetadata(record.id, attempt).bundleId, record.appSlot!),
        pid,
      });
    } catch (error) {
      process.stderr.write(`Hosted agent control did not start: ${(error as Error).message}\n`);
    }
  }

  private stopAgent(session: string): Promise<void> {
    return this.options.agents.appStopped(session).catch((error: unknown) => {
      process.stderr.write(`Hosted agent control did not stop: ${(error as Error).message}\n`);
    });
  }

  private async prepare(record: HostedDeviceSession): Promise<void> {
    const owned = this.owned.get(record.id)!;
    if (!this.options.allowed(record.client) || this.closed) {
      this.beginStop(record);
      return;
    }
    const run = this.run(record, owned, 'prepare');
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
      current.state =
        !outcome.notice && outcome.settled && isJsonObject(value) && value.state === 'ready' && device
          ? 'ready'
          : !outcome.notice && outcome.settled && isJsonObject(value) && value.state === 'stopped'
            ? 'stopped'
            : 'unknown';
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
    void this.stopAgent(record.id);
    void this.closeMetro(owned).catch((error: unknown) => this.failed(record.id, error));
    void this.closeView(owned).catch((error: unknown) => this.failed(record.id, error));
    this.change(record.id, (current) => {
      current.state = 'stopping';
    });
    owned.stopping = this.finishStop(record, owned)
      .catch((error: unknown) => this.failed(record.id, error))
      .finally(() => {
        delete owned.stopping;
      });
  }

  private async finishStop(record: HostedDeviceSession, owned: OwnedSession): Promise<void> {
    const home = join(deviceHostArea(record.id), 'home');
    owned.run?.cancel();
    await this.closeMetro(owned);
    await this.closeView(owned);
    releaseClaim(takeHostedInputClaim(owned.claim));
    if (owned.run) {
      owned.run.cancel();
      const outcome = await owned.run.done;
      const value = outcome.value;
      if (!outcome.settled)
        throw new Error('The prior worker group is unresolved. Its claim and device were retained.');
      if (
        isJsonObject(value) &&
        value.state === 'stopped' &&
        value.device === null &&
        !existsSync(join(home, 'hosted-device.json')) &&
        !existsSync(join(home, 'created-devices.json'))
      ) {
        this.change(record.id, (current) => {
          current.state = 'stopped';
          current.device = null;
          if (typeof value.notice === 'string') current.notice = value.notice;
          else delete current.notice;
        });
        this.release(record.id, owned);
        return;
      }
    }
    const device = readHostedDevice(home, record.platform);
    assertSessionDevice(record, device);
    if (record.device && hostedDeviceId(record.device) !== hostedDeviceId(device))
      throw new Error('The device record no longer matches this session.');
    this.change(record.id, (current) => {
      current.device = device;
    });
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
        if (record.state === 'stopped' || this.options.allowed(record.client) || this.revoked.has(record.id)) continue;
        this.revoked.add(record.id);
        try {
          this.beginStop(record);
        } catch (error) {
          this.failed(record.id, error);
        }
      }
    } catch (error) {
      for (const [id, owned] of this.owned) {
        owned.run?.cancel();
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
        void this.stopAgent(id);
      }
    }
    await Promise.all([...this.owned.values()].map((owned) => owned.stopping ?? owned.run?.done));
    await Promise.all([...this.probes.keys()].map((probe) => probe.done));
  }

  private run(
    record: HostedDeviceSession,
    owned: OwnedSession,
    mode: 'prepare' | 'stop' | 'install',
    attempt?: string,
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
        attempt,
        metroPort: mode === 'install' ? owned.metro?.port : undefined,
      },
      claim: owned.claim,
      timeoutMs: mode === 'stop' ? this.limits.stopMs : this.limits.prepareMs,
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
      const settled = closed && (!child.pid || !processGroupAlive(child.pid));
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
    const cancel = () => {
      if (finished || cancelling) return;
      cancelling = true;
      notice ??= 'Hosted worker was cancelled or exceeded its deadline.';
      signal('SIGTERM');
      killTimer = setTimeout(() => signal('SIGKILL'), this.limits.killGraceMs);
      finishTimer = setTimeout(finish, this.limits.killGraceMs * 2);
    };
    const finishGroup = () => {
      if (finished) return;
      if (!child.pid || !processGroupAlive(child.pid)) finish();
      else {
        cancel();
        groupTimer = setTimeout(finishGroup, 25);
      }
    };
    const timer = setTimeout(cancel, options.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (outputBytes + chunk.length > options.maxOutputBytes) {
        notice = 'Hosted worker output exceeded its bound.';
        cancel();
      } else {
        output.push(chunk);
        outputBytes += chunk.length;
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    child.stdin?.on('error', () => cancel());
    child.once('error', (error) => {
      notice = error.message;
      closed = true;
      finishGroup();
    });
    child.once('close', (code) => {
      if (code !== 0) notice ??= stderr.trim() || `Hosted worker exited ${code}.`;
      closed = true;
      finishGroup();
    });
    const captured = child.pid === undefined ? null : captureProcessIdentity(child.pid);
    if (!captured?.ok || child.pid === undefined) {
      notice = 'The worker process identity could not be captured; no native request was sent.';
      child.kill('SIGKILL');
      cancel();
    } else {
      identity = { pid: child.pid, processToken: captured.token };
      try {
        if (options.claim) setClaimChild(options.claim, identity);
        child.stdin?.end(JSON.stringify(options.input));
      } catch (error) {
        notice = (error as Error).message;
        cancel();
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
