import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EAS_TEST_GUARD_ROOT_ENV } from '../engine/eas-machine-root-guard-env.ts';
import { recordEasSessionClaim } from '../engine/eas-session-ledger.ts';

// A stand-in for the real ~/.stim/machine/eas, so a test that regresses the
// guard writes here instead of the real machine state.
let guardedRoot: string;
let previousGuardEnv: string | undefined;

beforeEach(() => {
  guardedRoot = mkdtempSync(join(tmpdir(), 'stim-guard-root-'));
  previousGuardEnv = process.env[EAS_TEST_GUARD_ROOT_ENV];
  process.env[EAS_TEST_GUARD_ROOT_ENV] = guardedRoot;
});

afterEach(() => {
  if (previousGuardEnv === undefined) delete process.env[EAS_TEST_GUARD_ROOT_ENV];
  else process.env[EAS_TEST_GUARD_ROOT_ENV] = previousGuardEnv;
  rmSync(guardedRoot, { recursive: true, force: true });
});

test('recordEasSessionClaim refuses to write the guarded root from the test process', async () => {
  const claim = {
    sessionId: 'drs_guard',
    name: 'stim-guard',
    platform: 'ios' as const,
    workspaceRoot: '/tmp/stim-guard-root',
    workspaceHome: '/tmp/stim-guard-home',
    stateFile: '/tmp/stim-guard-home/workspaces/root/state.json',
  };
  await expect(recordEasSessionClaim(claim, guardedRoot)).rejects.toThrow(
    /Refusing to write the real EAS machine root/,
  );
  expect(existsSync(join(guardedRoot, 'sessions.json'))).toBe(false);
});
