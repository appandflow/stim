import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measuredDirectorySizeAsync } from '../fs-util.ts';
import { workspaceInUseAsync } from '../workspace/in-use.ts';
import { macosDir } from '../macos/state.ts';
import { resetExecutor, setExecutor } from '../exec.ts';
import { makeExecutor } from './_factories.ts';
import { testContext } from './_context.ts';
import * as worktree from '../workspace/worktree.ts';
import { restoreProblem } from '../workspace/lightened.ts';

test.each(['plain', 'workspace'])('directory size preserves %s cleanup refusal over cancellation', async (kind) => {
  const { WorkspaceProcessCleanupError } = await import('../engine/workspace-process-lock.ts');
  const failure =
    kind === 'plain'
      ? Object.assign(new Error('unverified cleanup'), { code: 'STIM_CLAIM_UNAVAILABLE', reportCleanup: true })
      : new WorkspaceProcessCleanupError([], 'unverified cleanup', 'Inspect the child.');
  const controller = new AbortController();
  setExecutor(
    makeExecutor({
      runFileAsync: async () => {
        controller.abort();
        throw failure;
      },
    }),
  );
  try {
    const operation = testContext({ signal: controller.signal });
    await expect(
      measuredDirectorySizeAsync('/fixture', { timeoutMs: 1000, signal: controller.signal, operation }),
    ).rejects.toBe(failure);
  } finally {
    resetExecutor();
  }
});

test.skipIf(process.platform !== 'darwin')(
  'workspace in-use preserves process probe cleanup refusal over cancellation',
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'stim-in-use-cleanup-'));
    vi.stubEnv('STIM_HOME', home);
    const root = join(home, 'project');
    mkdirSync(root);
    mkdirSync(macosDir(root), { recursive: true });
    const failure = Object.assign(new Error('unverified cleanup'), {
      code: 'STIM_CLAIM_UNAVAILABLE',
      reportCleanup: true,
    });
    const controller = new AbortController();
    setExecutor(
      makeExecutor({
        runFileAsync: async () => {
          controller.abort();
          throw failure;
        },
      }),
    );
    try {
      const operation = testContext({ signal: controller.signal });
      await expect(workspaceInUseAsync(root, {}, controller.signal, operation)).rejects.toBe(failure);
    } finally {
      resetExecutor();
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test('restore problem preserves source probe cleanup refusal over cancellation', async () => {
  const failure = Object.assign(new Error('unverified cleanup'), {
    code: 'STIM_CLAIM_UNAVAILABLE',
    reportCleanup: true,
  });
  const controller = new AbortController();
  const source = vi.spyOn(worktree, 'warmWorktreePaths').mockImplementation(async () => {
    controller.abort();
    throw failure;
  });
  try {
    const operation = testContext({ signal: controller.signal });
    await expect(
      restoreProblem({ worktree: '/fixture', path: '/fixture/node_modules' }, new Map(), operation),
    ).rejects.toBe(failure);
  } finally {
    source.mockRestore();
  }
});
