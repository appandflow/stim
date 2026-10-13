import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { withAmbientContext } from '@stim-cli/core';
import { runPrebuild } from '../engine/prebuild.ts';
import { podEnvForRubyAsync, runPodInstall } from '../engine/deps.ts';
import { androidHome, androidToolPath, listInstalledSystemImages } from '../devices/android.ts';
import { reportAndroidResult } from '../commands/android/result.ts';
import { makeWriter } from './_factories.ts';
import { testContext } from './_context.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-api-native-context-'));
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
