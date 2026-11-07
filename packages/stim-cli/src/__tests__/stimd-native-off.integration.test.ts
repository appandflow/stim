import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { readClaimSet } from '@stim-cli/core/ownership-claim';
import { stimdClaimRoot } from '@stim-cli/core/state';
import { inspectProcessIdentity } from '../process-identity.ts';
import { operationState } from '../engine/operation-state.ts';
import { runOperation } from '../run-operation.ts';
import { startDeviceLogStream, stopDeviceLogStream } from '../daemon/client.ts';
import { workspaceLogsDir } from '../workspace/paths.ts';
import { testContext } from './_context.ts';

describe.skipIf(process.platform === 'win32')('native device logs without automatic passes', () => {
  test.each([
    ['ios', { STIM_DAEMON: 'off', CI: undefined }, 'command'],
    ['android', { STIM_DAEMON: undefined, CI: '1' }, 'command'],
    ['ios', { STIM_DAEMON: 'off', CI: undefined }, 'none'],
    ['android', { STIM_DAEMON: undefined, CI: '1' }, 'none'],
  ] as const)(
    '%s starts stimd and records launch evidence (%s, %s)',
    async (platform, mode, admission) => {
      const home = mkdtempSync(join(tmpdir(), 'stim-native-off-home-'));
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-native-off-app-')));
      const bin = join(home, 'bin');
      mkdirSync(bin);
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'fixture', dependencies: { 'react-native': '0.0.0' } }),
      );
      const xcrun = join(bin, 'xcrun');
      writeFileSync(
        xcrun,
        `#!/bin/sh\necho '{"eventType":"logEvent","eventMessage":"ios-evidence"}'\nexec sleep 600\n`,
      );
      chmodSync(xcrun, 0o755);
      const adb = join(bin, 'adb');
      writeFileSync(
        adb,
        `#!/bin/sh\ncase "$*" in\n  *pidof*) echo 3132 ;;\n  *logcat*) echo ' 1788902582.542 I/ReactNativeJS( 3132): android-evidence'; exec sleep 600 ;;\n  *) exit 0 ;;\nesac\n`,
      );
      chmodSync(adb, 0o755);
      vi.stubEnv('STIM_HOME', home);
      const env = {
        ...process.env,
        ...mode,
        STIM_HOME: home,
        STIM_ENGINE_ROOT: join(home, 'engine'),
        PATH: [bin, process.env.PATH].join(delimiter),
      };
      const context = testContext({ home, projectRoot: root, cwd: root, env });
      let end: (() => unknown) | undefined;
      let streamId: string | undefined;
      try {
        const build = await runOperation({
          caller: 'api',
          operation: 'build',
          platform,
          admission: 'command',
          cwd: root,
          env,
        });
        if ('refusal' in build) throw new Error(build.refusal.message);
        expect(build.opToken).toBeUndefined();
        expect(readClaimSet(stimdClaimRoot()).live).toEqual([]);
        const admitted = await runOperation({
          caller: 'api',
          operation: 'run',
          platform,
          admission,
          cwd: root,
          env,
        });
        if ('refusal' in admitted) throw new Error(admitted.refusal.message);
        end = admitted.end;
        expect(admitted.opToken).toBeTruthy();
        operationState(context).stimdOpToken = admitted.opToken;
        const spec =
          platform === 'ios'
            ? { root, platform: 'ios' as const, udid: 'U1', bundleId: 'com.test.app', appName: 'Test' }
            : { root, platform: 'android' as const, serial: 'emulator-1', packageName: 'com.test.app' };
        const started = await startDeviceLogStream(spec, context);
        if ('error' in started) throw new Error(started.error);
        streamId = started.streamId;
        await vi.waitFor(
          () => {
            const path = join(workspaceLogsDir(root), 'device.ndjson');
            expect(existsSync(path) && readFileSync(path, 'utf8')).toContain(`${platform}-evidence`);
          },
          { timeout: 15_000 },
        );
        expect(await stopDeviceLogStream(root, platform, 'default', streamId, context)).toEqual({ stopped: true });
        streamId = undefined;
      } finally {
        if (streamId) await stopDeviceLogStream(root, platform, 'default', streamId, context).catch(() => {});
        await end?.();
        const owner = readClaimSet(stimdClaimRoot()).live[0]?.owner;
        if (owner && inspectProcessIdentity(owner) === 'same') {
          process.kill(owner.pid, 'SIGTERM');
          await vi.waitFor(
            () => {
              if (inspectProcessIdentity(owner) === 'same') throw new Error('scratch stimd still runs');
            },
            { timeout: 10_000 },
          );
        }
        vi.unstubAllEnvs();
        rmSync(home, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
      }
    },
    45_000,
  );
});

describe.skipIf(process.platform === 'win32')('physical iOS on an attached daemon', () => {
  test('refuses the console before spawning devicectl', async () => {
    const { spawn } = await import('node:child_process');
    const { once } = await import('node:events');
    const { spawnEntry } = await import('../spawn-entry.ts');
    const { checkPhysicalIosLog } = await import('../daemon/client.ts');
    const home = mkdtempSync(join(tmpdir(), 'stim-attached-ios-home-'));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-attached-ios-app-')));
    const bin = join(home, 'bin');
    const invoked = join(home, 'invoked');
    mkdirSync(bin);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', dependencies: { 'react-native': '0.0.0' } }),
    );
    const xcrun = join(bin, 'xcrun');
    writeFileSync(xcrun, `#!/bin/sh\ntouch "${invoked}"\nexit 0\n`);
    chmodSync(xcrun, 0o755);
    vi.stubEnv('STIM_HOME', home);
    const env = {
      ...process.env,
      STIM_HOME: home,
      STIM_ENGINE_ROOT: join(home, 'engine'),
      STIM_DAEMON: 'on',
      PATH: [bin, process.env.PATH].join(delimiter),
    };
    const daemon = spawn(process.execPath, [spawnEntry('cli'), '__stimd', '--attached', '--no-handover'], {
      env,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const exited = once(daemon, 'exit');
    let end: (() => unknown) | undefined;
    try {
      await vi.waitFor(() => expect(existsSync(join(home, 'run', 'stimd.json'))).toBe(true), { timeout: 15_000 });
      const admitted = await runOperation({
        caller: 'api',
        operation: 'run',
        platform: 'ios',
        admission: 'command',
        cwd: root,
        env,
      });
      if ('refusal' in admitted) throw new Error(admitted.refusal.message);
      end = admitted.end;
      const context = testContext({ home, projectRoot: root, cwd: root, env });
      operationState(context).stimdOpToken = admitted.opToken;
      expect(await checkPhysicalIosLog(context)).toMatchObject({
        error: expect.stringContaining('attached stimd'),
        remedy: expect.stringContaining('stim serve'),
      });
      expect(
        await startDeviceLogStream(
          { root, platform: 'ios', udid: 'U1', bundleId: 'com.test.app', appName: 'Test', physical: true },
          context,
        ),
      ).toMatchObject({ error: expect.stringContaining('attached stimd') });
      expect(existsSync(invoked)).toBe(false);
    } finally {
      await end?.();
      daemon.stdin.end();
      if (daemon.exitCode === null) daemon.kill('SIGTERM');
      await exited;
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
