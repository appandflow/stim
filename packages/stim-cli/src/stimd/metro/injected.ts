import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stimBuildDigest } from '@stim-cli/core/state';

/** The directory of the files Stim injects into a project's Metro: `dist/injected` in a build, `src/injected` in a checkout. */
export function injectedDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['./injected', '../../injected']) {
    const candidate = resolve(here, rel);
    if (existsSync(resolve(candidate, 'metro-host.cjs'))) return candidate;
  }
  return null;
}

let digest: string | null | undefined;

/** The digest of this build's injected files, which a Metro it starts records in its claim and stamps on its records. */
export function injectedDigest(): string | null {
  if (digest === undefined) {
    const dir = injectedDir();
    digest = dir ? stimBuildDigest(dir, '.cjs') : null;
  }
  return digest;
}

/** `metro.ndjson` or `client.ndjson` lines, or parsed records, without those a Metro of other injected files wrote. */
// compat C6 permanent
const foreign = (inj: unknown) => typeof inj === 'string' && injectedDigest() !== null && inj !== injectedDigest();
export const ownBuildLines = (lines: string[]): string[] =>
  lines.filter((line) => !foreign(/"inj":"([^"]*)"/.exec(line)?.[1]));
export const ownBuildRecords = <T extends object>(records: T[]): T[] =>
  records.filter((record) => !('inj' in record && foreign(record.inj)));
// compat end
