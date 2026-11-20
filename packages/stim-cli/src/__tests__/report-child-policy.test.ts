import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { withAmbientContext, type StimContext } from '@stim-cli/core';
import { getExecutor } from '../exec.ts';
import { operationState } from '../engine/operation-state.ts';
import type { ClaimHandle } from '../ownership-claim.ts';
import { runReport } from '../report-runtime.ts';

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
  default: () =>
    Object.assign(new EventEmitter(), {
      pid: 12345,
      exitCode: null,
      signalCode: null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
      unref: () => {},
    }),
}));

test.each([
  ['ps', ['-axo', 'pid=,ppid='], false, true],
  ['lsof', ['-nP', '-iTCP:8081', '-sTCP:LISTEN', '-Fpn'], false, true],
  ['du', ['-sk', '/fixture'], false, true],
  ['nice', ['-n', '19', 'du', '-sk', '/fixture'], false, true],
  ['ps', ['-axo', 'pid='], true, false],
  ['ps', ['-axo', 'pid='], false, false, 'runFileAsync', 'shadowed'],
  ['ps', ['-axo', 'pid=', 'extra'], false, false],
  ['lsof', ['-r', '1'], false, false],
  ['nice', ['-n', '10', 'ps', '-axo', 'pid='], false, false],
  ['du', ['-sk', '/fixture', '-x'], false, false],
  ['lsof', ['-D', '/fixture/cache'], false, false],
  ['xcrun', ['simctl', 'privacy', 'fixture', 'reset', 'all'], false, false],
  ['adb', ['-s', 'fixture', 'reverse', 'tcp:8081', 'tcp:8081'], false, false],
  ['unknown', [], false, false],
  ['ps', ['-axww', '-o', 'pid='], false, true, 'spawn'],
  ['ps', ['-axww', '-o', 'pid='], true, false, 'spawn'],
] as const)(
  '%s %j (claimed=%s) classifies cleanup as read-only=%s',
  async (file, args, claimed, readOnly, kind?: 'runFileAsync' | 'spawn', shadowed?: 'shadowed') => {
    let env = process.env;
    if (shadowed) {
      const bin = mkdtempSync(join(tmpdir(), 'stim-report-shadow-'));
      onTestFinished(() => rmSync(bin, { recursive: true, force: true }));
      writeFileSync(join(bin, file), '#!/bin/sh\n', { mode: 0o755 });
      env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` };
    }
    const controller = new AbortController();
    const context: StimContext = {
      home: process.env.STIM_HOME ?? '',
      buildCache: null,
      projectRoot: process.cwd(),
      cwd: process.cwd(),
      env,
      runId: 'report-child-policy',
      signal: controller.signal,
      output: () => {},
    };
    const failure = runReport(context, async (operation) =>
      withAmbientContext(operation, () => {
        if (claimed) {
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
          operationState(operation).declaring.add(claim);
        }
        if (kind === 'spawn') {
          getExecutor().spawn(file, args);
          return 'started';
        }
        return getExecutor().runFileAsync(file, [...args], { timeoutMs: 10_000, declareFor: operation });
      }),
    ).catch((error: unknown) => error);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1100);
    const error = await failure;
    expect(error).toMatchObject({
      code: 'STIM_CLAIM_UNAVAILABLE',
      reportCleanup: true,
      reportChild: { pid: 12345, command: expect.any(String) },
    });
    expect(Reflect.get(Object(error), 'readOnly')).toBe(readOnly ? true : undefined);
  },
);

test('a read-only failure cannot hide another resource whose cleanup is unverified', async () => {
  const { trackReportResource } = await import('../report-runtime.ts');
  const failure = Object.assign(new Error('claimed child remains'), { reportResourceSettled: () => true });
  const context: StimContext = {
    home: process.env.STIM_HOME ?? '',
    buildCache: null,
    projectRoot: process.cwd(),
    cwd: process.cwd(),
    env: process.env,
    runId: 'mixed-report',
    signal: new AbortController().signal,
    output: () => {},
  };
  await expect(
    runReport(context, async (operation) => {
      trackReportResource(
        operation,
        Promise.reject(
          Object.assign(new Error('read child remains'), { readOnly: true, reportResourceSettled: () => false }),
        ),
        () => {},
      );
      trackReportResource(operation, Promise.reject(failure), () => {});
    }),
  ).rejects.toBe(failure);
  expect(failure).not.toHaveProperty('readOnly');
  const settled = Reflect.get(failure, 'cleanupSettled');
  if (typeof settled !== 'function') throw new Error('report did not carry its cleanup check');
  expect(settled()).toBe(true);
});
