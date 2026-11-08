import { LOG_ROTATE_BYTES } from '@stim-cli/core';
import { createHash } from 'node:crypto';
import type { ActivityDriver } from '@stim-cli/core/state';
import { probeWebDrivers } from '../../devices/activity.ts';
import { signalProcessTree } from '../../metro.ts';
import { createNdjsonWriter, readNdjsonGenerations, type NdjsonRecord } from '../../ndjson.ts';
import { connectOwnedBrowser, type CdpConnection, type CdpEvent } from '../../web/cdp.ts';
import { DESKTOP_PAGE, PHONE_SCREEN } from '../../web/chrome.ts';
import { consoleRecord, exceptionRecord, logEntryRecord, networkFailureRecord } from '../../web/events.ts';
import {
  INPUT_BINDING,
  INPUT_LISTENER,
  INPUT_STARTED,
  INPUT_WORLD,
  parseInputBatch,
  webAgentRecords,
} from '../../web/input.ts';
import { chromeProcessState, removeSingletonFiles } from '../../web/profile.ts';
import {
  browserLogFile,
  clearWebRecord,
  readWebRecord,
  updateWebRecord,
  webLogFile,
  type OwnedProcess,
  type WebRecord,
} from '../../web/state.ts';

const DEVTOOLS_WAIT_MS = 20_000;
const ROUTE_THROTTLE_MS = 250;
const CHROME_EXIT_WAIT_MS = 5_000;
const POLL_MS = 50;
const STOP_SETTLE_MS = 5_000;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWebBundle(url: string): boolean {
  return /\.bundle(?:\?|$)/.test(url) && /[?&]platform=web(?:&|$)/.test(url);
}

function createDriverProbe(port: number, ownPids: number[]): () => Promise<ActivityDriver | null> {
  let running: Promise<ActivityDriver | null> | null = null;
  return () => {
    running ??= probeWebDrivers({ port, ownPids })
      .catch(() => null)
      .then((drivers) => {
        running = null;
        return drivers?.[0] ?? null;
      });
    return running;
  };
}

export interface BrowserStream {
  /** Resolves once the owned page is attached and its record names it, or rejects with why it could not be. */
  attached: Promise<void>;
  /** Resolves when the stream ends: Chrome exited, its page closed, or `close` was called. */
  ended: Promise<void>;
  live(): boolean;
  /** Detaches without touching Chrome, which keeps running. */
  close(): Promise<string | null>;
  failure(): string | null;
}

/**
 * Observes the owned Chrome a workspace's record names through its DevTools endpoint: page console, exceptions,
 * network failures, navigations, route changes and agent input go to `web.ndjson`. The DevTools session holds the
 * phone emulation and the input listener, which Chrome drops with the session. When the owned page closes it closes
 * Chrome; when Chrome exits it removes the profile's lock files and the record.
 */
export function observeBrowser(root: string, record: WebRecord, chrome: OwnedProcess): BrowserStream {
  const owner = { pid: record.pid, processToken: record.processToken };
  const writer = createNdjsonWriter(webLogFile(root), {
    maxBytes: LOG_ROTATE_BYTES,
    ...(record.runId ? { fields: { runId: record.runId } } : {}),
  });
  const log = (level: string, event: string, msg: string, extra: Record<string, unknown> = {}) =>
    writer.write({ src: 'device', platform: 'web', level, event, msg, ...extra });
  let cdp: CdpConnection | null = null;
  let closed = false;
  let attachedLive = false;
  let disconnected = false;
  let stopping = false;
  let stopTask: Promise<void> | null = null;
  let disconnectTask: Promise<[string, string, string]> | null = null;
  let failure: string | null = null;
  let finalizing: Promise<string | null> | null = null;
  let transportClosed: Promise<void> = Promise.resolve();
  let handleDisconnect: (() => void) | null = null;
  const connecting = new AbortController();
  const pending = new Set<Promise<unknown>>();
  let flushRoute: (() => void) | null = null;
  let end!: () => void;
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  const chromeGone = () => chromeProcessState(chrome, record.profile) === 'gone';
  const finish = (level?: string, event?: string, msg?: string): Promise<string | null> => {
    attachedLive = false;
    if (finalizing) return finalizing;
    closed = true;
    if (cdp) cdp.close();
    else connecting.abort();
    finalizing = (async () => {
      await attached.catch(() => {});
      await transportClosed;
      await stopTask;
      const disconnectedResult = await disconnectTask;
      if (!event && disconnectedResult) [level, event, msg] = disconnectedResult;
      flushRoute?.();
      await Promise.allSettled(pending);
      if (level && event && msg && chromeGone()) {
        try {
          if (readWebRecord(root)?.chromeProcess?.processToken === chrome.processToken)
            removeSingletonFiles(record.profile);
        } catch {}
        log(level, event, msg);
      } else if (event && msg)
        log('error', event, `${msg}; Chrome pid ${chrome.pid} is still running, so its record is kept for stim stop`);
      const result = writer.close();
      if (result.dropped)
        failure = `the browser output could not be recorded: ${result.lastError?.message ?? 'write failed'}`;
      if (!failure && event && chromeGone()) {
        try {
          clearWebRecord(root, owner);
        } catch {}
      }
      end();
      return failure;
    })().catch((error: unknown) => {
      failure = `the browser output drain failed: ${describe(error)}`;
      writer.close();
      end();
      return failure;
    });
    return finalizing;
  };
  const stopChrome = async () => {
    stopping = true;
    try {
      await Promise.race([cdp?.send('Browser.close'), sleep(3000)]);
    } catch {}
    const deadline = Date.now() + CHROME_EXIT_WAIT_MS;
    while (!chromeGone() && Date.now() < deadline) await sleep(POLL_MS);
    const state = chromeProcessState(chrome, record.profile);
    if (state === 'running' || state === 'lingering') {
      try {
        signalProcessTree(chrome.pid, 'SIGKILL', { group: true });
      } catch {}
      const killDeadline = Date.now() + 2000;
      while (!chromeGone() && Date.now() < killDeadline) await sleep(POLL_MS);
    }
  };

  const attached = (async () => {
    let connection: CdpConnection | null = null;
    let lastError: unknown = null;
    const deadline = Date.now() + DEVTOOLS_WAIT_MS;
    const waiting = () => !closed && !chromeGone();
    while (!connection && Date.now() < deadline && waiting()) {
      try {
        connection = await connectOwnedBrowser(record.cdpPort, chrome.pid, connecting.signal);
      } catch (error) {
        lastError = error;
        await sleep(100);
      }
    }
    if (!connection) {
      throw new Error(
        `Chrome did not open DevTools on port ${record.cdpPort} within ${DEVTOOLS_WAIT_MS / 1000}s: ${describe(lastError)}`,
      );
    }
    cdp = connection;
    transportClosed = new Promise<void>((resolve) =>
      connection.onClose(() => {
        disconnected = true;
        attachedLive = false;
        resolve();
        handleDisconnect?.();
      }),
    );
    if (closed) return connection.close();
    const version = String((await connection.send('Browser.getVersion')).product ?? '');
    await connection.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = (await connection.send('Target.getTargets')) as {
      targetInfos?: { targetId: string; type: string }[];
    };
    const pages = targetInfos?.filter((target) => target.type === 'page') ?? [];
    const page = record.targetId ? pages.find((target) => target.targetId === record.targetId) : pages[0];
    if (!page && record.targetId) {
      stopTask = stopChrome().catch((error: unknown) => {
        failure = `the browser could not be stopped: ${describe(error)}`;
      });
      await stopTask;
      void finish('info', 'web_page_closed', 'the owned page was closed; closed Chrome');
      throw new Error('the owned browser page is no longer available');
    }
    if (!page) throw new Error('Chrome opened no page');
    const targetId = page.targetId;
    const { sessionId } = (await connection.send('Target.attachToTarget', { targetId, flatten: true })) as {
      sessionId: string;
    };

    const requests = new Map<string, { url: string; method: string; document: boolean }>();
    const driver = createDriverProbe(record.cdpPort, [process.pid, chrome.pid]);
    let batchDriver: Promise<ActivityDriver | null> | null = null;
    let reloading = false;
    let replaying = Boolean(record.targetId);
    const recordedKeys = new Map<string, number>();
    if (replaying) {
      for (const entry of readNdjsonGenerations(webLogFile(root))) {
        if (typeof entry.cdpKey === 'string') recordedKeys.set(entry.cdpKey, (recordedKeys.get(entry.cdpKey) ?? 0) + 1);
      }
    }
    const writePage = (method: string, params: Record<string, unknown>, entry: NdjsonRecord) => {
      const timestamp =
        method === 'Log.entryAdded' && params.entry && typeof params.entry === 'object' && 'timestamp' in params.entry
          ? params.entry.timestamp
          : params.timestamp;
      const key =
        typeof timestamp === 'number'
          ? createHash('sha256')
              .update(JSON.stringify([chrome.processToken, targetId, method, timestamp, entry]))
              .digest('hex')
          : null;
      const remaining = replaying && key ? (recordedKeys.get(key) ?? 0) : 0;
      if (key && remaining > 0) {
        recordedKeys.set(key, remaining - 1);
        return;
      }
      writer.write(key ? { ...entry, cdpKey: key } : entry);
    };
    let route: { written: string | null; latest: string | null; at: number; timer: NodeJS.Timeout | null } = {
      written: null,
      latest: null,
      at: 0,
      timer: null,
    };
    const writeRoute = () => {
      route.timer = null;
      if (route.latest === null || route.latest === route.written) return;
      route.written = route.latest;
      route.at = Date.now();
      log('info', 'web_route', `route changed to ${route.latest}`, { url: route.latest });
    };
    flushRoute = () => {
      if (route.timer) clearTimeout(route.timer);
      writeRoute();
    };
    connection.onEvent((event: CdpEvent) => {
      if (event.method === 'Target.targetDestroyed' && event.params.targetId === targetId && !stopping && !closed) {
        stopTask = stopChrome().catch((error: unknown) => {
          failure = `the browser could not be stopped: ${describe(error)}`;
        });
        void stopTask.then(() => finish('info', 'web_page_closed', 'the owned page was closed; closed Chrome'));
        return;
      }
      if (event.method === 'Target.targetCrashed' && event.params.targetId === targetId) {
        log('error', 'web_page_crashed', `the page renderer crashed (${String(event.params.status ?? 'unknown')})`);
        return;
      }
      if (event.sessionId !== sessionId) return;
      const params = event.params;
      switch (event.method) {
        case 'Runtime.consoleAPICalled':
          writePage(event.method, params, consoleRecord(params));
          return;
        case 'Runtime.exceptionThrown':
          writePage(event.method, params, exceptionRecord(params));
          return;
        case 'Log.entryAdded': {
          const entry = logEntryRecord(params);
          if (entry) writePage(event.method, params, entry);
          return;
        }
        case 'Runtime.bindingCalled': {
          if (params.name !== INPUT_BINDING) return;
          if (params.payload === INPUT_STARTED) {
            batchDriver = driver();
            const probe = batchDriver;
            pending.add(probe);
            void probe.finally(() => pending.delete(probe));
            return;
          }
          const batch = parseInputBatch(String(params.payload ?? ''));
          const attributed = batchDriver ?? driver();
          pending.add(attributed);
          void attributed.finally(() => pending.delete(attributed));
          batchDriver = null;
          if (!batch.actions.length && !batch.dropped) return;
          const task = (async () => {
            const found = await attributed;
            if (!found) return;
            for (const entry of webAgentRecords(batch, targetId, found.tool, Date.now())) writer.write(entry);
          })().catch((error: unknown) => {
            failure = `the browser input could not be recorded: ${describe(error)}`;
          });
          pending.add(task);
          void task.finally(() => pending.delete(task));
          return;
        }
        case 'Page.frameStartedNavigating':
          if (params.frameId === targetId) reloading = String(params.navigationType).startsWith('reload');
          return;
        case 'Page.navigatedWithinDocument': {
          if (params.frameId !== targetId || typeof params.url !== 'string') return;
          route.latest = params.url;
          if (route.timer) return;
          const wait = route.at + ROUTE_THROTTLE_MS - Date.now();
          if (wait <= 0) writeRoute();
          else route.timer = setTimeout(writeRoute, wait);
          return;
        }
        case 'Page.loadEventFired':
          log('info', 'web_page_loaded', 'the page fired its load event');
          return;
        case 'Network.requestWillBeSent': {
          const request = params.request as { url: string; method: string };
          const document = params.type === 'Document' && params.frameId === targetId;
          requests.set(String(params.requestId), { url: request.url, method: request.method, document });
          if (document) {
            if (route.timer) clearTimeout(route.timer);
            route = { written: null, latest: null, at: 0, timer: null };
            log('info', 'web_navigation', `${reloading ? 'reloading' : 'navigating to'} ${request.url}`, {
              url: request.url,
              marker: true,
              ...(reloading ? { reload: true } : {}),
            });
            reloading = false;
          }
          return;
        }
        case 'Network.responseReceived': {
          const facts = requests.get(String(params.requestId));
          const response = params.response as { url: string; status: number };
          if (!facts) return;
          if (facts.document) {
            log('info', 'web_document_response', `${response.status} ${response.url}`, { status: response.status });
          }
          if (isWebBundle(response.url)) {
            log(response.status < 400 ? 'info' : 'error', 'web_bundle_response', `${response.status} ${response.url}`, {
              status: response.status,
            });
          }
          if (response.status >= 400) {
            writer.write(networkFailureRecord({ ...facts, url: response.url, status: response.status }));
          }
          return;
        }
        case 'Network.loadingFinished':
          requests.delete(String(params.requestId));
          return;
        case 'Network.loadingFailed': {
          const facts = requests.get(String(params.requestId));
          requests.delete(String(params.requestId));
          if (!facts) return;
          writer.write(
            networkFailureRecord({
              ...facts,
              errorText: String(params.errorText ?? 'failed'),
              canceled: params.canceled === true,
            }),
          );
          return;
        }
      }
    });
    handleDisconnect = () => {
      if (stopping || closed) return;
      disconnectTask = (async (): Promise<[string, string, string]> => {
        const until = Date.now() + 2000;
        while (!chromeGone() && Date.now() < until) await sleep(POLL_MS);
        if (!chromeGone()) return ['warn', 'web_browser_unobserved', 'Chrome closed its DevTools connection'];
        const recorded = () => readWebRecord(root)?.chromeProcess?.processToken === chrome.processToken;
        const settle = Date.now() + STOP_SETTLE_MS;
        while (recorded() && Date.now() < settle) await sleep(POLL_MS);
        if (recorded()) return ['error', 'web_browser_exited', `Chrome exited; see ${browserLogFile(root)}`];
        return ['info', 'web_browser_stopped', 'Chrome was stopped'];
      })().catch((error: unknown): [string, string, string] => {
        failure = `the browser disconnect could not be recorded: ${describe(error)}`;
        return ['error', 'web_browser_failed', failure];
      });
      void disconnectTask.then(([level, event, msg]) => finish(level, event, msg));
    };
    if (disconnected) handleDisconnect();

    for (const domain of ['Runtime', 'Log', 'Network', 'Page'])
      await connection.send(`${domain}.enable`, {}, sessionId);
    replaying = false;
    recordedKeys.clear();
    try {
      await connection.send(
        'Runtime.addBinding',
        { name: INPUT_BINDING, executionContextName: INPUT_WORLD },
        sessionId,
      );
      await connection.send(
        'Page.addScriptToEvaluateOnNewDocument',
        { source: INPUT_LISTENER, worldName: INPUT_WORLD },
        sessionId,
      );
      const tree = await connection.send('Page.getFrameTree', {}, sessionId);
      const frameId = (tree.frameTree as { frame?: { id?: unknown } } | undefined)?.frame?.id;
      if (typeof frameId !== 'string') throw new Error('the current page frame is unavailable');
      const world = await connection.send('Page.createIsolatedWorld', { frameId, worldName: INPUT_WORLD }, sessionId);
      if (typeof world.executionContextId !== 'number') throw new Error('the current page context is unavailable');
      await connection.send(
        'Runtime.evaluate',
        { expression: INPUT_LISTENER, contextId: world.executionContextId },
        sessionId,
      );
    } catch (error) {
      log('warn', 'web_input_unobserved', `agent input on the page is not recorded: ${describe(error)}`);
    }
    if (record.viewport === 'phone') {
      await connection.send('Emulation.setDeviceMetricsOverride', { ...PHONE_SCREEN, mobile: true }, sessionId);
      await connection.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId);
    } else if (!record.targetId) {
      await fitDesktopPage(connection, targetId, sessionId);
    }
    if (closed || disconnected) throw new Error('the browser observer disconnected during setup');
    if (!updateWebRecord(root, owner, { targetId, version })) throw new Error('the browser record changed');
    const recorded = log(
      'info',
      record.targetId ? 'web_browser_observed' : 'web_browser_started',
      `stimd pid ${process.pid} observes ${version} (pid ${chrome.pid}) on ${record.profile}`,
    );
    if (!recorded || writer.dropped) throw new Error('the browser output could not be recorded');
    attachedLive = true;
  })();
  attached.catch((error: unknown) => {
    void finish('error', 'web_browser_failed', `could not observe the owned Chrome: ${describe(error)}`);
  });
  return {
    attached,
    ended,
    live: () => attachedLive && !closed,
    close: () => finish(),
    failure: () => failure,
  };
}

// --window-size sets Chrome's outer window, and Chrome's UI takes part of it even when headless.
async function fitDesktopPage(connection: CdpConnection, targetId: string, sessionId: string): Promise<void> {
  const { windowId, bounds } = (await connection.send('Browser.getWindowForTarget', { targetId })) as {
    windowId: number;
    bounds: { width: number; height: number };
  };
  const { result } = (await connection.send(
    'Runtime.evaluate',
    { expression: '[innerWidth, innerHeight]', returnByValue: true },
    sessionId,
  )) as { result: { value: [number, number] } };
  const [width, height] = result.value;
  if (width === DESKTOP_PAGE.width && height === DESKTOP_PAGE.height) return;
  await connection.send('Browser.setWindowBounds', {
    windowId,
    bounds: { width: bounds.width + DESKTOP_PAGE.width - width, height: bounds.height + DESKTOP_PAGE.height - height },
  });
}
