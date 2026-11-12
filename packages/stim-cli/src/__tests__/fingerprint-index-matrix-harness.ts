import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { getExecutor, resetExecutor } from '../exec.ts';
import { fingerprint, type Fingerprint } from '../fingerprint/evaluate.ts';
import { isUncertain } from '../fingerprint/key.ts';

const MOBILE_MODULES = fileURLToPath(new URL('../../../../apps/mobile/node_modules', import.meta.url));
const REPO_LOCK = join(MOBILE_MODULES, '..', '..', '..', 'pnpm-lock.yaml');
const SLOW = { timeout: 120_000 };
const ENV = { PATH: process.env.PATH, APP_FLAG: 'on' };

let base: string;
let app: string;

const git = (dir: string, ...args: string[]) =>
  getExecutor().runFile('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    timeoutMs: 20_000,
  });

function write(path: string, content = path): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function nativePackage(dir: string, name: string, version: string): void {
  write(join(dir, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }));
  write(
    join(dir, `${name}.podspec`),
    `Pod::Spec.new do |s|\n  s.name = '${name}'\n  s.version = '${version}'\n  s.source_files = 'ios/**/*.m'\nend\n`,
  );
  write(join(dir, 'ios', 'Lib.m'), '// native');
  write(join(dir, 'index.js'), 'module.exports = {};');
}

const lockEntry = (name: string, version: string, integrity: string) =>
  `\n  ${name}@${version}:\n    resolution: {integrity: ${integrity}}\n`;

/**
 * A git repository holding an Expo app with a committed ios/ (the template's autolinking command), a registry native
 * package, a JS package, a local Expo module, a workspace native package, plugins, assets and an env-reading config.
 * The Expo SDK comes from apps/mobile's install. `stamped` installs as pnpm does, with `.modules.yaml`; otherwise no
 * package manager stamp exists and the index falls back to each package's `package.json`.
 */
function fixture(stamped: boolean): string {
  const repo = join(base, 'repo');
  const root = join(repo, 'app');
  write(join(repo, '.gitignore'), 'node_modules/\n');
  const lock = readFileSync(REPO_LOCK, 'utf8').replace(
    /\npackages:\n/,
    `\npackages:\n${lockEntry('native-lib', '1.0.0', 'sha512-native')}${lockEntry('js-lib', '1.0.0', 'sha512-js')}`,
  );
  write(join(repo, 'pnpm-lock.yaml'), lock);
  const dependencies = ['expo', 'expo-constants', 'react-native', 'native-lib', 'js-lib', 'ws-lib'];
  write(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'app',
      version: '1.0.0',
      dependencies: Object.fromEntries(dependencies.map((d) => [d, '*'])),
    }),
  );
  write(
    join(root, 'app.json'),
    JSON.stringify({
      expo: {
        name: 'App',
        slug: 'app',
        icon: './assets/icon.png',
        ios: { bundleIdentifier: 'com.app' },
        plugins: ['./plugins/native'],
      },
    }),
  );
  write(join(root, 'assets', 'icon.png'), 'png');
  write(join(root, 'plugins', 'native.js'), 'module.exports = (config) => config;');
  write(
    join(root, 'app.config.js'),
    'module.exports = ({ config }) => ({ ...config, extra: { flag: process.env.APP_FLAG ?? null } });\n',
  );
  write(join(root, 'src', 'App.js'), 'export default 1;');
  write(
    join(root, 'ios', 'Podfile'),
    "config_command = ['node', 'expo-modules-autolinking', 'react-native-config', '--json', '--platform', 'ios']\n",
  );
  write(join(root, 'ios', 'App.xcodeproj', 'project.pbxproj'), '// pbxproj');
  write(join(root, 'ios', 'App', 'AppDelegate.swift'), '// delegate');
  write(join(root, 'modules', 'local-mod', 'package.json'), JSON.stringify({ name: 'local-mod', version: '0.0.0' }));
  write(join(root, 'modules', 'local-mod', 'expo-module.config.json'), '{"platforms":["apple"]}');
  write(join(root, 'modules', 'local-mod', 'ios', 'LocalMod.swift'), '// local');
  write(join(root, 'modules', 'plain', 'package.json'), JSON.stringify({ name: 'plain', version: '0.0.0' }));
  write(join(root, 'modules', 'plain', 'index.ts'), 'export {};');
  nativePackage(join(repo, 'packages', 'ws-lib'), 'ws-lib', '0.0.0');
  const modules = join(root, 'node_modules');
  mkdirSync(modules, { recursive: true });
  for (const name of readdirSync(MOBILE_MODULES))
    if (!name.startsWith('.')) symlinkSync(join(MOBILE_MODULES, name), join(modules, name));
  const install = (name: string, version: string, native: boolean) => {
    const dir = stamped ? join(modules, '.pnpm', `${name}@${version}`, 'node_modules', name) : join(modules, name);
    if (native) nativePackage(dir, name, version);
    else write(join(dir, 'package.json'), JSON.stringify({ name, version }));
    if (stamped) symlinkSync(relative(modules, dir), join(modules, name));
  };
  install('native-lib', '1.0.0', true);
  install('js-lib', '1.0.0', false);
  symlinkSync(relative(modules, join(repo, 'packages', 'ws-lib')), join(modules, 'ws-lib'));
  if (stamped) write(join(modules, '.modules.yaml'), 'layoutVersion: 5\n');
  git(base, 'init', '--quiet', repo);
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', 'init');
  return realpathSync(root);
}

async function key(index: 'use' | 'skip'): Promise<Fingerprint> {
  const result = await fingerprint(
    app,
    { platform: 'ios' },
    { env: { ...ENV, STIM_HOME: process.env.STIM_HOME }, embedMode: 'development', index },
  );
  if (isUncertain(result)) throw new Error(JSON.stringify(result));
  return result;
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fp-matrix-')));
  process.env.STIM_HOME = join(base, 'home');
});

afterEach(() => {
  resetExecutor();
  delete process.env.STIM_HOME;
  rmSync(base, { recursive: true, force: true });
});

export function describeMatrix(layout: string, stamped: boolean, from: number, to: number): void {
  describe.skipIf(process.platform === 'win32' || !existsSync(MOBILE_MODULES))(
    'the validation index against a full computation',
    () => {
      describe(`${layout} install`, () => {
        let before: string;
        const reinstall = () => {
          if (stamped) appendFileSync(join(app, 'node_modules', '.modules.yaml'), '# installed again\n');
        };
        const nm = (name: string) =>
          stamped
            ? join(app, 'node_modules', '.pnpm', `${name}@1.0.0`, 'node_modules', name)
            : join(app, 'node_modules', name);

        beforeEach(async () => {
          app = fixture(stamped);
          await new Promise((resolve) => setTimeout(resolve, 100));
          before = (await key('use')).hash;
          const hit = await key('use');
          if (hit.from !== 'index' || hit.hash !== before)
            throw new Error('the second computation was not an index hit');
        }, 120_000);

        const cases: [string, () => void][] = [
          [
            'a native edit in the committed ios/',
            () => appendFileSync(join(app, 'ios/App/AppDelegate.swift'), '\n// edit'),
          ],
          ['a new untracked file in ios/', () => write(join(app, 'ios/App/New.swift'))],
          [
            'a native dependency version bump',
            () => {
              nativePackage(nm('native-lib'), 'native-lib', '1.1.0');
              reinstall();
            },
          ],
          [
            'a native module added',
            () => {
              const dir = join(app, 'node_modules', 'added-lib');
              nativePackage(dir, 'added-lib', '2.0.0');
              const manifest = readFileSync(join(app, 'package.json'), 'utf8');
              write(join(app, 'package.json'), manifest.replace('"ws-lib":"*"', '"ws-lib":"*","added-lib":"*"'));
              reinstall();
            },
          ],
          [
            'a local Expo module edit',
            () => appendFileSync(join(app, 'modules/local-mod/ios/LocalMod.swift'), '\n// edit'),
          ],
          [
            'a workspace-linked native package edit',
            () => appendFileSync(join(base, 'repo/packages/ws-lib/ios/Lib.m'), '\n// edit'),
          ],
          [
            'an existing modules/ directory becoming a native module',
            () => write(join(app, 'modules/plain/expo-module.config.json'), '{"platforms":["apple"]}'),
          ],
          [
            'a root react-native.config.js added',
            () => write(join(app, 'react-native.config.js'), 'module.exports = { dependencies: {} };'),
          ],
          [
            'an app.json edit',
            () => write(join(app, 'app.json'), JSON.stringify({ expo: { name: 'Renamed', slug: 'app' } })),
          ],
          ['a .env file the config loader reads', () => write(join(app, '.env'), 'APP_FLAG=from-file')],
          ['an asset app.json names', () => write(join(app, 'assets/icon.png'), 'new png')],
          ['a local plugin app.json names', () => appendFileSync(join(app, 'plugins/native.js'), '\n// edit')],
          ['a patch added', () => write(join(app, 'patches/native-lib+1.0.0.patch'), '--- a/ios/Lib.m')],
          [
            'a native package linked to a copy outside node_modules',
            () => {
              const copy = join(base, 'linked', 'native-lib');
              nativePackage(copy, 'native-lib', '1.0.0');
              appendFileSync(join(copy, 'ios', 'Lib.m'), '\n// linked');
              rmSync(join(app, 'node_modules', 'native-lib'), { recursive: true });
              symlinkSync(copy, join(app, 'node_modules', 'native-lib'));
            },
          ],
          [
            'an integrity change of a native package in the lockfile',
            () => {
              const lock = join(base, 'repo', 'pnpm-lock.yaml');
              write(lock, readFileSync(lock, 'utf8').replace('sha512-native', 'sha512-repointed'));
            },
          ],
        ];

        test.each(cases.slice(from, to))(
          'moves the key after %s, as a computation without the index does',
          SLOW,
          async (_change, change) => {
            change();
            const indexed = await key('use');
            const full = await key('skip');
            expect(indexed.hash).toBe(full.hash);
            expect(indexed.hash).not.toBe(before);
          },
        );
      });
    },
  );
}
