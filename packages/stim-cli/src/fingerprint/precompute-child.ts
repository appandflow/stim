import { writeFileSync } from 'node:fs';
import { observeDetachedChildren } from '../exec.ts';
import type { FingerprintPrecomputeRequest } from '../fingerprint-precompute.ts';
import { recordDetachedGroups } from './detached-groups.ts';
import { fingerprintNotes } from './doctor.ts';
import { fingerprint, useParentFingerprintOwnership } from './evaluate.ts';
import { precomputePass } from './precompute.ts';
import { verifyPending } from './verify.ts';

export type PrecomputeChildInput = FingerprintPrecomputeRequest & {
  task?: 'evaluate' | 'notes' | 'verify';
  pendingFile?: string;
  embedMode?: 'development' | 'production';
  ownership: { directory: string; acknowledgement: string; nonce: string };
};

export async function runPrecomputeChild(
  input: PrecomputeChildInput,
  controller: AbortController,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const { root, platform, task, embedMode, pendingFile, ownership, ...target } = input;
  useParentFingerprintOwnership(ownership.directory);
  observeDetachedChildren(recordDetachedGroups(ownership.directory));
  let result;
  let output: string | undefined;
  let verified = true;
  try {
    const request = { root, target: { ...target, platform }, embedMode: embedMode ?? ('development' as const) };
    if (task === 'evaluate') {
      result = await fingerprint(root, request.target, {
        env,
        embedMode: request.embedMode,
        index: 'skip',
        signal: controller.signal,
      });
    } else if (task === 'notes') {
      result = await fingerprintNotes(request, { env, signal: controller.signal });
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
      output = JSON.stringify({
        failure: {
          message: 'message' in error ? error.message : undefined,
          code: 'STIM_CLAIM_UNAVAILABLE',
          reportCleanup: true,
          remedy: 'remedy' in error ? error.remedy : undefined,
        },
      });
    } else
      result =
        task === 'notes'
          ? [{ level: 'warn', message: 'fingerprint check failed' }]
          : task === 'evaluate'
            ? { uncertain: 'fingerprint evaluation failed' }
            : { outcome: 'skipped', reason: error instanceof Error ? error.message : String(error) };
  }
  if (verified)
    writeFileSync(ownership.acknowledgement, JSON.stringify({ nonce: ownership.nonce, settled: true }), {
      mode: 0o600,
    });
  return result === undefined ? output : JSON.stringify(result);
}
