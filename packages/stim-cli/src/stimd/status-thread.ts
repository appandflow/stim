import { parentPort } from 'node:worker_threads';
import { renderStatus } from '../commands/status.ts';
import { liveProbes, readStatus } from '../status-read.ts';

parentPort?.on('message', ({ cwd }: { cwd: string }) => {
  readStatus({ cwd, probes: liveProbes({ sharedListing: true }) })
    .then((snapshot) => parentPort?.postMessage({ json: renderStatus(snapshot, true, undefined, cwd).join('\n') }))
    .catch((error: unknown) =>
      parentPort?.postMessage({ failed: error instanceof Error ? error.message : String(error) }),
    );
});
