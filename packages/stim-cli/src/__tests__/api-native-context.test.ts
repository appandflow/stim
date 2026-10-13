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
import { dirname, join } from 'node:path';
import { withAmbientContext } from '@stim-cli/core';
import { runPrebuild } from '../engine/prebuild.ts';
import { podEnvForRubyAsync, runPodInstall } from '../engine/deps.ts';
import { androidHome, androidToolPath, listInstalledSystemImages } from '../devices/android.ts';
import { reportAndroidResult } from '../commands/android/result.ts';
import { makeWriter } from './_factories.ts';
import { testContext } from './_context.ts';
import { getExecutor } from '../exec.ts';
import { buildPlacementCandidates } from '../offload/client.ts';
import { createDebugLog, getConcurrencyLimits, getParkedMax } from '@stim-cli/core/state';
import { deviceSweepIsScoped } from '../commands/gc/devices.ts';
import { planCacheEmptying } from '../commands/gc/caches.ts';
import {
  endRecordedSession,
  remoteIosDeps,
  resolveRemoteContext,
  withRemoteSessionLock,
} from '../engine/device-remote.ts';
import { withNativeBuildRun } from '../engine/native-run.ts';
import { operationState } from '../engine/operation-state.ts';
import { cancellableSleep } from '../cancellation.ts';
import { runStop, stopWorkspaceNow } from '../commands/stop.ts';
import { writeWorkspaceState } from '../workspace/workspace-state.ts';
import { workspaceDir } from '../workspace/paths.ts';
import { readClaimSet } from '../ownership-claim.ts';
import { resolveCcache } from '../engine/ccache.ts';

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-api-native-context-')));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function executable(path: string, body: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!${process.execPath}\n${body}\n`);
  chmodSync(path, 0o755);
}

function context(env: NodeJS.ProcessEnv = {}) {
  return testContext({
    home: join(root, 'home'),
    projectRoot: root,
    cwd: root,
    env: {
      PATH: dirname(process.execPath),
      HOME: root,
      STIM_HOME: join(root, 'home'),
      STIM_CONTEXT_MARKER: 'client',
      ...env,
    },
  });
}

test('executable discovery uses the client PATH and working directory', () => {
  const bin = join(root, 'bin');
  const name = process.platform === 'win32' ? 'stim-client-tool.cmd' : 'stim-client-tool';
  const tool = join(bin, name);
  executable(tool, '');
  for (const path of [bin, 'bin']) {
    const env = process.platform === 'win32' ? { PATH: undefined, Path: path } : { PATH: path };
    withAmbientContext(context(env), () => {
      expect(getExecutor().findExecutable(name)).toBe(tool);
      expect(getExecutor().findExecutable('stim-absent-tool')).toBeNull();
    });
  }
});

test('an unqualified child working directory is the client workspace', async () => {
  const host = process.cwd();
  const directory = await withAmbientContext(context(), () =>
    getExecutor().runFileAsync(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { timeoutMs: 5000 }),
  );
  expect(directory).toBe(root);
  expect(process.cwd()).toBe(host);
});

test('client resource and placement overrides govern native admission', () => {
  const operation = context({
    STIM_REMOTE_BUILD_MODE: 'off',
    STIM_MAX_BUILDS: '1',
    STIM_MAX_DEVICES: '2',
    STIM_POOL_ANDROID_PARKED_MAX: '0',
  });
  withAmbientContext(operation, () => {
    expect(buildPlacementCandidates('auto').mode).toBe('off');
    expect(getConcurrencyLimits()).toEqual({ maxBuilds: 1, maxDevices: 2 });
    expect(getParkedMax('android')).toEqual({ max: 0, error: null });
  });
});

test('a scoped client home protects machine-global devices and caches', () => {
  const operation = context();
  expect(deviceSweepIsScoped(operation.env)).toBe(true);
  const cache = {
    name: 'Gradle',
    dir: join(root, 'machine-cache'),
    source: 'detected' as const,
    prune: 'entries' as const,
    note: 'machine cache',
  };
  expect(planCacheEmptying([cache], true, operation.env)[0]).toMatchObject({ willEmpty: false });
});

test('the native compiler cache uses the client size limit', () => {
  const operation = context({ STIM_CACHES_CCACHE_MAX_GB: '9' });
  withAmbientContext(operation, () => {
    const cache = resolveCcache({
      root,
      dir: join(operation.home, 'ccache'),
      env: operation.env,
      lookup: () => join(root, 'ccache'),
      onNote: () => {},
    });
    expect(cache?.env.CCACHE_MAXSIZE).toBe('9G');
  });
});

test('a shared debug logger follows each client environment without reusing its enabled state', () => {
  const enabled = context({ STIM_DEBUG: '1' });
  const disabled = { ...context({ STIM_DEBUG: '0' }), home: join(root, 'disabled-home') };
  const logger = createDebugLog('cli', { now: () => 0 });
  withAmbientContext(enabled, () => logger.log('first'));
  withAmbientContext(disabled, () => logger.log('disabled'));
  withAmbientContext(enabled, () => logger.log('second'));
  expect(existsSync(join(disabled.home, 'logs', 'debug', 'cli.ndjson'))).toBe(false);
  const events = readFileSync(join(enabled.home, 'logs', 'debug', 'cli.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).event);
  expect(events).toEqual(['first', 'second']);
});

test('a shared debug logger does not reuse another Stim home configuration', () => {
  const first = context();
  const second = { ...first, home: join(root, 'second-home') };
  mkdirSync(first.home);
  mkdirSync(second.home);
  writeFileSync(join(first.home, 'config.json'), JSON.stringify({ debug: { logs: true } }));
  writeFileSync(join(second.home, 'config.json'), JSON.stringify({ debug: { logs: false } }));
  const logger = createDebugLog('cli', { env: {}, now: () => 0 });
  withAmbientContext(first, () => logger.log('enabled'));
  withAmbientContext(second, () => logger.log('disabled'));
  expect(existsSync(join(first.home, 'logs', 'debug', 'cli.ndjson'))).toBe(true);
  expect(existsSync(join(second.home, 'logs', 'debug', 'cli.ndjson'))).toBe(false);
});

test.skipIf(process.platform === 'win32')('prebuild passes the client environment to the actual child', async () => {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { expo: '52.0.0' } }));
  executable(
    join(root, 'node_modules', '.bin', 'expo'),
    `const fs = require('node:fs'); fs.mkdirSync('ios'); fs.writeFileSync('child-env.json', JSON.stringify({ marker: process.env.STIM_CONTEXT_MARKER, home: process.env.STIM_HOME }));`,
  );
  const operation = context();
  const result = await withAmbientContext(operation, () => runPrebuild(root, 'ios', makeWriter(), { isExpo: true }));
  expect(result.failed).not.toBe(true);
  expect(JSON.parse(readFileSync(join(root, 'child-env.json'), 'utf8'))).toEqual({
    marker: 'client',
    home: operation.home,
  });
});

test('Android discovery reads the client SDK and its tools and images', () => {
  const sdk = join(root, 'sdk');
  mkdirSync(join(sdk, 'system-images', 'android-36', 'google_apis', 'arm64-v8a'), { recursive: true });
  const adb = join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
  executable(adb, '');
  const operation = context({ ANDROID_HOME: sdk });
  withAmbientContext(operation, () => {
    expect(androidHome()).toBe(sdk);
    expect(androidToolPath('adb')).toBe(adb);
    expect(listInstalledSystemImages().map((image) => image.pkg)).toEqual([
      'system-images;android-36;google_apis;arm64-v8a',
    ]);
  });
});

test('Android success links use the supplied output instead of the host terminal', () => {
  const output = vi.fn<(line: string) => void>();
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    reportAndroidResult({
      root,
      json: false,
      useBuildCache: true,
      variant: 'debug',
      release: false,
      runtimeKind: 'process',
      metroCheck: false,
      metroPort: null,
      logsDir: null,
      serial: 'fixture',
      apkPath: null,
      androidPackage: 'dev.fixture',
      installSkipped: false,
      record: { cacheHit: false },
      waitedForBuild: null,
      remote: null,
      providerName: null,
      launchState: true,
      launched: {},
      ccache: { status: 'not-run', hits: null, misses: null, hitRatePercent: null },
      durationMs: 0,
      writer: makeWriter(),
      emit: () => {},
      out: output,
      recordRun: () => {},
      links: { desktop: 'https://example.invalid/workspace' },
    });
    expect(output.mock.calls.flat().join('\n')).toContain('https://example.invalid/workspace');
    expect(stderr).not.toHaveBeenCalled();
  } finally {
    stderr.mockRestore();
  }
});

test.skipIf(process.platform !== 'darwin')(
  'Pod Ruby discovery leaves the host event loop available and preserves child env',
  async () => {
    mkdirSync(join(root, 'ios'));
    const bin = join(root, 'bin');
    const finished = join(root, 'login-finished');
    const release = join(root, 'release-login');
    const shell = join(bin, 'shell');
    executable(
      shell,
      `const fs = require('node:fs'); const started = Date.now(); const poll = () => { if (!fs.existsSync(${JSON.stringify(release)}) && Date.now() - started < 1500) return setTimeout(poll, 10); fs.writeFileSync(process.argv.at(-1), ${JSON.stringify('@@ruby-env-begin@@\nPATH=' + bin + '\n@@ruby-env-end@@\n')}); fs.writeFileSync(${JSON.stringify(finished)}, 'done'); }; poll();`,
    );
    executable(
      join(bin, 'pod'),
      `require('node:fs').writeFileSync('pod-env.json', JSON.stringify({ marker: process.env.STIM_CONTEXT_MARKER, home: process.env.STIM_HOME }));`,
    );
    vi.stubEnv('SHELL', shell);
    vi.stubEnv('HOME', root);
    vi.stubEnv('PATH', bin);
    vi.stubEnv('GEM_HOME', undefined);
    vi.stubEnv('GEM_PATH', undefined);
    const operation = context({ PATH: bin, SHELL: shell });
    const available = new Promise<boolean>((resolve) =>
      setTimeout(() => {
        const beforeExit = !existsSync(finished);
        writeFileSync(release, 'release');
        resolve(beforeExit);
      }, 0),
    );
    const result = await withAmbientContext(operation, () => runPodInstall(root, makeWriter()));
    expect(await available).toBe(true);
    expect(result.failed).not.toBe(true);
    expect(JSON.parse(readFileSync(join(root, 'ios', 'pod-env.json'), 'utf8'))).toEqual({
      marker: 'client',
      home: operation.home,
    });
  },
);

test.skipIf(process.platform !== 'darwin')(
  'Ruby discovery does not reuse another client environment for the same shell',
  async () => {
    const shell = join(root, 'shell');
    executable(
      shell,
      `require('node:fs').writeFileSync(process.argv.at(-1), '@@ruby-env-begin@@\\nGEM_HOME=' + process.env.STIM_RUBY_PROFILE + '\\n@@ruby-env-end@@\\n');`,
    );
    const first = context({ SHELL: shell, STIM_RUBY_PROFILE: join(root, 'first-gems') });
    const second = context({ SHELL: shell, STIM_RUBY_PROFILE: join(root, 'second-gems') });
    const one = await withAmbientContext(first, () => podEnvForRubyAsync(null));
    const two = await withAmbientContext(second, () => podEnvForRubyAsync(null));
    expect(one.GEM_HOME).toBe(first.env.STIM_RUBY_PROFILE);
    expect(two.GEM_HOME).toBe(second.env.STIM_RUBY_PROFILE);
  },
);

test.skipIf(process.platform !== 'darwin')(
  'aborting Ruby discovery waits for its own login child to exit',
  async () => {
    const shell = join(root, 'shell');
    const pidFile = join(root, 'login-pid');
    executable(
      shell,
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 100);`,
    );
    const controller = new AbortController();
    const operation = { ...context({ SHELL: shell }), signal: controller.signal };
    const pending = withAmbientContext(operation, () => podEnvForRubyAsync(null));
    const started = Date.now();
    while (!existsSync(pidFile) && Date.now() - started < 3000) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    const rejected = pending.catch((error: unknown) => error);
    controller.abort();
    expect(await rejected).toMatchObject({ name: 'AbortError' });
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  },
);

test.skipIf(process.platform === 'win32')('the EAS version probe lets host timers run', async () => {
  const tool = join(root, 'eas');
  executable(tool, `setTimeout(() => console.log('eas-cli/24.8.0'), 150);`);
  let ticked = false;
  const timer = setTimeout(() => {
    ticked = true;
  }, 20);
  try {
    const result = await withAmbientContext(context(), () =>
      resolveRemoteContext({
        root,
        backend: 'eas',
        easBin: tool,
        lookupAgentDevice: () => '/fixture-agent-device',
        operation: context(),
      }),
    );
    expect('ctx' in result).toBe(true);
    expect(ticked).toBe(true);
  } finally {
    clearTimeout(timer);
  }
});

function abortAfterMarker(marker: string, controller: AbortController) {
  const timer = setInterval(() => {
    if (existsSync(marker)) controller.abort();
  }, 5);
  return () => clearInterval(timer);
}

function expectChildGone(pid: number) {
  expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
}

test.skipIf(process.platform === 'win32')('a proxy install can be cancelled without blocking the host', async () => {
  const tool = join(root, 'agent-device');
  const marker = join(root, 'install-started.json');
  vi.stubEnv('AGENT_DEVICE_DAEMON_AUTH_TOKEN', 'host-token');
  executable(
    tool,
    `const fs = require('node:fs');
if (process.argv[2] === 'install') {
  fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid: process.pid, marker: process.env.STIM_CONTEXT_MARKER}));
  setTimeout(() => {}, 2000);
}`,
  );
  const controller = new AbortController();
  const operation = { ...context(), signal: controller.signal };
  const deps = remoteIosDeps({
    root,
    label: 'context-test',
    backend: 'proxy',
    easBin: '',
    agentDeviceBin: tool,
    operation,
    existingDaemon: { baseUrl: 'http://127.0.0.1:4310', token: 'fixture' },
  });
  const cancel = abortAfterMarker(marker, controller);
  try {
    const result = await withAmbientContext(operation, () =>
      withNativeBuildRun(
        operation,
        root,
        { command: 'ios', platform: 'ios' },
        async () => {
          expect((await deps.ensureBooted()).ok).toBe(true);
          return deps.installIosApp({ udid: 'fixture', appPath: '/fixture.app' });
        },
        { write: () => {} },
      ),
    );
    expect(result.failed).toBe(true);
    const child = JSON.parse(readFileSync(marker, 'utf8'));
    expect(child.marker).toBe('client');
    expectChildGone(child.pid);
    expect(operationState(operation).running.size).toBe(0);
  } finally {
    cancel();
  }
});

describe.skipIf(process.platform === 'win32')('EAS cancellation with an owned child', () => {
  test.each(['create', 'daemon-wait'])(
    'cancelling EAS during %s stops its returned session before releasing the operation',
    async (stage) => {
      const tool = join(root, 'eas');
      const marker = join(root, 'session-started.json');
      const stopped = join(root, 'session-stopped.json');
      executable(
        tool,
        `const fs = require('node:fs');
const command = process.argv[2];
if (command === 'sim') {
  console.log(JSON.stringify({ id: 'drs_context', name: 'stim-context-test', type: 'agent-device' }));
  if (${JSON.stringify(stage)} === 'create') {
    fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid }));
    setTimeout(() => {}, 2000);
  }
} else if (command === 'simulator:get') {
  fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid }));
  console.log(JSON.stringify({id: 'drs_context', status: 'IN_PROGRESS'}));
} else if (command === 'simulator:stop') {
  fs.writeFileSync(${JSON.stringify(stopped)}, JSON.stringify({id: process.argv[process.argv.indexOf('--id') + 1], marker: process.env.STIM_CONTEXT_MARKER}));
  console.log(JSON.stringify({id: 'drs_context', status: 'STOPPED'}));
}`,
      );
      const controller = new AbortController();
      const operation = { ...context(), signal: controller.signal };
      const deps = remoteIosDeps({
        root,
        label: 'context-test',
        backend: 'eas',
        easBin: tool,
        agentDeviceBin: tool,
        operation,
      });
      const cancel = abortAfterMarker(marker, controller);
      try {
        const result = await withAmbientContext(operation, () =>
          withNativeBuildRun(operation, root, { command: 'ios', platform: 'ios' }, () => deps.ensureBooted(), {
            write: () => {},
          }),
        );
        expect(result.failed).toBe(true);
        expect(result.reason).toContain('The session was stopped');
        expect(JSON.parse(readFileSync(stopped, 'utf8'))).toEqual({ id: 'drs_context', marker: 'client' });
        expectChildGone(JSON.parse(readFileSync(marker, 'utf8')).pid);
        expect(operationState(operation).running.size).toBe(0);
      } finally {
        cancel();
      }
    },
  );
});

test('stop requests cancellation before waiting for remote boot cleanup', async () => {
  const controller = new AbortController();
  const operation = { ...context(), signal: controller.signal };
  operationState(operation).abortOperation = () => controller.abort();
  let ready: () => void = () => {};
  const booting = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const run = withAmbientContext(operation, () =>
    withNativeBuildRun(
      operation,
      root,
      { command: 'ios', platform: 'ios' },
      async () => {
        try {
          await withRemoteSessionLock(root, async () => {
            ready();
            await cancellableSleep(5000, { signal: operation.signal });
          });
        } catch (error) {
          if (!operation.signal.aborted) throw error;
        }
      },
      { write: () => {} },
    ),
  );
  await booting;
  const stopContext = context();
  try {
    const result = await withAmbientContext(stopContext, () =>
      stopWorkspaceNow({
        root,
        operation: stopContext,
        report: () => {},
        endRemote: () =>
          withRemoteSessionLock(root, async () => ({ status: 'torn-down', label: 'fixture' }), { waitMs: 1000 }),
        stop: () => runStop({ root, remoteDevice: null, report: () => {} }),
      }),
    );
    expect(result).toMatchObject({ ok: true });
    expect(controller.signal.aborted).toBe(true);
  } finally {
    controller.abort();
    await run;
  }
});

test.skipIf(process.platform === 'win32')('cancelling a reuse query preserves the recorded EAS session', async () => {
  const tool = join(root, 'eas');
  const marker = join(root, 'reuse-query.json');
  const stopped = join(root, 'unexpected-stop');
  executable(
    tool,
    `const fs = require('node:fs');
if (process.argv[2] === 'simulator:get') {
  fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid: process.pid}));
  console.log(JSON.stringify({id: 'drs_existing', name: 'stim-context-test', status: 'IN_PROGRESS'}));
  setTimeout(() => {}, 2000);
} else if (process.argv[2] === 'simulator:stop') {
  fs.writeFileSync(${JSON.stringify(stopped)}, 'stopped');
  console.log(JSON.stringify({id: 'drs_existing', status: 'STOPPED'}));
}`,
  );
  const controller = new AbortController();
  const operation = { ...context(), signal: controller.signal };
  const deps = remoteIosDeps({
    root,
    label: 'context-test',
    backend: 'eas',
    easBin: tool,
    agentDeviceBin: tool,
    operation,
  });
  withAmbientContext(operation, () =>
    writeWorkspaceState(root, {
      remoteDevice: { sessionId: 'drs_existing', platform: 'ios', startedAt: new Date().toISOString() },
    }),
  );
  const cancel = abortAfterMarker(marker, controller);
  try {
    await expect(
      withAmbientContext(operation, () =>
        withNativeBuildRun(operation, root, { command: 'ios', platform: 'ios' }, () => deps.ensureBooted(), {
          write: () => {},
        }),
      ),
    ).rejects.toMatchObject({ code: 'STIM_CANCELLED' });
    expect(existsSync(stopped)).toBe(false);
    expectChildGone(JSON.parse(readFileSync(marker, 'utf8')).pid);
  } finally {
    cancel();
  }
});

describe.skipIf(process.platform === 'win32')('session cleanup child ownership', () => {
  test.each(['cli', 'client'])('%s cleanup declares its child on the ownership claim', async (mode) => {
    const tool = join(root, 'eas');
    const marker = join(root, 'cleanup-query.json');
    const release = join(root, 'finish-query');
    executable(
      tool,
      `const fs = require('node:fs');
if (process.argv[2] === 'simulator:get') {
  fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid: process.pid, marker: process.env.STIM_CONTEXT_MARKER ?? 'cli'}));
  const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(release)})) return;
    clearInterval(timer);
    console.log(JSON.stringify({id: 'drs_existing', name: 'stim-context-test', status: 'STOPPED'}));
  }, 10);
}`,
    );
    vi.stubEnv('STIM_HOME', join(root, 'cli-home'));
    const client = mode === 'client' ? context() : undefined;
    const end = () =>
      endRecordedSession({
        root,
        sessionId: 'drs_existing',
        easBin: tool,
        lookupAgentDevice: () => tool,
        ledgerRoot: join(root, 'ledger'),
      });
    const cleanup = client ? withAmbientContext(client, end) : end();
    try {
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
      const child = JSON.parse(readFileSync(marker, 'utf8'));
      const read = () => readClaimSet(join(workspaceDir(root), 'remote-session.lock'));
      const claims = client ? withAmbientContext(client, read) : read();
      expect(child.marker).toBe(mode === 'client' ? 'client' : 'cli');
      expect(claims.live).toHaveLength(1);
      expect(claims.live[0]?.child?.pid).toBe(child.pid);
    } finally {
      writeFileSync(release, 'done');
      await cleanup;
    }
  });
});
