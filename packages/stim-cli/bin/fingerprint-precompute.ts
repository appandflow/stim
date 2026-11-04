import { processContext } from '../src/cli-operation.ts';
import { precomputeFingerprint } from '../src/cache/fingerprint-memo.ts';
import type { FingerprintPrecomputeRequest } from '../src/fingerprint-precompute.ts';

let input = '';
for await (const chunk of process.stdin) input += String(chunk);
const { root, platform, ...target }: FingerprintPrecomputeRequest = JSON.parse(input);
let result;
try {
  result = await precomputeFingerprint(root, { ...target, platform }, { operation: processContext(root) });
} catch (error) {
  result = { outcome: 'skipped', reason: error instanceof Error ? error.message : String(error) };
}
process.stdout.write(JSON.stringify(result));
