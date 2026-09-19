import { readFileSync, readdirSync } from 'node:fs';
import errors from '../../packages/stim-cli/src/guide/errors.ts';
import { buildTroubleshooting } from './gen-troubleshooting.mjs';

const NOT_A_REFUSAL_CODE = new Set([
  'STIM_ANDROID_CAS_TOOLCHAIN',
  'STIM_METRO_PUBLIC_URL',
  'STIM_POOL_ANDROID_PARKED_MAX',
  'STIM_POOL_IOS_PARKED_MAX',
]);

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
    if (entry.isDirectory()) return ['__tests__', 'guide'].includes(entry.name) ? [] : sourceFiles(child);
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
        .matchAll(/'(STIM_[A-Z_]+)'/g),
    ]
      .map((m) => m[1])
      .filter((code) => !NOT_A_REFUSAL_CODE.has(code)),
  );
  expect(emitted.size).toBeGreaterThan(40);
  expect([...emitted].filter((code) => !anchors.has(code))).toEqual([]);
});

test('the page carries no markup MDX would refuse to parse', () => {
  for (const [name, section] of Object.entries(errors.sections)) {
    expect(`${name}: ${section.body()}`).not.toContain('```');
  }
  const outsideCode = buildTroubleshooting(errors)
    .replace(/```text\n[\s\S]*?\n```/g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/<a id="STIM_[A-Z_]+"><\/a>/g, '')
    .replace(/`[^`]*`/g, '');
  expect(outsideCode).not.toMatch(/[<{]/);
});
