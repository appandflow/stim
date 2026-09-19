import { readFileSync, readdirSync } from 'node:fs';
import errors from '../../packages/stim-cli/src/guide/errors.ts';
import { buildTroubleshooting } from './gen-troubleshooting.mjs';

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(child);
    return entry.name.endsWith('.ts') ? [readFileSync(child, 'utf-8')] : [];
  });
}

test('every refusal code the CLI can emit has an anchored entry on the troubleshooting page', () => {
  const page = buildTroubleshooting(errors);
  const anchors = new Set(
    [...page.matchAll(/\{\/\* #(STIM_[A-Z_]+) \*\/\}|<a id="(STIM_[A-Z_]+)"/g)].map((m) => m[1] ?? m[2]),
  );
  const emitted = new Set(
    [
      ...sourceFiles(new URL('../../packages/stim-cli/src/', import.meta.url))
        .join('\n')
        .matchAll(/(?:code:\s*|\.code\s*=\s*)'(STIM_[A-Z_]+)'/g),
    ].map((m) => m[1]),
  );
  expect(emitted.size).toBeGreaterThan(0);
  expect([...emitted].filter((code) => !anchors.has(code))).toEqual([]);
});
