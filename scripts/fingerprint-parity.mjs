// Node 22.22 strips the imported TypeScript sources without a loader flag.
import { run } from './fingerprint-runner.mjs';

await run(
  process.argv.slice(2).length
    ? process.argv.slice(2)
    : (process.env.STIM_PARITY_PROJECTS ?? '').split(':').filter(Boolean),
  true,
);
