import { setPriority } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { StimContext } from '@stim-cli/core';
import { getExecutor } from './exec.ts';
import type { AndroidLayout } from './workspace/settings.ts';
import type { FingerprintPrecompute } from './cache/fingerprint-memo.ts';

const PRECOMPUTE_TIMEOUT_MS = 120_000;

export interface FingerprintPrecomputeRequest {
  root: string;
  platform: 'ios' | 'android';
  iosProjectPath?: string;
  androidLayout?: AndroidLayout;
}

/** Runs `precomputeFingerprint` in a child process at low priority, so the caller's event loop never hosts the project's code. */
export async function runFingerprintPrecompute(
  operation: StimContext,
  request: FingerprintPrecomputeRequest,
): Promise<FingerprintPrecompute> {
  const output = await getExecutor().runFileAsync(
    process.execPath,
    [fileURLToPath(new URL('../dist/fingerprint-precompute.mjs', import.meta.url))],
    {
      cwd: request.root,
      env: Object.fromEntries(
        Object.entries(operation.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
      input: JSON.stringify(request),
      timeoutMs: PRECOMPUTE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      signal: operation.signal,
      onSpawn: (child) => {
        try {
          if (child.pid) setPriority(child.pid, 10);
        } catch {}
      },
    },
  );
  return JSON.parse(output);
}
