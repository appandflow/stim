import { expect, test } from 'vitest';
import { isBlanked, matchRule, relativeCwd } from '../stim-script.ts';
import type { ScriptRule } from '../types.ts';

const rule = (extra: Partial<ScriptRule>): ScriptRule => ({
  argv: ['logs'],
  stdout: 'x',
  source: 'synthetic',
  note: 'test',
  ...extra,
});

test('an exact rule does not match extra arguments, a prefix rule does', () => {
  expect(matchRule([rule({})], ['logs', '--errors'], '.')).toBeNull();
  expect(matchRule([rule({ prefix: true })], ['logs', '--errors'], '.')).not.toBeNull();
});

test('a prefix longer than the command never matches, so a bare gc is not a dry run', () => {
  expect(matchRule([rule({ argv: ['gc', '--dry-run'], prefix: true })], ['gc'], '.')).toBeNull();
});

test('the first rule whose directory fits answers, so one command can refuse in one directory and work in another', () => {
  const rules = [rule({ cwd: '.', exit: 1 }), rule({ cwd: 'apps/mobile', exit: 0 })];
  expect(matchRule(rules, ['logs'], '.')?.exit).toBe(1);
  expect(matchRule(rules, ['logs'], 'apps/mobile')?.exit).toBe(0);
  expect(matchRule(rules, ['logs'], 'apps/docs')).toBeNull();
});

test('the directory is relative to the workspace root', () => {
  expect(relativeCwd('/w', '/w')).toBe('.');
  expect(relativeCwd('/w', '/w/apps/mobile')).toBe('apps/mobile');
});

test('blanking a guide topic blanks its sections too', () => {
  expect(isBlanked([['guide', 'errors']], ['guide', 'errors', 'STIM_NO_PROJECT'])).toBe(true);
  expect(isBlanked([['guide', 'errors']], ['guide', 'agent'])).toBe(false);
});
