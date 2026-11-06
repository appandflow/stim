import {
  type FramesSeekParams,
  REPLAY_RATES,
  PLATFORMS,
  type Platform,
  type RequestId,
  FRAME_FPS,
  FRAME_EDGE,
  type FrameTarget,
  type MacosWindow,
  type DeviceFrameArtwork,
} from '../protocol.ts';
import type { JsonObject } from '../feed.ts';
import { readTargetError } from '../logs.ts';
import { SLOT_NAME } from '../control.ts';
import { listSegments, isJsonObject, type RecordingPlatform, type StatusPayload } from '@stim-cli/core/state';
import { send, viewHostedPlacement, type ConnectionContext } from './context.ts';
import { presenceKey } from '../presence.ts';
import { HostedViews } from '../hosted-view.ts';
import type { FrameHint } from '../frame-helper.ts';
import { HOSTED_MAX_BITRATE, VideoGate, DEFAULT_VIDEO_LIMITS, type AccessUnit, videoPacket } from '../video.ts';
import { recordingDir, Player } from '../replay.ts';
import { type Device, type Frame, deviceKey, ownedDevice } from '../frames.ts';
import { FRAME_RETRY_MS, LatestFrames } from '../frame-delivery.ts';

/** `at` and `rate` of a seek, null when neither is given, or why they are refused. */
export function parseReplay(
  at: unknown,
  rate: unknown,
): { at: number; rate: FramesSeekParams['rate'] } | string | null {
  if (at === undefined && rate === undefined) return null;
  if (typeof at !== 'number' || !Number.isFinite(at)) return 'at must be epoch milliseconds.';
  const parsed = rate === undefined ? 0 : rate;
  if (!REPLAY_RATES.includes(parsed as FramesSeekParams['rate'])) {
    return `rate must be one of ${REPLAY_RATES.join(', ')}.`;
  }
  return { at, rate: parsed as FramesSeekParams['rate'] };
}

function frameTargetError(target: JsonObject, hosted: boolean): string | null {
  const error = readTargetError(target);
  if (error) return error;
  const { archive, platform, slot, physical, at, deviceFrame, duoFrame } = target;
  if (archive !== undefined && (at === undefined || physical)) {
    return 'Archived frames require params.at and cannot be physical.';
  }
  if (!PLATFORMS.includes(platform as Platform)) {
    return 'frames.subscribe needs params.workspace or params.archive and params.platform (ios, android, web or macos).';
  }
  if (slot !== undefined && (typeof slot !== 'string' || !SLOT_NAME.test(slot))) {
    return 'slot must be 1-64 letters, digits, underscores or hyphens.';
  }
  if (physical !== undefined && typeof physical !== 'boolean') return 'physical must be true or false.';
  if (deviceFrame !== undefined && typeof deviceFrame !== 'boolean') return 'deviceFrame must be true or false.';
  if (
    duoFrame !== undefined &&
    (typeof duoFrame !== 'boolean' || (duoFrame && (platform !== 'ios' || physical || hosted)))
  ) {
    return 'duoFrame needs a local owned iOS simulator.';
  }
  return null;
}

function hasFootage(dir: string, closedOnly = false): boolean {
  return listSegments(dir, closedOnly).length > 0;
}

/** Presence for a relayed hosted subscription that asked for it: the host's, and this machine's own. */
function hostedPresenceFor(
  ctx: ConnectionContext,
  target: JsonObject,
  host: { machine: string; session: string },
  dir: string | null,
): ((subscription: string) => () => void) | undefined {
  const { platform, slot } = target;
  if (target.presence !== true || (platform !== 'ios' && platform !== 'android') || !dir) return undefined;
  const key = presenceKey(dir, platform, typeof slot === 'string' ? slot : 'default', false);
  return (subscription) => {
    const unfollow = ctx.hostedBridge.follow(key, host);
    const unsubscribe = ctx.presence.subscribe(key, (participants) =>
      send(ctx.socket, { event: 'presence', subscription, participants }),
    );
    return () => {
      unsubscribe();
      unfollow();
    };
  };
}

export function subscribeFrames(
  ctx: ConnectionContext,
  id: RequestId,
  params: unknown,
  hosted?: { client: string; session: string; view: ReturnType<HostedViews['target']> },
): void {
  const framePool = hosted?.view.frames ?? ctx.frames;
  const target = isJsonObject(params) ? params : {};
  const { platform, fps, maxEdge, video, at, rate, deviceFrame, duoFrame } = target;
  const targetError = frameTargetError(target, hosted !== undefined);
  if (targetError) return ctx.error(id, 'bad-request', targetError);
  const slot = target.slot as string | undefined;
  const physical = target.physical as boolean | undefined;
  const workspace = target.workspace as string | undefined;
  const archive = target.archive as string | undefined;
  const wantsDuo = duoFrame === true && at === undefined;
  const wantsArtwork = deviceFrame === true && !physical && platform !== 'web';
  if (video !== undefined && (!Array.isArray(video) || !video.every((codec) => typeof codec === 'string'))) {
    return ctx.error(id, 'bad-request', 'video must be a list of codec names.');
  }
  const wantsVideo = (video as string[] | undefined)?.includes('h264') === true;
  const maxFps = wantsVideo ? FRAME_FPS.video : FRAME_FPS.max;
  if (fps !== undefined && (typeof fps !== 'number' || !Number.isInteger(fps) || fps < 1 || fps > maxFps)) {
    return ctx.error(id, 'bad-request', `fps must be a whole number from 1 to ${maxFps}.`);
  }
  if (
    maxEdge !== undefined &&
    (typeof maxEdge !== 'number' || !Number.isInteger(maxEdge) || maxEdge < FRAME_EDGE.min || maxEdge > FRAME_EDGE.max)
  ) {
    return ctx.error(
      id,
      'bad-request',
      `maxEdge must be a whole number of pixels from ${FRAME_EDGE.min} to ${FRAME_EDGE.max}.`,
    );
  }
  const resolvedDir = hosted ? null : ctx.readDir(id, { workspace, archive });
  if (!hosted && !resolvedDir) return;
  const host =
    archive || hosted || !resolvedDir
      ? undefined
      : viewHostedPlacement(resolvedDir, platform as Platform, slot as string | undefined, physical);
  if (host) {
    if (
      (platform === 'macos' && slot !== undefined && slot !== 'default') ||
      physical ||
      duoFrame ||
      at !== undefined ||
      rate !== undefined
    ) {
      return ctx.error(
        id,
        'bad-request',
        platform === 'ios'
          ? 'Hosted iOS frames require a non-physical target without replay or duoFrame.'
          : platform === 'android'
            ? 'Hosted Android frames require a non-physical target without replay or duoFrame.'
            : 'Hosted macOS frames require the default, non-physical target without replay.',
      );
    }
    return void ctx.relay.subscribe(
      id,
      host,
      target,
      (subscription, stop) => ctx.subscriptions.set(subscription, stop),
      hostedPresenceFor(ctx, target, host, resolvedDir),
    );
  }
  const offersVideo = wantsVideo && !wantsDuo && (archive !== undefined || ctx.frameHelper() !== null);
  const replayAt = parseReplay(at, rate);
  if (typeof replayAt === 'string') return ctx.error(id, 'bad-request', replayAt);
  if (replayAt && !offersVideo) {
    return ctx.error(id, 'bad-request', 'Replay needs a video subscription: pass video: ["h264"].');
  }
  const hint: FrameHint = {
    fps: Math.min(fps ?? FRAME_FPS.default, offersVideo ? FRAME_FPS.video : FRAME_FPS.max),
    maxEdge: maxEdge ?? FRAME_EDGE.default,
    ...(hosted ? { maxBitrate: HOSTED_MAX_BITRATE } : {}),
  };
  const replayDir =
    platform === 'macos'
      ? null
      : recordingDir(workspace, platform as RecordingPlatform, typeof slot === 'string' ? slot : 'default', archive);
  if (replayAt && (physical || replayDir === null || !hasFootage(replayDir, archive !== undefined))) {
    return ctx.error(
      id,
      'no-recording',
      `Nothing was recorded for ${physical ? 'a physical ' : ''}${platform} in ${archive ?? workspace}.`,
    );
  }
  const subscription = ctx.openSubscription(id, offersVideo ? { video: 'h264' } : {});
  if (!subscription) return;
  const frameTarget: FrameTarget = {
    ...(archive === undefined ? { workspace } : { archive }),
    platform: platform as Platform,
    ...(slot ? { slot } : {}),
    ...(physical ? { physical } : {}),
  };
  const gate = new VideoGate(DEFAULT_VIDEO_LIMITS.congestedBytes);
  let sequence = 0;
  let streamed: Device | null = null;
  let draining: NodeJS.Timeout | null = null;
  const drain = () => {
    draining = null;
    if (ended || !streamed) return;
    if (ctx.socket.bufferedAmount <= DEFAULT_VIDEO_LIMITS.congestedBytes) return framePool.keyframe(streamed);
    framePool.congested(streamed);
    draining = setTimeout(drain, FRAME_RETRY_MS);
  };
  let attached: string | null = null;
  let detach: (() => void) | null = null;
  let ended = false;
  const delivery = new LatestFrames<Frame>(
    hint.fps,
    () => ctx.socket.bufferedAmount,
    (frame) => {
      send(ctx.socket, {
        event: 'frame',
        subscription,
        platform: frameTarget.platform,
        slot: slot ?? 'default',
        mime: 'image/jpeg',
        ...frame,
      });
    },
  );
  const cleanup = () => {
    ended = true;
    stopPresence?.();
    player?.stop();
    ctx.replays.delete(subscription);
    stopViewing?.();
    ctx.keyframes.delete(subscription);
    ctx.congestion.delete(subscription);
    delivery.stop();
    if (draining) clearTimeout(draining);
    detach?.();
    detach = null;
    unsubscribeStatus?.();
  };
  const end = (message: string) => {
    if (ended) return;
    cleanup();
    ctx.subscriptions.delete(subscription);
    send(ctx.socket, { event: 'error', subscription, error: { code: 'frames-failed', message } });
  };
  const listener = {
    frame: (frame: Frame) => delivery.push(frame),
    delayed: (delayed: boolean, reason?: string) => {
      if (!ended) send(ctx.socket, { event: 'frame-delayed', subscription, delayed, ...(reason ? { reason } : {}) });
    },
    failed: end,
    ...(frameTarget.platform === 'macos'
      ? {
          windows: ({
            current,
            windows,
            pinned,
          }: {
            current: MacosWindow | null;
            windows: MacosWindow[];
            pinned: boolean;
          }) => {
            if (!ended) send(ctx.socket, { event: 'macos-windows', subscription, current, windows, pinned });
          },
        }
      : {}),
    ...(wantsDuo ? { duo: (frame: Frame) => delivery.push(frame) } : {}),
    ...(wantsArtwork
      ? {
          artwork: (artwork: DeviceFrameArtwork | null) => {
            if (!ended && !player) send(ctx.socket, { event: 'device-frame', subscription, artwork });
          },
        }
      : {}),
    ...(offersVideo
      ? {
          video: (unit: AccessUnit) => {
            if (ended || player || ctx.socket.readyState !== ctx.socket.OPEN) return;
            const verdict = gate.admit(unit, ctx.socket.bufferedAmount);
            if (verdict === 'send') ctx.socket.send(videoPacket(subscription, sequence++, unit));
            else if (verdict === 'congested' && !draining) drain();
          },
        }
      : {}),
  };
  let player: Player | null = null;
  let latest: StatusPayload | null = null;
  const attach = (resolved: Device) => {
    if (wantsArtwork) send(ctx.socket, { event: 'device-frame', subscription, artwork: null });
    if (!hosted && resolved.platform === 'macos') ctx.nativeViewerOpened = true;
    detach?.();
    gate.reset();
    streamed = resolved;
    attached = deviceKey(resolved);
    detach = hosted
      ? ctx.hostedViews.subscribe(hosted.client, hosted.session, listener, hint)
      : framePool.subscribe(resolved, listener, hint);
  };
  const replay = (): Player => {
    if (player) return player;
    if (wantsArtwork) send(ctx.socket, { event: 'device-frame', subscription, artwork: null });
    detach?.();
    detach = null;
    attached = null;
    player = new Player(
      replayDir!,
      {
        unit: (unit) => {
          if (!ended && ctx.socket.readyState === ctx.socket.OPEN)
            ctx.socket.send(videoPacket(subscription, sequence++, unit));
        },
        bufferedBytes: () => ctx.socket.bufferedAmount,
        ended: (position) =>
          queueMicrotask(() => {
            if (!ended) send(ctx.socket, { event: 'replay-ended', subscription, at: position });
          }),
      },
      DEFAULT_VIDEO_LIMITS.congestedBytes,
      archive !== undefined,
    );
    return player;
  };
  const goLive = (): string | null => {
    if (archive !== undefined) return `Archive ${archive} cannot go live.`;
    const resolved = latest
      ? ownedDevice(latest, frameTarget, null, { adbEmulators: ctx.adbEmulators })
      : 'The device status is not known yet.';
    if (typeof resolved === 'string') return resolved;
    player?.stop();
    player = null;
    attach(resolved);
    return null;
  };
  if (offersVideo) {
    ctx.congestion.set(subscription, () => {
      if (streamed && !player) framePool.congested(streamed);
    });
    ctx.keyframes.set(subscription, () => {
      if (player) return player.resend();
      gate.reset();
      if (streamed) framePool.keyframe(streamed);
    });
    ctx.replays.set(subscription, {
      seek: (seekAt, seekRate) => {
        if (physical || replayDir === null || !hasFootage(replayDir, archive !== undefined)) return null;
        const wasLive = player === null;
        const shown = replay().seek(seekAt, seekRate);
        if (shown === null && wasLive) goLive();
        return shown;
      },
      live: goLive,
    });
  }
  if (replayAt && replay().seek(replayAt.at, replayAt.rate) === null) {
    send(ctx.socket, { event: 'replay-ended', subscription, at: replayAt.at });
  }
  const stopPresence =
    target.presence === true && archive === undefined && !hosted && resolvedDir
      ? ctx.localAgents.subscribe(
          presenceKey(resolvedDir, frameTarget.platform, slot ?? 'default', physical === true),
          (participants) => {
            if (!ended) send(ctx.socket, { event: 'presence', subscription, participants });
          },
        )
      : undefined;
  const stopViewing = archive !== undefined || physical || hosted ? undefined : ctx.recorder?.viewing(frameTarget);
  let unsubscribeStatus: (() => void) | null = null;
  if (hosted) attach(hosted.view.device);
  else if (archive === undefined)
    unsubscribeStatus = ctx.statusFeed.subscribe({
      item: (payload) => {
        if (ended) return;
        latest = payload as unknown as StatusPayload;
        if (player) return;
        const resolved = ownedDevice(latest, frameTarget, attached, { adbEmulators: ctx.adbEmulators });
        if (typeof resolved === 'string') return queueMicrotask(() => end(resolved));
        if (deviceKey(resolved) === attached) return;
        attach(resolved);
      },
      failed: (message) => queueMicrotask(() => end(message)),
    });
  ctx.subscriptions.set(subscription, cleanup);
}
