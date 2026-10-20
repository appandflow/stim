import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStim } from 'stim';
import { workspaceName } from '../../../core/index.ts';
import { captureProcessToken } from '../../../core/process-identity.ts';
import { runCI } from '../index.ts';

test('a throwing reporter cannot interrupt owned process cleanup or redirect its captured home', async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'stim-ci-reporter-')));
  const root = join(scratch, 'project');
  const home = join(scratch, 'home');
  const cli = fileURLToPath(new URL('../../../stim-cli/dist/cli.mjs', import.meta.url));
  const children: { child: ChildProcess; closed: Promise<unknown> }[] = [];
  mkdirSync(root);
  mkdirSync(home);
  vi.stubEnv('STIM_HOME', home);
  try {
    for (const setting of ['iosSimulatorApp', 'androidEmulatorApp']) {
      execFileSync(process.execPath, [cli, 'settings', 'set', setting, 'stim-desktop'], { stdio: 'ignore' });
    }
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'reporter-fixture', private: true }));
    for (const platform of ['ios', 'android']) {
      const child = spawn(
        process.execPath,
        [
          '-e',
          "process.on('SIGTERM', () => setTimeout(() => process.exit(), 500)); console.log('ready'); setInterval(() => {}, 1000);",
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const closed = once(child, 'close');
      children.push({ child, closed });
      await once(child.stdout!, 'data');
      const directory = join(home, 'workspaces', workspaceName(root));
      mkdirSync(directory, { recursive: true });
      const statePath = join(directory, 'state.json');
      const collectors = platform === 'ios' ? {} : JSON.parse(readFileSync(statePath, 'utf8')).collectors;
      writeFileSync(
        statePath,
        JSON.stringify({
          collectors: { ...collectors, [platform]: { pid: child.pid, processToken: captureProcessToken(child.pid!) } },
        }),
      );
    }
    const result = await runCI({
      projectRoot: root,
      run: { platform: 'ios' },
      command: [process.execPath, '-e', 'process.exitCode = 0'],
      artifactsDir: join(scratch, 'artifacts'),
      onProgress: () => {
        vi.stubEnv('STIM_HOME', join(scratch, 'changed-home'));
        throw new Error('reporter unavailable');
      },
    });
    expect(result.exitCode).toBe(1);
    expect(children.every(({ child }) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
    expect(result.cleanup.result?.ok).toBe(true);
    expect(result.cleanup.error).toBeUndefined();
    expect(result.reportingError?.message).toBe('reporter unavailable');
    expect(JSON.parse(readFileSync(result.resultPath, 'utf8')).reportingError.message).toBe('reporter unavailable');
    expect(JSON.parse(readFileSync(result.diagnostics.path!, 'utf8')).directory).toBe(
      join(home, 'workspaces', workspaceName(root), 'logs'),
    );
  } finally {
    await createStim({ projectRoot: root, home })
      .stop()
      .catch(() => {});
    for (const { child, closed } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
    vi.unstubAllEnvs();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 20_000);
