import { lstatSync } from 'node:fs';
import { readFailure, send, type ConnectionContext } from './context.ts';
import { type StimLogsOptions, createStim } from 'stim';
import {
  type NdjsonRecord,
  isJsonObject,
  readBuildHistory,
  readArchiveState,
  listRecordedDevices,
  RECORDING_PLATFORMS,
  type RecordingPlatform,
  listSegments,
  queryJsonLogs,
  type AgentSnapshotTree,
  readAgentSnapshot,
} from '@stim-cli/core/state';
import type { RequestId, ArchiveDetailResult, ErrorCode } from '../protocol.ts';
import { readTargetError, archivedTimeline } from '../logs.ts';
import { join } from 'node:path';
import { recordedSpans, recordingDir, timelineMarkers, segmentKeyframe } from '../replay.ts';
import { SLOT_NAME } from '../control.ts';
import type { PairedDevice } from '../registry.ts';
import { type AuditRecord, appendAudit } from '../actions.ts';
import { homedir } from 'node:os';

const MAX_KEYFRAME_READS = 8;

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return true;
  }
}

function collect(ctx: ConnectionContext, query: StimLogsOptions, cwd: string): Promise<NdjsonRecord[] | string> {
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), ctx.commandLimits.timeoutMs);
  let task: Promise<NdjsonRecord[] | string>;
  const cancel = async () => {
    abort.abort();
    await task;
  };
  ctx.holdSlot(cancel);
  ctx.running.add(cancel);
  task = Promise.resolve()
    .then(() =>
      createStim({ projectRoot: cwd, env: ctx.options.env, admission: 'none' }).logs({
        ...query,
        signal: abort.signal,
      }),
    )
    .then(
      (records) =>
        Buffer.byteLength(records.map((record) => JSON.stringify(record)).join('\n')) > ctx.commandLimits.maxOutputBytes
          ? `stim logs printed more than ${ctx.commandLimits.maxOutputBytes} bytes.`
          : records,
      (cause: unknown) => readFailure(cause),
    )
    .finally(() => {
      clearTimeout(deadline);
      ctx.releaseSlot(cancel);
      ctx.running.delete(cancel);
    });
  return task;
}

export function archiveDetail(ctx: ConnectionContext, id: RequestId, params: unknown): void {
  const target = isJsonObject(params) ? params : {};
  if (target.archive === undefined) return ctx.error(id, 'bad-request', 'archive.detail needs params.archive.');
  const targetError = readTargetError(target);
  if (targetError) return ctx.error(id, 'bad-request', targetError);
  const archive = target.archive as string;
  const dir = ctx.readDir(id, { archive });
  if (!dir) return;
  const result: ArchiveDetailResult = {
    builds: readBuildHistory(readArchiveState(archive)),
    recordings: listRecordedDevices(join(dir, 'recordings'), true)
      .filter((recorded) => !isLink(recorded.dir))
      .flatMap((recorded) => {
        const spans = recordedSpans(recorded.segments.filter((segment) => !isLink(segment.file)));
        return spans.length ? [{ platform: recorded.platform, slot: recorded.slot, spans }] : [];
      })
      .toSorted((a, b) => a.platform.localeCompare(b.platform) || a.slot.localeCompare(b.slot)),
  };
  send(ctx.socket, { id, result });
}

export function replayRange(ctx: ConnectionContext, id: RequestId, params: unknown): void | Promise<void> {
  const target = isJsonObject(params) ? params : {};
  const { platform, slot } = target;
  const targetError = readTargetError(target);
  if (targetError) return ctx.error(id, 'bad-request', targetError);
  const workspace = target.workspace as string | undefined;
  const archive = target.archive as string | undefined;
  if (!RECORDING_PLATFORMS.includes(platform as RecordingPlatform)) {
    return ctx.error(
      id,
      'bad-request',
      'replay.range needs params.workspace or params.archive and params.platform (ios, android or web).',
    );
  }
  if (slot !== undefined && (typeof slot !== 'string' || !SLOT_NAME.test(slot))) {
    return ctx.error(id, 'bad-request', 'params.slot must be 1-64 letters, digits, underscores or hyphens.');
  }
  const cwd = ctx.readDir(id, { workspace, archive });
  if (!cwd) return;
  if (archive === undefined && ctx.slotsFull(2)) {
    return ctx.error(id, 'limit-exceeded', ctx.slotsMessage(2));
  }
  const slotName = slot ?? 'default';
  const spans = recordedSpans(
    listSegments(recordingDir(workspace, platform as RecordingPlatform, slotName, archive), archive !== undefined),
  );
  const replayTarget = { workspace, platform: platform as RecordingPlatform, slot: slotName };
  const state = {
    enabled: archive === undefined ? (ctx.recorder?.enabled(workspace!) ?? false) : false,
    recording: archive === undefined ? (ctx.recorder?.recording(replayTarget) ?? false) : false,
    spans,
  };
  if (!spans.length) return send(ctx.socket, { id, result: { ...state, markers: [] } });
  if (archive !== undefined) {
    const timeline = archivedTimeline(cwd);
    const records = [
      ...queryJsonLogs({ records: timeline, sources: ['agent'], tail: 5000 }),
      ...queryJsonLogs({
        records: timeline,
        sources: ['metro', 'client', 'build', 'device'],
        minLevel: 'error',
        tail: 5000,
      }),
    ];
    const markers = timelineMarkers(records, platform as RecordingPlatform, slotName, spans[0]!.start);
    return send(ctx.socket, { id, result: { ...state, markers } });
  }
  const since = `${Math.ceil((Date.now() - spans[0]!.start) / 60_000) + 1}m`;
  void Promise.all([
    collect(ctx, { sources: ['agent'], since, tail: 5000 }, cwd),
    collect(ctx, { sources: ['metro', 'client', 'build', 'device'], minLevel: 'error', since, tail: 5000 }, cwd),
  ]).then(([actions, errors]) => {
    const failed = [actions, errors].find((result) => typeof result === 'string');
    if (typeof failed === 'string') return ctx.error(id, 'stim-failed', failed);
    const records = [...(actions as NdjsonRecord[]), ...(errors as NdjsonRecord[])];
    const viewports = new Map<string, AgentSnapshotTree['viewport']>();
    const markers = timelineMarkers(records, platform as RecordingPlatform, slotName, spans[0]!.start, (session) => {
      const known = viewports.get(session);
      if (known !== undefined) return known;
      const read = readAgentSnapshot(cwd, session)?.viewport ?? null;
      viewports.set(session, read);
      return read;
    });
    return send(ctx.socket, { id, result: { ...state, markers } });
  });
}

export function replayKeyframe(ctx: ConnectionContext, id: RequestId, params: unknown): void | Promise<void> {
  const target = isJsonObject(params) ? params : {};
  const { platform, slot, at } = target;
  const targetError = readTargetError(target);
  if (targetError) return ctx.error(id, 'bad-request', targetError);
  const workspace = target.workspace as string | undefined;
  const archive = target.archive as string | undefined;
  if (!RECORDING_PLATFORMS.includes(platform as RecordingPlatform)) {
    return ctx.error(
      id,
      'bad-request',
      'replay.keyframe needs params.workspace or params.archive and params.platform (ios, android or web).',
    );
  }
  if (slot !== undefined && (typeof slot !== 'string' || !SLOT_NAME.test(slot))) {
    return ctx.error(id, 'bad-request', 'params.slot must be 1-64 letters, digits, underscores or hyphens.');
  }
  if (typeof at !== 'number' || !Number.isFinite(at))
    return ctx.error(id, 'bad-request', 'at must be epoch milliseconds.');
  if (!ctx.readDir(id, { workspace, archive })) return;
  if (ctx.keyframeReads >= MAX_KEYFRAME_READS) {
    return ctx.error(id, 'limit-exceeded', `A connection can read ${MAX_KEYFRAME_READS} keyframes at a time.`);
  }
  ctx.keyframeReads++;
  return segmentKeyframe(
    recordingDir(workspace, platform as RecordingPlatform, slot ?? 'default', archive),
    at,
    archive !== undefined,
  ).then((found) => {
    ctx.keyframeReads--;
    if (!found) return ctx.error(id, 'no-recording', 'Nothing was recorded for this device.');
    const { segment, unit } = found;
    return send(ctx.socket, {
      id,
      result: {
        start: segment.start,
        end: segment.end,
        at: unit.capturedAt,
        width: unit.width,
        height: unit.height,
        ...(unit.posture ? { posture: unit.posture } : {}),
        data: unit.data.toString('base64'),
      },
    });
  });
}

export function setRecording(ctx: ConnectionContext, id: RequestId, params: unknown, session: PairedDevice): void {
  const enabled = isJsonObject(params) ? params.enabled : undefined;
  const record: AuditRecord = {
    at: new Date().toISOString(),
    device: { id: session.id, name: session.name },
    action: 'recording.set',
    workspace: null,
    ok: false,
  };
  const audit = (outcome: Pick<AuditRecord, 'ok' | 'error'>) => {
    try {
      appendAudit({ ...record, ...outcome });
    } catch (cause) {
      console.error(`stim-server: could not append to the action log: ${(cause as Error).message}`);
    }
  };
  const refuseSetting = (code: ErrorCode, message: string) => {
    audit({ ok: false, error: { code, message } });
    ctx.error(id, code, message);
  };
  if (!ctx.canControl(session)) {
    return refuseSetting(
      'forbidden',
      `This device can only read. On the machine, run \`stim pairings grant ${session.id} --control\` to let it change settings.`,
    );
  }
  if (typeof enabled !== 'boolean') return refuseSetting('bad-request', 'params.enabled must be true or false.');
  ctx.recordingTurn = ctx.cancelling.track(
    ctx.recordingTurn
      .catch(() => {})
      .then(async () => {
        if (ctx.closing) return;
        const abort = new AbortController();
        let finished = false;
        const fail = (message: string) => {
          if (finished || ctx.closing) return;
          finished = true;
          refuseSetting('action-failed', message);
        };
        const deadline = setTimeout(() => {
          fail(`stim settings did not finish within ${ctx.actionLimits.timeoutMs / 1000} s.`);
          abort.abort();
        }, ctx.actionLimits.timeoutMs);
        const task = Promise.resolve()
          .then(() =>
            createStim({ projectRoot: homedir(), env: ctx.options.env, admission: 'none' }).setSetting(
              'recording.enabled',
              String(enabled),
              { scope: 'machine', signal: abort.signal },
            ),
          )
          .then((result) => {
            if (finished || ctx.closing) return;
            if (Buffer.byteLength(JSON.stringify(result)) + 1 > ctx.actionLimits.maxOutputBytes)
              return fail(`stim settings printed more than ${ctx.actionLimits.maxOutputBytes} bytes.`);
            finished = true;
            audit({ ok: true });
            send(ctx.socket, { id, result: { enabled, recordingsDeleted: result.recordingsDeleted ?? [] } });
            return undefined;
          })
          .catch((cause: unknown) => fail(readFailure(cause)))
          .finally(() => clearTimeout(deadline));
        const cancel = async () => {
          abort.abort();
          await task;
        };
        ctx.running.add(cancel);
        await task.finally(() => ctx.running.delete(cancel));
        return undefined;
      }),
  );
}
