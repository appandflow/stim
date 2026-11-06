import { describe, expect, it } from 'vitest';
import { buildCompatDigest } from './build-compat.mjs';
import { staticFingerprintProblems } from './static-fingerprint.mjs';

const files = ['packages/stim-cli/src/cache/build-cache.ts', 'packages/stim-cli/src/cache/static-fingerprint.ts'];
const oids = { [files[0]]: 'a1', [files[1]]: 'b1' };
const record = { schema: 2, files, digest: buildCompatDigest(files, oids) };

describe('static fingerprint record', () => {
  it('holds while the listed files and the schema are unchanged', () => {
    expect(staticFingerprintProblems(record, 2, oids)).toEqual([]);
  });

  it('fails when a listed file changes, or the schema moves, until the record is updated', () => {
    const changed = { ...oids, [files[1]]: 'b2' };
    expect(staticFingerprintProblems(record, 2, changed)).toEqual([
      expect.stringContaining('changed since the last record'),
    ]);
    expect(staticFingerprintProblems(record, 3, oids)).toEqual([expect.stringContaining('records static schema 2')]);
    const updated = { schema: 3, files, digest: buildCompatDigest(files, changed) };
    expect(staticFingerprintProblems(updated, 3, changed)).toEqual([]);
  });
});
