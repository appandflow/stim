import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clock, outcome, STATUS } from '../assertions.mjs';
import { createBallast, gib } from '../ballast.mjs';
import { checkRungOrder, diffState } from '../ladder.mjs';
import { HarnessError } from '../workspaces.mjs';
import { hasEntries, launch, loadGate, setup, startPoller } from '../phases.mjs';
import { readSimulators } from '../platform.mjs';
import { run, sleep } from '../shell.mjs';

const SCENARIO = 'disk';
const GIB = 1024 ** 3;
const STEPS = [
  { label: '19 GB', gb: 19, refuses: false },
  { label: '11 GB', gb: 11, refuses: false },
  { label: '5 GB', gb: 4.5, refuses: true },
];
const HIGH_IDLE_MS = 150_000;
const HIGH_DORMANT_IDLE_MS = 10.5 * 60_000;
const OBSERVE_MIN_MS = 150_000;
const OBSERVE_QUIET_MS = 120_000;
const OBSERVE_MAX_MS = 6 * 60_000;
const OBSERVE_POLL_MS = 10_000;
const BUILD_WAIT_MS = 25 * 60_000;
const HEARTBEAT_MS = 20_000;
const SHARED_CACHES = ['build-cache', 'compilation-cache', 'metro-cache', 'fingerprint-memo'];
const ORDER_TOLERANCE_MS = 60_000;

async function cacheSizes(home) {
  const dirs = SHARED_CACHES.map((name) => join(home, name)).filter(existsSync);
  const sizes = {};
  if (!dirs.length) return sizes;
  const du = await run('du', ['-sk', ...dirs], { timeoutMs: 120_000 });
  for (const line of du.stdout.split('\n')) {
    const match = /^(\d+)\s+(.*)$/.exec(line);
    if (match) sizes[match[2].split('/').at(-1)] = Number(match[1]) * 1024;
  }
  return sizes;
}

async function readState(ctx, tracked, caches) {
  const sims = await readSimulators(60_000);
  const digest = ctx.snapshots.findLast((poll) => poll.ok);
  if (sims === null || !digest) return null;
  const present = new Set(sims.map((sim) => sim.udid));
  const workspaces = {};
  for (const workspace of tracked) {
    const record = ctx.record(workspace);
    const facts = digest?.envs[workspace.path]?.facts;
    workspaces[workspace.label] = {
      metroUp: Boolean(facts?.metroRunning),
      devicesUp: facts?.devicesUp ?? 0,
      deviceExists: record.udid ? present.has(record.udid) : false,
      derived: record.workspaceDir ? hasEntries(join(record.workspaceDir, 'derived-data')) : false,
      nodeModules: existsSync(join(workspace.path, 'node_modules')),
      pods: existsSync(join(workspace.path, 'ios', 'Pods')),
    };
  }
  return { workspaces, caches: await caches() };
}

function throttled(read, everyMs) {
  let last = { at: 0, value: {} };
  return async () => {
    if (Date.now() - last.at >= everyMs) last = { at: Date.now(), value: await read() };
    return last.value;
  };
}

function startBuilder(ctx, workspace) {
  const chain = { open: true, current: null, iterations: [] };
  chain.done = (async () => {
    let n = 0;
    while (chain.open && !ctx.signal.aborted) {
      n += 1;
      chain.current = Date.now();
      const result = await ctx.stim.exec(`ios-build-${n}`, workspace.path, ['ios', '--no-build-cache', '--json'], {
        timeoutMs: 40 * 60_000,
      });
      chain.iterations.push({ n, startedAt: result.startedAt, endedAt: result.endedAt, result });
      chain.current = null;
    }
  })();
  return chain;
}

function startHeartbeat(ctx, workspace) {
  const beat = { open: true, count: 0, failures: 0 };
  beat.done = (async () => {
    while (beat.open && !ctx.signal.aborted) {
      const result = await ctx.stim.exec('reload', workspace.path, ['reload', '--json'], { timeoutMs: 120_000 });
      beat.count += 1;
      if (!result.ok) beat.failures += 1;
      await sleep(HEARTBEAT_MS, ctx.signal);
    }
  })();
  return beat;
}

async function waitUntil(ctx, ms) {
  while (Date.now() < ms && !ctx.signal.aborted) await sleep(Math.min(5000, ms - Date.now()), ctx.signal);
}

async function observeStep(ctx, step, tracked, caches, state, stepAt) {
  const events = [];
  let lastEventAt = stepAt;
  let current = state;
  for (;;) {
    await sleep(OBSERVE_POLL_MS, ctx.signal);
    const next = await readState(ctx, tracked, caches);
    const found = next ? diffState(current, next, Date.now()) : [];
    if (found.length) lastEventAt = Date.now();
    for (const event of found)
      ctx.emit('ladder', `${step.label}: ${event.kind} ${event.workspace ?? ''} ${event.detail}`);
    events.push(...found);
    current = next ?? current;
    const elapsed = Date.now() - stepAt;
    if (
      (elapsed >= OBSERVE_MIN_MS && Date.now() - lastEventAt >= OBSERVE_QUIET_MS) ||
      elapsed >= OBSERVE_MAX_MS ||
      ctx.signal.aborted
    )
      break;
  }
  return { events, state: current };
}

async function probeStart(ctx, probe) {
  const free = gib(ctx.ballast.free());
  const result = await ctx.stim.exec('probe-start', probe.path, ['start', '--json'], { timeoutMs: 5 * 60_000 });
  if (result.ok) await ctx.stim.exec('probe-stop', probe.path, ['stop', '--json'], { timeoutMs: 5 * 60_000 });
  return { free, result };
}

function assertSteps(ctx, steps) {
  const items = steps.map(({ step, probe, freeAfterLadder, inFlight, events }) => {
    const code = probe.result.json?.code ?? null;
    const refused = !probe.result.ok && code === 'STIM_LOW_DISK';
    const ok = step.refuses ? refused : probe.result.ok && code === null;
    return outcome(
      step.label,
      ok ? STATUS.pass : STATUS.fail,
      `probe free ${probe.free.toFixed(2)} GB (${freeAfterLadder.toFixed(2)} GB before re-ballast): stim start exit ${probe.result.code}${code ? ` ${code}` : ''}, expected ${step.refuses ? 'STIM_LOW_DISK' : 'success'}`,
      `build in flight at the step: ${inFlight}, state freed during the step: ${events.length} events`,
    );
  });
  ctx.assertions.fromItems(
    SCENARIO,
    'only-last-refused',
    'only the last step (below the 5 GB hard floor) refuses a new `stim start`',
    items,
  );
}

const straddles = (iteration, stepAt) => iteration.startedAt <= stepAt && stepAt <= iteration.endedAt;

function assertBuild(ctx, chain, steps) {
  const A = ctx.assertions;
  const iterations = chain.iterations;
  const hardAt = steps.at(-1)?.stepAt ?? null;
  const lines = iterations.map(
    (iteration) =>
      `build ${iteration.n}: exit ${iteration.result.code} from ${clock(iteration.startedAt)} to ${clock(iteration.endedAt)}, in flight at ${
        steps
          .filter(({ stepAt }) => straddles(iteration, stepAt))
          .map(({ step }) => step.label)
          .join(', ') || 'no step'
      }${iteration.result.ok ? '' : `, ${iteration.result.json?.code ?? 'no failure payload'}`}`,
  );
  const stuck = chain.current !== null;
  const failed = stuck || iterations.some((iteration) => !iteration.result.ok);
  const overlapped = hardAt !== null && iterations.some((iteration) => straddles(iteration, hardAt));
  const title = 'a build in flight at the hard floor completes, and so does every build started before it';
  if (failed)
    A.fail(SCENARIO, 'build-completes', title, [
      ...(stuck ? ['a build was still running 25 minutes after the last step'] : []),
      ...lines,
    ]);
  else if (!overlapped)
    A.unavailable(SCENARIO, 'build-completes', title, [
      'no build was in flight when the hard-floor step began, so completion under it was not exercised',
      ...lines,
    ]);
  else A.pass(SCENARIO, 'build-completes', title, lines);
}

function assertActive(ctx, active, firstStepAt, beat) {
  const polls = ctx.snapshots.filter((poll) => poll.ok && poll.startedAt >= firstStepAt && poll.envs[active.path]);
  const broken = polls.find((poll) => {
    const facts = poll.envs[active.path].facts;
    return !(facts.metroRunning && facts.devicesUp > 0);
  });
  const lines = [
    `${polls.length} status polls during the steps, ${beat.count} reload heartbeats (${beat.failures} failed)`,
  ];
  if (broken) lines.push(`first poll with Metro or the device down: ${clock(broken.startedAt)}`);
  ctx.assertions.fromItems(
    SCENARIO,
    'active-untouched',
    'the active workspace keeps its Metro, device and app through every step',
    [outcome(active.label, !polls.length ? STATUS.unavailable : broken ? STATUS.fail : STATUS.pass, ...lines)],
  );
}

export async function runDisk(ctx) {
  await setup(ctx, ctx.opts.workspaces);
  const [active, builder, probe, ...victims] = ctx.workspaces;
  active.role = 'active (reload heartbeat)';
  builder.role = 'builder (repeated fresh builds)';
  probe.role = 'probe (stim start at each step)';
  for (const victim of victims) victim.role = 'idle victim';
  const tracked = [active, ...victims];
  ctx.ballast = createBallast({ dir: ctx.ballastDir });
  writeFileSync(join(ctx.out, 'ballast.path'), `${ctx.ballast.file}\n`);
  ctx.cleanups.push(async () => {
    await ctx.ballast.release();
    ctx.ballast.remove();
  });
  const poller = startPoller(ctx);
  let chain = null;
  let beat = null;
  try {
    for (const workspace of [...victims, active]) {
      await loadGate(ctx, `launching ${workspace.label}`);
      const launched = await launch(ctx, workspace);
      if (!launched.ok) {
        ctx.assertions.fail(SCENARIO, 'launch', 'the victims and the active workspace launch', [
          `${workspace.label}: ios exit ${launched.ios.code}, ${ctx.record(workspace).errorCode}`,
        ]);
        return;
      }
    }
    const lastVictimLaunch = Math.max(...victims.map((victim) => ctx.record(victim).launchedAt));
    beat = startHeartbeat(ctx, active);
    ctx.setStage('quiet');
    await waitUntil(ctx, lastVictimLaunch + HIGH_IDLE_MS);

    const caches = throttled(() => cacheSizes(ctx.home), 30_000);
    let state = await readState(ctx, tracked, caches);
    if (!state) throw new HarnessError('could not read the starting state (simctl list or status failed)');
    const events = [];
    const steps = [];
    chain = startBuilder(ctx, builder);
    const firstStepAt = Date.now();
    for (const [index, step] of STEPS.entries()) {
      if (ctx.signal.aborted) break;
      if (index === 1) await waitUntil(ctx, lastVictimLaunch + HIGH_DORMANT_IDLE_MS);
      if (step.refuses) chain.open = false;
      ctx.setStage(`step-${step.label.replace(' ', '')}`);
      const placed = await ctx.ballast.stepTo(step.gb * GIB, ctx.signal);
      const stepAt = Date.now();
      const inFlight = chain.current !== null;
      ctx.emit(
        'disk',
        `step ${step.label}: free ${gib(placed.before).toFixed(1)} -> ${gib(placed.after).toFixed(1)} GB, ballast ${gib(placed.ballastBytes).toFixed(1)} GB${placed.clamped ? ' (clamped at the safety floor)' : ''}, build in flight ${inFlight}`,
      );
      const observed = await observeStep(ctx, step, tracked, caches, state, stepAt);
      state = observed.state;
      events.push(...observed.events);
      const freeAfterLadder = gib(ctx.ballast.free());
      await ctx.ballast.stepTo(step.gb * GIB, ctx.signal);
      const probed = await probeStart(ctx, probe);
      ctx.emit(
        'disk',
        `step ${step.label}: probe stim start exit ${probed.result.code} ${probed.result.json?.code ?? ''}`,
      );
      steps.push({ step, stepAt, inFlight, events: observed.events, freeAfterLadder, probe: probed });
    }
    if (ctx.signal.aborted) return;
    chain.open = false;
    ctx.setStage('build-drain');
    await Promise.race([chain.done, sleep(BUILD_WAIT_MS, ctx.signal)]);
    beat.open = false;

    const order = checkRungOrder(events, ORDER_TOLERANCE_MS);
    const title =
      'state is freed in rung order: idle stage, parked devices, shared caches, dormant stage, node_modules and Pods';
    if (order.verdict === 'unavailable') {
      ctx.assertions.unavailable(SCENARIO, 'freed-order', title, [
        `fewer than two rungs freed anything (${order.rungs.join(', ') || 'none'}), so no order can be checked`,
        ...order.evidence,
      ]);
    } else
      (order.verdict === 'pass' ? ctx.assertions.pass : ctx.assertions.fail)(
        SCENARIO,
        'freed-order',
        title,
        order.evidence,
      );
    assertActive(ctx, active, firstStepAt, beat);
    assertBuild(ctx, chain, steps);
    assertSteps(ctx, steps);
  } finally {
    if (chain) chain.open = false;
    if (beat) beat.open = false;
    await ctx.ballast.release();
    await poller.stop();
  }
}
