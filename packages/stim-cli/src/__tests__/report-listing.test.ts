import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { withAmbientContext, type StimContext } from '@stim-cli/core';
import { getExecutor } from '../exec.ts';
import { operationState } from '../engine/operation-state.ts';
import type { ClaimHandle } from '../ownership-claim.ts';
import { setReportChildLog } from '../report-child-log.ts';
import { runReport } from '../report-runtime.ts';

const spawned = vi.hoisted(() => [] as { file: string; child: EventEmitter }[]);
vi.mock('../process-identity.ts', () => ({
  captureProcessIdentity: () => ({ ok: true, token: 'fixture' }),
  inspectProcessIdentity: () => 'unknown',
}));
vi.mock('../engine/spawn-claims.ts', () => ({
  spawnDeclared: (_context: unknown, start: () => unknown, options?: { until?: Promise<void> }) => {
    void options?.until?.catch(() => {});
    return start();
  },
}));
vi.mock('cross-spawn', () => ({
  default: (file: string) => {
    const child = Object.assign(new EventEmitter(), {
      pid: 12345,
      exitCode: null,
      signalCode: null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
      unref: () => {},
    });
    spawned.push({ file, child });
    return child;
  },
}));

const events: { level: string; event: string }[] = [];
let call: Promise<unknown> | undefined;
beforeEach(() => setReportChildLog((level, event) => void events.push({ level, event })));
afterEach(() => {
  setReportChildLog(undefined);
  for (const { child } of spawned.splice(0)) child.emit('exit', null, 'SIGKILL');
  events.length = 0;
});

const claim: ClaimHandle = {
  root: '/fixture',
  path: '/fixture/claim',
  claimId: 'fixture',
  mode: 'exclusive',
  owner: { pid: 12345, processToken: 'fixture' },
  startedAt: new Date().toISOString(),
  details: {},
  label: 'fixture',
};

/** Runs `file` in a report, cancels the report, and returns what the report threw. */
async function cancelled(file: string, { claimed = false, via = 'runFileAsync' } = {}): Promise<unknown> {
  const controller = new AbortController();
  const context: StimContext = {
    home: process.env.STIM_HOME ?? '',
    buildCache: null,
    projectRoot: process.cwd(),
    cwd: process.cwd(),
    env: process.env,
    runId: 'report-listing',
    signal: controller.signal,
    output: () => {},
  };
  const failure = runReport(context, async (operation) =>
    withAmbientContext(operation, () => {
      if (claimed) operationState(operation).declaring.add(claim);
      if (via === 'spawn') {
        getExecutor().spawn(file, ['-axo', 'pid=']);
        return 'started';
      }
      call = getExecutor().runFileAsync(file, ['-axo', 'pid='], { timeoutMs: 10_000, declareFor: operation });
      return call;
    }),
  ).catch((error: unknown) => error);
  controller.abort();
  await vi.advanceTimersByTimeAsync(1100);
  return failure;
}

describe.skipIf(process.platform !== 'darwin')('a macOS ps listing whose cleanup cannot be verified', () => {
  test.each(['runFileAsync', 'spawn'])('runs /bin/ps and is left without a refusal through %s', async (via) => {
    const error = await cancelled('ps', { via });
    expect(spawned.map(({ file }) => file)).toEqual(['/bin/ps']);
    expect(error).not.toHaveProperty('reportCleanup');
    expect(events).toContainEqual({ level: 'warn', event: 'report_child_left' });
  });

  test('fails the left call with its own abort error', async () => {
    await cancelled('ps');
    await expect(call).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('is refused once eight are left, and left again after one exits', async () => {
    for (let each = 0; each < 8; each++) expect(await cancelled('ps')).not.toHaveProperty('reportCleanup');
    expect(await cancelled('ps')).toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE', reportCleanup: true });
    spawned[0]?.child.emit('exit', null, 'SIGKILL');
    expect(await cancelled('ps')).not.toHaveProperty('reportCleanup');
  });

  test.each([
    ['a ps named by path', '/usr/local/bin/ps', false],
    ['another program', 'lsof', false],
    ['a ps under declared claims', 'ps', true],
  ])('%s is refused as before', async (_name, file, claimed) => {
    expect(await cancelled(file, { claimed })).toMatchObject({ code: 'STIM_CLAIM_UNAVAILABLE', reportCleanup: true });
    expect(spawned.map((entry) => entry.file)).toEqual([file]);
    expect(events.some(({ event }) => event === 'report_child_left')).toBe(false);
  });
});
