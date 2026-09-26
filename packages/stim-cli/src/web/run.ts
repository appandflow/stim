import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOG_ROTATE_BYTES } from '@stim-cli/core';
import { WEB_VIEWPORTS, type WebViewport } from '@stim-cli/core/state';
import { relaunchWithLogFile } from '../detached-entry.ts';
import { recordCreatedDevice } from '../devices/created-devices.ts';
import { getExecutor } from '../exec.ts';
import { signalProcessTree } from '../metro.ts';
import { createNdjsonWriter, type NdjsonWriter } from '../ndjson.ts';
import {
  clearClaimChild,
  markClaimChildPending,
  releaseClaim,
  setClaimChild,
  tryAcquireClaim,
  type ClaimHandle,
} from '../ownership-claim.ts';
import { captureProcessIdentity, captureProcessToken } from '../process-identity.ts';
import { connectOwnedBrowser, type CdpConnection, type CdpEvent } from './cdp.ts';
import { PHONE_SCREEN, chromeArgs } from './chrome.ts';
import { consoleRecord, exceptionRecord, logEntryRecord, networkFailureRecord } from './events.ts';
import { chromeProcessState, liveProfileHolder, removeSingletonFiles } from './profile.ts';
import {
  browserLogFile,
  clearWebRecord,
  type OwnedProcess,
  updateWebRecord,
  webClaimRoot,
  webDir,
  webLogFile,
  webProfileDir,
  writeWebRecord,
} from './state.ts';

export interface WebSupervisorOptions {
  root: string;
  launchId: string | null;
  chrome: string;
  url: string;
  port: number;
  headless: boolean;
  viewport: WebViewport;
  ignoreCertificateErrors: boolean;
}

const USAGE =
  'Usage: web-run --root <path> --chrome <path> --url <url> --port <n> [--launch-id <id>] [--headed] [--viewport desktop|phone] [--ignore-certificate-errors]';

export function parseArgs(argv: string[]): WebSupervisorOptions | { error: string } {
  const values: Record<string, string> = {};
  let headless = true;
  let ignoreCertificateErrors = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--headed') headless = false;
    else if (arg === '--ignore-certificate-errors') ignoreCertificateErrors = true;
    else if (['--root', '--chrome', '--url', '--port', '--viewport', '--launch-id'].includes(arg)) {
      const value = argv[++i];
      if (value === undefined) return { error: `${arg} needs a value. ${USAGE}` };
      values[arg.slice(2)] = value;
    } else return { error: `Unknown browser supervisor argument "${arg}". ${USAGE}` };
  }
  const { root, chrome, url } = values;
  if (!root || !isAbsolute(root)) return { error: `--root must be an absolute path. ${USAGE}` };
  if (!chrome || !isAbsolute(chrome)) return { error: `--chrome must be an absolute path. ${USAGE}` };
  if (!url || !/^https?:\/\//.test(url)) return { error: `--url must be an http or https URL. ${USAGE}` };
  const port = Number(values.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return { error: `--port must be a TCP port. ${USAGE}` };
  const viewport = (values.viewport ?? 'desktop') as WebViewport;
  if (!WEB_VIEWPORTS.includes(viewport)) return { error: `--viewport must be desktop or phone. ${USAGE}` };
  return {
    root: resolve(root),
    launchId: values['launch-id'] ?? null,
    chrome,
    url,
    port,
    headless,
    viewport,
    ignoreCertificateErrors,
  };
}

const DEVTOOLS_WAIT_MS = 20_000;
const CHROME_EXIT_WAIT_MS = 5_000;
const POLL_MS = 50;

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWebBundle(url: string): boolean {
  return /\.bundle(?:\?|$)/.test(url) && /[?&]platform=web(?:&|$)/.test(url);
}

interface RequestFacts {
  url: string;
  method: string;
  document: boolean;
}

export async function runWebSupervisor(
  options: WebSupervisorOptions,
  {
    onExit = (code: number) => process.exit(code),
    stderr = (line: string) => console.error(line),
  }: { onExit?: (code: number) => void; stderr?: (line: string) => void } = {},
): Promise<void> {
  const root = realpathSync(options.root);
  mkdirSync(webDir(root), { recursive: true });
  const writer: NdjsonWriter = createNdjsonWriter(webLogFile(root), { maxBytes: LOG_ROTATE_BYTES });
  const log = (level: string, event: string, msg: string, extra: Record<string, unknown> = {}) =>
    writer.write({ src: 'device', platform: 'web', level, event, msg, ...extra });

  const processToken = captureProcessToken(process.pid);
  if (!processToken) {
    stderr('Stim browser supervisor: could not capture process identity; refusing to start an unmanaged browser.');
    writer.close();
    onExit(1);
    return;
  }
  const owner: OwnedProcess = { pid: process.pid, processToken };

  let claim: ClaimHandle | undefined;
  try {
    const attempt = tryAcquireClaim({
      root: webClaimRoot(root),
      mode: 'exclusive',
      label: 'browser supervisor',
      details: { purpose: 'browser supervisor' },
    });
    if (attempt.pending) releaseClaim(attempt.pending);
    claim = attempt.acquired;
    if (!claim) throw new Error(`another browser supervisor holds ${attempt.held?.path ?? webClaimRoot(root)}`);
  } catch (error) {
    stderr(`Stim browser supervisor: ${describe(error)}`);
    writer.close();
    onExit(1);
    return;
  }

  const profile = webProfileDir(root);
  let chrome: ChildProcess | null = null;
  let chromeRecord: OwnedProcess | null = null;
  let cdp: CdpConnection | null = null;
  let finished = false;
  let stopping = false;

  const chromeGone = () => !chromeRecord || chromeProcessState(chromeRecord) === 'gone';

  const finish = (code: number, level: string, event: string, msg: string) => {
    if (finished) return;
    finished = true;
    cdp?.close();
    const gone = chromeGone();
    if (gone) {
      try {
        removeSingletonFiles(profile);
      } catch {}
      if (claim) clearClaimChild(claim);
    }
    if (!gone) {
      log(
        'error',
        event,
        `${msg}; Chrome pid ${chromeRecord?.pid} is still running, so its record and claim are kept for stim stop`,
      );
      writer.close();
      onExit(1);
      return;
    }
    log(level, event, msg);
    try {
      clearWebRecord(root, owner);
    } catch {}
    releaseClaim(claim);
    writer.close();
    onExit(code);
  };

  const stopChrome = async () => {
    stopping = true;
    try {
      await Promise.race([cdp?.send('Browser.close'), sleep(3000)]);
    } catch {}
    const deadline = Date.now() + CHROME_EXIT_WAIT_MS;
    while (!chromeGone() && Date.now() < deadline) await sleep(POLL_MS);
    const state = chromeRecord ? chromeProcessState(chromeRecord) : 'gone';
    if (chromeRecord && (state === 'running' || state === 'lingering')) {
      try {
        signalProcessTree(chromeRecord.pid, 'SIGKILL', { group: true });
      } catch {}
      const killDeadline = Date.now() + 2000;
      while (!chromeGone() && Date.now() < killDeadline) await sleep(POLL_MS);
    }
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void stopChrome().then(() =>
        finish(0, 'info', 'web_browser_stopped', `browser supervisor received ${signal}; closed Chrome`),
      );
    });
  }

  try {
    mkdirSync(profile, { recursive: true });
    recordCreatedDevice('web', profile);
    const holder = liveProfileHolder(profile);
    if (holder !== null) throw new Error(`Chrome pid ${holder} still holds the profile ${profile}`);
    removeSingletonFiles(profile);
    const launch = {
      chrome: options.chrome,
      headless: options.headless,
      viewport: options.viewport,
      ignoreCertificateErrors: options.ignoreCertificateErrors,
    };
    writeWebRecord(root, {
      pid: process.pid,
      processToken,
      ...launch,
      cdpPort: options.port,
      profile,
      url: options.url,
      startedAt: new Date().toISOString(),
      ...(options.launchId ? { launchId: options.launchId } : {}),
    });

    const fd = openSync(browserLogFile(root), 'a');
    markClaimChildPending(claim);
    chrome = getExecutor().spawn(options.chrome, chromeArgs({ profile, port: options.port, ...launch }), {
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    const pid = chrome.pid;
    const captured = pid === undefined ? null : captureProcessIdentity(pid);
    if (!pid || !captured?.ok) {
      chrome.kill('SIGKILL');
      throw new Error(`could not identify the Chrome process${captured && !captured.ok ? `: ${captured.reason}` : ''}`);
    }
    chromeRecord = { pid, processToken: captured.token };
    setClaimChild(claim, chromeRecord);
    updateWebRecord(root, owner, { chromeProcess: chromeRecord });
    chrome.on('exit', (code, signal) => {
      if (stopping) return;
      void (async () => {
        const deadline = Date.now() + 2000;
        while (!chromeGone() && Date.now() < deadline) await sleep(POLL_MS);
        finish(
          1,
          'error',
          'web_browser_exited',
          `Chrome exited (${signal ? `signal ${signal}` : `exit code ${code}`}); see ${browserLogFile(root)}`,
        );
      })();
    });

    let connection: CdpConnection | null = null;
    let lastError: unknown = null;
    const deadline = Date.now() + DEVTOOLS_WAIT_MS;
    const isFinished = () => finished;
    while (!connection && Date.now() < deadline && !isFinished()) {
      try {
        connection = await connectOwnedBrowser(options.port, pid);
      } catch (error) {
        lastError = error;
        await sleep(100);
      }
    }
    if (!connection) {
      throw new Error(
        `Chrome did not open DevTools on port ${options.port} within ${DEVTOOLS_WAIT_MS / 1000}s: ${describe(lastError)}`,
      );
    }
    cdp = connection;
    const version = String((await connection.send('Browser.getVersion')).product ?? '');
    await connection.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = (await connection.send('Target.getTargets')) as {
      targetInfos?: { targetId: string; type: string }[];
    };
    const page = targetInfos?.find((target) => target.type === 'page');
    if (!page) throw new Error('Chrome opened no page');
    const targetId = page.targetId;
    const { sessionId } = (await connection.send('Target.attachToTarget', { targetId, flatten: true })) as {
      sessionId: string;
    };

    const requests = new Map<string, RequestFacts>();
    connection.onEvent((event: CdpEvent) => {
      if (event.method === 'Target.targetDestroyed' && event.params.targetId === targetId && !stopping) {
        void stopChrome().then(() => finish(0, 'info', 'web_page_closed', 'the owned page was closed; closed Chrome'));
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
          writer.write(consoleRecord(params));
          return;
        case 'Runtime.exceptionThrown':
          writer.write(exceptionRecord(params));
          return;
        case 'Log.entryAdded': {
          const record = logEntryRecord(params);
          if (record) writer.write(record);
          return;
        }
        case 'Page.loadEventFired':
          log('info', 'web_page_loaded', 'the page fired its load event');
          return;
        case 'Network.requestWillBeSent': {
          const request = params.request as { url: string; method: string };
          const document = params.type === 'Document' && params.frameId === targetId;
          requests.set(String(params.requestId), { url: request.url, method: request.method, document });
          if (document)
            log('info', 'web_navigation', `navigating to ${request.url}`, { url: request.url, marker: true });
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
    connection.onClose(() => {
      if (!stopping && chromeGone()) finish(1, 'error', 'web_browser_exited', 'Chrome closed its DevTools connection');
    });

    for (const domain of ['Runtime', 'Log', 'Network', 'Page'])
      await connection.send(`${domain}.enable`, {}, sessionId);
    if (options.viewport === 'phone') {
      await connection.send('Emulation.setDeviceMetricsOverride', { ...PHONE_SCREEN, mobile: true }, sessionId);
      await connection.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId);
    }
    updateWebRecord(root, owner, { targetId, version });
    log(
      'info',
      'web_browser_started',
      `browser supervisor pid ${process.pid} runs ${version} (pid ${pid}) on ${profile}`,
    );
    connection.send('Page.navigate', { url: options.url }, sessionId).catch((error: unknown) => {
      log('debug', 'web_navigation_slow', `Page.navigate did not answer: ${describe(error)}; the page may still load`);
    });
  } catch (error) {
    stderr(`Stim browser supervisor: ${describe(error)}`);
    await stopChrome();
    finish(1, 'error', 'web_browser_failed', `could not start the owned Chrome: ${describe(error)}`);
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (relaunchWithLogFile(argv)) return;
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    console.error(`Stim browser supervisor: ${parsed.error}`);
    process.exit(2);
    return;
  }
  if (!existsSync(parsed.root)) {
    console.error(`Stim browser supervisor: --root ${parsed.root} does not exist.`);
    process.exit(2);
    return;
  }
  process.title = 'stim-web';
  await runWebSupervisor(parsed);
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((error) => {
    console.error(`Stim browser supervisor: ${describe(error)}`);
    process.exit(1);
  });
}
