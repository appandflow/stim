import { createHash } from 'node:crypto';

export function manifestDigest(entries: readonly { path: string; kind: string; sha256: string }[]): string {
  const hash = createHash('sha256');
  for (const entry of entries.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`${entry.path}\0${entry.kind}\0${entry.sha256}\n`);
  }
  return hash.digest('hex');
}
