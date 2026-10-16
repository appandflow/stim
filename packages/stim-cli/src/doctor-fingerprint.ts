import { fileURLToPath } from 'node:url';
import type { AndroidLayout } from './workspace/settings.ts';
import type { StimContext } from '@stim-cli/core';
import type { ProjectFingerprint } from './cache/build-cache.ts';
import { getExecutor } from './exec.ts';

export interface DoctorFingerprintRequest {
  root: string;
  platform?: string;
  iosProjectPath?: string;
  androidLayout?: AndroidLayout;
  debug?: boolean;
  cold?: boolean;
}

export async function readDoctorFingerprint(
  operation: StimContext,
  request: DoctorFingerprintRequest,
): Promise<ProjectFingerprint | null> {
  const output = await getExecutor().runFileAsync(
    process.execPath,
    [fileURLToPath(new URL('../dist/doctor-fingerprint.mjs', import.meta.url))],
    {
      cwd: operation.cwd,
      env: Object.fromEntries(
        Object.entries(operation.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
      input: JSON.stringify(request),
      timeoutMs: 60_000,
      killSignal: 'SIGKILL',
      signal: operation.signal,
    },
  );
  const result: ProjectFingerprint | null = JSON.parse(output);
  return result;
}
