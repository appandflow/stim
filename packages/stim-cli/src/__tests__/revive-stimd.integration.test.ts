import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withAmbientContext, type StimContext } from '@stim-cli/core';
import { stimdRecordFile } from '@stim-cli/core/state';
import { processOperation } from '../cli-operation.ts';
import { reviveDeps } from '../commands/revive.ts';
import { beforeCommand, cancelCliOp, startDeviceLogStream, stopDeviceLogStream } from '../daemon/client.ts';
import { invocation } from '../stimd/forwarded.ts';
import { upsertProject } from '../workspace/config.ts';
import { workspaceLogsDir } from '../workspace/paths.ts';

vi.mock('../commands/ios.ts', () => ({
  runIosOperation: vi.fn<typeof import('../commands/ios.ts').runIosOperation>(),
}));
vi.mock('../commands/android.ts', () => ({
  runAndroidOperation: vi.fn<typeof import('../commands/android.ts').runAndroidOperation>(),
}));
import { runIosOperation } from '../commands/ios.ts';

const entry = fileURLToPath(new URL('../../bin/cli.ts', import.meta.url));

test.skipIf(process.platform === 'win32')(
  'revive records device logs through its CLI admission',
  async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'stim-revive-stimd-')));
    const home = join(dir, 'home');
    const root = join(dir, 'app');
    const bin = join(dir, 'bin');
    for (const path of [home, root, bin]) mkdirSync(path);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
    for (const tool of ['launchctl', 'systemd-run', 'xcrun']) {
      writeFileSync(
        join(bin, tool),
        tool === 'xcrun'
          ? `#!/bin/sh\necho '{"eventType":"logEvent","eventMessage":"revive-evidence"}'\nexec sleep 600\n`
          : '#!/bin/sh\nexit 1\n',
      );
      chmodSync(join(bin, tool), 0o755);
    }
    vi.stubEnv('STIM_HOME', home);
    vi.stubEnv('STIM_DAEMON', 'on');
    vi.stubEnv('STIM_ENGINE_ROOT', join(dir, 'engine'));
    vi.stubEnv('HOME', dir);
    vi.stubEnv('XDG_RUNTIME_DIR', '');
    vi.stubEnv('PATH', [bin, process.env.PATH].join(delimiter));
    const operation = processOperation(root);
    let child: ChildProcess | undefined;
    let stream: Awaited<ReturnType<typeof startDeviceLogStream>> | undefined;
    vi.mocked(runIosOperation).mockImplementation(async (context: StimContext) => {
      stream = await startDeviceLogStream(
        { root, platform: 'ios', slot: 'default', udid: 'U1', bundleId: 'com.test.app', appName: 'Test' },
        context,
      );
      return {
        facts: {
          platform: 'ios',
          udid: 'U1',
          deviceName: 'Test',
          launched: true,
          deviceType: null,
          runtime: null,
          configuration: null,
          cacheHit: false,
          cacheSkipped: true,
          compilationCache: { status: 'not-run', hits: null, cacheableTasks: null, hitRatePercent: null },
          waitedForBuild: null,
          installSkipped: true,
          logs: {},
        },
        uploadsAbandoned: false,
      };
    });
    try {
      upsertProject(root, {});
      child = spawn(process.execPath, [entry, '__stimd'], { env: process.env, stdio: 'ignore' });
      await vi.waitFor(() => expect(JSON.parse(readFileSync(stimdRecordFile(), 'utf8')).pid).toBe(child?.pid), {
        timeout: 15_000,
      });
      const forwarded = invocation(root, process.env);
      if ('code' in forwarded) throw new Error(forwarded.message);
      await withAmbientContext(operation.context, async () => {
        await beforeCommand('revive', process.env, { cwd: root, recordUse: false, pin: true, invocation: forwarded });
        await reviveDeps(operation.context).run('ios', root, {
          slot: 'default',
          expectedDevice: 'U1',
          installedApp: null,
          configuration: null,
          recordedBuild: null,
        });
      });
      expect(stream).toEqual({ streamId: expect.any(String) });
      await vi.waitFor(
        () => expect(readFileSync(join(workspaceLogsDir(root), 'device.ndjson'), 'utf8')).toContain('revive-evidence'),
        { timeout: 10_000 },
      );
    } finally {
      if (stream && 'streamId' in stream)
        await stopDeviceLogStream(root, 'ios', 'default', stream.streamId, operation.context);
      cancelCliOp();
      operation.dispose();
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await vi.waitFor(() => expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true), {
          timeout: 20_000,
        });
      }
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  60_000,
);
