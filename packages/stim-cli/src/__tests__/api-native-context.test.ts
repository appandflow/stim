import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { withAmbientContext } from '@stim-cli/core';
import { runPrebuild } from '../engine/prebuild.ts';
import { podEnvForRubyAsync, runPodInstall } from '../engine/deps.ts';
import { androidHome, androidToolPath, listInstalledSystemImages } from '../devices/android.ts';
import { reportAndroidResult } from '../commands/android/result.ts';
import { makeWriter } from './_factories.ts';
import { testContext } from './_context.ts';
import { getExecutor } from '../exec.ts';
import { buildPlacementSettings } from '../offload/selection.ts';
import { createDebugLog, getConcurrencyLimits, getParkedMax } from '@stim-cli/core/state';
import { deviceSweepIsScoped } from '../commands/gc/devices.ts';
import { planCacheEmptying } from '../commands/gc/caches.ts';
import {
  endRecordedSession,
  remoteIosDeps,
  readInstalledEasCliVersionAsync,
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
import { checkEasFallback } from '../engine/eas-fallback.ts';
import { checkEasAuth, loadProjectProvider } from '../engine/remote-cache.ts';
import { resolveEasDevelopmentBuild } from '../engine/eas-build.ts';
import { swapJsBundle } from '../engine/js-swap.ts';
import { swapApkBundle } from '../engine/apk-swap.ts';

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

function globalLauncher(packageName: 'eas-cli' | 'agent-device', body: string, manager: string) {
  const name = packageName === 'eas-cli' ? 'eas' : 'agent-device';
  const packageRoot = join(root, 'global install', 'node_modules', packageName);
  const entry = join(packageRoot, 'bin', 'run.js');
  executable(entry, body);
  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify({ name: packageName, bin: { [name]: 'bin/run.js' } }),
  );
  if (manager === 'script') return entry;
  const tool = join(root, 'global bin', `${name}.cmd`);
  mkdirSync(dirname(tool), { recursive: true });
  const target =
    manager === 'pnpm-absolute' ? entry : `${manager === 'npm' ? '%dp0%' : '%~dp0'}\\${relative(dirname(tool), entry)}`;
  writeFileSync(tool, `@SETLOCAL\r\n@SET dp0=%~dp0\r\n@node "${target}" %*\r\n`);
  return tool;
}

function projectCli(name: 'expo' | 'eas-cli', body: string): string {
  const dir = join(root, 'node_modules', name);
  const entry = join(dir, 'run.js');
  executable(entry, body);
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name, bin: { [name === 'eas-cli' ? 'eas' : name]: 'run.js' } }),
  );
  return entry;
}

function context(env: NodeJS.ProcessEnv = {}) {
  return testContext({
    home: join(root, 'home'),
    projectRoot: root,
    cwd: root,
    env: {
      PATH: dirname(process.execPath),
      HOME: root,
      USERPROFILE: root,
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
    STIM_REMOTE_BUILD: 'local',
    STIM_MAX_BUILDS: '1',
    STIM_MAX_DEVICES: '2',
    STIM_POOL_ANDROID_PARKED_MAX: '0',
  });
  withAmbientContext(operation, () => {
    expect(buildPlacementSettings('local')).toEqual([{ key: 'remote.build', value: 'local', from: 'env' }]);
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

test('prebuild passes the client environment to the actual child', async () => {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { expo: '52.0.0' } }));
  projectCli(
    'expo',
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
      `const fs = require('node:fs');
const marker = ${JSON.stringify(pidFile)};
fs.writeFileSync(marker + '.tmp', String(process.pid));
fs.renameSync(marker + '.tmp', marker);
setInterval(() => {}, 100);`,
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
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  },
);

test('the EAS version probe lets host timers run', async () => {
  const tool = join(root, 'eas.js');
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

describe.skipIf(process.platform !== 'win32')('Windows global EAS launchers', () => {
  test.each(['npm', 'pnpm', 'pnpm-absolute'])(
    'a Windows %s global launcher runs its selected EAS package',
    async (manager) => {
      const tool = globalLauncher('eas-cli', `console.log('eas-cli/24.8.0');`, manager);
      const shadow = join(root, 'node_modules', 'eas-cli');
      executable(join(shadow, 'bin', 'run.js'), `console.log('wrong package');`);
      writeFileSync(join(shadow, 'package.json'), JSON.stringify({ name: 'eas-cli', bin: { eas: 'bin/run.js' } }));
      const operation = context();
      expect(await withAmbientContext(operation, () => readInstalledEasCliVersionAsync(tool, root, operation))).toBe(
        'eas-cli/24.8.0',
      );
    },
  );
});

test.each(process.platform === 'win32' ? ['script', 'npm', 'pnpm', 'pnpm-absolute'] : ['script'])(
  'an EAS %s version deadline kills its actual child and closes its pipes',
  async (kind) => {
    const marker = join(root, 'version-pid');
    const tool = globalLauncher(
      'eas-cli',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setTimeout(() => {}, 4000);`,
      kind,
    );
    const executor = getExecutor();
    const run = executor.runFileAsync.bind(executor);
    const deadline = vi
      .spyOn(executor, 'runFileAsync')
      .mockImplementation((file, args, options) => run(file, args, { ...options, timeoutMs: 1000 }));
    const operation = context();
    const started = Date.now();
    try {
      expect(
        await withAmbientContext(operation, () => readInstalledEasCliVersionAsync(tool, root, operation)),
      ).toBeNull();
      expect(existsSync(marker)).toBe(true);
      expectChildGone(Number(readFileSync(marker, 'utf8')));
      expect(Date.now() - started).toBeLessThan(3000);
      expect(operationState(operation).running.size).toBe(0);
    } finally {
      deadline.mockRestore();
    }
  },
);

function abortAfterMarker(marker: string, controller: AbortController) {
  const timer = setInterval(() => {
    if ((statSync(marker, { throwIfNoEntry: false })?.size ?? 0) > 0) controller.abort();
  }, 5);
  return () => clearInterval(timer);
}

function expectChildGone(pid: number) {
  expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
}

test.each(
  process.platform === 'darwin'
    ? ['config', 'prebuild', 'js-swap', 'apk-swap', 'eas-build']
    : ['config', 'prebuild', 'apk-swap', 'eas-build'],
)('%s owns its actual SDK child and drains an API abort', async (stage) => {
  const marker = join(root, 'sdk-pid');
  projectCli(
    stage === 'eas-build' ? 'eas-cli' : 'expo',
    `const fs = require('node:fs');
const marker = ${JSON.stringify(marker)};
fs.writeFileSync(marker + '.tmp', String(process.pid));
fs.renameSync(marker + '.tmp', marker);
setTimeout(() => {}, 4000);`,
  );
  writeFileSync(join(root, 'app.config.js'), 'module.exports = {};');
  const cachedApp = join(root, 'cache', 'Test.app');
  mkdirSync(cachedApp, { recursive: true });
  writeFileSync(
    join(cachedApp, 'Info.plist'),
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict></dict></plist>',
  );
  const cachedApk = join(root, 'cache', 'test.apk');
  writeFileSync(cachedApk, 'cached bytes');
  const controller = new AbortController();
  const operation = {
    ...context({ PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter) }),
    signal: controller.signal,
  };
  const pending = withAmbientContext(operation, () =>
    withNativeBuildRun(
      operation,
      root,
      { command: 'ios', platform: 'ios' },
      async () => {
        if (stage === 'config') return loadProjectProvider(root, { context: operation });
        if (stage === 'prebuild') return runPrebuild(root, 'ios', makeWriter(), { isExpo: true });
        if (stage === 'eas-build')
          return resolveEasDevelopmentBuild({
            context: operation,
            root,
            platform: 'android',
            profile: 'development',
            isExpo: true,
            env: operation.env,
            signal: operation.signal,
            note: () => {},
          });
        const options = { context: operation, root, isExpo: true, heartbeatMs: 0, hermesEnabled: false };
        if (stage === 'js-swap')
          return swapJsBundle({ ...options, iosDir: join(root, 'ios'), cachedAppPath: cachedApp });
        return swapApkBundle({
          ...options,
          cachedApkPath: cachedApk,
          keystore: { path: join(root, 'debug.keystore'), pass: 'pass:android', password: null },
        });
      },
      { write: () => {} },
    ),
  ).catch((error: unknown) => error);
  try {
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
    const pid = Number(readFileSync(marker, 'utf8'));
    const claims = withAmbientContext(operation, () => readClaimSet(join(workspaceDir(root), 'native-run.lock')));
    expect(claims.live).toHaveLength(1);
    expect(claims.live[0]?.child?.pid).toBe(pid);
    const started = Date.now();
    controller.abort();
    await pending;
    expect(Date.now() - started).toBeLessThan(3000);
    expectChildGone(pid);
    expect(operationState(operation).running.size).toBe(0);
  } finally {
    controller.abort();
    await pending;
  }
});

test.each(
  ['availability', 'whoami'].flatMap((stage) =>
    (process.platform === 'win32' ? ['script', 'npm', 'pnpm', 'pnpm-absolute'] : ['script']).map((kind) => [
      stage,
      kind,
    ]),
  ),
)('EAS %s through %s declares its actual child and drains cancellation', async (stage, kind) => {
  const marker = join(root, 'probe-child.json');
  const tool = globalLauncher(
    'eas-cli',
    `const fs = require('node:fs');
if (process.argv[2] === '--version') console.log('eas-cli/24.8.0');
else {
  fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, marker: process.env.STIM_CONTEXT_MARKER }));
  setTimeout(() => {}, 4000);
}`,
    kind,
  );
  const controller = new AbortController();
  const operation = { ...context(), signal: controller.signal };
  const resolveBin = () => ({ file: tool, source: 'path' as const });
  const pending = withAmbientContext(operation, () =>
    withNativeBuildRun(
      operation,
      root,
      { command: 'ios', platform: 'ios' },
      async () => {
        if (stage === 'whoami') return checkEasAuth({ context: operation, projectRoot: root, resolveBin });
        return checkEasFallback({
          root,
          platform: 'ios',
          slot: 'default',
          release: true,
          isExpo: false,
          tunnelMode: null,
          publicUrl: null,
          localOnlyFlags: [],
          env: operation.env,
          operation,
          resolveBin,
          onPath: () => true,
        });
      },
      { write: () => {} },
    ),
  ).catch((error: unknown) => error);
  try {
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
    const child = JSON.parse(readFileSync(marker, 'utf8'));
    const claims = withAmbientContext(operation, () => readClaimSet(join(workspaceDir(root), 'native-run.lock')));
    expect(child.marker).toBe('client');
    expect(claims.live).toHaveLength(1);
    expect(claims.live[0]?.child?.pid).toBe(child.pid);
    const started = Date.now();
    controller.abort();
    await pending;
    expect(Date.now() - started).toBeLessThan(3000);
    expectChildGone(child.pid);
    expect(operationState(operation).running.size).toBe(0);
  } finally {
    controller.abort();
    await pending;
  }
});

test.each(process.platform === 'win32' ? ['script', 'npm', 'pnpm', 'pnpm-absolute'] : ['script'])(
  'a proxy %s install can be cancelled without blocking the host',
  async (manager) => {
    const marker = join(root, 'install-started.json');
    vi.stubEnv('AGENT_DEVICE_DAEMON_AUTH_TOKEN', 'host-token');
    const tool = globalLauncher(
      'agent-device',
      `const fs = require('node:fs');
if (process.argv[2] === 'install') {
  fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid: process.pid, marker: process.env.STIM_CONTEXT_MARKER}));
  setTimeout(() => {}, 2000);
}`,
      manager,
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
  },
);

describe('EAS cancellation with an owned child', () => {
  test.each(['create', 'daemon-wait'])(
    'cancelling EAS during %s stops its returned session before releasing the operation',
    async (stage) => {
      const tool = join(root, 'eas.js');
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

test('cancelling a reuse query preserves the recorded EAS session', async () => {
  const tool = join(root, 'eas.js');
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

describe('session cleanup child ownership', () => {
  test.each(['cli', 'client'])('%s cleanup declares its child on the ownership claim', async (mode) => {
    const tool = join(root, 'eas.js');
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
