import type { DeviceActivity, EnvironmentState, LastBuild } from '@/protocol/types';

/**
 * What only a person can act on or decide, from one Mac's status. apps/desktop/Sources/StimKit/NeedsAttention.swift
 * holds the same rule; both replay apps/desktop/Tests/StimKitTests/Fixtures/needs-attention-vectors.json.
 */
export interface NeedsAttentionItem {
  /** Stable while the problem lasts; `stuck`, `looping` and `machine` items use the oversight notification ids. */
  id: string;
  /** The oversight notification category that covers the item; `attention` is for the rest. */
  category: 'attention' | 'stuck' | 'looping' | 'machine';
  severity: 'error' | 'warning';
  /** The workspace path; null for the machine. */
  workspace: string | null;
  body: string;
  /** A `stim` command to run from `workspace`, or null when the fix is outside Stim. */
  remedy: string | null;
}

export interface NeedsAttentionInput {
  environments: EnvironmentState[];
  /** Each volume Stim uses; null when not measured. */
  volumes: { freeBytes: number }[] | null;
  now: number;
  stuckMinutes: number;
  easSessionMinutes: number;
}

const PERSON_ISSUES = new Set(['port-not-ours', 'supervisor-unverified', 'browser-unverified', 'avd-unchecked']);

const SIGNING_CODES = new Set([
  'STIM_NO_SIGNING_IDENTITY',
  'STIM_CODESIGN_FAILED',
  'STIM_NO_PROFILE',
  'STIM_PROFILE_MISMATCH',
]);

const DISK_FLOOR_BYTES = 5e9;
const LOOP_COUNT = 3;
const STALE_MS = 24 * 60 * 60 * 1000;
const WORK_EVIDENCE = ['agent-action', 'metro-bundle', 'workspace-use'];

const LANGUAGES: Record<string, string> = {
  swift: 'Swift',
  m: 'Objective-C',
  mm: 'Objective-C++',
  kt: 'Kotlin',
  java: 'Java',
  c: 'C',
  cc: 'C++',
  cpp: 'C++',
  h: 'C',
  hpp: 'C++',
  js: 'JavaScript',
  ts: 'TypeScript',
  tsx: 'TypeScript',
  gradle: 'Gradle',
  kts: 'Gradle',
};

const platformName = (platform: string) => (platform === 'ios' ? 'iOS' : 'Android');
const basename = (path: string) => path.split('/').findLast(Boolean) ?? path;
const time = (text: string | null | undefined) => (text ? Date.parse(text) : Number.NaN);

function formatBytes(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  const gb = bytes / 1e9;
  return gb >= 100 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

function signingItem(
  env: EnvironmentState,
  platform: 'ios' | 'android',
  build: LastBuild,
  now: number,
): NeedsAttentionItem | null {
  const code = build.errorCode ?? '';
  if (!SIGNING_CODES.has(code)) return null;
  if (!env.live && !(now - time(build.finishedAt ?? build.startedAt) < STALE_MS)) return null;
  return {
    id: `run-${platform}:${env.path}`,
    category: 'attention',
    severity: 'error',
    workspace: env.path,
    body: `${platformName(platform)} signing or provisioning failed (${code})`,
    remedy: null,
  };
}

function loopItem(env: EnvironmentState, platform: 'ios' | 'android', now: number): NeedsAttentionItem | null {
  const history = env.builds?.[platform];
  const failed = (build: { result?: string; status: string }) => (build.result ?? build.status) === 'failed';
  const head = history?.[0];
  if (!history || !head || !failed(head)) return null;
  if (!env.live && !(now - time(head.finishedAt ?? head.startedAt) < STALE_MS)) return null;
  const causeOf = (build: LastBuild) => {
    const at = build.diagnostics?.find((d) => d.file && d.line !== null && d.line !== undefined);
    return at ? { key: `${at.file}:${at.line}`, at } : { key: build.errorCode ?? 'failed', at: null };
  };
  const cause = causeOf(head);
  let count = 0;
  for (const build of history) {
    if (!failed(build) || causeOf(build).key !== cause.key) break;
    count++;
  }
  if (count < LOOP_COUNT) return null;
  const name = platformName(platform);
  let body: string;
  if (cause.at) {
    const file = basename(cause.at.file!);
    const language = LANGUAGES[file.split('.').at(-1)?.toLowerCase() ?? ''];
    body = `Same ${language ? `${language} ` : `${name} build `}error ${count}x at ${file}:${cause.at.line}`;
  } else if (head.errorCode === 'STIM_LAUNCH_FAILED') body = `App failed to launch on ${name} ${count}x in a row`;
  else body = `${name} build failed ${count}x in a row${head.errorCode ? ` (${head.errorCode})` : ''}`;
  return {
    id: `looping-${platform}:${env.path}`,
    category: 'looping',
    severity: 'error',
    workspace: env.path,
    body,
    remedy: null,
  };
}

interface Device {
  model: string;
  running: boolean;
  activity: (DeviceActivity & { recent?: Partial<Record<string, string>> }) | undefined;
  web: boolean;
}

function devicesOf(env: EnvironmentState): Device[] {
  const out: Device[] = [];
  const add = (ios?: EnvironmentState['ios'], android?: EnvironmentState['android']) => {
    if (ios) {
      const model = /\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*$/.exec(ios.name ?? '')?.[1] ?? 'iOS Simulator';
      out.push({ model, running: ios.state === 'Booted', activity: ios.activity, web: false });
    }
    if (android) {
      const model = android.physical ? 'Android device' : 'Android Emulator';
      out.push({ model, running: android.state === 'detected', activity: android.activity, web: false });
    }
  };
  add(env.ios, env.android);
  for (const slot of env.slots ?? []) add(slot.ios, slot.android);
  if (env.web) out.push({ model: 'Chrome', running: env.web.running, activity: env.web.activity, web: true });
  return out;
}

function quietSince(env: EnvironmentState, devices: Device[]): number | null {
  const times: number[] = [];
  for (const device of devices) {
    const recent = device.activity?.recent;
    if (!recent) times.push(time(device.activity?.lastActivityAt));
    else {
      times.push(...WORK_EVIDENCE.map((basis) => time(recent[basis])));
      if (device.web && device.activity?.state === 'driven') times.push(time(recent['page-log']));
    }
    times.push(time(device.activity?.driver?.since));
  }
  for (const build of [env.lastBuilds?.ios, env.lastBuilds?.android]) {
    times.push(time(build?.startedAt), time(build?.finishedAt));
  }
  times.push(time(env.build?.startedAt));
  const finite = times.filter(Number.isFinite);
  return finite.length ? Math.max(...finite) : null;
}

function stuckItem(env: EnvironmentState, input: NeedsAttentionInput): NeedsAttentionItem | null {
  const devices = devicesOf(env);
  const driven = devices.find((d) => d.running && d.activity?.state === 'driven');
  if (!driven || env.build?.state === 'running') return null;
  const since = quietSince(env, devices);
  if (since === null || input.now - since < input.stuckMinutes * 60_000) return null;
  const minutes = Math.floor((input.now - since) / 60_000);
  const newest = [env.lastBuilds?.ios, env.lastBuilds?.android]
    .filter((b): b is LastBuild => b !== undefined)
    .reduce<LastBuild | null>((a, b) => (a === null || time(b.startedAt) > time(a.startedAt) ? b : a), null);
  const after = newest?.status === 'ok' ? ` after a green ${platformName(newest.platform)} build` : '';
  return {
    id: `stuck:${env.path}`,
    category: 'stuck',
    severity: 'warning',
    workspace: env.path,
    body: `No agent activity for ${minutes} min${after}; ${driven.model} still up`,
    remedy: null,
  };
}

function workspaceItems(env: EnvironmentState, input: NeedsAttentionInput): NeedsAttentionItem[] {
  const items: NeedsAttentionItem[] = [];
  for (const issue of env.issues ?? []) {
    if (issue.severity === 'info' || !PERSON_ISSUES.has(issue.code)) continue;
    items.push({
      id: `issue-${issue.code}-${issue.slot ?? 'default'}:${env.path}`,
      category: 'attention',
      severity: issue.severity,
      workspace: env.path,
      body: issue.slot ? `${issue.slot}: ${issue.message}` : issue.message,
      remedy: issue.remedy,
    });
  }
  for (const platform of ['ios', 'android'] as const) {
    const last = env.lastBuilds?.[platform];
    const building = env.build?.state === 'running' && env.build.platform === platform;
    const signing = last && last.status === 'failed' && !building ? signingItem(env, platform, last, input.now) : null;
    const item = signing ?? loopItem(env, platform, input.now);
    if (item) items.push(item);
  }
  for (const device of env.physicalDevices ?? []) {
    if (!(time(device.lease.expiresAt) <= input.now)) continue;
    const slot = device.slot === 'default' ? '' : ` --slot ${device.slot}`;
    items.push({
      id: `lease-${device.platform}-${device.slot}:${env.path}`,
      category: 'attention',
      severity: 'warning',
      workspace: env.path,
      body: `Lease on ${device.name ?? device.model ?? device.id} expired`,
      remedy: `stim device unlock ${device.platform}${slot}`,
    });
  }
  const driven = devicesOf(env).some((d) => d.running && d.activity?.state === 'driven');
  for (const session of env.remoteDevices ?? []) {
    const started = time(session.startedAt);
    if (driven || !(input.now - started >= input.easSessionMinutes * 60_000)) continue;
    items.push({
      id: `eas-${session.sessionId}:${env.path}`,
      category: 'attention',
      severity: 'warning',
      workspace: env.path,
      body: `EAS session running for ${Math.floor((input.now - started) / 60_000)} min with no agent; billed while it runs`,
      remedy: 'stim stop',
    });
  }
  const stuck = stuckItem(env, input);
  if (stuck) items.push(stuck);
  return items;
}

/**
 * The items, errors first, then the machine's, then live workspaces' before idle ones', each in status order. Log
 * errors, a single failed run, and issues an agent's next `stim` command repairs are left out: agents handle them.
 */
export function needsAttention(input: NeedsAttentionInput): NeedsAttentionItem[] {
  const ranked: { item: NeedsAttentionItem; scope: number }[] = [];
  const lowest = input.volumes?.reduce<number | null>(
    (min, v) => (min === null ? v.freeBytes : Math.min(min, v.freeBytes)),
    null,
  );
  if (lowest !== null && lowest !== undefined && lowest < DISK_FLOOR_BYTES) {
    ranked.push({
      scope: 0,
      item: {
        id: 'machine:disk',
        category: 'machine',
        severity: 'error',
        workspace: null,
        body: `${formatBytes(lowest)} free, below Stim's floor`,
        remedy: null,
      },
    });
  }
  for (const env of input.environments) {
    for (const item of workspaceItems(env, input)) ranked.push({ item, scope: env.live ? 1 : 2 });
  }
  const severity = (item: NeedsAttentionItem) => (item.severity === 'error' ? 0 : 1);
  return ranked
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => severity(a.item) - severity(b.item) || a.scope - b.scope || a.index - b.index)
    .map((entry) => entry.item);
}
