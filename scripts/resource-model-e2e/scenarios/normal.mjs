import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { outcome, STATUS, judgeIdleTiming } from '../assertions.mjs';
import {
  POLL_MS,
  QUIET_TICK_MS,
  TICK_MS,
  assertIdleDown,
  launch,
  loadGate,
  pollStatus,
  reviveWorkspaces,
  setup,
  startPoller,
  waitForIdle,
} from '../phases.mjs';
import { readSimulators } from '../platform.mjs';
import { sleep } from '../shell.mjs';

const SCENARIO = 'normal';

async function dormantPhase(ctx, live, reviveEndMs) {
  const A = ctx.assertions;
  const { dormant } = ctx.clocks;
  if (!dormant.available) {
    for (const [id, title] of [
      ['dormant-devices-deleted', 'the dormant stage deletes the owned devices'],
      ['dormant-stage-reported', 'status reports the dormant stage with the devices it deleted'],
      ['dormant-deps-kept', 'node_modules and Pods survive the dormant stage'],
    ]) {
      A.unavailable(SCENARIO, id, title, [`not available on this build: ${dormant.reason}`]);
    }
    return;
  }
  const windowMs = dormant.minutes * 60_000;
  ctx.setStage('dormant-wait');
  ctx.emit('dormant', `waiting ${dormant.minutes} min for the dormant stage`);
  const owned = new Map(live.map((workspace) => [workspace.label, [...(ctx.record(workspace).udids ?? [])]]));
  const seen = new Map();
  const end = reviveEndMs + windowMs + QUIET_TICK_MS + 5 * 60_000;
  const previousPollStartMs = new Map(live.map((workspace) => [workspace.label, null]));
  while (Date.now() < end && seen.size < live.length && !ctx.signal.aborted) {
    const began = Date.now();
    const sims = await readSimulators(60_000);
    if (sims === null) {
      await sleep(POLL_MS, ctx.signal);
      continue;
    }
    const names = new Set(sims.map((sim) => sim.udid));
    for (const workspace of live) {
      if (seen.has(workspace.label)) continue;
      const udids = owned.get(workspace.label);
      if (udids.length && udids.every((udid) => !names.has(udid)))
        seen.set(workspace.label, { startedAt: began, endedAt: Date.now() });
      else previousPollStartMs.set(workspace.label, began);
    }
    await sleep(POLL_MS, ctx.signal);
  }
  A.fromItems(
    SCENARIO,
    'dormant-devices-deleted',
    `the dormant stage deletes the owned devices within ${dormant.minutes} min plus one 5-minute quiet tick`,
    live.map((workspace) => {
      const hit = seen.get(workspace.label);
      if (!hit)
        return outcome(
          workspace.label,
          STATUS.fail,
          `devices ${owned.get(workspace.label).join(', ') || 'none recorded'} still exist`,
        );
      const timing = judgeIdleTiming({
        commandEndMs: ctx.record(workspace).revivedAt ?? reviveEndMs,
        lastActivityMs: null,
        readAtMs: ctx.record(workspace).revivedAt ?? reviveEndMs,
        windowMs,
        tickMs: TICK_MS,
        lateTickMs: QUIET_TICK_MS,
        previousPollStartMs: previousPollStartMs.get(workspace.label),
        idlePollStartMs: hit.startedAt,
        idlePollEndMs: hit.endedAt,
      });
      return outcome(workspace.label, timing.ok ? STATUS.pass : STATUS.fail, ...timing.evidence);
    }),
  );
  const polled = await pollStatus(ctx);
  A.fromItems(
    SCENARIO,
    'dormant-stage-reported',
    'status reports the dormant stage with the devices it deleted',
    live.map((workspace) => {
      if (!seen.has(workspace.label)) {
        return outcome(workspace.label, STATUS.unavailable, 'the workspace never reached the dormant stage');
      }
      const stage = polled.envs[workspace.path]?.facts.dormantStage;
      if (!stage) {
        return outcome(workspace.label, STATUS.unavailable, 'not available on this build: status has no dormantStage');
      }
      return outcome(
        workspace.label,
        STATUS.pass,
        `dormantStage at ${stage.at}, dormantDays ${stage.dormantDays}, deletedDevices ${JSON.stringify(stage.deletedDevices)}, archived ${JSON.stringify(stage.archived)}`,
      );
    }),
  );
  A.fromItems(
    SCENARIO,
    'dormant-deps-kept',
    'node_modules and Pods survive the dormant stage',
    live.map((workspace) => {
      if (!seen.has(workspace.label)) {
        return outcome(workspace.label, STATUS.unavailable, 'the workspace never reached the dormant stage');
      }
      const modules = existsSync(join(workspace.path, 'node_modules'));
      const pods = existsSync(join(workspace.path, 'ios', 'Pods'));
      return outcome(
        workspace.label,
        modules && pods ? STATUS.pass : STATUS.fail,
        `node_modules present=${modules}, ios/Pods present=${pods}`,
      );
    }),
  );
}

export async function runNormal(ctx) {
  const A = ctx.assertions;
  await setup(ctx, ctx.opts.workspaces);
  for (const workspace of ctx.workspaces) workspace.role = 'workspace';
  const poller = startPoller(ctx);
  try {
    const launched = [];
    for (const workspace of ctx.workspaces) {
      await loadGate(ctx, `launching ${workspace.label}`);
      const result = await launch(ctx, workspace);
      if (result.ok) launched.push(workspace);
    }
    A.fromItems(
      SCENARIO,
      'launch',
      'each workspace starts and launches its app, one after another',
      ctx.workspaces.map((workspace) => {
        const record = ctx.record(workspace);
        const ok =
          record.startExit === 0 &&
          record.iosExit === 0 &&
          (record.launched === true || record.launched === 'bundling');
        return outcome(
          workspace.label,
          ok ? STATUS.pass : STATUS.fail,
          `start exit ${record.startExit}, ios exit ${record.iosExit}, launched ${record.launched}${record.errorCode ? `, ${record.errorCode}` : ''}`,
        );
      }),
    );
    if (!launched.length) return;
    for (const workspace of launched)
      ctx.record(workspace).udids = new Set(ctx.record(workspace).udid ? [ctx.record(workspace).udid] : []);

    const waited = await waitForIdle(
      ctx,
      launched.map((workspace) => ({ workspace, commandEndMs: ctx.record(workspace).launchedAt })),
      { windowMs: ctx.idleWindowMs, graceMs: 5 * 60_000 },
    );
    await assertIdleDown(ctx, SCENARIO, waited, ctx.idleWindowMs);

    const revivable = launched.filter((workspace) => waited.get(workspace.label)?.resolved);
    await reviveWorkspaces(ctx, SCENARIO, revivable, { concurrent: false });
    const reviveEndMs = Math.max(...revivable.map((workspace) => ctx.record(workspace).revivedAt ?? Date.now()));

    if (ctx.opts.dormantMinutes !== null && revivable.length) await dormantPhase(ctx, revivable, reviveEndMs);
  } finally {
    await poller.stop();
  }
}
