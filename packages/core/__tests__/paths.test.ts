import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildCacheRoot as sharedBuildCache,
  metroCacheRoot as sharedMetroCache,
  workspaceId,
  workspaceName,
  workspaceSlug,
  workspaceStateDir as workspaceDir,
} from '../index.ts';
import {
  emulatorLogFile,
  sharedCcache,
  sharedCompilationCache,
  sharedGradle,
  sharedPods,
  serverLocalSocket,
  supervisorPidFile,
  workspaceDerivedData,
  workspaceGradleBuild,
  workspaceLogsDir,
  workspaceAgentDeviceDir,
  workspaceStateFile,
} from '../state/paths.ts';

describe('workspace paths', () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
    process.env.STIM_HOME = tmpHome;
  });
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    delete process.env.STIM_HOME;
  });

  test('workspace state lives under STIM_HOME with a readable collision-safe name', () => {
    const root = '/repo/My App';
    const dir = join(tmpHome, 'workspaces', workspaceName(root));
    expect(workspaceSlug(root)).toBe('my-app');
    expect(workspaceId(root)).toMatch(/^[a-f0-9]{16}$/);
    expect(workspaceName(root)).toBe(`my-app--${workspaceId(root)}`);
    expect(workspaceDir(root)).toBe(dir);
    expect(workspaceLogsDir(root)).toBe(join(dir, 'logs'));
    expect(workspaceAgentDeviceDir(root)).toBe(join(dir, 'agent-device'));
    expect(workspaceDerivedData(root)).toBe(join(dir, 'derived-data'));
    expect(workspaceGradleBuild(root)).toBe(join(dir, 'gradle-build'));
    expect(supervisorPidFile(root)).toBe(join(dir, 'supervisor.pid'));
    expect(workspaceStateFile(root)).toBe(join(dir, 'state.json'));
    expect(emulatorLogFile(root)).toBe(join(dir, 'logs', 'emulator.log'));
  });

  test('path calculation is pure: no directory is created as a side effect', () => {
    const root = join(tmpdir(), 'stim-nonexistent-xyz');
    workspaceDir(root);
    workspaceLogsDir(root);
    workspaceAgentDeviceDir(root);
    workspaceDerivedData(root);
    workspaceGradleBuild(root);
    supervisorPidFile(root);
    workspaceStateFile(root);
    emulatorLogFile(root);
    expect(existsSync(workspaceDir(root))).toBe(false);
    expect(existsSync(join(root, '.stim'))).toBe(false);
  });

  test('same basename at different paths is readable and collision-safe', () => {
    expect(workspaceSlug('/one/mobile')).toBe('mobile');
    expect(workspaceSlug('/two/mobile')).toBe('mobile');
    expect(workspaceName('/one/mobile')).not.toBe(workspaceName('/two/mobile'));
  });
});

describe('shared paths', () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
    process.env.STIM_HOME = tmpHome;
  });
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    delete process.env.STIM_HOME;
  });

  test('shared caches honour STIM_HOME', () => {
    expect(sharedMetroCache()).toBe(join(tmpHome, 'metro-cache'));
    expect(sharedBuildCache()).toBe(join(tmpHome, 'build-cache'));
    expect(sharedCompilationCache()).toBe(join(tmpHome, 'compilation-cache'));
    expect(sharedCcache()).toBe(join(tmpHome, 'ccache'));
    expect(sharedGradle()).toBe(join(tmpHome, 'gradle'));
    expect(sharedPods()).toBe(join(tmpHome, 'pods'));
  });

  test.skipIf(process.platform !== 'darwin')(
    'local sockets fit long hosted and Unicode homes without sharing identities',
    () => {
      process.env.STIM_HOME = '/tmp/short';
      expect(serverLocalSocket()).toBe('/tmp/short/server/local.sock');
      process.env.STIM_HOME = '/tmp/' + 'a'.repeat(80);
      expect(serverLocalSocket()).toBe(process.env.STIM_HOME + '/server/local.sock');
      expect(Buffer.byteLength(serverLocalSocket())).toBe(103);
      process.env.STIM_HOME += 'a';
      expect(serverLocalSocket()).not.toBe(process.env.STIM_HOME + '/server/local.sock');
      process.env.STIM_HOME =
        '/Users/desktop-test/.stim/device-host/sessions/00000000-0000-0000-0000-000000000001/home';
      const hosted = serverLocalSocket();
      expect(hosted).toBe(
        `/tmp/stim-sockets-${process.getuid?.()}/9f6edf71ce2641a80365d6ee1e38df37cebd7261304e96694ce1bc2053ab1267.sock`,
      );
      process.env.STIM_HOME = '/tmp/' + '\u00e9'.repeat(45);
      expect(serverLocalSocket()).toBe(
        `/tmp/stim-sockets-${process.getuid?.()}/46b20e2924d77e53740dfa2db4d94ffaf8ea79ce0ee1dae0ac77a566b2f16748.sock`,
      );
      expect(serverLocalSocket()).not.toBe(hosted);
      expect(Buffer.byteLength(serverLocalSocket())).toBeLessThanOrEqual(103);
      process.env.STIM_HOME = '/tmp/./unused/../' + '\u00e9'.repeat(45);
      expect(serverLocalSocket()).toBe(
        `/tmp/stim-sockets-${process.getuid?.()}/46b20e2924d77e53740dfa2db4d94ffaf8ea79ce0ee1dae0ac77a566b2f16748.sock`,
      );
      process.env.STIM_HOME = '/tmp/\u0301foo/../' + '\u00e9'.repeat(45);
      expect(serverLocalSocket()).toBe(
        `/tmp/stim-sockets-${process.getuid?.()}/46b20e2924d77e53740dfa2db4d94ffaf8ea79ce0ee1dae0ac77a566b2f16748.sock`,
      );
    },
  );

  test.skipIf(process.platform !== 'linux')('Linux keeps working socket paths through 107 UTF-8 bytes', () => {
    for (const length of [103, 104, 107]) {
      process.env.STIM_HOME = '/tmp/' + 'a'.repeat(length - 23);
      expect(serverLocalSocket()).toBe(process.env.STIM_HOME + '/server/local.sock');
      expect(Buffer.byteLength(serverLocalSocket())).toBe(length);
    }
    process.env.STIM_HOME += 'a';
    expect(serverLocalSocket()).not.toBe(process.env.STIM_HOME + '/server/local.sock');
    expect(Buffer.byteLength(serverLocalSocket())).toBeLessThanOrEqual(107);
    process.env.STIM_HOME = '/tmp/./unused/../' + '\u00e9'.repeat(45);
    expect(serverLocalSocket()).toBe(
      `/tmp/stim-sockets-${process.getuid?.()}/46b20e2924d77e53740dfa2db4d94ffaf8ea79ce0ee1dae0ac77a566b2f16748.sock`,
    );
  });

  test('shared paths are pure: reading one creates nothing', () => {
    sharedMetroCache();
    sharedBuildCache();
    sharedCompilationCache();
    sharedCcache();
    sharedGradle();
    sharedPods();
    expect(existsSync(join(tmpHome, 'metro-cache'))).toBe(false);
    expect(existsSync(join(tmpHome, 'build-cache'))).toBe(false);
    expect(existsSync(join(tmpHome, 'ccache'))).toBe(false);
  });
});

describe('shared cache roots', () => {
  let tmpHome: string;
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'stim-test-'));
    process.env.STIM_HOME = tmpHome;
  });
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    delete process.env.STIM_HOME;
    delete process.env.STIM_BUILD_CACHE;
    delete process.env.STIM_METRO_CACHE;
  });

  test('explicit cache env overrides win and remain parent roots', () => {
    const customBuild = resolve('/tmp/custom-build');
    const customMetro = resolve('/tmp/custom-metro');
    process.env.STIM_BUILD_CACHE = customBuild;
    expect(sharedBuildCache()).toBe(customBuild);

    process.env.STIM_METRO_CACHE = customMetro;
    expect(sharedMetroCache()).toBe(customMetro);
    expect(sharedMetroCache('demo')).toBe(join(customMetro, 'demo'));
    expect(sharedMetroCache('@scope/app')).toBe(join(customMetro, '-scope-app'));
  });

  test('a named Metro cache is a subdirectory, and cannot escape the root', () => {
    expect(sharedMetroCache('demo')).toBe(join(tmpHome, 'metro-cache', 'demo'));
    expect(sharedMetroCache('@scope/app')).toBe(join(tmpHome, 'metro-cache', '-scope-app'));
    expect(sharedMetroCache('..')).toBe(join(tmpHome, 'metro-cache', 'app'));
  });
});
