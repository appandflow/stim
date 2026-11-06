// Full matrix: one minimal installed fixture per Expo SDK 53-58 and bare RN
// minor 0.74-0.88, each with npm hoisted, pnpm isolated and pnpm hoisted installs.
// This repo has apps/mobile (SDK 58, installed) and
// packages/stim-cli/src/__tests__/fixtures/sample-bare-project (RN 0.74, not installed).
// Node 22.22 strips the imported TypeScript sources without a loader flag.
import { run } from './fingerprint-runner.mjs';

await run(process.argv.slice(2), false);
