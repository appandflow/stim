import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../fingerprint/verify.ts');
  vi.doUnmock('../fingerprint/evaluate.ts');
  vi.doUnmock('../fingerprint/doctor.ts');
  vi.doUnmock('../fingerprint/precompute.ts');
  vi.resetModules();
});

test.each([
  ['plain object', () => ({ reportCleanup: true, message: 'unverified', remedy: 'inspect the child' })],
  ['Error', () => Object.assign(new Error('unverified'), { reportCleanup: true, remedy: 'inspect the child' })],
] as const)('the report entry does not acknowledge a marked %s cleanup failure', async (_kind, failure) => {
  const directory = mkdtempSync(join(tmpdir(), 'stim-fp-entry-'));
  const acknowledgement = join(directory, 'settled.json');
  const request = {
    root: directory,
    platform: 'ios',
    task: 'verify',
    pendingFile: 'pending.json',
    ownership: { directory, acknowledgement, nonce: 'fixture' },
  };
  vi.doMock('../fingerprint/verify.ts', () => ({
    verifyPending: async () => {
      throw failure();
    },
  }));
  vi.doMock('../fingerprint/evaluate.ts', () => ({
    fingerprint: vi.fn<() => void>(),
    useParentFingerprintOwnership: vi.fn<() => void>(),
  }));
  vi.doMock('../fingerprint/doctor.ts', () => ({ fingerprintNotes: vi.fn<() => void>() }));
  vi.doMock('../fingerprint/precompute.ts', () => ({ precomputePass: vi.fn<() => void>() }));
  const stdin = vi
    .spyOn(process, 'stdin', 'get')
    .mockReturnValue(Readable.from([JSON.stringify(request)]) as typeof process.stdin);
  let output = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  const exitCode = process.exitCode;
  try {
    await import('../../bin/fingerprint-precompute.ts');
    expect(existsSync(acknowledgement)).toBe(false);
    expect(JSON.parse(output)).toMatchObject({
      failure: { code: 'STIM_CLAIM_UNAVAILABLE', reportCleanup: true, message: 'unverified' },
    });
  } finally {
    process.exitCode = exitCode;
    stdin.mockRestore();
    stdout.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
