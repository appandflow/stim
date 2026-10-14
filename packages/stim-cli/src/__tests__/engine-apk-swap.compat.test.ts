import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withAmbientContext } from '@stim-cli/core';
import { getExecutor } from '../exec.ts';
import { swapApkBundle } from '../engine/apk-swap.ts';
import { withNativeBuildRun } from '../engine/native-run.ts';
import { readClaimSet } from '../ownership-claim.ts';
import { testContext } from './_context.ts';

test.skipIf(process.platform !== 'win32')(
  'Windows APK signing declares the Java signer and drains it before cancelled reuse returns',
  { timeout: 15_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'stim-signing-cancel-'));
    const executor = getExecutor();
    const javaHome = (process.env.JAVA_HOME ?? '').replaceAll('"', '');
    expect(javaHome, 'JAVA_HOME must name an installed JDK for this compatibility check').not.toBe('');
    const pidFile = join(root, 'signer.pid');
    const controller = new AbortController();
    const context = testContext({
      home: join(root, 'home'),
      cwd: root,
      projectRoot: root,
      signal: controller.signal,
      env: {
        PATH: dirname(process.execPath),
        JAVA_HOME: javaHome,
        HOME: root,
        USERPROFILE: root,
        STIM_HOME: join(root, 'home'),
        SIGNER_PID_FILE: pidFile,
      },
    });
    const tools = join(root, 'tools');
    const jar = join(tools, 'lib', 'apksigner.jar');
    let work: Promise<Awaited<ReturnType<typeof swapApkBundle>>> | undefined;
    let claimRoot = '';
    try {
      mkdirSync(dirname(jar), { recursive: true });
      writeFileSync(
        join(root, 'Signer.java'),
        'import java.nio.file.*; public class Signer { public static void main(String[] args) throws Exception {' +
          'Files.writeString(Path.of(System.getenv("SIGNER_PID_FILE")), Long.toString(ProcessHandle.current().pid()));' +
          'Thread.sleep(4000); System.exit(1); }}',
      );
      await executor.runFileAsync(join(javaHome, 'bin', 'javac.exe'), [join(root, 'Signer.java')], {
        timeoutMs: 10_000,
      });
      await executor.runFileAsync(
        join(javaHome, 'bin', 'jar.exe'),
        ['--create', '--file', jar, '--main-class', 'Signer', '-C', root, 'Signer.class'],
        { timeoutMs: 10_000 },
      );
      writeFileSync(
        join(tools, 'apksigner.bat'),
        '@"%JAVA_HOME%\\bin\\java.exe" -jar "%~dp0lib\\apksigner.jar" %*\r\n',
      );
      const cli = join(root, 'node_modules', 'expo');
      mkdirSync(cli, { recursive: true });
      writeFileSync(join(cli, 'package.json'), JSON.stringify({ name: 'expo', bin: { expo: 'cli.js' } }));
      writeFileSync(
        join(cli, 'cli.js'),
        'const fs=require("node:fs"); fs.writeFileSync(process.argv[process.argv.indexOf("--bundle-output")+1], "bundle");',
      );
      const cached = join(root, 'cached.apk');
      writeFileSync(cached, 'cached bytes');
      const zipalign = join(tools, 'zipalign.exe');
      const filteredExecutor = {
        ...executor,
        runFileAsync: async (...args: Parameters<typeof executor.runFileAsync>) => {
          if (basename(args[0]) === 'jar') return '';
          if (args[0] === zipalign) {
            const input = args[1].at(-2);
            const output = args[1].at(-1);
            if (!input || !output) throw new Error('zipalign must name its input and output');
            copyFileSync(input, output);
            return '';
          }
          return executor.runFileAsync(...args);
        },
      };
      work = withAmbientContext(context, () =>
        withNativeBuildRun(
          context,
          root,
          { platform: 'android', command: 'android' },
          (claim) => {
            claimRoot = claim.root;
            return swapApkBundle({
              context,
              root,
              isExpo: true,
              cachedApkPath: cached,
              keystore: { path: join(root, 'debug.keystore'), pass: 'pass:android', password: null },
              exec: filteredExecutor,
              hermesEnabled: false,
              buildTools: { path: zipalign, tool: 'zipalign', version: '37.0.0', major: 37 },
              storedAssets: { version: 1, assets: [] },
              readManifest: () => ({ version: 1, assets: [] }),
              heartbeatMs: 0,
            });
          },
          { write: () => {} },
        ),
      );
      let pid = 0;
      for (let i = 0; i < 100 && pid <= 1; i++) {
        if (existsSync(pidFile)) pid = Number(readFileSync(pidFile, 'utf8'));
        if (pid <= 1) await delay(25);
      }
      expect(pid).toBeGreaterThan(1);
      const declared = readClaimSet(claimRoot).live[0]?.child?.pid;
      const started = Date.now();
      controller.abort();
      const result = await work;
      expect(declared).toBe(pid);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(result).toMatchObject({ failed: true, step: 'apksigner' });
      expect(result.apkPath).toBeUndefined();
      expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
      expect(readClaimSet(claimRoot).live).toHaveLength(0);
      expect(readFileSync(cached, 'utf8')).toBe('cached bytes');
    } finally {
      controller.abort();
      await work;
      rmSync(root, { recursive: true, force: true });
    }
  },
);
