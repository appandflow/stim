import { constants, availableParallelism, loadavg } from 'node:os';
import { basename } from 'node:path';
import chalk from 'chalk';
import type { StimContext } from '@stim-cli/core';
import { testSlotLimit } from '@stim-cli/core/state';
import { defineOp, type Op } from '../cli/define-op.ts';
import { exitCli, processContext, runProcessOperation } from '../cli-operation.ts';
import { formatElapsed, phaseLine } from '../command-output.ts';
import { debugLog } from '../debug-log.ts';
import { operationState } from '../engine/operation-state.ts';
import { spawnDeclared } from '../engine/spawn-claims.ts';
import {
  configuredWorkers,
  packageManagerFor,
  planTestRun,
  testScriptFor,
  testScriptRun,
  testWorkerCount,
} from '../engine/test-run.ts';
import { acquireTestSlot, listTestSlots, releaseTestSlot, type TestSlotHandle } from '../engine/test-slots.ts';
import { getExecutor } from '../exec.ts';
import { readClaimSet } from '../ownership-claim.ts';
import { groupExitBudgetMs, waitForGroupExit } from '../process-group-exit.ts';

const note = (context: StimContext, text: string) => context.output('stderr', `${phaseLine('test', text)}\n`);

function refusal(context: StimContext, code: string, message: string, remedy: string): number {
  context.output('stderr', `${chalk.red(phaseLine('error', `${code}: ${message}`))}\n${phaseLine('remedy', remedy)}\n`);
  return 1;
}

const KILL_GRACE_CAP_MS = 10_000;

const signalGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal);
  } catch {}
};

/**
 * Runs `argv` and resolves once it exited. With `group`, the command leads its own process group: a cancellation
 * reaches the whole group, the group gets SIGKILL when it outlives a grace period, whether or not its leader exited,
 * and the run resolves only once the group is empty. `survivors` is true when processes of the group still run after
 * that; the declaration then keeps recording the child, so the slot claim stays held by the group. Without `group`
 * (a run nested in another stim test), the command stays in the caller's group, which the outer run waits for.
 */
async function runCommand(
  context: StimContext,
  argv: string[],
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
        cwd: context.cwd,
        env,
        detached: group,
      }),
    { until: emptied },
  );
  const pid = group ? child.pid : undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const killGroup = () => {
    if (pid !== undefined) signalGroup(pid, 'SIGKILL');
  };
  const forward = () => {
    if (pid === undefined) return;
    const reason = context.signal.reason;
    signalGroup(pid, reason === 'SIGINT' ? 'SIGINT' : reason === 'SIGHUP' ? 'SIGHUP' : 'SIGTERM');
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
    if (!gone && pid !== undefined && context.signal.aborted) {
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

async function runTest(context: StimContext, command: string[], ceilingMs: number | undefined): Promise<number> {
  const { cwd, env } = context;
  if (process.platform === 'win32')
    return refusal(
      context,
      'STIM_BAD_ARG',
      'stim test is not supported on Windows: Stim cannot stop the process tree of a test command there.',
      'Run the test command directly on Windows, or run stim test on macOS or Linux.',
    );
  const started = Date.now();
  const scriptRun = testScriptRun(command);
  const manager = scriptRun ?? packageManagerFor(cwd);
  const script = command.length && !scriptRun ? null : testScriptFor(cwd);
  if ((!command.length || scriptRun) && !script)
    return refusal(
      context,
      'STIM_BAD_ARG',
      `No package.json with a test script was found from ${cwd}.`,
      'Pass the test command after --, for example: stim test -- npx jest',
    );
  const argv = command.length ? command : [manager, 'run', 'test'];
  const program = basename(argv[0] ?? '');
  debugLog.log('test_start', { program, script: script !== null, manager });
  let slot: TestSlotHandle | undefined;
  let exit: number;
  let signal: NodeJS.Signals | null;
  let retain = false;
  let marker = '1';
  try {
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
    const workers = testWorkerCount({ cores, slots, load1 });
    const plan = planTestRun({ argv, workers, script, manager, configured: configuredWorkers(cwd) });
    debugLog.log('test_workers', { workers, cores, slots, load1, applied: plan.applied, skipped: plan.skipped });
    const basis = `${cores} cores, ${slots} test slot${slots === 1 ? '' : 's'}, load ${load1}`;
    note(
      context,
      plan.applied
        ? `${workers} workers (${basis}) through ${plan.applied}`
        : `no worker count passed: ${plan.skipped} (${basis})`,
    );
    const result = await runCommand(context, plan.argv, { ...env, STIM_TEST_RUN: marker }, slot !== undefined);
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
  arguments: '[command...]',
  description:
    "Run a test command under a machine-wide test slot (concurrency.maxTests), with Jest's or Vitest's worker count sized to this machine. Without a command, run the project's test script through its package manager. Output and exit status are the command's own.",
  options: {
    wait: {
      flags: '--wait <seconds>',
      description:
        'How long to wait for a test slot before refusing with STIM_AT_CAPACITY (0 refuses at once); without it, a queued run waits until a slot frees.',
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
  },
  run: async ({ args, options }) => {
    const ceilingMs = options.wait === undefined ? undefined : options.wait === false ? 0 : options.wait * 1000;
    const { value } = await runProcessOperation(
      processContext('').cwd,
      (context) => runTest(context, [...args], ceilingMs),
      { hangup: true },
    );
    if (value !== 0) exitCli(value);
  },
});

export default test;
