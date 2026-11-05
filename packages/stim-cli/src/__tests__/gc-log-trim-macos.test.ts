import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getExecutor, resetExecutor, setExecutor } from '../exec.ts';
import { collectWorkspaceLogs, trimWorkspaceLogs } from '../commands/gc/logs.ts';
import { testContext } from './_context.ts';
import { operationState } from '../engine/operation-state.ts';
import { macosDir } from '../macos/state.ts';
import { saveConfig, upsertProject } from '../workspace/config.ts';
import { ensureWorkspaceStorage, workspaceDir } from '../workspace/paths.ts';
import { WorkspaceProcessCleanupError } from '../engine/workspace-process-lock.ts';
import { releaseClaim, readClaimSet, type ClaimHandle } from '../ownership-claim.ts';
import { LOG_ROTATE_BYTES } from '@stim-cli/core';

let tmpHome: string;
let projects: string;

beforeEach(() => {
  tmpHome = realpathSync(mkdtempSync(join(tmpdir(), 'stim-test-')));
  process.env.STIM_HOME = tmpHome;
  vi.stubEnv('HOME', tmpHome);
  vi.stubEnv('USERPROFILE', tmpHome);
  vi.stubEnv('AGENT_DEVICE_STATE_DIR', '');
  vi.stubEnv('AGENT_DEVICE_IOS_RUNNER_LEASE_DIR', '');
  projects = realpathSync(mkdtempSync(join(tmpdir(), 'stim-projects-')));
  const real = getExecutor();
  setExecutor({
    ...real,
    run: () => '',
    runQuiet: () => null,
    runFile: (file, args, opts) => (file === 'du' || file === 'git' ? real.runFile(file, args, opts) : ''),
    runFileQuiet: (file, args, opts) => (file === 'git' ? real.runFileQuiet(file, args, opts) : null),
    findExecutable: (name) => (name === 'gh' ? null : real.findExecutable(name)),
    spawn: () => {
      throw new Error('unexpected spawn');
    },
  });
  saveConfig({ version: 2, projects: {}, repos: {} });
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetExecutor();
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(projects, { recursive: true, force: true });
  delete process.env.STIM_HOME;
  process.exitCode = 0;
});

function loggedWorkspace(name: string): { root: string; logs: string } {
  const root = join(projects, name);
  mkdirSync(root, { recursive: true });
  const logs = join(ensureWorkspaceStorage(root), 'logs');
  mkdirSync(logs, { recursive: true });
  upsertProject(root, { metroPort: 8100 });
  return { root, logs };
}

function oversizedLog(file: string): void {
  const line = `${JSON.stringify({ msg: 'x'.repeat(1000) })}\n`;
  writeFileSync(file, `${line.repeat(Math.ceil((2 * LOG_ROTATE_BYTES + 64 * 1024) / line.length))}{"msg":"last"}\n`);
}

test.skipIf(process.platform !== 'darwin')(
  'log trim preserves its actual admission claim when a native safety probe cannot be drained',
  async () => {
    const workspace = loggedWorkspace('probe-refusal');
    const file = join(workspace.logs, 'metro.ndjson');
    oversizedLog(file);
    const original = readFileSync(file);
    const report = await collectWorkspaceLogs();
    mkdirSync(macosDir(workspace.root), { recursive: true });
    const operation = testContext();
    const current = getExecutor();
    let claims: ClaimHandle[] = [];
    setExecutor({
      ...current,
      runFileAsync: async (tool, args, options) => {
        if (tool !== 'ps') return current.runFileAsync(tool, args, options);
        claims = [...operationState(operation).declaring];
        throw new WorkspaceProcessCleanupError(claims, 'Probe cleanup is unknown', 'Verify the recorded probe.');
      },
    });
    try {
      await expect(trimWorkspaceLogs(report, undefined, operation)).rejects.toMatchObject({
        code: 'STIM_CLAIM_UNAVAILABLE',
        remedy: expect.stringContaining('native-run.lock'),
      });
      expect(claims).toHaveLength(1);
      expect(readClaimSet(join(workspaceDir(workspace.root), 'native-run.lock')).live).toHaveLength(1);
      expect(readFileSync(file).equals(original)).toBe(true);
    } finally {
      for (const claim of claims) releaseClaim(claim);
    }
  },
);
