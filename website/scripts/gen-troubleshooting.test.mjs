import errors from '../../packages/stim-cli/src/guide/errors.ts';
import { buildTroubleshooting } from './gen-troubleshooting.mjs';

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
