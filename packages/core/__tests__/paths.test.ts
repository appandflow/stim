import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCacheRoot as sharedBuildCache, metroCacheRoot as sharedMetroCache } from '../index.ts';
import { sharedCcache, sharedCompilationCache, sharedGradle, sharedPods, stimdSocket } from '../state/paths.ts';

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
      expect(stimdSocket()).toBe('/tmp/short/run/stimd.sock');
      process.env.STIM_HOME = '/tmp/' + 'a'.repeat(83);
      expect(stimdSocket()).toBe(process.env.STIM_HOME + '/run/stimd.sock');
      expect(Buffer.byteLength(stimdSocket())).toBe(103);
      process.env.STIM_HOME += 'a';
      expect(stimdSocket()).not.toBe(process.env.STIM_HOME + '/run/stimd.sock');
      process.env.STIM_HOME =
        '/Users/desktop-test/.stim/device-host/sessions/00000000-0000-0000-0000-000000000001/stim-home';
      const hosted = stimdSocket();
      expect(hosted).toBe(
        `/tmp/stim-sockets-${process.getuid?.()}/b0d5ccf1c88c0627470c485853d9e2b40a094c7407f6468d9355dd804856378c.sock`,
      );
      process.env.STIM_HOME = '/tmp/' + '\u00e9'.repeat(45);
      expect(stimdSocket()).toBe(
        `/tmp/stim-sockets-${process.getuid?.()}/2c413285b3a4a5ad5d33bc7970cd2cb5868eaec8d7f4253dfbe31ed210855e06.sock`,
      );
      expect(stimdSocket()).not.toBe(hosted);
      expect(Buffer.byteLength(stimdSocket())).toBeLessThanOrEqual(103);
      process.env.STIM_HOME = '/tmp/./unused/../' + '\u00e9'.repeat(45);
      expect(stimdSocket()).toBe(
        `/tmp/stim-sockets-${process.getuid?.()}/2c413285b3a4a5ad5d33bc7970cd2cb5868eaec8d7f4253dfbe31ed210855e06.sock`,
      );
      process.env.STIM_HOME = '/tmp/\u0301foo/../' + '\u00e9'.repeat(45);
      expect(stimdSocket()).toBe(
        `/tmp/stim-sockets-${process.getuid?.()}/2c413285b3a4a5ad5d33bc7970cd2cb5868eaec8d7f4253dfbe31ed210855e06.sock`,
      );
    },
  );

  test.skipIf(process.platform !== 'linux')('Linux keeps working socket paths through 107 UTF-8 bytes', () => {
    for (const length of [103, 104, 107]) {
      process.env.STIM_HOME = '/tmp/' + 'a'.repeat(length - 20);
      expect(stimdSocket()).toBe(process.env.STIM_HOME + '/run/stimd.sock');
      expect(Buffer.byteLength(stimdSocket())).toBe(length);
    }
    process.env.STIM_HOME += 'a';
    expect(stimdSocket()).not.toBe(process.env.STIM_HOME + '/run/stimd.sock');
    expect(Buffer.byteLength(stimdSocket())).toBeLessThanOrEqual(107);
    process.env.STIM_HOME = '/tmp/./unused/../' + '\u00e9'.repeat(45);
    expect(stimdSocket()).toBe(
      `/tmp/stim-sockets-${process.getuid?.()}/2c413285b3a4a5ad5d33bc7970cd2cb5868eaec8d7f4253dfbe31ed210855e06.sock`,
    );
  });
});
