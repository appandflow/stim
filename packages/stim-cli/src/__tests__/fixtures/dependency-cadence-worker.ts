import { parentPort, threadId, workerData } from 'node:worker_threads';
import { runDormantDependencies } from '../../daemon/dependencies.ts';

const port = parentPort;
if (port) {
  port.on('message', async ({ type, input }) => {
    if (type !== 'run') return;
    const { now, force, fail, disabled } = input;
    Date.now = () => now;
    let inspected = false;
    const report = () =>
      port.postMessage({ type: 'log', level: 'info', event: 'fixture', msg: '', fields: { threadId, inspected } });
    try {
      const result = await runDormantDependencies({
        config: {
          version: 2,
          idle: { dormantDays: disabled ? 0 : 1, sourceDormantDays: 0 },
          repos: {},
          get projects() {
            inspected = true;
            if (fail) throw new Error('inventory failed');
            return {};
          },
        },
        act: false,
        devices: [],
        simsFailed: true,
        log: () => {},
        force,
        cadence: force ? undefined : workerData.dependencyCadence,
      });
      report();
      port.postMessage({ type: 'done', result });
    } catch (error) {
      report();
      port.postMessage({ type: 'failed', message: (error as Error).message });
    }
  });
}
