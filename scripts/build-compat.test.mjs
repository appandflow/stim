import { describe, expect, it } from 'vitest';
import { buildCompatDigest, buildCompatFiles, buildCompatProblems } from './build-compat.mjs';

const files = ['packages/server/src/build.ts', 'packages/stim-cli/src/offload/worker.ts'];
const oids = { [files[0]]: 'a1', [files[1]]: 'b1' };
const record = { compat: 1, files, digest: buildCompatDigest(files, oids) };

describe('build compatibility record', () => {
  it('holds while the listed files and the constant are unchanged', () => {
    expect(buildCompatProblems(record, 1, files, oids)).toEqual([]);
    expect(buildCompatDigest(files.toReversed(), oids)).toBe(record.digest);
  });

  it('fails when a listed file changes until the record names a bump or no bump', () => {
    const changed = { ...oids, [files[1]]: 'b2' };
    expect(buildCompatProblems(record, 1, files, changed)).toEqual([
      expect.stringContaining('changed since the last record'),
    ]);
    const recorded = buildCompatDigest(files, changed);
    expect(buildCompatProblems({ ...record, digest: recorded }, 1, files, changed)).toEqual([]);
    expect(buildCompatProblems({ compat: 2, files, digest: recorded }, 2, files, changed)).toEqual([]);
  });

  it('fails when the constant and the recorded version disagree, or a listed file is gone', () => {
    expect(buildCompatProblems(record, 2, files, oids)).toEqual([
      expect.stringContaining('records build compatibility 1'),
    ]);
    expect(buildCompatProblems(record, 1, files, { [files[0]]: 'a1' })).toEqual([
      expect.stringContaining(`missing: ${files[1]}`),
    ]);
  });

  it('covers every TypeScript source in a listed directory, so a new file there fails the record', () => {
    const tracked = [
      'packages/stim-cli/src/offload/worker.ts',
      'packages/stim-cli/src/offload/__tests__/worker.test.ts',
      'packages/stim-cli/src/offload/README.md',
      'packages/stim-cli/src/offloaded.ts',
    ];
    const entries = ['packages/server/src/build.ts', 'packages/stim-cli/src/offload/'];
    expect(buildCompatFiles(entries, tracked)).toEqual(files);
    const added = buildCompatFiles(entries, [...tracked, 'packages/stim-cli/src/offload/client.ts']);
    expect(buildCompatProblems(record, 1, added, { ...oids, 'packages/stim-cli/src/offload/client.ts': 'c1' })).toEqual(
      [expect.stringContaining('changed since the last record')],
    );
  });
});
