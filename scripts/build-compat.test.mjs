import { describe, expect, it } from 'vitest';
import { buildCompatDigest, buildCompatProblems } from './build-compat.mjs';

const files = ['packages/stim-cli/src/offload/worker.ts', 'packages/server/src/build.ts'];
const oids = { [files[0]]: 'a1', [files[1]]: 'b1' };
const record = { compat: 1, files, digest: buildCompatDigest(files, oids) };

describe('build compatibility record', () => {
  it('holds while the listed files and the constant are unchanged', () => {
    expect(buildCompatProblems(record, 1, oids)).toEqual([]);
    expect(buildCompatDigest(files.toReversed(), oids)).toBe(record.digest);
  });

  it('fails when a listed file changes until the record names a bump or no bump', () => {
    const changed = { ...oids, [files[1]]: 'b2' };
    expect(buildCompatProblems(record, 1, changed)).toEqual([expect.stringContaining('changed since the last record')]);
    expect(buildCompatProblems({ ...record, digest: buildCompatDigest(files, changed) }, 1, changed)).toEqual([]);
    expect(buildCompatProblems({ compat: 2, files, digest: buildCompatDigest(files, changed) }, 2, changed)).toEqual(
      [],
    );
  });

  it('fails when the constant and the recorded version disagree, or a listed file is gone', () => {
    expect(buildCompatProblems(record, 2, oids)).toEqual([expect.stringContaining('records build compatibility 1')]);
    expect(buildCompatProblems(record, 1, { [files[0]]: 'a1' })).toEqual([
      expect.stringContaining(`missing: ${files[1]}`),
    ]);
  });
});
