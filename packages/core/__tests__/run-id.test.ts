import { expect, test } from 'vitest';
import { RUN_ID_ENV, validRunId } from '../state/run-id.ts';

test('accepts ids of letters, digits, dot, underscore and dash up to 64 characters', () => {
  expect(validRunId('desktop-2026.10_08')).toBe('desktop-2026.10_08');
  expect(validRunId('a'.repeat(64))).not.toBeNull();
  for (const bad of ['', 'a'.repeat(65), 'has space', 'semi;colon', 'new\nline', 7, undefined]) {
    expect(validRunId(bad)).toBeNull();
  }
  expect(RUN_ID_ENV).toBe('STIM_RUN_ID');
});
