import { join } from 'node:path';
import { inPrivacyProtectedFolder, parseGitStatus } from '../workspace/git-summary.ts';

const oid = 'a'.repeat(40);

test('parseGitStatus counts changed and untracked entries and reads ahead and behind', () => {
  const text = [
    `# branch.oid ${oid}`,
    '# branch.head feature',
    '# branch.upstream origin/feature',
    '# branch.ab +3 -1',
    `1 .M N... 100644 100644 100644 ${oid} ${oid} src/a.ts`,
    `1 A. N... 000000 100644 100644 ${'0'.repeat(40)} ${oid} src/b.ts`,
    `2 R. N... 100644 100644 100644 ${oid} ${oid} R100 src/c.ts\tsrc/old c.ts`,
    `u UU N... 100644 100644 100644 100644 ${oid} ${oid} ${oid} src/d.ts`,
    '? scratch/',
    '? notes.txt',
  ].join('\n');
  expect(parseGitStatus(text)).toEqual({
    head: oid,
    changed: 4,
    untracked: 2,
    upstream: 'origin/feature',
    ahead: 3,
    behind: 1,
  });
});

test('parseGitStatus leaves ahead and behind null when the upstream is gone or missing, and head null when unborn', () => {
  expect(parseGitStatus(`# branch.oid ${oid}\n# branch.head feature\n# branch.upstream origin/feature`)).toEqual({
    head: oid,
    changed: 0,
    untracked: 0,
    upstream: 'origin/feature',
    ahead: null,
    behind: null,
  });
  expect(parseGitStatus('# branch.oid (initial)\n# branch.head main\n? a.txt')).toMatchObject({
    head: null,
    untracked: 1,
    upstream: null,
    ahead: null,
  });
});

test('inPrivacyProtectedFolder matches the folders macOS guards and nothing that only shares a prefix', () => {
  const home = '/Users/me';
  expect(inPrivacyProtectedFolder(join(home, 'Documents', 'Codex', 'stim'), home)).toBe(true);
  expect(inPrivacyProtectedFolder(join(home, 'Library', 'Mobile Documents', 'repo'), home)).toBe(true);
  expect(inPrivacyProtectedFolder('/Volumes/External/repo', home)).toBe(true);
  expect(inPrivacyProtectedFolder(join(home, 'Documentsx', 'repo'), home)).toBe(false);
  expect(inPrivacyProtectedFolder(join(home, 'Developer', 'Documents'), home)).toBe(false);
});
