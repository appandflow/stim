import { t } from '@lingui/core/macro';

import { formatBytes } from '@/intl/format';
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
  /** `grantedAt` of the device leases stim-server holds for phones, so a person controlling a device is no agent. */
  ownLeases?: readonly string[];
}

const PERSON_ISSUES = new Set(['port-not-ours', 'supervisor-unverified', 'browser-unverified', 'avd-unchecked']);

const isSigningCode = (code: string) =>
  ['STIM_NO_SIGNING_IDENTITY', 'STIM_CODESIGN_FAILED', 'STIM_NO_PROFILE', 'STIM_PROFILE_MISMATCH'].includes(code);

const DISK_FLOOR_BYTES = 5e9;
const LOOP_COUNT = 3;
export const STALE_MS = 24 * 60 * 60 * 1000;
const WORK_EVIDENCE = ['agent-action', 'metro-bundle', 'workspace-use'];

function languageOf(extension: string): string | undefined {
  switch (extension) {
    case 'swift':
      return t`Swift`;
    case 'm':
      return t`Objective-C`;
    case 'mm':
      return t`Objective-C++`;
    case 'kt':
      return t`Kotlin`;
    case 'java':
      return t`Java`;
    case 'c':
    case 'h':
      return t`C`;
    case 'cc':
    case 'cpp':
    case 'hpp':
      return t`C++`;
    case 'js':
      return t`JavaScript`;
    case 'ts':
    case 'tsx':
      return t`TypeScript`;
    case 'gradle':
    case 'kts':
      return t`Gradle`;
    default:
      return undefined;
  }
}

const platformName = (platform: string) => (platform === 'ios' ? 'iOS' : t`Android`);
const basename = (path: string) => path.split('/').findLast(Boolean) ?? path;
const time = (text: string | null | undefined) => (text ? Date.parse(text) : Number.NaN);

function signingItem(
  env: EnvironmentState,
  platform: 'ios' | 'android',
  build: LastBuild,
  now: number,
): NeedsAttentionItem | null {
  const code = build.errorCode ?? '';
  if (!isSigningCode(code)) return null;
  if (!env.live && !(now - time(build.finishedAt ?? build.startedAt) < STALE_MS)) return null;
  const name = platformName(platform);
  return {
    id: `run-${platform}:${env.path}`,
    category: 'attention',
    severity: 'error',
    workspace: env.path,
    body: t`${name} signing or provisioning failed (${code})`,
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
    const language = languageOf(file.split('.').at(-1)?.toLowerCase() ?? '');
    const line = String(cause.at.line);
    body = language
      ? t`Same ${language} error ${count}x at ${file}:${line}`
      : t`Same ${name} build error ${count}x at ${file}:${line}`;
  } else if (head.errorCode === 'STIM_LAUNCH_FAILED') body = t`App failed to launch on ${name} ${count}x in a row`;
  else {
    const { errorCode } = head;
    body = errorCode
      ? t`${name} build failed ${count}x in a row (${errorCode})`
      : t`${name} build failed ${count}x in a row`;
  }
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
      const model = /\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*$/.exec(ios.name ?? '')?.[1] ?? t`iOS Simulator`;
      out.push({ model, running: ios.state === 'Booted', activity: ios.activity, web: false });
    }
    if (android) {
      const model = android.physical ? t`Android device` : t`Android Emulator`;
      out.push({ model, running: android.state === 'detected', activity: android.activity, web: false });
    }
  };
  add(env.ios, env.android);
  for (const slot of env.slots ?? []) add(slot.ios, slot.android);
  if (env.web) out.push({ model: t`Chrome`, running: env.web.running, activity: env.web.activity, web: true });
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

/** Whether an agent drives the device: a lease stim-server holds for a phone is a person controlling it. */
function agentDriven(device: Device, ownLeases: readonly string[]): boolean {
  const { activity } = device;
  if (activity?.state !== 'driven') return false;
  const since = activity.driver?.since;
  return !(activity.driver?.tool === 'stim device lock' && since && ownLeases.includes(since));
}

function stuckItem(env: EnvironmentState, input: NeedsAttentionInput): NeedsAttentionItem | null {
  const devices = devicesOf(env);
  const driven = devices.find((d) => d.running && agentDriven(d, input.ownLeases ?? []));
  if (!driven || env.build?.state === 'running') return null;
  const since = quietSince(env, devices);
  if (since === null || input.now - since < input.stuckMinutes * 60_000) return null;
  const minutes = Math.floor((input.now - since) / 60_000);
  const newest = [env.lastBuilds?.ios, env.lastBuilds?.android]
    .filter((b): b is LastBuild => b !== undefined)
    .reduce<LastBuild | null>((a, b) => (a === null || time(b.startedAt) > time(a.startedAt) ? b : a), null);
  const { model } = driven;
  const green = newest?.status === 'ok' ? platformName(newest.platform) : null;
  return {
    id: `stuck:${env.path}`,
    category: 'stuck',
    severity: 'warning',
    workspace: env.path,
    body: green
      ? t`No agent activity for ${minutes} min after a green ${green} build; ${model} still up`
      : t`No agent activity for ${minutes} min; ${model} still up`,
    remedy: null,
  };
}

function workspaceItems(env: EnvironmentState, input: NeedsAttentionInput): NeedsAttentionItem[] {
  const items: NeedsAttentionItem[] = [];
  for (const issue of env.issues ?? []) {
    if (issue.severity === 'info' || !PERSON_ISSUES.has(issue.code)) continue;
    const { slot, message } = issue;
    items.push({
      id: `issue-${issue.code}-${issue.slot ?? 'default'}:${env.path}`,
      category: 'attention',
      severity: issue.severity,
      workspace: env.path,
      body: slot ? t`${slot}: ${message}` : message,
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
    const leased = device.name ?? device.model ?? device.id;
    items.push({
      id: `lease-${device.platform}-${device.slot}:${env.path}`,
      category: 'attention',
      severity: 'warning',
      workspace: env.path,
      body: t`Lease on ${leased} expired`,
      remedy: `stim device unlock ${device.platform}${slot}`,
    });
  }
  const driven = devicesOf(env).some((d) => d.running && agentDriven(d, input.ownLeases ?? []));
  for (const session of env.remoteDevices ?? []) {
    const started = time(session.startedAt);
    if (driven || !(input.now - started >= input.easSessionMinutes * 60_000)) continue;
    const minutes = Math.floor((input.now - started) / 60_000);
    items.push({
      id: `eas-${session.sessionId}:${env.path}`,
      category: 'attention',
      severity: 'warning',
      workspace: env.path,
      body: t`EAS session running for ${minutes} min with no agent; billed while it runs`,
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
    const free = formatBytes(lowest);
    ranked.push({
      scope: 0,
      item: {
        id: 'machine:disk',
        category: 'machine',
        severity: 'error',
        workspace: null,
        body: t`${free} free, below Stim's floor`,
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
