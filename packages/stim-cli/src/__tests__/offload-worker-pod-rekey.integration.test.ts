import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BuildHost } from '../job/offload/host.ts';
import { fingerprint, fingerprintRuntime } from '../fingerprint/evaluate.ts';
import { fingerprintOffloadInputs } from '../fingerprint/operation.ts';
import { isUncertain } from '../fingerprint/key.ts';
import { readClaimSet } from '../ownership-claim.ts';
import { getExecutor } from '../exec.ts';

const cli = fileURLToPath(new URL('../../dist/cli.mjs', import.meta.url));
const modules = fileURLToPath(new URL('../../../../apps/mobile/node_modules', import.meta.url));
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

describe.skipIf(process.platform === 'win32')('post-pods worker rekey', () => {
  test.each(['lock', 'other', 'added', 'after-build', 'workspace', 'declared'] as const)(
    'build.start %s post-pods changes through the real worker',
    { timeout: 180_000 },
    async (change) => {
      const temp = realpathSync(mkdtempSync(join(tmpdir(), 'stim-worker-pods-')));
      const project = join(temp, 'project');
      const home = join(temp, 'home');
      const bin = join(temp, 'bin');
      mkdirSync(project);
      mkdirSync(home);
      mkdirSync(bin);
      const oldEnv = { ...process.env };
      process.env.STIM_HOME = home;
      process.env.STIM_ENGINE_ROOT = join(temp, 'engine');
      process.env.PATH = `${bin}${delimiter}${oldEnv.PATH ?? ''}`;
      let host: BuildHost | undefined;
      let session: ReturnType<BuildHost['session']> | undefined;
      let workerOutcome: unknown;
      let uncertain = false;
      try {
        writeFileSync(
          join(home, 'config.json'),
          JSON.stringify({
            server: { maxLoadPerCore: 100_000 },
            daemon: { mode: 'off' },
            concurrency: { maxBuilds: 0 },
          }),
        );
        const signal = AbortSignal.timeout(110_000);
        const run = (file: string, args: string[]) =>
          getExecutor().runFileAsync(file, args, {
            cwd: project,
            signal,
            timeoutMs: 110_000,
            cleanupOnExit: true,
            containProcessTree: true,
          });
        for (const setting of ['iosSimulatorApp', 'androidEmulatorApp'])
          await run(process.execPath, [cli, 'settings', 'set', setting, 'stim-desktop']);
        const files: Record<string, string> = {
          'package.json': JSON.stringify({
            name: 'worker-pods',
            version: '1.0.0',
            dependencies: { expo: '*', 'react-native': '*' },
          }),
          'app.json': JSON.stringify({ expo: { name: 'Fixture', slug: 'fixture' } }),
          'pnpm-lock.yaml': readFileSync(join(modules, '..', '..', '..', 'pnpm-lock.yaml'), 'utf8'),
          '.gitignore': 'node_modules\nios/Pods/\n',
          'ios/Podfile':
            "platform :ios, '16.0'\nconfig_command = ['node', '--eval', 'require(require.resolve(\"expo/bin/autolinking\"))(process.argv.slice(1))', 'react-native-config', '--json', '--platform', 'ios']\nconfig = use_native_modules!(config_command)\n",
          'ios/Fixture.xcodeproj/project.pbxproj': '// fixture\n',
          ...(change === 'workspace' ? { 'ios/Fixture.xcworkspace/contents.xcworkspacedata': '<Workspace/>\n' } : {}),
          ...(change === 'declared' ? { 'native-extra/kept.txt': 'kept\n' } : {}),
        };
        const write = (path: string, text: string) => {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, text);
        };
        for (const [path, text] of Object.entries(files)) write(join(project, path), text);
        symlinkSync(modules, join(project, 'node_modules'), 'junction');
        const script = (name: string, body: string) => {
          const path = join(bin, name);
          writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
          chmodSync(path, 0o755);
        };
        script('pnpm', ':');
        script(
          'pod',
          `mkdir -p Pods\nprintf 'PODS:\\n  - Fixture (1.0.0)\\n\\nCOCOAPODS: 1.16.2\\n' > Podfile.lock\ncp Podfile.lock Pods/Manifest.lock\n${change === 'other' ? "printf '\\n# changed by pod install\\n' >> Podfile" : change === 'added' ? "mkdir -p Fixture; printf '// generated\\n' > Fixture/Generated.swift" : change === 'workspace' ? "mkdir -p Fixture.xcworkspace/xcshareddata/swiftpm; printf '{}\\n' > Fixture.xcworkspace/xcshareddata/swiftpm/Package.resolved" : change === 'declared' ? "printf 'added\\n' > ../native-extra/added.txt" : ':'}`,
        );
        script(
          'xcrun',
          `printf '%s\\n' '{"devices":{"iOS-27-0":[{"udid":"fixture","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17","isAvailable":true}]}}'`,
        );
        script(
          'xcodebuild',
          `case " $* " in *' -list '*) printf '%s\\n' '{"project":{"name":"Fixture","schemes":["Fixture"]}}'; exit 0;; esac\nprintf built > ${JSON.stringify(join(temp, 'compiled'))}\n${change === 'after-build' ? "mkdir -p Fixture; printf '// generated\\n' > Fixture/Generated.swift" : ':'}\ndd=''\nwhile [ "$#" -gt 0 ]; do if [ "$1" = '-derivedDataPath' ]; then shift; dd="$1"; fi; shift; done\napp="$dd/Build/Products/Debug-iphonesimulator/Fixture.app"\nmkdir -p "$app"\nprintf '%s\\n' '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.stim.fixture</string></dict></plist>' > "$app/Info.plist"\nprintf '%s\\n' '** BUILD SUCCEEDED **'`,
        );
        await run('git', ['init', '--quiet', project]);
        await run('git', ['-C', project, 'add', '.']);
        const target = {
          platform: 'ios' as const,
          ...(change === 'declared' ? { fingerprintInputs: ['native-extra'] } : {}),
        };
        const initial = await fingerprint(project, target, {
          env: process.env,
          embedMode: 'development',
          index: 'skip',
          signal,
        });
        if (isUncertain(initial)) throw new Error(initial.uncertain);
        const replay = fingerprintOffloadInputs(project, target, initial, process.env);
        if (isUncertain(replay)) throw new Error(replay.uncertain);
        host = new BuildHost({
          worker: cli,
          workerArgs: ['__job', 'offload-worker'],
          env: process.env,
          limits: { minFreeBytes: 0 },
        });
        let finish!: (value: unknown) => void;
        const outcome = new Promise<unknown>((resolve) => {
          finish = resolve;
        });
        const frames: Buffer[] = [];
        session = host.session(
          'client',
          { OPEN: 1, readyState: 1, bufferedAmount: 0, send: (frame: Buffer) => frames.push(frame) },
          (event) => {
            if ('outcome' in event) {
              workerOutcome = event.outcome;
              finish(event.outcome);
            }
          },
        );
        const manifest = Object.keys(files).map((path) => {
          const data = readFileSync(join(project, path));
          return { path, kind: 'file' as const, size: data.length, sha256: sha(data) };
        });
        expect(session.sync({ repo: 'repo', files: manifest, done: true })).toHaveProperty('result.missing');
        for (const item of manifest) {
          const data = readFileSync(join(project, item.path));
          expect(session.blob(Buffer.concat([Buffer.from(item.sha256, 'hex'), data]))).toBeNull();
        }
        const mirror = join(host.clientDir('client'), 'repos', 'repo', 'src');
        mkdirSync(mirror, { recursive: true });
        symlinkSync(modules, join(mirror, 'node_modules'), 'junction');
        const started = await session.start({
          repo: 'repo',
          project: '',
          platform: 'ios',
          runtime: 'iOS-27-0',
          stimBuild: 'fixture',
          compat: 6,
          fingerprint: initial.hash,
          fingerprintSchema: replay.schema,
          fingerprintSources: replay.sources.map(({ name, kind, hash }) => ({ id: name, kind, hash })),
          fingerprintEnv: replay.env,
          fingerprintNative: replay.native,
          fingerprintLayout: replay.layout,
          fingerprintRuntime: replay.runtime,
          ...(replay.fingerprintInputs ? { fingerprintInputs: replay.fingerprintInputs } : {}),
          podsOnWorker: true,
        });
        if (!('result' in started)) throw new Error(started.error.message);
        signal.throwIfAborted();
        let abort!: () => void;
        const cancelled = new Promise<never>((_, reject) => {
          abort = () => reject(new Error('worker did not finish'));
          signal.addEventListener('abort', abort, { once: true });
        });
        const result = await Promise.race([outcome, cancelled]).finally(() =>
          signal.removeEventListener('abort', abort),
        );
        if (result && typeof result === 'object' && 'code' in result && result.code === 'fingerprint-runtime')
          console.error(
            JSON.stringify({
              expectedRuntime: replay.runtime,
              mirrorRuntime: fingerprintRuntime(mirror, process.env),
              mirrorModules: existsSync(join(mirror, 'node_modules')),
              mirrorExpo: existsSync(join(mirror, 'node_modules/expo')),
            }),
          );
        const expected = {
          lock: { ok: true, fingerprint: expect.any(String), artifact: { sha256: expect.any(String) } },
          other: { ok: false, code: 'fingerprint-mismatch' },
          added: { ok: false, code: 'no-fingerprint', message: expect.stringContaining('ios/Fixture/Generated.swift') },
          'after-build': { ok: false, code: 'fingerprint-moved' },
          workspace: {
            ok: false,
            code: 'no-fingerprint',
            message: expect.stringContaining('ios/Fixture.xcworkspace/xcshareddata/swiftpm/Package.resolved'),
          },
          declared: { ok: false, code: 'no-fingerprint', message: expect.stringContaining('native-extra/added.txt') },
        };
        if (result && typeof result === 'object' && 'ok' in result && result.ok !== expected[change].ok)
          console.error('Unexpected worker outcome:', JSON.stringify(result));
        expect(result).toMatchObject(expected[change]);
        expect(existsSync(join(temp, 'compiled'))).toBe(change === 'lock' || change === 'after-build');
        let verified: { fingerprintChanged: boolean; sizeMatches: boolean; digestMatches: boolean } | null = null;
        if (change === 'lock') {
          if (
            !result ||
            typeof result !== 'object' ||
            !('fingerprint' in result) ||
            typeof result.fingerprint !== 'string' ||
            !('artifact' in result) ||
            !result.artifact ||
            typeof result.artifact !== 'object' ||
            !('sha256' in result.artifact) ||
            typeof result.artifact.sha256 !== 'string'
          )
            throw new Error('The worker returned no fingerprinted artifact.');
          const fetched = await session.artifact({ job: started.result.job });
          if (!('result' in fetched)) throw new Error(fetched.error.message);
          const bytes = Buffer.concat(frames.map((frame) => frame.subarray(32)));
          verified = {
            fingerprintChanged: result.fingerprint !== initial.hash,
            sizeMatches: bytes.length === fetched.result.size,
            digestMatches: sha(bytes) === fetched.result.sha256 && fetched.result.sha256 === result.artifact.sha256,
          };
        }
        expect(verified).toEqual(
          change === 'lock' ? { fingerprintChanged: true, sizeMatches: true, digestMatches: true } : null,
        );
      } catch (error) {
        uncertain = typeof error === 'object' && error !== null && 'reportCleanup' in error;
        throw error;
      } finally {
        session?.close();
        let settled = !host && !uncertain;
        try {
          await host?.close();
          const claims = host ? readClaimSet(join(host.clientDir('client'), 'repos', 'repo.claims')) : null;
          settled =
            !uncertain &&
            (!claims || (!claims.live.length && !claims.unresolved.length)) &&
            !(
              workerOutcome &&
              typeof workerOutcome === 'object' &&
              'code' in workerOutcome &&
              workerOutcome.code === 'cleanup-unresolved'
            );
        } finally {
          for (const name of Object.keys(process.env)) if (!Object.hasOwn(oldEnv, name)) delete process.env[name];
          Object.assign(process.env, oldEnv);
          if (settled) rmSync(temp, { recursive: true, force: true });
          else console.error(`Unverified worker cleanup; retained ${temp}`);
        }
      }
    },
  );
});
