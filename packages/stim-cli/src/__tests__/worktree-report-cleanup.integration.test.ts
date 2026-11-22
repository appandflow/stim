import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as iosDevices from '../devices/ios.ts';
import * as agentSessions from '../agent-sessions.ts';
import { savedWorktreeUse } from '../commands/gc/worktrees.ts';
import { saveConfig } from '../workspace/config.ts';
import { getExecutor } from '../exec.ts';
import { runOperationFile } from '../engine/operation-exec.ts';
import { testContext } from './_context.ts';

test('cancelling shared worktree inventory settles its native child before returning', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-worktree-report-cleanup-')));
  const root = join(base, 'app');
  mkdirSync(root);
  vi.stubEnv('STIM_HOME', join(base, 'home'));
  saveConfig({ projects: { [root]: { platforms: { ios: { owned: true, deviceUdid: 'U1' } } } }, repos: {} });
  const controller = new AbortController();
  const reason = new Error('controlled inventory cancellation');
  const pidFile = join(base, 'pid');
  let native: Promise<string> | undefined;
  const agents = vi.spyOn(agentSessions, 'discoverAgentSessions');
  vi.spyOn(iosDevices, 'listAllIosSimsAsync').mockImplementation(async (options) => {
    native = runOperationFile(
      options?.operation,
      getExecutor(),
      process.execPath,
      [
        '-e',
        'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)',
        pidFile,
      ],
      { signal: options?.signal, timeoutMs: 15_000 },
    );
    await native;
    return [];
  });
  const pending = savedWorktreeUse([{ path: root, keys: [root] }], testContext({ signal: controller.signal }));
  const result = pending.then(
    () => null,
    (error: unknown) => error,
  );
  try {
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 5000 });
    const pid = Number(readFileSync(pidFile, 'utf8'));
    controller.abort(reason);
    expect(await result).toBe(reason);
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
    expect(agents).not.toHaveBeenCalled();
  } finally {
    controller.abort(reason);
    await native?.catch(() => {});
    await result;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(base, { recursive: true, force: true });
  }
}, 20_000);
