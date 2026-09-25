import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EAS_TEST_GUARD_ROOT_ENV } from '../engine/eas-machine-root-guard-env.ts';
import { recordEasSessionClaim } from '../engine/eas-session-ledger.ts';
import { withEasProjectLock } from '../engine/eas-project-lock.ts';

const LEDGER_URL = new URL('../engine/eas-session-ledger.ts', import.meta.url).href;
const PATHS_URL = new URL('../workspace/paths.ts', import.meta.url).href;

const CHILD_SCRIPT = `
const { recordEasSessionClaim } = await import(process.argv[1]);
const { workspaceStateFile } = await import(process.argv[2]);
const root = process.argv[3];
const workspaceRoot = process.argv[4];
const workspaceHome = process.argv[5];
recordEasSessionClaim(
  {
    sessionId: 'drs_child',
    name: 'stim-child',
    platform: 'ios',
    workspaceRoot,
    workspaceHome,
    stateFile: workspaceStateFile(workspaceRoot),
  },
  root,
);
`;

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

test('recordEasSessionClaim refuses to write the guarded root from the test process', () => {
  const claim = {
    sessionId: 'drs_guard',
    name: 'stim-guard',
    platform: 'ios' as const,
    workspaceRoot: '/tmp/stim-guard-root',
    workspaceHome: '/tmp/stim-guard-home',
    stateFile: '/tmp/stim-guard-home/workspaces/root/state.json',
  };
  expect(() => recordEasSessionClaim(claim, guardedRoot)).toThrow(/Refusing to write the real EAS machine root/);
  expect(existsSync(join(guardedRoot, 'sessions.json'))).toBe(false);
});

test('withEasProjectLock refuses to use the guarded root from the test process', () => {
  const fn = vi.fn<() => Promise<string>>(async () => 'ran');
  expect(() => withEasProjectLock('/tmp/stim-guard-root', fn, { machineRoot: guardedRoot })).toThrow(
    /Refusing to write the real EAS machine root/,
  );
  expect(fn).not.toHaveBeenCalled();
});

test('a write to the same root by a process without the guard marker succeeds', async () => {
  const workspaceHome = mkdtempSync(join(tmpdir(), 'stim-guard-home-'));
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'stim-guard-ws-'));
  try {
    const { [EAS_TEST_GUARD_ROOT_ENV]: _omit, ...childEnv } = process.env;
    await new Promise<void>((resolve, reject) => {
      let stderr = '';
      const child = spawn(
        process.execPath,
        ['--input-type=module', '-e', CHILD_SCRIPT, LEDGER_URL, PATHS_URL, guardedRoot, workspaceRoot, workspaceHome],
        { env: { ...childEnv, STIM_HOME: workspaceHome }, stdio: ['ignore', 'ignore', 'pipe'] },
      );
      child.stderr?.setEncoding('utf-8');
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`guard child failed (${signal || code}): ${stderr}`));
      });
    });

    const sessionsFile = join(guardedRoot, 'sessions.json');
    expect(existsSync(sessionsFile)).toBe(true);
    expect(JSON.parse(readFileSync(sessionsFile, 'utf-8')).claims.drs_child.name).toBe('stim-child');
  } finally {
    rmSync(workspaceHome, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
