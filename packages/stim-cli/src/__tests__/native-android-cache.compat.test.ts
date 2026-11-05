import { appendFile, mkdir, readFile, readdir, realpath, rm, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { androidHome, findBuildTool } from '../devices/android.ts';
import { getExecutor } from '../exec.ts';
import { nativeAndroidCache, materializeNativeApk } from '../integrations/native-android-cache.ts';
import { testContext } from './_context.ts';

test.each([false, true])(
  'real Android SDK tools verify a signed native APK before cache reuse (v3=%s)',
  async (v3) => {
    const sdk = androidHome();
    const signer = findBuildTool(['apksigner'], { home: sdk });
    const aapt = findBuildTool(['aapt'], { home: sdk });
    const executor = getExecutor();
    const keytool = executor.findExecutable('keytool');
    if (!signer || !aapt || !keytool) throw new Error('Android SDK apksigner/aapt and a JDK keytool are required.');
    const platform = (await readdir(join(sdk, 'platforms')))
      .filter((name) => /^android-\d+$/.test(name))
      .toSorted((a, b) => Number(b.slice(8)) - Number(a.slice(8)))[0];
    if (!platform) throw new Error('An installed Android SDK platform is required.');
    const root = await realpath(await mkdtemp(join(tmpdir(), 'stim-native-apk-compat-')));
    const home = join(root, 'home');
    const cli = fileURLToPath(new URL('../../dist/cli.mjs', import.meta.url));
    await mkdir(home);
    await writeFile(join(root, 'settings.gradle'), "rootProject.name = 'native-apk-compat'\n");
    await writeFile(join(root, 'gradlew'), '#!/bin/sh\nexit 1\n');
    vi.stubEnv('STIM_HOME', home);
    vi.stubEnv('STIM_BUILD_CACHE', join(root, 'cache'));
    const options = { cwd: root, timeoutMs: 60_000 };
    const command = (file: string, args: string[]) => executor.runFileAsync(file, args, options);
    try {
      await command(process.execPath, [cli, 'settings', 'set', 'iosSimulatorApp', 'stim-desktop']);
      await command(process.execPath, [cli, 'settings', 'set', 'androidEmulatorApp', 'stim-desktop']);
      const manifest = join(root, 'AndroidManifest.xml');
      const unsigned = join(root, 'unsigned.apk');
      const signed = join(root, 'signed.apk');
      const key = join(root, 'fixture.jks');
      await writeFile(
        manifest,
        '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="dev.stim.cache.compat" android:versionCode="1" android:versionName="1"><uses-sdk android:minSdkVersion="23"/><application android:hasCode="false" android:label="Cache probe"/></manifest>',
      );
      await command(aapt.path, [
        'package',
        '-f',
        '-M',
        manifest,
        '-I',
        join(sdk, 'platforms', platform, 'android.jar'),
        '-F',
        unsigned,
      ]);
      await command(keytool, [
        '-genkeypair',
        '-keystore',
        key,
        '-storepass',
        'fixture-pass',
        '-keypass',
        'fixture-pass',
        '-alias',
        'fixture',
        '-keyalg',
        'RSA',
        '-validity',
        '1',
        '-dname',
        'CN=Stim cache compatibility',
        '-noprompt',
      ]);
      await command(signer.path, [
        'sign',
        '--v2-signing-enabled',
        'true',
        '--v3-signing-enabled',
        String(v3),
        '--ks',
        key,
        '--ks-pass',
        'pass:fixture-pass',
        '--key-pass',
        'pass:fixture-pass',
        '--out',
        signed,
        unsigned,
      ]);
      const context = testContext({ home, cwd: root, projectRoot: root });
      const cache = nativeAndroidCache(sdk, null, () => 'dev.stim.cache.compat', context);
      const target = {
        projectRoot: root,
        platform: 'android' as const,
        key: 'native-compat',
        sourcePath: signed,
        overwrite: false,
        signal: context.signal,
      };
      const stored = await cache.store(target);
      if (typeof stored !== 'string') throw new Error('The native APK was not stored.');
      expect(await materializeNativeApk(target.key, stored, sdk, null, context)).toMatchObject({
        androidPackage: 'dev.stim.cache.compat',
      });
      const before = await readFile(stored);
      const controller = new AbortController();
      controller.abort();
      await expect(cache.store({ ...target, overwrite: true, signal: controller.signal })).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(await readFile(stored)).toEqual(before);
      await appendFile(stored, 'corrupt');
      expect(await materializeNativeApk(target.key, stored, sdk, null, context)).toBeNull();
    } finally {
      try {
        await command(process.execPath, [cli, 'stop']);
      } finally {
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    }
  },
  120_000,
);
