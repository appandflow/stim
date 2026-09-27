import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rotatedLogPath } from '@stim-cli/core';
import { WEB_VIEWPORTS, type WebPageState, type WebViewport } from '@stim-cli/core/state';
import { inspectProcessIdentity, sameProcessRecord, type ProcessRecord } from '../process-identity.ts';
import { chromeProcessState } from './profile.ts';
import { workspaceDir, workspaceLogsDir } from '../workspace/paths.ts';
import {
  clearWorkspaceStateKey,
  readWorkspaceState,
  updateWorkspaceState,
  writeWorkspaceState,
} from '../workspace/workspace-state.ts';

const WEB_STATE_KEY = 'web';

export const CDP_PORT_LABEL = 'web-cdp';

export interface WebLaunchConfig {
  chrome: string;
  headless: boolean;
  viewport: WebViewport;
  ignoreCertificateErrors: boolean;
}

export interface OwnedProcess {
  pid: number;
  processToken: string;
}

/** The browser supervisor's record in workspace state; `chromeProcess` appears once Chrome is spawned. */
export interface WebRecord extends OwnedProcess, WebLaunchConfig {
  pid: number;
  processToken: string;
  chromeProcess?: OwnedProcess;
  cdpPort: number;
  profile: string;
  url: string;
  startedAt: string;
  targetId?: string;
  version?: string;
  launchId?: string;
}

export function webDir(root: string): string {
  return join(workspaceDir(root), 'web');
}

export function webProfileDir(root: string): string {
  return join(webDir(root), 'profile');
}

export function webClaimRoot(root: string): string {
  return join(webDir(root), 'supervisor.lock');
}

export function webLogFile(root: string): string {
  return join(workspaceLogsDir(root), 'web.ndjson');
}

export function webSupervisorLogFile(root: string): string {
  return join(workspaceLogsDir(root), 'web-supervisor.log');
}

export function browserLogFile(root: string): string {
  return join(workspaceLogsDir(root), 'browser.log');
}

function processRecord(value: unknown): OwnedProcess | undefined {
  const record = value as { pid?: unknown; processToken?: unknown } | null;
  return typeof record?.pid === 'number' && typeof record.processToken === 'string'
    ? { pid: record.pid, processToken: record.processToken }
    : undefined;
}

function parseWebRecord(value: unknown): WebRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const owner = processRecord(record);
  if (!owner || typeof record.cdpPort !== 'number' || typeof record.profile !== 'string') return null;
  if (typeof record.url !== 'string' || typeof record.chrome !== 'string') return null;
  const chromeProcess = processRecord(record.chromeProcess);
  return {
    pid: owner.pid,
    processToken: owner.processToken,
    chrome: record.chrome,
    ...(chromeProcess ? { chromeProcess } : {}),
    cdpPort: record.cdpPort,
    profile: record.profile,
    url: record.url,
    headless: record.headless !== false,
    viewport: WEB_VIEWPORTS.includes(record.viewport as WebViewport) ? (record.viewport as WebViewport) : 'desktop',
    ignoreCertificateErrors: record.ignoreCertificateErrors === true,
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : '',
    ...(typeof record.targetId === 'string' ? { targetId: record.targetId } : {}),
    ...(typeof record.version === 'string' ? { version: record.version } : {}),
    ...(typeof record.launchId === 'string' ? { launchId: record.launchId } : {}),
  };
}

export function readWebRecord(root: string): WebRecord | null {
  return parseWebRecord(readWorkspaceState(root)?.[WEB_STATE_KEY]);
}

export function writeWebRecord(root: string, record: WebRecord): void {
  writeWorkspaceState(root, { [WEB_STATE_KEY]: record });
}

/** Merges `patch` into the record only while `owner` still holds it; false when another supervisor does. */
export function updateWebRecord(root: string, owner: ProcessRecord, patch: Partial<WebRecord>): boolean {
  let updated = false;
  updateWorkspaceState(root, (state) => {
    const current = parseWebRecord(state[WEB_STATE_KEY]);
    if (!current || !sameProcessRecord(current, owner)) return state;
    updated = true;
    return { ...state, [WEB_STATE_KEY]: { ...current, ...patch } };
  });
  return updated;
}

export function clearWebRecord(root: string, owner: ProcessRecord): boolean {
  return clearWorkspaceStateKey(root, WEB_STATE_KEY, (value) => {
    const current = parseWebRecord(value);
    return !current || sameProcessRecord(current, owner);
  });
}

export function cdpEndpoint(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** The workspace's browser record and whether its supervisor and Chrome are verified live. */
export interface WebFacts {
  record: WebRecord;
  status: 'running' | 'orphaned' | 'stopped' | 'unverified';
}

export function webFacts(record: WebRecord | null): WebFacts | null {
  if (!record) return null;
  const supervisor = inspectProcessIdentity(record);
  const chrome = record.chromeProcess ? chromeProcessState(record.chromeProcess) : 'gone';
  if (supervisor === 'unknown' || chrome === 'unknown') return { record, status: 'unverified' };
  if (chrome === 'gone') return { record, status: 'stopped' };
  return { record, status: supervisor === 'same' && chrome === 'running' ? 'running' : 'orphaned' };
}

const PAGE_FAILURES = new Set(['web_document_failed', 'web_page_crashed']);
const NAVIGATION = Buffer.from('"event":"web_navigation"');
const PAGE_EVENT = '"event":"web_';

/**
 * The latest page load in the web log's `lines`: the newest `web_navigation` marker, and whether a document
 * failure, a crash or the load event followed it. Null before the first navigation.
 */
export function latestPageLoad(lines: readonly string[]): WebPageState | null {
  let failure: string | null = null;
  let loaded = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    let record: { event?: unknown; msg?: unknown; url?: unknown };
    try {
      record = JSON.parse(lines[i]!) as typeof record;
    } catch {
      continue;
    }
    if (record.event === 'web_navigation' && typeof record.url === 'string') {
      if (failure !== null) return { url: record.url, state: 'failed', error: failure };
      return { url: record.url, state: loaded ? 'loaded' : 'loading' };
    }
    if (typeof record.event !== 'string') continue;
    if (PAGE_FAILURES.has(record.event)) failure = typeof record.msg === 'string' ? record.msg : record.event;
    else if (record.event === 'web_page_loaded') loaded = true;
  }
  return null;
}

/** The page lines from the newest navigation on, in the web log or, right after a rotation, its previous file. */
function pageLines(file: string): string[] | null {
  for (const path of [file, rotatedLogPath(file)]) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      continue;
    }
    const at = bytes.lastIndexOf(NAVIGATION);
    if (at < 0) continue;
    const start = bytes.lastIndexOf(0x0a, at) + 1;
    return bytes
      .subarray(start)
      .toString('utf8')
      .split('\n')
      .filter((line) => line.includes(PAGE_EVENT));
  }
  return null;
}

export function readWebPage(root: string): WebPageState | null {
  const lines = pageLines(webLogFile(root));
  return lines ? latestPageLoad(lines) : null;
}
