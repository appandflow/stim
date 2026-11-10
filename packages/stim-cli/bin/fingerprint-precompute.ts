import { precomputePass } from '../src/fingerprint/precompute.ts';
import { fingerprint, useParentFingerprintOwnership } from '../src/fingerprint/evaluate.ts';
import { writeFileSync } from 'node:fs';
import { fingerprintNotes } from '../src/fingerprint/doctor.ts';
import { verifyPending } from '../src/fingerprint/verify.ts';
import type { FingerprintPrecomputeRequest } from '../src/fingerprint-precompute.ts';

const controller = new AbortController();
const stop = () => controller.abort(new Error('Fingerprint evaluation was cancelled.'));
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
let input = '';
for await (const chunk of process.stdin) input += String(chunk);
const {
  root,
  platform,
  task,
  embedMode,
  pendingFile,
  ownership,
  ...target
}: FingerprintPrecomputeRequest & {
  task?: 'evaluate' | 'notes' | 'verify';
  pendingFile?: string;
  embedMode?: 'development' | 'production';
  ownership: { directory: string; acknowledgement: string; nonce: string };
} = JSON.parse(input);
useParentFingerprintOwnership(ownership.directory);
let result;
let verified = true;
try {
  const request = { root, target: { ...target, platform }, embedMode: embedMode ?? ('development' as const) };
  if (task === 'evaluate') {
    result = await fingerprint(root, request.target, {
      env: process.env,
      embedMode: request.embedMode,
      index: 'skip',
      signal: controller.signal,
    });
  } else if (task === 'notes') {
    result = await fingerprintNotes(request, { env: process.env, signal: controller.signal });
  } else if (task === 'verify') {
    if (!pendingFile) throw new Error('Missing pending fingerprint verification.');
    result = { verified: await verifyPending({ perPass: 1, signal: controller.signal, root, file: pendingFile }) };
  } else {
    const pass = await precomputePass([{ root, target: { ...target, platform }, embedMode: 'development' }], {
      admitted: true,
      signal: controller.signal,
    });
    const computed = pass.precomputed[0];
    result =
      !computed || computed.outcome === 'skipped'
        ? { outcome: 'skipped', reason: computed?.reason ?? 'no precompute result' }
        : { outcome: computed.from === 'index' ? 'present' : 'recorded' };
  }
} catch (error) {
  if (typeof error === 'object' && error !== null && 'reportCleanup' in error) {
    verified = false;
    process.stdout.write(
      JSON.stringify({
        failure: {
          message: 'message' in error ? error.message : undefined,
          code: 'STIM_CLAIM_UNAVAILABLE',
          reportCleanup: true,
          remedy: 'remedy' in error ? error.remedy : undefined,
        },
      }),
    );
    process.exitCode = 0;
  } else
    result =
      task === 'notes'
        ? [{ level: 'warn', message: 'fingerprint check failed' }]
        : task === 'evaluate'
          ? { uncertain: 'fingerprint evaluation failed' }
          : { outcome: 'skipped', reason: error instanceof Error ? error.message : String(error) };
}
if (verified)
  writeFileSync(ownership.acknowledgement, JSON.stringify({ nonce: ownership.nonce, settled: true }), { mode: 0o600 });
if (result !== undefined) process.stdout.write(JSON.stringify(result));
process.off('SIGTERM', stop);
process.off('SIGINT', stop);
