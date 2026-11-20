import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import { tryAcquireClaim } from '@stim-cli/core/ownership-claim';
import { processContext } from '../../cli-operation.ts';
import { declareSpawnsOn, spawnDeclared } from '../../engine/spawn-claims.ts';
import { WorkspaceProcessCleanupError } from '../../engine/workspace-process-error.ts';
import { captureProcessIdentity } from '../../process-identity.ts';
import { serveThreadJobs } from '../../stimd/thread-jobs.ts';

type Input = { children?: number; readOnly?: true };

/** A stimd thread whose job declares `children` sleepers on a claim under `cwd`, then refuses naming the first. */
if (parentPort)
  serveThreadJobs<Input>(parentPort, processContext, async (input, operation) => {
    const { cwd, children = 1, readOnly } = input;
    if (readOnly)
      throw Object.assign(new Error('Cannot verify cleanup for ps.'), {
        code: 'STIM_CLAIM_UNAVAILABLE',
        reportCleanup: true,
        readOnly: true,
        reportChild: { pid: 85183, processToken: null, command: 'ps -axo pid=' },
      });
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
  });
