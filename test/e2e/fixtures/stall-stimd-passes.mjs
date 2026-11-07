import * as workerThreads from 'node:worker_threads';
import { appendFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url);
const builtin = require('node:worker_threads');
const Worker = workerThreads.Worker;
builtin.Worker = class extends Worker {
  constructor(filename, options) {
    super(filename, options);
    this.stallPasses = options?.workerData?.stimdThread === 'passes';
  }
  postMessage(message, ...rest) {
    if (this.stallPasses) {
      if (message.type === 'run') appendFileSync(process.env.STIM_TEST_STALLED_PASSES, 'started\n');
      return;
    }
    return super.postMessage(message, ...rest);
  }
};
syncBuiltinESMExports();
