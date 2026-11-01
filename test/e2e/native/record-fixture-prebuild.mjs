import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { fingerprintProject } from '../../../packages/stim-cli/src/cache/build-cache.ts';
import { nativeDirCarry, recordPrebuild } from '../../../packages/stim-cli/src/engine/prebuild.ts';
import { assertMatchingPods } from './harness.mjs';

assert(process.env.STIM_HOME, 'Native QA preparation requires an isolated STIM_HOME.');
const root = realpathSync(process.argv[2]);
assertMatchingPods(root);
const fingerprint = await fingerprintProject(root, { platform: 'ios', iosProjectPath: 'ios' });
assert(fingerprint?.hash, 'The completed Expo fixture prebuild could not be fingerprinted.');
recordPrebuild(root, 'ios', fingerprint.hash);
assert.deepEqual(await nativeDirCarry(root, 'ios'), { generatedFrom: fingerprint.hash });
