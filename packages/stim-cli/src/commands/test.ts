import { constants, availableParallelism, loadavg } from 'node:os';
import { basename } from 'node:path';
import chalk from 'chalk';
import type { StimContext } from '@stim-cli/core';
import { testSlotLimit, testWorkersSetting } from '@stim-cli/core/state';
import { defineOp, type Op } from '../cli/define-op.ts';
import { exitCli, processContext, runProcessOperation } from '../cli-operation.ts';
import { formatElapsed, phaseLine } from '../command-output.ts';
import { debugLog } from '../debug-log.ts';
import { operationState } from '../engine/operation-state.ts';
import { spawnDeclared } from '../engine/spawn-claims.ts';
import {
  AVAILABLE_KINDS,
  detectKinds,
  namedKinds,
  scriptRunsKinds,
  skipScriptKinds,
  TEST_KINDS,
} from '../engine/test-kinds.ts';
import {
  configuredWorkers,
  packageScripts,
  packageManagerFor,
  planTestRun,
  testScriptFor,
  testScriptRun,
  testWorkerCount,
  vitestVersionFor,
  type PackageManager,
} from '../engine/test-run.ts';
import { acquireTestSlot, listTestSlots, releaseTestSlot, type TestSlotHandle } from '../engine/test-slots.ts';
import { getExecutor } from '../exec.ts';
import { readClaimSet } from '../ownership-claim.ts';
import { groupExitBudgetMs, waitForGroupExit } from '../process-group-exit.ts';
import { captureProcessIdentity, inspectProcessIdentity } from '../process-identity.ts';

const note = (context: StimContext, text: string) => context.output('stderr', `${phaseLine('test', text)}\n`);

function refusal(context: StimContext, code: string, message: string, remedy: string): number {
  context.output('stderr', `${chalk.red(phaseLine('error', `${code}: ${message}`))}\n${phaseLine('remedy', remedy)}\n`);
  return 1;
}

const KILL_GRACE_CAP_MS = 10_000;

export interface GroupLeader {
  pid: number;
  /** The leader's identity captured at spawn, or null when the capture failed. */
  processToken: string | null;
}

function pidInUse(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

/**
 * Sends `signal` to the process group `leader` led, only while that group id provably still belongs to it, since POSIX
 * does not reuse a pid while a process group with that id exists: the leader is still the recorded process, or no
 * process has its pid. Without a recorded identity, `running` (the leader is the caller's child and not reaped yet)
 * also keeps the pid reserved. Returns whether the signal went out.
 */
export function signalLedGroup(leader: GroupLeader, signal: NodeJS.Signals, running = false): boolean {
  const identity = leader.processToken === null ? 'unknown' : inspectProcessIdentity(leader);
  if (identity === 'different') return false;
  if (identity === 'unknown' && !running && pidInUse(leader.pid)) return false;
  try {
    process.kill(-leader.pid, signal);
  } catch {}
  return true;
}

/**
 * Stops what is left in the process group `leader` led once the leader exited: SIGTERM, then SIGKILL after `graceMs`,
 * each through {@link signalLedGroup}. Resolves to whether the group emptied.
 */
export async function stopGroupLeftovers(leader: GroupLeader, graceMs: number): Promise<boolean> {
  for (const [signal, waitMs] of [
    ['SIGTERM', graceMs],
    ['SIGKILL', groupExitBudgetMs()],
  ] as const) {
    if (!signalLedGroup(leader, signal)) return false;
    if (await waitForGroupExit(leader.pid, waitMs)) return true;
  }
  return false;
}

/**
 * Runs `argv` in `cwd` and resolves once it exited. With `group`, the command leads its own process group: a
 * cancellation reaches the whole group, the group gets SIGKILL when it outlives a grace period, whether or not its
 * leader exited, processes the command left in the group after it exited get SIGTERM after a grace period and SIGKILL
 * after another, and the run resolves only once the group is empty. Every group signal goes through `signalLedGroup`.
 * `survivors` is true when processes of the group still run after that; the declaration then keeps recording the child,
 * so the slot claim stays held by the group. Without `group` (a run nested in another stim test), the command stays in
 * the caller's group, which the outer run waits for and stops, and a cancellation, its grace and SIGKILL reach only the
 * direct child, not the outer group's other members.
 */
async function runCommand(
  context: StimContext,
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  group: boolean,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; survivors: boolean }> {
  const state = operationState(context);
  state.handled = true;
  state.draining = true;
  const [file = '', ...args] = argv;
  let settleGroup!: (gone: boolean) => void;
  const emptied = new Promise<void>((resolve, reject) => {
    settleGroup = (gone) => (gone ? resolve() : reject(new Error('the test command left processes running')));
  });
  void emptied.catch(() => {});
  const child = spawnDeclared(
    context,
    () =>
      getExecutor().spawn(file, args, {
        stdio: ['ignore', 'inherit', 'inherit'],
        cwd,
        env,
        detached: group,
      }),
    { until: emptied },
  );
  const pid = group ? child.pid : undefined;
  const captured = pid === undefined ? null : captureProcessIdentity(pid);
  const leader = pid === undefined ? null : { pid, processToken: captured?.ok ? captured.token : null };
  const running = () => child.exitCode === null && child.signalCode === null;
  const send = (signal: NodeJS.Signals) => {
    if (leader) signalLedGroup(leader, signal, running());
    else if (running()) child.kill(signal);
  };
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const killGroup = () => send('SIGKILL');
  const forward = () => {
    const reason = context.signal.reason;
    send(reason === 'SIGINT' ? 'SIGINT' : reason === 'SIGHUP' ? 'SIGHUP' : 'SIGTERM');
    killTimer ??= setTimeout(killGroup, groupExitBudgetMs(KILL_GRACE_CAP_MS));
  };
  context.signal.addEventListener('abort', forward);
  state.exitCleanups.add(killGroup);
  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('error', (error) => {
        note(context, `${basename(file)} could not start: ${error.message}`);
        resolve({ code: 127, signal: null });
      });
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const cancelled = context.signal.aborted;
    let gone =
      pid === undefined || (await waitForGroupExit(pid, groupExitBudgetMs(cancelled ? KILL_GRACE_CAP_MS : undefined)));
    if (!gone && leader && !context.signal.aborted) {
      gone = await stopGroupLeftovers(leader, groupExitBudgetMs(KILL_GRACE_CAP_MS));
      if (gone) note(context, `stopped the processes the test command left running in its process group ${pid}`);
    } else if (!gone && pid !== undefined) {
      killGroup();
      gone = await waitForGroupExit(pid, groupExitBudgetMs());
    }
    if (!gone)
      note(
        context,
        `processes the test command started still run in its process group ${pid}; the test slot stays held until they exit`,
      );
    settleGroup(gone);
    return { ...exit, survivors: !gone };
  } finally {
    clearTimeout(killTimer);
    context.signal.removeEventListener('abort', forward);
    state.exitCleanups.delete(killGroup);
  }
}

/** Whether `marker`, a `STIM_TEST_RUN` value, names a test slot claim that is still held. */
function heldTestRun(marker: string): boolean {
  const at = marker.lastIndexOf('#');
  if (at < 0) return false;
  const path = marker.slice(0, at);
  const claimId = marker.slice(at + 1);
  return (
    listTestSlots().some((held) => held.path === path && held.alive) &&
    readClaimSet(path).live.some((holder) => holder.claimId === claimId)
  );
}

interface TestRun {
  argv: string[];
  dir: string;
  script: string | null;
  manager: PackageManager;
  extra: string[];
}

/**
 * The run that `stim test` asked for: the operands before `--` name kinds, and with no kind named, the words after `--`
 * are the whole command. Without either, the project's detected kinds run.
 */
function resolveRun(
  context: StimContext,
  kindWords: string[],
  after: string[],
): { run: TestRun } | { refused: number } {
  const { cwd } = context;
  const refuse = (message: string, remedy: string) => ({ refused: refusal(context, 'STIM_BAD_ARG', message, remedy) });
  const named = namedKinds(kindWords);
  if ('unknown' in named)
    return refuse(
      `${named.unknown} is not a test kind; the kinds are ${TEST_KINDS.join(', ')}, and e2e for every e2e kind. A command goes after --.`,
      `stim test -- ${[...kindWords, ...after].join(' ')}`,
    );
  const missing = named.kinds.filter((kind) => !AVAILABLE_KINDS.includes(kind));
  if (missing.length)
    return refuse(
      `Stim cannot run the ${missing.join(', ')} test kind${missing.length === 1 ? '' : 's'} yet; it runs only ${AVAILABLE_KINDS.join(', ')}.`,
      'Run those tests with their own command after --: stim test -- <command>',
    );
  if (!named.kinds.length && after.length) {
    const scriptRun = testScriptRun(after);
    const script = scriptRun ? testScriptFor(cwd) : null;
    if (scriptRun && !script)
      return refuse(
        `No package.json with a test script was found from ${cwd}.`,
        'Pass the test command after --, for example: stim test -- npx jest',
      );
    return { run: { argv: after, dir: cwd, script, manager: scriptRun ?? packageManagerFor(cwd), extra: [] } };
  }
  const { run, skipped } = skipScriptKinds(detectKinds(cwd));
  for (const each of skipped) note(context, `${each.kind}: skipped, ${each.reason}`);
  const js = run.find((each) => each.kind === 'js');
  if (!js)
    return refuse(
      `No package.json with a test script was found from ${cwd}.`,
      'Pass the test command after --, for example: stim test -- npx jest',
    );
  return { run: { argv: js.argv, dir: js.cwd, script: js.script, manager: js.manager, extra: after } };
}

/** `stim test --list`: the kinds the project has, with the command each runs, on stdout. */
function listKinds(context: StimContext, json: boolean): number {
  const { run, skipped } = skipScriptKinds(detectKinds(context.cwd));
  const kinds = run.map((each) => ({
    kind: each.kind,
    origin: 'detected' as const,
    command: each.argv,
    cwd: each.cwd,
    script: each.script,
    runner: each.runner,
    needs: ['test-slot'],
    runnable: true,
    scriptRuns: [...scriptRunsKinds(each.script).keys()],
  }));
  if (json) {
    context.output('stdout', `${JSON.stringify({ kinds, skipped }, null, 2)}\n`);
    return 0;
  }
  if (!kinds.length && !skipped.length) context.output('stdout', `No test kinds found from ${context.cwd}.\n`);
  for (const each of kinds) {
    const runner = each.runner ? `${each.runner}, sized` : 'not sized';
    context.output(
      'stdout',
      `${each.kind}  ${each.command.join(' ')}  (${runner}; in ${each.cwd}; takes a test slot)\n`,
    );
    if (each.scriptRuns.length)
      context.output('stdout', `    the test script also runs ${each.scriptRuns.join(', ')}\n`);
  }
  for (const each of skipped) context.output('stdout', `${each.kind}  skipped: ${each.reason}\n`);
  return 0;
}

async function runTest(
  context: StimContext,
  operands: string[],
  beforeDash: number,
  ceilingMs: number | undefined,
  list: { json: boolean } | null,
): Promise<number> {
  const { cwd, env } = context;
  if (process.platform === 'win32')
    return refusal(
      context,
      'STIM_BAD_ARG',
      'stim test is not supported on Windows: Stim cannot stop the process tree of a test command there.',
      'Run the test command directly on Windows, or run stim test on macOS or Linux.',
    );
  const started = Date.now();
  const kindWords = operands.slice(0, beforeDash);
  const after = operands.slice(beforeDash);
  if (list) {
    if (operands.length)
      return refusal(context, 'STIM_BAD_ARG', 'stim test --list takes no kind or command.', 'stim test --list');
    return listKinds(context, list.json);
  }
  if (kindWords.length > 1 && after.length)
    return refusal(
      context,
      'STIM_BAD_ARG',
      'Arguments after -- go to one kind; several kinds were named.',
      `stim test ${kindWords[0] ?? 'js'} -- ${after.join(' ')}`,
    );
  const resolved = resolveRun(context, kindWords, after);
  if ('refused' in resolved) return resolved.refused;
  const { argv, dir, script, manager, extra } = resolved.run;
  const program = basename(argv[0] ?? '');
  debugLog.log('test_start', { program, script: script !== null, manager });
  let slot: TestSlotHandle | undefined;
  let exit: number;
  let signal: NodeJS.Signals | null;
  let retain = false;
  let marker = '1';
  try {
    const fixed = testWorkersSetting({ env });
    const parent = env.STIM_TEST_RUN;
    if (parent && heldTestRun(parent)) {
      note(context, 'inside another stim test run, which holds the test slot; running without one');
      marker = parent;
    } else {
      slot = await acquireTestSlot({
        root: cwd,
        signal: context.signal,
        out: (line) => context.output('stderr', `  ${line}\n`),
        ceilingMs,
      });
      debugLog.log('test_slot', { index: slot.index ?? null, waitedMs: slot.slotWaitMs ?? 0 });
      marker = slot.path && slot.claim ? `${slot.path}#${slot.claim.claimId}` : '1';
    }
    const cores = availableParallelism();
    const slots = testSlotLimit({ env }).max;
    const load1 = Math.round((loadavg()[0] ?? 0) * 10) / 10;
    // @ref LLP 0020#a-fixed-worker-count -- a set count skips the load reduction
    const workers = fixed || testWorkerCount({ cores, slots, load1 });
    const plan = planTestRun({
      argv,
      workers,
      script,
      manager,
      extra,
      configured: configuredWorkers(dir),
      scripts: packageScripts(dir),
      vitestVersion: vitestVersionFor(argv, dir, (file) => getExecutor().findExecutable(file, { env, cwd: dir })),
      nodeOptions: env.NODE_OPTIONS,
    });
    debugLog.log('test_workers', {
      workers,
      source: fixed ? 'concurrency.testWorkers' : 'derived',
      cores,
      slots,
      load1,
      applied: plan.applied,
      skipped: plan.skipped,
    });
    const basis = `${cores} cores, ${slots} test slot${slots === 1 ? '' : 's'}, load ${load1}`;
    note(
      context,
      plan.applied
        ? `${workers} workers (${fixed ? 'set by concurrency.testWorkers' : basis}) through ${plan.applied}`
        : `no worker count passed: ${plan.skipped} (${fixed ? `concurrency.testWorkers ${fixed}` : basis})`,
    );
    const result = await runCommand(context, plan.argv, dir, { ...env, STIM_TEST_RUN: marker }, slot !== undefined);
    retain = result.survivors;
    signal = result.signal;
    exit = signal ? 128 + (constants.signals[signal] ?? 0) : (result.code ?? 1);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') throw error;
    if (!error.code.startsWith('STIM_')) throw error;
    const remedy =
      'remedy' in error && typeof error.remedy === 'string' ? error.remedy : 'stim guide lifecycle concurrency';
    return refusal(context, error.code, error.message, remedy);
  } finally {
    releaseTestSlot(slot, retain);
  }
  debugLog.log('test_exit', { exit, signal, ms: Date.now() - started });
  note(context, `${program} exited ${signal ?? exit} after ${formatElapsed(Date.now() - started)}`);
  return exit;
}

const test: Op = defineOp({
  name: 'test',
  arguments: '[kind...]',
  argumentDescriptions: {
    'kind...': `the test kinds to run (${TEST_KINDS.join(', ')}, or e2e); without one, every kind the project has. A command to run instead goes after --.`,
  },
  description:
    "Run a project's tests by kind, or a test command after --, under a machine-wide test slot (concurrency.maxTests), with Jest's, Vitest's or node --test's worker count sized to this machine. The js kind runs the project's test script through its package manager. Output and exit status are the test command's own.",
  options: {
    wait: {
      flags: '--wait <seconds>',
      description:
        'How long to wait for a test slot before refusing with STIM_AT_CAPACITY (0 refuses at once); without it, a queued run waits up to 90 minutes.',
      parse: (value: string) => {
        const seconds = Number(value);
        if (!value.trim() || !Number.isFinite(seconds) || seconds < 0)
          throw new Error('expected a number of seconds, 0 or more');
        return seconds;
      },
    },
    noWait: {
      flags: '--no-wait',
      description: 'Refuse with STIM_AT_CAPACITY instead of queueing when every test slot is taken.',
    },
    list: {
      flags: '--list',
      description: 'List the test kinds this project has and the command each runs, and run nothing.',
    },
    json: {
      flags: '--json',
      description: 'With --list, print the list as JSON on stdout.',
    },
  },
  run: async ({ args, options, beforeDash }) => {
    const ceilingMs = options.wait === undefined ? undefined : options.wait === false ? 0 : options.wait * 1000;
    const list = options.list ? { json: options.json === true } : null;
    const { value, interrupted } = await runProcessOperation(
      processContext('').cwd,
      async (context) =>
        options.json && !list
          ? refusal(context, 'STIM_BAD_ARG', '--json applies only to --list.', 'stim test --list --json')
          : runTest(context, [...args], beforeDash ?? args.length, ceilingMs, list),
      { hangup: true },
    );
    const code = interrupted ?? value;
    if (code !== 0) exitCli(code);
  },
});

export default test;
