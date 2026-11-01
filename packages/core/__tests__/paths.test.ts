import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCacheRoot as sharedBuildCache, metroCacheRoot as sharedMetroCache } from '../index.ts';
import { sharedCcache, sharedCompilationCache, sharedGradle, sharedPods, serverLocalSocket } from '../state/paths.ts';

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
});
