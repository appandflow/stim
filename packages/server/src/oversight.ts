/**
 * The notification rules for a human who oversees agents. apps/mobile/src/lib/oversight.ts holds the same code;
 * packages/server/__tests__/oversight-agreement.test.ts fails when the two differ. Stim Desktop's Swift port,
 * apps/desktop/Sources/StimKit/Oversight.swift, replays the runs packages/server/__tests__/oversight.test.ts records;
 * after changing a rule, regenerate them with `pnpm test packages/server/__tests__/oversight.test.ts -u`.
 */

/** What a notification is about; each can be switched off on its own. */
export const OVERSIGHT_CATEGORIES = ['started', 'stuck', 'looping', 'finished', 'machine', 'control'] as const;

export type OversightCategory = (typeof OVERSIGHT_CATEGORIES)[number];

export const DEFAULT_STUCK_MINUTES = 15;

interface Activity {
  state: string;
  driver?: { tool: string; since: string | null };
  lastActivityAt?: string;
  recent?: Partial<Record<string, string>>;
}

/**
 * What counts as someone working on a device: agent actions, reloads and Stim runs. App log records do not, because an
 * idle app keeps logging; a new log error counts through the error count instead. The owned Chrome page records only
 * an agent's input as agent actions, not its navigations or scripts, so its page log counts while an agent drives it.
 */
const WORK_EVIDENCE = ['agent-action', 'metro-bundle', 'workspace-use'];

interface Device {
  name?: string | null;
  state?: string;
  physical?: boolean;
  activity?: Activity;
}

interface Build {
  platform: 'ios' | 'android';
  status: 'ok' | 'failed';
  result?: string;
  startedAt: string;
  finishedAt: string | null;
  errorCode?: string;
  diagnostics?: { file: string | null; line: number | null }[];
}

/** The part of a `stim status --json` environment the rules read. */
export interface OversightEnvironment {
  path: string;
  live: boolean;
  phase?: string;
  ios?: Device | null;
  android?: Device | null;
  slots?: { slot: string; ios?: Device | null; android?: Device | null }[];
  worktree?: {
    path: string;
    branch?: string;
    repository?: string;
    git?: { mergedInto: string | null } | null;
  } | null;
  build?: { state: string; startedAt: string } | null;
  lastBuilds?: { ios?: Build; android?: Build };
  builds?: { ios?: Build[]; android?: Build[] };
  logs?: { errorsSinceMarker: number } | null;
  web?: { running: boolean; activity?: Activity } | null;
}

export interface OversightStatus {
  environments: OversightEnvironment[];
  unprovisionedWorktrees?: { path: string; repository?: string }[];
}

/** A workspace's pull request, from GitHub. */
export interface OversightPullRequest {
  number: number;
  state: 'open' | 'merged' | 'closed';
  draft: boolean;
  url: string;
}

export interface OversightInput {
  machine: string;
  /** Null when the machine's status is not current, so its workspaces are left as they were. */
  status: OversightStatus | null;
  volumes: { freeBytes: number }[] | null;
  memoryPressure: 'normal' | 'warning' | 'critical' | null;
  /** The phone's connection to the machine; null where it is not known, as on the machine itself. */
  link: 'open' | 'offline' | 'refused' | 'unpaired' | null;
  /** Each workspace's pull request by path, null when it has none; a missing path was not looked up. */
  pullRequests: Record<string, OversightPullRequest | null>;
  /** `grantedAt` of the device leases stim-server holds for phones, so a person controlling a device is no agent. */
  ownLeases: readonly string[];
}

export interface OversightPrefs {
  categories: readonly OversightCategory[];
  stuckMinutes: number;
  /** Whether it is quiet hours now: nothing notifies, and what still holds afterwards notifies then. */
  quiet: boolean;
}

export type OversightTarget =
  | { kind: 'machine' }
  | { kind: 'workspace'; path: string }
  | { kind: 'device'; path: string; platform: 'ios' | 'android' | 'web'; slot: string }
  | { kind: 'build'; path: string; platform: 'ios' | 'android' }
  | { kind: 'url'; path: string; url: string };

export interface OversightNotification {
  /** Stable for the workspace or machine and category, so a later notification replaces the earlier one. */
  id: string;
  category: OversightCategory;
  title: string;
  body: string;
  /** Delivered without sound or banner interruption. */
  quiet: boolean;
  /** Groups notifications in the notification list; null leaves them ungrouped. */
  thread: string | null;
  target: OversightTarget;
}

interface Loop {
  signature: string;
  notified: boolean;
}

interface WorkspaceEntry {
  seenAt: number;
  warmed: boolean;
  drove: boolean;
  drivenAt: number | null;
  driveNotified: boolean;
  errors: number;
  errorsAt: number | null;
  stuckAt: number | null;
  finished: boolean;
  loops: { ios?: Loop; android?: Loop };
  pr: { number: number; ready: boolean; merged: boolean } | null | undefined;
  mergedInto: string | null;
  mergeNotified: boolean;
}

interface Held {
  since: number;
  notified: boolean;
}

export interface OversightState {
  workspaces: Record<string, WorkspaceEntry>;
  disk?: Held;
  memory?: Held;
  /** Whether memory pressure was ever read, so the first reading records what is true without notifying. */
  memoryKnown?: boolean;
  link?: Held & { kind: string };
}

export interface OversightResult {
  state: OversightState;
  notifications: OversightNotification[];
  /** When a timed rule may become due while nothing else changes. */
  wakeAt: number | null;
}

const LOW_DISK_BYTES = 20e9;
const DISK_CRITICAL_BYTES = LOW_DISK_BYTES / 4;
/** Free space a low-disk episode needs back before it ends, so space hovering at the floor notifies once. */
const DISK_RECOVERED_BYTES = DISK_CRITICAL_BYTES + 1e9;
const MEMORY_SETTLE_MS = 60_000;
const OFFLINE_SETTLE_MS = 60_000;
/** How long an agent must be gone, with nothing happening, before its green work counts as finished. */
const FINISH_SETTLE_MS = 5 * 60_000;
const LOOP_COUNT = 3;
/** A workspace absent this long is forgotten; a shorter gap is a status that briefly left it out. */
const FORGET_MS = 2 * 60_000;

const platformName = (platform: string) => (platform === 'ios' ? 'iOS' : 'Android');
const basename = (path: string) => path.split('/').findLast(Boolean) ?? path;
const time = (text: string | null | undefined) => (text ? Date.parse(text) : Number.NaN);

function worktreeRoot(path: string): string | null {
  const parts = path.split('/');
  for (let i = parts.length - 2; i > 0; i--) {
    if (parts[i] === '.worktrees') return parts.slice(0, i).join('/');
    if (parts[i] === 'worktrees' && parts[i - 1] === '.claude') return parts.slice(0, i - 1).join('/');
  }
  return null;
}

function markedCheckout(path: string): string | null {
  const parts = path.split('/');
  for (let i = parts.length - 2; i > 0; i--) {
    if (parts[i] === '.worktrees' || (parts[i] === 'worktrees' && parts[i - 1] === '.claude')) {
      return parts.slice(0, i + 2).join('/');
    }
  }
  return null;
}

/** The name home shows for a workspace: its branch, else its checkout's folder. */
export function oversightTitle(env: OversightEnvironment, status: OversightStatus): string {
  if (env.worktree?.branch) return env.worktree.branch;
  const checkout = env.worktree?.path ?? markedCheckout(env.path);
  if (checkout) return basename(checkout);
  const roots = new Set<string>();
  for (const { path, worktree } of status.environments) roots.add(worktreeRoot(path) ?? worktree?.repository ?? path);
  for (const { path, repository } of status.unprovisionedWorktrees ?? []) {
    const root = worktreeRoot(path) ?? repository;
    if (root) roots.add(root);
  }
  const own = worktreeRoot(env.path) ?? env.worktree?.repository;
  const root =
    own ??
    [...roots]
      .filter((r) => env.path === r || env.path.startsWith(`${r}/`))
      .reduce<string | null>((best, r) => (best === null || r.length < best.length ? r : best), null) ??
    env.path;
  return basename(root);
}

type Platform = 'ios' | 'android' | 'web';

interface SlotDevice {
  platform: Platform;
  slot: string;
  model: string;
  running: boolean;
  activity: Activity | undefined;
}

function devicesOf(env: OversightEnvironment): SlotDevice[] {
  const out: SlotDevice[] = [];
  const add = (slot: string, ios?: Device | null, android?: Device | null) => {
    if (ios) {
      out.push({
        platform: 'ios',
        slot,
        model: /\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*$/.exec(ios.name ?? '')?.[1] ?? 'iOS Simulator',
        running: ios.state === 'Booted',
        activity: ios.activity,
      });
    }
    if (android) {
      out.push({
        platform: 'android',
        slot,
        model: android.physical ? 'Android device' : 'Android Emulator',
        running: android.state === 'detected',
        activity: android.activity,
      });
    }
  };
  add('default', env.ios, env.android);
  for (const slot of env.slots ?? []) add(slot.slot, slot.ios, slot.android);
  if (env.web) {
    out.push({
      platform: 'web',
      slot: 'default',
      model: 'Chrome',
      running: env.web.running,
      activity: env.web.activity,
    });
  }
  return out;
}

function agentDriven(device: SlotDevice, ownLeases: readonly string[]): boolean {
  const activity = device.activity;
  if (activity?.state !== 'driven') return false;
  const since = activity.driver?.since;
  return !(activity.driver?.tool === 'stim device lock' && since && ownLeases.includes(since));
}

function newestBuild(env: OversightEnvironment): Build | null {
  const builds = [env.lastBuilds?.ios, env.lastBuilds?.android].filter((b): b is Build => b !== undefined);
  return builds.reduce<Build | null>((a, b) => (a === null || time(b.startedAt) > time(a.startedAt) ? b : a), null);
}

function lastActivityAt(env: OversightEnvironment, devices: SlotDevice[], seen: (number | null)[]): number | null {
  const times = seen.map((at) => at ?? Number.NaN);
  for (const device of devices) {
    const recent = device.activity?.recent;
    if (!recent) times.push(time(device.activity?.lastActivityAt));
    else {
      times.push(...WORK_EVIDENCE.map((basis) => time(recent[basis])));
      if (device.platform === 'web' && device.activity?.state === 'driven') times.push(time(recent['page-log']));
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

const failed = (build: Build) => (build.result ?? build.status) === 'failed';

function causeOf(build: Build): { key: string; at: { file: string | null; line: number | null } | null } {
  const at = build.diagnostics?.find((d) => d.file && d.line !== null);
  if (at) return { key: `${at.file}:${at.line}`, at };
  return { key: build.errorCode ?? 'failed', at: null };
}

/** The streak of failures at the head of a platform's history that share the newest one's cause. */
function failureStreak(
  platform: 'ios' | 'android',
  history: Build[] | undefined,
): {
  signature: string;
  count: number;
  body: (count: number) => string;
} | null {
  const head = history?.[0];
  if (!head || !failed(head)) return null;
  const cause = causeOf(head);
  let count = 0;
  for (const build of history) {
    if (!failed(build) || causeOf(build).key !== cause.key) break;
    count++;
  }
  const name = platformName(platform);
  const body = (n: number) => {
    if (cause.at) {
      const file = basename(cause.at.file!);
      const language = LANGUAGES[file.split('.').at(-1)?.toLowerCase() ?? ''];
      return `Same ${language ? `${language} ` : `${name} build `}error ${n}x at ${file}:${cause.at.line}`;
    }
    if (head.errorCode === 'STIM_LAUNCH_FAILED') return `App failed to launch on ${name} ${n}x in a row`;
    const code = head.errorCode ? ` (${head.errorCode})` : '';
    return `${name} build failed ${n}x in a row${code}`;
  };
  return { signature: cause.key, count, body };
}

function heldFor(held: Held | undefined, now: number): Held {
  return held ?? { since: now, notified: false };
}

interface Run {
  input: OversightInput;
  prefs: OversightPrefs;
  now: number;
  /** The first look, which records what is true without notifying. */
  baseline: boolean;
  notifications: OversightNotification[];
  wakeAt: number | null;
}

function wake(run: Run, at: number): void {
  if (at > run.now) run.wakeAt = run.wakeAt === null ? at : Math.min(run.wakeAt, at);
}

/** Notifies an event now; one missed for quiet hours or a switched-off category is dropped. */
function event(run: Run, notification: OversightNotification): void {
  if (!run.baseline && !run.prefs.quiet && run.prefs.categories.includes(notification.category)) {
    run.notifications.push(notification);
  }
}

/** Whether a lasting problem is settled: notified now, or dropped when its category is off. */
function lasting(run: Run, notification: OversightNotification): boolean {
  if (run.baseline || !run.prefs.categories.includes(notification.category)) return true;
  if (run.prefs.quiet) return false;
  run.notifications.push(notification);
  return true;
}

function machineNotification(run: Run, id: string, body: string): OversightNotification {
  return {
    id: `machine:${id}`,
    category: 'machine',
    title: run.input.machine,
    body,
    quiet: false,
    thread: null,
    target: { kind: 'machine' },
  };
}

const LINK_BODY = {
  offline: 'Offline',
  unpaired: 'Not paired: pair again',
  refused: 'Refused the connection: pair again or update',
} as const;

function overseeMachine(run: Run, previous: OversightState | null, state: OversightState, awakeSince: number): void {
  const { input, now } = run;
  const kind = input.link;
  if (kind !== null && kind !== 'open') {
    const held = { ...heldFor(previous?.link?.kind === kind ? previous.link : undefined, now), kind };
    const due = Math.max(held.since, awakeSince) + (kind === 'offline' ? OFFLINE_SETTLE_MS : 0);
    if (!held.notified && now < due) wake(run, due);
    else if (!held.notified) held.notified = lasting(run, machineNotification(run, 'link', LINK_BODY[kind]));
    state.link = held;
  }

  const lowest = input.volumes?.reduce<number | null>(
    (min, v) => (min === null ? v.freeBytes : Math.min(min, v.freeBytes)),
    null,
  );
  if (input.volumes === null) {
    if (previous?.disk) state.disk = previous.disk;
  } else if (
    lowest !== null &&
    lowest !== undefined &&
    lowest < (previous?.disk ? DISK_RECOVERED_BYTES : DISK_CRITICAL_BYTES)
  ) {
    const held = { ...heldFor(previous?.disk, now) };
    const body = `${formatBytes(lowest)} free, below Stim's floor`;
    if (!held.notified) held.notified = lasting(run, machineNotification(run, 'disk', body));
    state.disk = held;
  }

  state.memoryKnown = input.memoryPressure !== null || previous?.memoryKnown === true;
  if (input.memoryPressure === 'critical') {
    const held = { ...heldFor(previous?.memory, now) };
    if (!previous?.memoryKnown) held.notified = true;
    const due = held.since + MEMORY_SETTLE_MS;
    if (!held.notified && now < due && !run.baseline) wake(run, due);
    else if (!held.notified)
      held.notified = lasting(run, machineNotification(run, 'memory', 'Memory pressure is critical'));
    state.memory = held;
  } else if (input.memoryPressure === null && previous?.memory) state.memory = previous.memory;
}

type Notify = (
  category: OversightCategory,
  body: string,
  target: OversightTarget,
  id?: string,
) => OversightNotification;

interface WorkspaceLook {
  env: OversightEnvironment;
  entry: WorkspaceEntry;
  notify: Notify;
  devices: SlotDevice[];
  driven: SlotDevice[];
}

function deviceTarget(env: OversightEnvironment, device: SlotDevice): OversightTarget {
  return { kind: 'device', path: env.path, platform: device.platform, slot: device.slot };
}

function overseeStart(run: Run, { env, entry, notify, driven }: WorkspaceLook): void {
  if (env.phase === 'warming' && !entry.warmed) {
    entry.warmed = true;
    event(run, notify('started', `Warming on ${run.input.machine}`, { kind: 'workspace', path: env.path }));
  }
  const first = driven[0];
  if (!first) return;
  entry.drove = true;
  entry.drivenAt = run.now;
  entry.finished = false;
  if (entry.driveNotified) return;
  entry.driveNotified = true;
  const tool = first.activity?.driver?.tool ?? 'An agent';
  const body = `${tool} started driving ${first.model} on ${run.input.machine}`;
  event(run, notify('started', body, deviceTarget(env, first)));
}

/** Work finishes when the agent stops after a green build; it looks stuck when nothing happens for too long. */
function overseeProgress(run: Run, { env, entry, notify, devices, driven }: WorkspaceLook): void {
  const { now } = run;
  const idle = !env.live && (env.phase === undefined || env.phase === 'idle');
  const building = env.build?.state === 'running';
  const newest = newestBuild(env);
  const green = newest?.status === 'ok';
  const releasedGreen = driven.length === 0 && green;
  const quietSince = lastActivityAt(env, devices, [entry.errorsAt, driven.length ? null : entry.drivenAt]);
  if (entry.stuckAt !== null && quietSince !== null && quietSince > entry.stuckAt) entry.stuckAt = null;

  if (entry.drove && releasedGreen && newest && !building && quietSince !== null && !entry.finished) {
    const due = quietSince + FINISH_SETTLE_MS;
    if (!idle && now < due) wake(run, due);
    else {
      entry.finished = true;
      const body = `Agent stopped after a green ${platformName(newest.platform)} build`;
      event(run, notify('finished', body, { kind: 'workspace', path: env.path }));
    }
  }
  if (idle || entry.finished) {
    entry.drove = false;
    entry.driveNotified = false;
  }
  if (idle) {
    entry.warmed = false;
    entry.finished = false;
  }

  const device = driven[0] ?? devices.find((d) => d.running);
  if (!entry.drove || !device?.running || building || quietSince === null || releasedGreen) return;
  if (entry.stuckAt !== null) return;
  const due = quietSince + run.prefs.stuckMinutes * 60_000;
  if (now < due) return wake(run, due);
  const minutes = Math.floor((now - quietSince) / 60_000);
  const after = green && newest ? ` after a green ${platformName(newest.platform)} build` : '';
  const body = `No agent activity for ${minutes} min${after}; ${device.model} still up`;
  if (lasting(run, notify('stuck', body, deviceTarget(env, device)))) entry.stuckAt = quietSince;
}

function overseeLoops(run: Run, { env, entry, notify }: WorkspaceLook, prev: WorkspaceEntry | undefined): void {
  for (const platform of ['ios', 'android'] as const) {
    const streak = failureStreak(platform, env.builds?.[platform]);
    if (!streak) continue;
    const before = prev?.loops[platform];
    const loop: Loop =
      before && before.signature === streak.signature && streak.count >= LOOP_COUNT
        ? { ...before }
        : { signature: streak.signature, notified: false };
    if (streak.count >= LOOP_COUNT && !loop.notified) {
      const target: OversightTarget = { kind: 'build', path: env.path, platform };
      loop.notified = lasting(run, notify('looping', streak.body(streak.count), target, `looping-${platform}`));
    }
    entry.loops[platform] = loop;
  }
}

/** A pull request that became ready for review or merged, or, without GitHub, a branch git finds merged. */
function overseeMerge(run: Run, { env, entry, notify }: WorkspaceLook, prev: WorkspaceEntry | undefined): void {
  const pr = run.input.pullRequests[env.path];
  if (pr !== undefined) {
    const known = entry.pr;
    const current = pr && { number: pr.number, ready: pr.state === 'open' && !pr.draft, merged: pr.state === 'merged' };
    if (pr && current && known !== undefined) {
      const url: OversightTarget = { kind: 'url', path: env.path, url: pr.url };
      const same = known?.number === pr.number;
      if (current.ready && !(same && known.ready)) {
        event(run, notify('finished', `PR #${pr.number} is ready for review`, url));
      }
      if (current.merged && !(same && known.merged) && !entry.mergeNotified) {
        entry.mergeNotified = true;
        event(run, notify('finished', `PR #${pr.number} merged`, url));
      }
    } else if (current?.merged) entry.mergeNotified = true;
    entry.pr = current;
  }
  if (!prev) {
    if (entry.mergedInto !== null) entry.mergeNotified = true;
  } else if (entry.mergedInto === null) {
    if (env.worktree?.git && !entry.pr?.merged) entry.mergeNotified = false;
  } else if (prev.mergedInto === null && !entry.mergeNotified) {
    entry.mergeNotified = true;
    event(run, notify('finished', `Merged into ${entry.mergedInto}`, { kind: 'workspace', path: env.path }));
  }
}

function overseeWorkspace(
  run: Run,
  env: OversightEnvironment,
  status: OversightStatus,
  prev: WorkspaceEntry | undefined,
): WorkspaceEntry {
  const errors = env.logs?.errorsSinceMarker ?? 0;
  const git = env.worktree?.git;
  const entry: WorkspaceEntry = {
    seenAt: run.now,
    warmed: prev?.warmed ?? false,
    drove: prev?.drove ?? false,
    drivenAt: prev?.drivenAt ?? null,
    driveNotified: prev?.driveNotified ?? false,
    errors,
    errorsAt: prev && prev.errors !== errors ? run.now : (prev?.errorsAt ?? null),
    stuckAt: prev?.stuckAt ?? null,
    finished: prev?.finished ?? false,
    loops: {},
    pr: prev?.pr,
    mergedInto: git ? git.mergedInto : (prev?.mergedInto ?? null),
    mergeNotified: prev?.mergeNotified ?? false,
  };
  const title = oversightTitle(env, status);
  const notify: Notify = (category, body, target, id = category) => ({
    id: `${id}:${env.path}`,
    category,
    title,
    body,
    quiet: category === 'started',
    thread: category === 'started' ? `started:${run.input.machine}` : null,
    target,
  });
  const devices = devicesOf(env);
  const driven = devices.filter((device) => agentDriven(device, run.input.ownLeases));
  const look = { env, entry, notify, devices, driven };
  overseeStart(run, look);
  overseeProgress(run, look);
  overseeLoops(run, look, prev);
  overseeMerge(run, look, prev);
  return entry;
}

/**
 * The notifications a machine owes since `previous`, the state the last call returned. Null `previous` records
 * what is already true without notifying, so a restart or a new registration stays quiet. Each workspace and
 * machine problem notifies once per episode, under one id per category, so a later episode replaces it.
 * `awakeSince` restarts the offline settle time, for a checker that was not running.
 */
export function oversee(
  previous: OversightState | null,
  input: OversightInput,
  prefs: OversightPrefs,
  now: number,
  awakeSince = 0,
): OversightResult {
  const run: Run = { input, prefs, now, baseline: previous === null, notifications: [], wakeAt: null };
  const state: OversightState = { workspaces: {} };
  overseeMachine(run, previous, state, awakeSince);
  const status = input.status;
  if (status === null) state.workspaces = { ...previous?.workspaces };
  else {
    for (const env of status.environments) {
      state.workspaces[env.path] = overseeWorkspace(run, env, status, previous?.workspaces[env.path]);
    }
    for (const [path, entry] of Object.entries(previous?.workspaces ?? {})) {
      if (!(path in state.workspaces) && now - entry.seenAt < FORGET_MS) state.workspaces[path] = entry;
    }
  }
  return { state, notifications: run.notifications, wakeAt: run.wakeAt };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  const gb = bytes / 1e9;
  return gb >= 100 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

/** Whether `minuteOfDay` falls in quiet hours from `start` to `end`, minutes after midnight; they may span midnight. */
export function inQuietHours(quietHours: { start: number; end: number } | null, minuteOfDay: number): boolean {
  if (!quietHours || quietHours.start === quietHours.end) return false;
  const { start, end } = quietHours;
  return start < end ? minuteOfDay >= start && minuteOfDay < end : minuteOfDay >= start || minuteOfDay < end;
}
