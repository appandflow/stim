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
import { buildSlotPath } from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';
import { fingerprint } from '../fingerprint/evaluate.ts';
import { isUncertain } from '../fingerprint/key.ts';
import { fingerprintOffloadInputs } from '../fingerprint/operation.ts';
import { BuildHost } from '../job/offload/host.ts';
import { readClaimSet } from '../ownership-claim.ts';

const cli = fileURLToPath(new URL('../../dist/cli.mjs', import.meta.url));
const modules = fileURLToPath(new URL('../../../../apps/mobile/node_modules', import.meta.url));
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const until = async (check: () => boolean, ms: number, what: string) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const script = (path: string, body: string) => {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
  chmodSync(path, 0o755);
};

describe.skipIf(process.platform === 'win32')('a host-stopped offload worker', () => {
  test.each([
    ['cancel', 'xcodebuild'],
    ['timeout', 'xcodebuild'],
    ['cancel', 'evaluator'],
  ] as const)(
    'a %s while %s hangs ends the build as cancelled and admits the next build',
    { timeout: 150_000 },
    async (stop, hang) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-offload-cancel-')));
      const project = join(root, 'project');
      const home = join(root, 'home');
      const bin = join(root, 'bin');
      const pids = join(root, 'hung-pids');
      mkdirSync(project);
      mkdirSync(home);
      mkdirSync(bin);
      writeFileSync(
        join(home, 'config.json'),
        JSON.stringify({ server: { maxLoadPerCore: 100_000 }, daemon: { mode: 'off' }, concurrency: { maxBuilds: 1 } }),
      );
      vi.stubEnv('STIM_HOME', home);
      vi.stubEnv('STIM_ENGINE_ROOT', join(root, 'engine'));
      vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`);
      script(join(bin, 'pnpm'), ':');
      script(
        join(bin, 'pod'),
        "mkdir -p Pods\nprintf 'PODS:\\n  - Fixture (1.0.0)\\n\\nCOCOAPODS: 1.16.2\\n' > Podfile.lock\ncp Podfile.lock Pods/Manifest.lock",
      );
      script(
        join(bin, 'xcrun'),
        `printf '%s\\n' '{"devices":{"iOS-27-0":[{"udid":"fixture","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17","isAvailable":true}]}}'`,
      );
      script(
        join(bin, 'xcodebuild'),
        `case " $* " in *' -list '*) printf '%s\\n' '{"project":{"name":"Fixture","schemes":["Fixture"]}}'; exit 0;; esac\necho $$ >> '${pids}'\nexec sleep 600`,
      );
      const files: Record<string, string> = {
        'package.json': JSON.stringify({
          name: 'worker-cancel',
          version: '1.0.0',
          dependencies: { expo: '*', 'react-native': '*' },
        }),
        'app.config.js': `const { appendFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
if (existsSync(join(__dirname, '..', 'hang-evaluator'))) {
  appendFileSync(join(__dirname, '..', 'hung-pids'), process.pid + '\\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
module.exports = { name: 'Fixture', slug: 'fixture' };
`,
        'pnpm-lock.yaml': readFileSync(join(modules, '..', '..', '..', 'pnpm-lock.yaml'), 'utf8'),
        '.gitignore': 'node_modules\nios/Pods/\n',
        'ios/Podfile':
          "platform :ios, '16.0'\nconfig_command = ['node', '--eval', 'require(require.resolve(\"expo/bin/autolinking\"))(process.argv.slice(1))', 'react-native-config', '--json', '--platform', 'ios']\nconfig = use_native_modules!(config_command)\n",
        'ios/Fixture.xcodeproj/project.pbxproj': '// fixture\n',
      };
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(project, path)), { recursive: true });
        writeFileSync(join(project, path), text);
      }
      symlinkSync(modules, join(project, 'node_modules'), 'junction');
      await getExecutor().runFileAsync('git', ['init', '--quiet', project], { timeoutMs: 30_000 });
      await getExecutor().runFileAsync('git', ['-C', project, 'add', '.'], { timeoutMs: 30_000 });
      const target = { platform: 'ios' as const };
      const initial = await fingerprint(project, target, {
        env: process.env,
        embedMode: 'development',
        index: 'skip',
        signal: AbortSignal.timeout(60_000),
      });
      if (isUncertain(initial)) throw new Error(initial.uncertain);
      const replay = fingerprintOffloadInputs(project, target, initial, process.env);
      if (isUncertain(replay)) throw new Error(replay.uncertain);

      const host = new BuildHost({
        worker: cli,
        workerArgs: ['__job', 'offload-worker'],
        env: process.env,
        limits: { minFreeBytes: 0, killGraceMs: 5000, ...(stop === 'timeout' ? { timeoutMs: 30_000 } : {}) },
      });
      const outcomes: unknown[] = [];
      const session = host.session('client', { OPEN: 1, readyState: 1, bufferedAmount: 0, send: () => {} }, (event) => {
        if ('outcome' in event) outcomes.push(event.outcome);
      });
      const area = join(host.clientDir('client'), 'repos', 'repo');
      const hung = () =>
        [pids, join(area, 'hung-pids')].flatMap((file) =>
          existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(Number) : [],
        );
      try {
        const manifest = Object.keys(files).map((path) => {
          const data = readFileSync(join(project, path));
          return { path, kind: 'file' as const, size: data.length, sha256: sha(data) };
        });
        session.sync({ repo: 'repo', files: manifest, done: true });
        for (const item of manifest)
          session.blob(Buffer.concat([Buffer.from(item.sha256, 'hex'), readFileSync(join(project, item.path))]));
        mkdirSync(join(area, 'src'), { recursive: true });
        symlinkSync(modules, join(area, 'src', 'node_modules'), 'junction');
        if (hang === 'evaluator') writeFileSync(join(area, 'hang-evaluator'), '');
        const params = {
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
          podsOnWorker: true,
        };
        const first = await session.start(params);
        if (!('result' in first)) throw new Error(first.error.message);
        await until(() => hung().length > 0 || outcomes.length > 0, 60_000, `the hung ${hang}`);
        expect(outcomes).toEqual([]);
        expect(readClaimSet(buildSlotPath(0)).live).toHaveLength(1);
        if (stop === 'cancel') session.cancel({ job: first.result.job });
        await until(() => outcomes.length === 1, 60_000, 'the first outcome');
        expect(outcomes[0]).toMatchObject({ ok: false, code: 'cancelled' });
        const stopped = hung();
        expect(stopped.filter(alive)).toEqual([]);
        expect(readClaimSet(buildSlotPath(0))).toMatchObject({ live: [], unresolved: [] });
        expect(readClaimSet(`${area}.claims`)).toMatchObject({ live: [], unresolved: [] });

        const second = await session.start(params);
        expect(second).toHaveProperty('result.job');
        if ('result' in second) {
          await until(() => hung().length > stopped.length || outcomes.length > 1, 60_000, `the second ${hang}`);
          session.cancel({ job: second.result.job });
          await until(() => outcomes.length === 2, 60_000, 'the second outcome');
        }
      } finally {
        session.close();
        await host.close();
        vi.unstubAllEnvs();
        for (const pid of hung())
          if (alive(pid))
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {
              process.kill(pid, 'SIGKILL');
            }
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
