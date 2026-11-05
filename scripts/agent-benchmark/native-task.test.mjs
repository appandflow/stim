import { expect, it } from 'vitest';
import { nativeProcessIdentityValid, nativeSourceProof } from './native-task.mjs';

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

it('rejects missing or malformed process start identities before a native audit can pass', () => {
  expect(nativeProcessIdentityValid('macos', { pid: 42, startSeconds: '123', startMicros: 456 })).toBe(true);
  expect(nativeProcessIdentityValid('ios', { pid: 42 })).toBe(false);
  expect(nativeProcessIdentityValid('macos', { pid: 42, startSeconds: '123', startMicros: 1_000_000 })).toBe(false);
  expect(
    nativeProcessIdentityValid('android', {
      pid: 42,
      bootId: '01234567-89ab-cdef-0123-456789abcdef',
      startTicks: '123',
    }),
  ).toBe(true);
  expect(nativeProcessIdentityValid('android', { pid: 42, bootId: 'unknown', startTicks: '123' })).toBe(false);
});
