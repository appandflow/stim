import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { fingerprint } from '../../../packages/stim-cli/src/fingerprint/evaluate.ts';
import { isUncertain } from '../../../packages/stim-cli/src/fingerprint/key.ts';
import { nativeDirCarry, recordPrebuild } from '../../../packages/stim-cli/src/engine/prebuild.ts';
import { assertMatchingPods } from './harness.mjs';

assert(process.env.STIM_HOME, 'Native QA preparation requires an isolated STIM_HOME.');
const root = realpathSync(process.argv[2]);
assertMatchingPods(root);
const result = await fingerprint(
  root,
  { platform: 'ios', iosProjectPath: 'ios' },
  {
    env: process.env,
    embedMode: 'development',
    index: 'skip',
  },
);
assert(!isUncertain(result), 'The completed Expo fixture prebuild could not be fingerprinted.');
recordPrebuild(root, 'ios', result.hash);
assert.deepEqual(await nativeDirCarry(root, 'ios'), { generatedFrom: result.hash });
