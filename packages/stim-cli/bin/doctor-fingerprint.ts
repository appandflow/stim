import * as fingerprint from '@expo/fingerprint';
import { fingerprintProject } from '../src/cache/build-cache.ts';
import type { DoctorFingerprintRequest } from '../src/doctor-fingerprint.ts';

let input = '';
for await (const chunk of process.stdin) input += String(chunk);
const { root, cold, ...options }: DoctorFingerprintRequest = JSON.parse(input);
let result = null;
try {
  result = await fingerprintProject(root, {
    ...options,
    ...(cold
      ? {
          createFingerprint: (projectRoot, requestOptions) =>
            fingerprint.createFingerprintAsync(projectRoot, { ...requestOptions, useRNCoreAutolinkingFromExpo: true }),
        }
      : {}),
  });
} catch {}
process.stdout.write(JSON.stringify(result));
