import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeQaMatrix, manifestDiffIsVersionOnly, renderChecklist, renderMarkdown } from './release-qa-matrix.mjs';
import { pathRules, qaRows } from './release-qa-matrix.data.mjs';

const repositoryRoot = join(import.meta.dirname, '..');

function row(result, id) {
  return result.rows.find((candidate) => candidate.id === id);
}

function directories(relative) {
  return readdirSync(join(repositoryRoot, relative), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.'))
    .map((entry) => `${relative === '.' ? '' : `${relative}/`}${entry.name}`);
}

describe('release QA matrix', () => {
  it('requires only the rows the changed paths reach, with their platform scope and causes', () => {
    const result = computeQaMatrix([
      { path: 'packages/stim-cli/src/engine/gradle.ts', added: 40, removed: 12 },
      { path: 'packages/stim-cli/src/commands/logs.ts', added: 3, removed: 1 },
    ]);

    expect(result.rows.filter((candidate) => candidate.required).map((candidate) => candidate.id)).toEqual([
      'loop',
      'logs',
      'caches',
    ]);
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

  it('prefers the most specific rule over the directory it sits in', () => {
    const specific = computeQaMatrix([{ path: 'packages/stim-cli/src/engine/tunnel.ts', added: 1, removed: 1 }]);
    const fallback = computeQaMatrix([{ path: 'packages/stim-cli/src/engine/new-thing.ts', added: 1, removed: 1 }]);

    expect(specific.rows.filter((candidate) => candidate.required).map((candidate) => candidate.id)).toEqual([
      'remote-provider',
    ]);
    expect(fallback.rows.filter((candidate) => candidate.required).map((candidate) => candidate.id)).toEqual([
      'loop',
      'caches',
      'launch-evidence',
    ]);
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

  it('requires the full matrix when a changed path is outside the mapping', () => {
    const result = computeQaMatrix([{ path: 'daemon/src/main.rs', added: 90, removed: 0 }]);

    expect(result.unclassified).toEqual(['daemon/src/main.rs']);
    expect(result.rows.every((candidate) => candidate.required)).toBe(true);
    expect(row(result, 'android-flavor').reason).toBe(
      'the mapping does not cover daemon/src/main.rs, so the full matrix is required',
    );
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
      '- **android-flavor**: field protocol on a real flavored Android repository. Required by packages/stim-cli/src/engine/apk-swap.ts.',
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
});
