import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EAS_TEST_GUARD_ROOT_ENV, recordEasSessionClaim } from '../engine/eas-session-ledger.ts';
import { withEasProjectLock } from '../engine/eas-project-lock.ts';

const LEDGER_URL = new URL('../engine/eas-session-ledger.ts', import.meta.url).href;
const PATHS_URL = new URL('../workspace/paths.ts', import.meta.url).href;

const CHILD_SCRIPT = `
const { recordEasSessionClaim } = await import(process.argv[1]);
const { workspaceStateFile } = await import(process.argv[2]);
const workspaceRoot = process.argv[3];
recordEasSessionClaim({
  sessionId: 'drs_child',
  name: 'stim-child',
  platform: 'ios',
  workspaceRoot,
  workspaceHome: process.argv[4],
  stateFile: workspaceStateFile(workspaceRoot),
});
`;

function claimFor(workspaceRoot: string, workspaceHome: string) {
  return {
    sessionId: 'drs_guard',
    name: 'stim-guard',
    platform: 'ios' as const,
    workspaceRoot,
    workspaceHome,
    stateFile: join(workspaceHome, 'workspaces', 'root', 'state.json'),
  };
}

test('recordEasSessionClaim refuses to write the real EAS machine root from the test process', () => {
  expect(() => recordEasSessionClaim(claimFor('/tmp/stim-guard-root', '/tmp/stim-guard-home'))).toThrow(
    /Refusing to write the real EAS machine root/,
  );
});

test('withEasProjectLock refuses to use the real EAS machine root from the test process', () => {
  const fn = vi.fn<() => Promise<string>>(async () => 'ran');
  expect(() => withEasProjectLock('/tmp/stim-guard-root', fn)).toThrow(/Refusing to write the real EAS machine root/);
  expect(fn).not.toHaveBeenCalled();
});

test('a write by a process without the test guard marker succeeds', async () => {
  const childHome = mkdtempSync(join(tmpdir(), 'stim-guard-home-'));
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'stim-guard-ws-'));
  try {
    const { [EAS_TEST_GUARD_ROOT_ENV]: _omit, ...childEnv } = process.env;
    await new Promise<void>((resolve, reject) => {
      let stderr = '';
      const child = spawn(
        process.execPath,
        ['--input-type=module', '-e', CHILD_SCRIPT, LEDGER_URL, PATHS_URL, workspaceRoot, childHome],
        {
          env: { ...childEnv, HOME: childHome, USERPROFILE: childHome, STIM_HOME: childHome },
          stdio: ['ignore', 'ignore', 'pipe'],
        },
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

    const sessionsFile = join(childHome, '.stim', 'machine', 'eas', 'sessions.json');
    expect(existsSync(sessionsFile)).toBe(true);
    expect(JSON.parse(readFileSync(sessionsFile, 'utf-8')).claims.drs_child.name).toBe('stim-child');
  } finally {
    rmSync(childHome, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
