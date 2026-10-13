import { expect, it } from 'vitest';
import { nativeSourceProof } from './native-task.mjs';

it('rejects an unchanged revision or unrelated source changes despite a matching screenshot marker', () => {
  const before = 'Text("native-revision-one")\n';
  const input = {
    before,
    after: 'Text("revision-run-one")\n',
    marker: 'revision-run-one',
    source: 'App.swift',
    changedPaths: ['App.swift'],
  };
  expect(nativeSourceProof(input)).toBe(true);
  expect(nativeSourceProof({ ...input, after: before })).toBe(false);
  expect(nativeSourceProof({ ...input, after: input.after + 'Text("Count: 1")\n' })).toBe(false);
  expect(nativeSourceProof({ ...input, changedPaths: ['App.swift', 'Package.swift'] })).toBe(false);
});
