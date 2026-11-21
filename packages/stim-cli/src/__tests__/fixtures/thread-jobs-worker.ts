import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import type { StimContext } from '@stim-cli/core';
import { tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import { processContext } from '../../cli-operation.ts';
import type { DiskPassInput, DiskPassResult } from '../../daemon/passes.ts';
import { declareSpawnsOn, spawnDeclared } from '../../engine/spawn-claims.ts';
import { WorkspaceProcessCleanupError } from '../../engine/workspace-process-error.ts';
import { captureProcessIdentity } from '../../process-identity.ts';
import { serveThreadJobs } from '../../stimd/thread-jobs.ts';
import { triggeringRoot } from '../../stimd/passes/preview.ts';

function refuse(cwd: string, children: number, operation: StimContext): never {
  const claim = tryAcquireClaim({ root: join(cwd, 'work.lock'), mode: 'exclusive' }).acquired;
  if (!claim) throw new Error('the fixture claim is held');
  declareSpawnsOn(operation, claim);
  const pids = Array.from(
    { length: children },
    () => spawnDeclared(operation, () => spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })).pid ?? 0,
  );
  writeFileSync(join(cwd, 'pids'), pids.join(' '));
  const named = pids[0] ?? 0;
  const captured = captureProcessIdentity(named);
  throw new WorkspaceProcessCleanupError(
    [claim],
    `Cannot verify cleanup for report child ${named}.`,
    'Inspect fixture child.',
    Object.assign(new Error('unverified'), {
      reportChild: { pid: named, processToken: captured.ok ? captured.token : null },
    }),
  );
}

/**
 * A stimd thread whose job declares `children` sleepers on a claim under `cwd`, then refuses naming the first. Its disk
 * pass waits until it is aborted when the pressure's first reason is `wait`, and otherwise does the same with one
 * sleeper under the folder its second reason names. Its gc request answers with the root the operation it opens
 * protects, at once, or with `settled` 200 ms after the request leaves, once it wrote that file.
 */
if (parentPort)
  serveThreadJobs<
    { children?: number },
    DiskPassInput,
    DiskPassResult,
    { settled?: string },
    { protectedRoot: string }
  >(
    parentPort,
    processContext,
    async ({ cwd, children = 1 }, operation) => refuse(cwd, children, operation),
    undefined,
    async ({ pressure }, operation) => {
      if (pressure.reasons[0] !== 'wait') refuse(pressure.reasons[1] ?? '', 1, operation);
      await new Promise((resolve) => operation.signal.addEventListener('abort', resolve));
      operation.signal.throwIfAborted();
      return { actions: [], pressure };
    },
    ({ settled }, open) => {
      const protectedRoot = triggeringRoot(open(new AbortController().signal));
      if (!settled) return { result: Promise.resolve({ protectedRoot }), leave: () => {} };
      let leave: (() => void) | undefined;
      const result = new Promise<{ protectedRoot: string }>((resolve) => {
        leave = () =>
          void setTimeout(() => {
            writeFileSync(settled, 'settled');
            resolve({ protectedRoot });
          }, 200);
      });
      return { result, leave: () => leave?.() };
    },
  );
