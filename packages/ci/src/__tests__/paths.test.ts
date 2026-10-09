import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCI } from '../index.ts';

it('keeps the worker refusal for an inherited relative cache path on a hosted runner', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-ci-paths-')));
  vi.stubEnv('GITHUB_ACTIONS', 'true');
  vi.stubEnv('RUNNER_ENVIRONMENT', 'github-hosted');
  vi.stubEnv('RUNNER_TEMP', join(root, 'job'));
  vi.stubEnv('STIM_HOME', undefined);
  vi.stubEnv('STIM_BUILD_CACHE', 'relative-cache');
  try {
    const result = await runCI({
      projectRoot: root,
      artifactsDir: join(root, 'results'),
      run: { platform: 'web' },
      command: [process.execPath, '-e', 'process.exitCode = 0'],
    });
    expect(result.exitCode).toBe(1);
    expect(result.failure?.code).toBe('STIM_RELATIVE_PATH');
    expect(result.run).toBeNull();
    expect(result.test).toBeNull();
    expect(existsSync(join(root, 'relative-cache'))).toBe(false);
    expect(process.env.STIM_BUILD_CACHE).toBe('relative-cache');
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
