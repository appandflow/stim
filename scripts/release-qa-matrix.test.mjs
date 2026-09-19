import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeQaMatrix, manifestDiffIsVersionOnly, renderChecklist, renderMarkdown } from './release-qa-matrix.mjs';
import { pathRules, qaRows } from './release-qa-matrix.data.mjs';

const repositoryRoot = join(import.meta.dirname, '..');

function row(result, id) {
  return result.rows.find((candidate) => candidate.id === id);
}

function requiredIds(result) {
  return result.rows.filter((candidate) => candidate.required).map((candidate) => candidate.id);
}

function directories(relative) {
  return readdirSync(join(repositoryRoot, relative), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.'))
    .map((entry) => `${relative === '.' ? '' : `${relative}/`}${entry.name}`);
}

function isDirectoryRule(path) {
  return !path.split('/').pop().includes('.');
}

function releaseTable() {
  const text = readFileSync(join(repositoryRoot, 'RELEASE.md'), 'utf8');
  const lines = text.slice(text.indexOf('## 3. Pre-tag QA gate')).split('\n');
  const header = lines.findIndex((line) => line.startsWith('| Change since the last release'));
  const rows = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) break;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    rows.push({ change: cells[0], evidence: cells[1] });
  }
  return rows;
}

describe('release QA matrix', () => {
  it('requires only the rows the changed paths reach, with their platform scope and causes', () => {
    const result = computeQaMatrix([
      { path: 'packages/stim-cli/src/engine/gradle.ts', added: 40, removed: 12 },
      { path: 'packages/stim-cli/src/commands/logs.ts', added: 3, removed: 1 },
    ]);

    expect(requiredIds(result)).toEqual(['loop', 'logs', 'caches']);
    expect(row(result, 'caches')).toMatchObject({
      platforms: ['android'],
      reason: 'packages/stim-cli/src/engine/gradle.ts',
    });
    expect(row(result, 'logs').platforms).toEqual(['ios', 'android']);
    expect(row(result, 'release-build')).toMatchObject({
      required: false,
      reason: 'no changed path touches release build or JS/APK swap behavior',
    });
  });

  it('narrows at file level and falls back to every row for an unmapped file', () => {
    const specific = computeQaMatrix([{ path: 'packages/stim-cli/src/engine/tunnel.ts', added: 1, removed: 1 }]);
    const fallback = computeQaMatrix([{ path: 'packages/stim-cli/src/engine/new-thing.ts', added: 1, removed: 1 }]);

    expect(requiredIds(specific)).toEqual(['remote-provider']);
    expect(requiredIds(fallback)).toEqual(qaRows.map((candidate) => candidate.id));
  });

  it('drops a documentation change and the candidate version bump without requiring a row', () => {
    const result = computeQaMatrix([
      { path: 'docs/releases/1.7.0.md', added: 20, removed: 0 },
      {
        path: 'packages/core/package.json',
        added: 1,
        removed: 1,
        exemptReason: 'version field only, the release candidate bump',
      },
    ]);

    expect(result.rows.some((candidate) => candidate.required)).toBe(false);
    expect(result.exempt).toEqual([
      { path: 'docs/releases/1.7.0.md', reason: 'documentation' },
      { path: 'packages/core/package.json', reason: 'version field only, the release candidate bump' },
    ]);
    expect(row(result, 'caches').reason).toBe(
      'no changed path touches build, cache, fingerprint, Pods, Metro, single-flight, or gc behavior',
    );
  });

  it('reads a manifest diff as a version bump only when nothing else moved', () => {
    const bump =
      '--- a/packages/core/package.json\n+++ b/packages/core/package.json\n-  "version": "1.6.0",\n+  "version": "1.7.0",\n';
    const dependency = `${bump}-    "unique-pid": "^1.0.0",\n+    "unique-pid": "^2.0.0",\n`;

    expect(manifestDiffIsVersionOnly(bump)).toBe(true);
    expect(manifestDiffIsVersionOnly(dependency)).toBe(false);
    expect(manifestDiffIsVersionOnly('')).toBe(false);
  });

  it('requires the full matrix when a changed path is outside the mapping, and says so in both renderings', () => {
    const result = computeQaMatrix([{ path: 'daemon/src/main.rs', added: 90, removed: 0 }]);
    const context = { range: 'v1.6.0..HEAD', command: 'node scripts/release-qa-matrix.mjs v1.6.0' };

    expect(result.unclassified).toEqual(['daemon/src/main.rs']);
    expect(result.rows.every((candidate) => candidate.required)).toBe(true);
    expect(renderChecklist(result, context)).toContain(
      'Unclassified paths (the full matrix is required until the mapping covers them)',
    );

    const markdown = renderMarkdown(result, context);
    expect(markdown).toContain(
      '- **android-flavor**: field protocol on a real flavored Android repository. Required because the mapping does not cover daemon/src/main.rs, so the full matrix is required.',
    );
    expect(markdown).toContain('Unclassified paths, which require every row until the mapping covers them:');
    expect(markdown).toContain('- `daemon/src/main.rs`');
  });

  it('renders a checklist and a release-note QA section carrying both decisions', () => {
    const result = computeQaMatrix([
      { path: 'packages/stim-cli/src/engine/apk-swap.ts', added: 8, removed: 2 },
      { path: 'docs/testing.md', added: 4, removed: 4 },
    ]);
    const context = { range: 'v1.6.0..HEAD', command: 'node scripts/release-qa-matrix.mjs v1.6.0' };

    const checklist = renderChecklist(result, context);
    expect(checklist).toContain('[ ] release-build  android');
    expect(checklist).toContain('      because: packages/stim-cli/src/engine/apk-swap.ts');
    expect(checklist).toContain('  [-] logs');
    expect(checklist).toContain('  documentation (1): docs/testing.md');

    const markdown = renderMarkdown(result, context);
    expect(markdown).toContain('## QA');
    expect(markdown).toContain(
      '- **android-flavor**: field protocol on a real flavored Android repository. Required by `packages/stim-cli/src/engine/apk-swap.ts`.',
    );
    expect(markdown).toContain('- **real-repository**: no changed path touches project detection');
  });

  it('covers every top-level source directory and names only rows the table defines', () => {
    const covered = new Set(pathRules.map((rule) => rule.path));
    const sourceDirectories = [
      ...directories('.').filter((name) => name !== 'packages'),
      ...directories('packages'),
      ...directories('packages/stim-cli/src'),
    ];

    expect(sourceDirectories.filter((directory) => !covered.has(directory))).toEqual([]);
    expect(pathRules.length).toBe(covered.size);

    const ids = new Set(qaRows.map((candidate) => candidate.id));
    for (const rule of pathRules) {
      expect(Boolean(rule.exempt) !== Boolean(rule.rows)).toBe(true);
      for (const id of rule.rows ?? []) expect(ids).toContain(id);
    }
  });

  it('never lets a directory fallback require fewer rows than the directory above it', () => {
    const withRows = pathRules.filter((rule) => rule.rows);
    const violations = [];
    for (const rule of withRows) {
      if (!isDirectoryRule(rule.path)) continue;
      const ancestors = withRows.filter((other) => rule.path.startsWith(`${other.path}/`));
      if (ancestors.length === 0) continue;
      const parent = ancestors.reduce((best, other) => (other.path.length > best.path.length ? other : best));
      for (const id of parent.rows) {
        if (!rule.rows.includes(id)) violations.push(`${rule.path} drops ${id} required by ${parent.path}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps the row wording identical to the RELEASE.md section 3 table', () => {
    expect(qaRows.map(({ change, evidence }) => ({ change, evidence }))).toEqual(releaseTable());
  });
});
