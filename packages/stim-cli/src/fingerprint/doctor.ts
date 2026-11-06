import { realpathSync } from 'node:fs';
import { fingerprint } from './evaluate.ts';
import { installRoot } from './inputs.ts';
import { diffInputs, isUncertain } from './key.ts';
import { lockfileClassifier } from './provenance.ts';
import { disagreementCount, type VerifyRequest } from './verify.ts';

export interface FingerprintNote {
  level: 'warn' | 'info';
  message: string;
  remedy?: string;
}

const APPLIED_CONFIG_KEYS = new Set(['extraSources']);

/**
 * What `doctor` reports about Stim's own fingerprint of a workspace: computing it twice without the index (the key
 * must not move), why none can be computed, opaque parts, ignored `fingerprint.config.js` keys, a lockfile the
 * provenance readers cannot classify, inputs outside the project, names that differ only by case, and the index
 * disagreements counted on this machine.
 */
export async function fingerprintNotes(
  request: VerifyRequest,
  { env, signal }: { env: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<FingerprintNote[]> {
  const notes: FingerprintNote[] = [];
  const opts = { env, embedMode: request.embedMode, index: 'skip' as const, signal };
  const first = await fingerprint(request.root, request.target, opts);
  if (isUncertain(first))
    return [{ level: 'warn', message: `no build-cache key: ${first.uncertain}`, remedy: first.remedy }];
  const second = await fingerprint(request.root, request.target, opts);
  if (isUncertain(second) || second.hash !== first.hash) {
    const moved = isUncertain(second) ? [second.uncertain] : diffInputs(first.inputs, second.inputs).map((c) => c.name);
    notes.push({ level: 'warn', message: `the build-cache key moved between two computations: ${moved.join(', ')}` });
  }
  for (const part of first.opaque)
    notes.push({ level: 'info', message: `${part}, so its result is recomputed on every run instead of reused` });
  for (const key of first.fingerprintConfigKeys.filter((name) => !APPLIED_CONFIG_KEYS.has(name)))
    notes.push({
      level: 'info',
      message: `fingerprint.config.js ${key} is ignored by Stim's build-cache key`,
      remedy: key === 'preset' ? 'List extra native inputs in cache.fingerprintInputs.' : undefined,
    });
  if (lockfileClassifier(installRoot(realpathSync.native(request.root))).lockfile === null)
    notes.push({
      level: 'info',
      message: 'no readable lockfile, so every native package is hashed by its files',
      remedy: 'Commit a text lockfile (package-lock.json, pnpm-lock.yaml, yarn.lock or bun.lock).',
    });
  if (!first.portable)
    notes.push({ level: 'info', message: 'an input lies outside the project, so builds are not offloaded' });
  const byCase = new Map<string, string[]>();
  for (const { name } of first.inputs)
    byCase.set(name.toLowerCase(), [...(byCase.get(name.toLowerCase()) ?? []), name]);
  for (const names of byCase.values())
    if (names.length > 1) notes.push({ level: 'warn', message: `inputs differ only by case: ${names.join(', ')}` });
  const disagreements = disagreementCount();
  if (disagreements > 0)
    notes.push({ level: 'warn', message: `${disagreements} index hits disagreed with a full computation` });
  return notes;
}
