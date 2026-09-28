import {
  closeSync,
  existsSync,
  futimesSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { configDir, workspaceStateDir } from '@stim-cli/core';
import {
  capDrops,
  closedSegmentName,
  footageDrops,
  listRecordedDevices,
  openSegmentName,
  RECORDING_CAP_BYTES,
  RECORDING_FOOTAGE_MS,
  RECORDING_PLATFORMS,
  recordingDeviceName,
  workspaceRecordingsDir,
  type DeviceActivity,
  type EnvironmentState,
  type RecordingPlatform,
  type StatusPayload,
} from '@stim-cli/core/state';
import { releaseClaim, tryAcquireClaim, type ClaimHandle } from '@stim-cli/core/ownership-claim';
import type { FeedListener } from './feed.ts';
import { serverDir } from './registry.ts';
import { deviceKey, ownedDevice, type Device, type FramePool } from './frames.ts';
import { VIDEO_FOLDED, VIDEO_KEYFRAME, VIDEO_UNFOLDED, type FrameTarget } from './protocol.ts';
import type { AccessUnit } from './video.ts';

const HEARTBEAT_MS = 2000;
/** How long a recording whose helper failed, or had no helper yet, waits before it starts again; doubled per failure. */
const RETRY_MS = 5000;
const MAX_RETRY_MS = 5 * 60_000;
const RESUBSCRIBE_MS = 5000;
/** A record's header after its u32 length: u8 flags, f64 capture time, u16 width, u16 height. */
const RECORD_HEADER_BYTES = 13;

export interface RecordLimits {
  footageMs: number;
  capBytes: number;
  /** A new segment starts at the first keyframe this long after the current one started. */
  segmentMs: number;
  pruneMs: number;
}

const DEFAULT_RECORD_LIMITS: RecordLimits = {
  footageMs: RECORDING_FOOTAGE_MS,
  capBytes: RECORDING_CAP_BYTES,
  segmentMs: 5000,
  pruneMs: 30_000,
};

/** One stored access unit: u32 length of the rest, then the header and the Annex-B bytes. */
function recordBytes(unit: AccessUnit): Buffer {
  const header = Buffer.alloc(4 + RECORD_HEADER_BYTES);
  header.writeUInt32BE(RECORD_HEADER_BYTES + unit.data.length, 0);
  const posture = unit.posture === 'folded' ? VIDEO_FOLDED : unit.posture === 'unfolded' ? VIDEO_UNFOLDED : 0;
  header.writeUInt8((unit.keyframe ? VIDEO_KEYFRAME : 0) | posture, 4);
  header.writeDoubleBE(unit.capturedAt, 5);
  header.writeUInt16BE(unit.width, 13);
  header.writeUInt16BE(unit.height, 15);
  return Buffer.concat([header, unit.data]);
}

interface Target extends FrameTarget {
  slot: string;
  platform: RecordingPlatform;
}

function targetKey(target: Pick<FrameTarget, 'workspace' | 'platform' | 'slot'>): string {
  return JSON.stringify([target.workspace, target.platform, target.slot ?? 'default']);
}

function isDriven(activity: DeviceActivity | undefined): boolean {
  return activity?.state === 'driven';
}

/** Each recordable device slot of an environment, and whether an automation tool drives it now. */
function environmentTargets(environment: EnvironmentState): { target: Target; driven: boolean }[] {
  const workspace = environment.path;
  const slots = [{ slot: 'default', ios: environment.ios, android: environment.android }, ...(environment.slots ?? [])];
  return [
    ...slots.flatMap(({ slot, ios, android }) => [
      { target: { workspace, platform: 'ios' as const, slot }, driven: isDriven(ios?.activity) },
      { target: { workspace, platform: 'android' as const, slot }, driven: isDriven(android?.activity) },
    ]),
    { target: { workspace, platform: 'web' as const, slot: 'default' }, driven: isDriven(environment.web?.activity) },
  ];
}

/**
 * Writes one device slot's footage as segments under the workspace's recordings directory. A segment is created
 * only while the workspace directory still has its `workspace.json`, so a directory that `worktree remove` or
 * `gc` emptied is never filled again; a write that fails ends the recording, and the next status starts it again.
 */
class DeviceRecording {
  readonly device: Device;
  /** When the recording stopped writing because its helper or a write failed; null while it works. */
  brokenAt: number | null = null;
  /** Whether a unit reached the disk. */
  wrote = false;
  /** The helper was not built yet, which is no failure of the device. */
  helperless = false;
  private readonly dir: string;
  private readonly workspaceDir: string;
  private readonly detach: () => void;
  private readonly segmentMs: number;
  private fd: number | null = null;
  private start = 0;
  private last = 0;
  private part = '';
  private readonly keyframe: () => void;

  constructor(device: Device, target: Target, frames: FramePool, segmentMs: number) {
    this.device = device;
    this.segmentMs = segmentMs;
    this.keyframe = () => frames.recordKeyframe(device);
    this.workspaceDir = workspaceStateDir(target.workspace);
    this.dir = join(workspaceRecordingsDir(target.workspace), recordingDeviceName(target.platform, target.slot));
    const detach = frames.record(device, {
      frame: () => {},
      delayed: () => {},
      record: (unit) => this.write(unit),
      failed: () => this.fail(),
    });
    if (!detach) {
      this.brokenAt = Date.now();
      this.helperless = true;
    }
    this.detach = detach ?? (() => {});
  }

  get openFile(): string | null {
    return this.fd === null ? null : this.part;
  }

  /** Asks for a keyframe once a segment is due to end, so a screen that does not change still gets segments. */
  heartbeat(now: number): void {
    if (this.fd === null) return;
    if (now - this.start >= this.segmentMs) this.keyframe();
    try {
      futimesSync(this.fd, now / 1000, now / 1000);
    } catch {
      this.fail();
    }
  }

  stop(): void {
    this.detach();
    this.finish(this.last);
  }

  private write(unit: AccessUnit): void {
    if (this.brokenAt !== null) return;
    try {
      if (this.fd !== null && unit.keyframe && unit.capturedAt - this.start >= this.segmentMs)
        this.finish(unit.capturedAt);
      if (this.fd === null) {
        if (!unit.keyframe || !existsSync(join(this.workspaceDir, 'workspace.json'))) return;
        makeDirs(this.dir);
        this.start = unit.capturedAt;
        this.part = join(this.dir, openSegmentName(this.start));
        this.fd = openSync(this.part, 'a', 0o600);
      }
      writeSync(this.fd, recordBytes(unit));
      this.wrote = true;
      this.last = Math.max(this.last, unit.capturedAt);
    } catch {
      this.fail();
    }
  }

  private finish(end: number): void {
    const fd = this.fd;
    if (fd === null) return;
    this.fd = null;
    try {
      closeSync(fd);
      renameSync(this.part, join(this.dir, closedSegmentName(this.start, Math.max(end, this.last, this.start))));
    } catch {
      this.brokenAt ??= Date.now();
    }
  }

  private fail(): void {
    this.brokenAt ??= Date.now();
    this.finish(this.last);
  }
}

function makeDirs(dir: string): void {
  for (const path of [join(dir, '..'), dir]) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

/**
 * Records owned simulators, emulators and the Stim-owned Chrome page while an automation tool drives them or a
 * client watches them, for the workspaces whose `recording.enabled` status is on. It keeps the last
 * {@link RecordLimits.footageMs} of footage per device and {@link RecordLimits.capBytes} across the Stim home, and
 * deletes a workspace's recordings once its status shows recording off.
 */
export class Recorder {
  private readonly frames: FramePool;
  private readonly subscribeStatus: (listener: FeedListener) => () => void;
  private readonly limits: RecordLimits;
  private readonly now: () => number;
  private readonly viewers = new Map<string, number>();
  private readonly sessions = new Map<string, DeviceRecording>();
  private unsubscribe: (() => void) | null = null;
  private resubscribe: NodeJS.Timeout | null = null;
  private payload: StatusPayload | null = null;
  private readonly timers: NodeJS.Timeout[];
  private readonly failures = new Map<string, number>();
  private claim: ClaimHandle | null = null;
  private claimWarned = false;
  private closed = false;

  constructor(options: {
    frames: FramePool;
    subscribeStatus: (listener: FeedListener) => () => void;
    limits?: Partial<RecordLimits>;
    now?: () => number;
  }) {
    this.frames = options.frames;
    this.subscribeStatus = options.subscribeStatus;
    this.limits = { ...DEFAULT_RECORD_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
    this.subscribe();
    this.timers = [
      setInterval(() => this.heartbeat(), Math.min(HEARTBEAT_MS, this.limits.segmentMs)),
      setInterval(() => this.prune(), this.limits.pruneMs),
    ];
    this.prune();
  }

  /**
   * One stim-server records and prunes a Stim home at a time, under an exclusive ownership claim; another one
   * serves replays but records nothing until the claim frees.
   */
  private owns(): boolean {
    if (this.claim) return true;
    let attempt;
    try {
      attempt = tryAcquireClaim({
        root: join(serverDir(), 'recorder'),
        mode: 'exclusive',
        label: 'stim-server recording',
      });
    } catch (error) {
      if (!this.claimWarned) console.error(`stim-server: not recording: ${(error as Error).message}`);
      this.claimWarned = true;
      return false;
    }
    if (attempt.acquired) {
      this.claim = attempt.acquired;
      return true;
    }
    if (attempt.pending) releaseClaim(attempt.pending);
    if (!this.claimWarned) {
      const holder = attempt.held?.owner.pid ?? attempt.waitingFor?.[0]?.owner.pid;
      console.error(`stim-server: another stim-server (pid ${holder ?? 'unknown'}) records this Stim home.`);
    }
    this.claimWarned = true;
    return false;
  }

  /** A client watches the device in `target`; recording lasts until the returned function runs. */
  viewing(target: Pick<FrameTarget, 'workspace' | 'platform' | 'slot'>): () => void {
    const key = targetKey(target);
    this.viewers.set(key, (this.viewers.get(key) ?? 0) + 1);
    this.evaluate();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.viewers.get(key) ?? 1) - 1;
      if (count > 0) this.viewers.set(key, count);
      else this.viewers.delete(key);
      this.evaluate();
    };
  }

  /** `recording.enabled` for `workspace` as the last status showed it; true before the first status. */
  enabled(workspace: string): boolean {
    const environment = this.payload?.environments?.find((candidate) => candidate.path === workspace);
    return environment?.recording?.enabled !== false;
  }

  /** Whether `target` is being recorded now. */
  recording(target: Pick<FrameTarget, 'workspace' | 'platform' | 'slot'>): boolean {
    const session = this.sessions.get(targetKey(target));
    return session !== undefined && session.brokenAt === null;
  }

  close(): void {
    this.closed = true;
    for (const timer of this.timers) clearInterval(timer);
    if (this.resubscribe) clearTimeout(this.resubscribe);
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const session of this.sessions.values()) session.stop();
    this.sessions.clear();
    releaseClaim(this.claim);
    this.claim = null;
  }

  private subscribe(): void {
    this.unsubscribe = this.subscribeStatus({
      item: (value) => {
        this.payload = value as unknown as StatusPayload;
        this.evaluate();
      },
      failed: () => {
        this.unsubscribe = null;
        this.resubscribe = setTimeout(() => {
          this.resubscribe = null;
          if (!this.closed) this.subscribe();
        }, RESUBSCRIBE_MS);
      },
    });
  }

  private evaluate(): void {
    const payload = this.payload;
    if (this.closed || !payload || !Array.isArray(payload.environments) || !this.owns()) return;
    const wanted = new Map<string, Device>();
    for (const environment of payload.environments) {
      if (environment.recording?.enabled === false) {
        this.forget(environment.path);
        continue;
      }
      for (const { target, driven } of environmentTargets(environment)) {
        const key = targetKey(target);
        if (!driven && !this.viewers.has(key)) continue;
        const current = this.sessions.get(key);
        const device = ownedDevice(payload, target, current ? deviceKey(current.device) : null);
        if (typeof device !== 'string' && RECORDING_PLATFORMS.includes(device.platform)) wanted.set(key, device);
      }
    }
    const now = this.now();
    for (const [key, session] of this.sessions) {
      const device = wanted.get(key);
      if (session.wrote || !device) this.failures.delete(key);
      const failures = this.failures.get(key) ?? 0;
      const broken = session.brokenAt !== null;
      const retry = broken && now - session.brokenAt! >= Math.min(RETRY_MS * 2 ** failures, MAX_RETRY_MS);
      if (device && deviceKey(device) === deviceKey(session.device) && !retry) continue;
      if (device && broken && !session.helperless) this.failures.set(key, failures + 1);
      session.stop();
      this.sessions.delete(key);
    }
    for (const [key, device] of wanted) {
      if (this.sessions.has(key)) continue;
      const [workspace, platform, slot] = JSON.parse(key) as [string, RecordingPlatform, string];
      this.sessions.set(
        key,
        new DeviceRecording(device, { workspace, platform, slot }, this.frames, this.limits.segmentMs),
      );
    }
  }

  /** Stops recording a workspace whose status shows recording off, and deletes its recordings. */
  private forget(workspace: string): void {
    for (const [key, session] of this.sessions) {
      if ((JSON.parse(key) as string[])[0] !== workspace) continue;
      session.stop();
      this.sessions.delete(key);
    }
    const dir = workspaceRecordingsDir(workspace);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }

  private heartbeat(): void {
    const now = this.now();
    for (const session of this.sessions.values()) session.heartbeat(now);
    if ([...this.sessions.values()].some((session) => session.brokenAt !== null)) this.evaluate();
  }

  /**
   * Keeps each device's last `footageMs` of footage and all recordings under `capBytes`, oldest first. A `.part`
   * segment no session writes, left by a server that stopped, is closed at its modification time first.
   */
  private prune(): void {
    const owned = this.claim !== null;
    if (!this.owns()) return;
    if (!owned) this.evaluate();
    const writing = new Set([...this.sessions.values()].flatMap((session) => session.openFile ?? []));
    const root = join(configDir(), 'workspaces');
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      return;
    }
    const devices = names.flatMap((name) => {
      const recordings = join(root, name, 'recordings');
      const found = listRecordedDevices(recordings);
      for (const device of found) {
        for (const segment of device.segments) {
          if (!segment.open || writing.has(segment.file)) continue;
          try {
            renameSync(segment.file, join(device.dir, closedSegmentName(segment.start, segment.end)));
          } catch {}
        }
      }
      return found.length ? listRecordedDevices(recordings) : [];
    });
    const aged = new Set(devices.flatMap((device) => footageDrops(device.segments, this.limits.footageMs)));
    const kept = devices.map((device) =>
      Object.assign({}, device, { segments: device.segments.filter((segment) => !aged.has(segment)) }),
    );
    for (const segment of [...aged, ...capDrops(kept, this.limits.capBytes)]) rmSync(segment.file, { force: true });
  }
}
