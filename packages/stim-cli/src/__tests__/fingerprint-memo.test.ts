import {
  appendFileSync,
  cpSync,
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
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { fingerprintMemoDir } from '@stim-cli/core/state';
import { fingerprintProject, type ProjectFingerprint } from '../cache/build-cache.ts';
import { memoizedFingerprint, settleFingerprintCheck } from '../cache/fingerprint-memo.ts';
import { staticFingerprint } from '../cache/static-fingerprint.ts';
import { getExecutor, resetExecutor } from '../exec.ts';
import { testContext } from './_context.ts';

let base: string;
let home: string;
let app: string;
let full: number;
let next: string;

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
  write(join(dir, `${name}.podspec`), `Pod::Spec.new { |s| s.name = '${name}' }`);
  write(join(dir, 'ios', 'Lib.m'), '// native');
  write(join(dir, 'android', 'build.gradle'), '// gradle');
  write(join(dir, 'index.js'), 'module.exports = {};');
}

/**
 * An app with committed ios/, a registry native package, a JS package, a local Expo module, a workspace-linked
 * native package and a static app.json. `layout` places installed packages the way npm or pnpm does.
 */
function fixture(layout: 'npm' | 'pnpm'): string {
  const repo = join(base, 'repo');
  const root = join(repo, 'app');
  write(join(repo, '.gitignore'), 'node_modules/\n');
  write(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'app',
      dependencies: { 'native-lib': '1.0.0', 'js-lib': '1.0.0', 'ws-lib': 'workspace:*' },
    }),
  );
  write(
    join(root, 'app.json'),
    JSON.stringify({
      expo: {
        name: 'App',
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
    'module.exports = ({ config }) => ({ ...config, extra: { flag: process.env.APP_FLAG } });\n',
  );
  write(join(root, 'src', 'App.js'), 'export default 1;');
  write(join(root, 'ios', 'App.xcodeproj', 'project.pbxproj'), '// pbxproj');
  write(join(root, 'ios', 'App', 'AppDelegate.swift'), '// delegate');
  write(join(root, 'modules', 'local-mod', 'package.json'), JSON.stringify({ name: 'local-mod', version: '0.0.0' }));
  write(join(root, 'modules', 'local-mod', 'expo-module.config.json'), '{"platforms":["apple"]}');
  write(join(root, 'modules', 'local-mod', 'ios', 'LocalMod.swift'), '// local');
  write(join(root, 'modules', 'plain', 'package.json'), JSON.stringify({ name: 'plain', version: '0.0.0' }));
  write(join(root, 'modules', 'plain', 'index.ts'), 'export {};');
  nativePackage(join(repo, 'packages', 'ws-lib'), 'ws-lib', '0.0.0');
  const lockfile = layout === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml';
  write(join(repo, lockfile), 'packages:\n  native-lib@1.0.0: {}\n  js-lib@1.0.0: {}\n');
  const modules = join(root, 'node_modules');
  const install = (name: string, version: string, native: boolean) => {
    const dir =
      layout === 'npm' ? join(modules, name) : join(modules, '.pnpm', `${name}@${version}`, 'node_modules', name);
    if (native) nativePackage(dir, name, version);
    else write(join(dir, 'package.json'), JSON.stringify({ name, version }));
    if (layout === 'pnpm') symlinkSync(relative(modules, dir), join(modules, name));
  };
  mkdirSync(modules, { recursive: true });
  install('native-lib', '1.0.0', true);
  install('js-lib', '1.0.0', false);
  symlinkSync(relative(modules, join(repo, 'packages', 'ws-lib')), join(modules, 'ws-lib'));
  git(base, 'init', '--quiet', repo);
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', 'init');
  return realpathSync(root);
}

const operation = (env: NodeJS.ProcessEnv = { PATH: process.env.PATH }) => testContext({ env });
const computed = async (): Promise<ProjectFingerprint> => {
  full++;
  return { hash: next, sources: [] };
};

const confirm = async (): Promise<ProjectFingerprint> => ({ hash: next, sources: [] });

async function lookup(root: string, env?: NodeJS.ProcessEnv, background = confirm) {
  const result = await memoizedFingerprint(
    root,
    { platform: 'ios' },
    { consult: true, record: true, operation: operation(env), fingerprint: computed, background },
  );
  const settled = await result.check?.settle(10_000);
  return { hit: result.memoHit, hash: result.fingerprint?.hash ?? null, settled };
}

beforeEach(() => {
  resetExecutor();
  base = realpathSync(mkdtempSync(join(tmpdir(), 'stim-fpmemo-')));
  home = mkdtempSync(join(tmpdir(), 'stim-fpmemo-home-'));
  process.env.STIM_HOME = home;
  full = 0;
  next = 'h1';
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  delete process.env.STIM_HOME;
});

describe.skipIf(process.platform === 'win32')('the static check in front of the full fingerprint', () => {
  describe.each(['npm', 'pnpm'] as const)('%s layout', (layout) => {
    beforeEach(async () => {
      app = fixture(layout);
      assert.equal((await lookup(app)).hit, false);
      assert.equal((await lookup(app)).hit, true);
      full = 0;
    });

    const nm = (name: string) => join(app, 'node_modules', name);

    test.each<[string, () => void]>([
      [
        'a native edit in the committed ios/',
        () => appendFileSync(join(app, 'ios/App/AppDelegate.swift'), '\n// edit'),
      ],
      ['a new untracked file in ios/', () => write(join(app, 'ios/App/New.swift'))],
      [
        'a native dependency version bump',
        () => {
          write(join(nm('native-lib'), 'package.json'), JSON.stringify({ name: 'native-lib', version: '1.1.0' }));
        },
      ],
      [
        'a native module added',
        () => {
          nativePackage(join(app, 'node_modules', 'added-lib'), 'added-lib', '2.0.0');
          write(
            join(app, 'package.json'),
            JSON.stringify({
              name: 'app',
              dependencies: { 'native-lib': '1.0.0', 'js-lib': '1.0.0', 'added-lib': '2.0.0' },
            }),
          );
        },
      ],
      [
        'a local Expo module edit',
        () => appendFileSync(join(app, 'modules/local-mod/ios/LocalMod.swift'), '\n// edit'),
      ],
      [
        'a workspace-linked native package edit',
        () => appendFileSync(join(base, 'repo/packages/ws-lib/ios/Lib.m'), '\n// x'),
      ],
      [
        'an existing modules/ directory becoming a native module',
        () => write(join(app, 'modules/plain/expo-module.config.json'), '{}'),
      ],
      ['a root react-native.config.js added', () => write(join(app, 'react-native.config.js'), 'module.exports = {};')],
      ['an app.json edit', () => write(join(app, 'app.json'), JSON.stringify({ expo: { name: 'Renamed' } }))],
      ['a .env file the config loader reads', () => write(join(app, '.env'), 'APP_FLAG=1')],
      ['an asset app.json names', () => write(join(app, 'assets/icon.png'), 'new png')],
      ['a local plugin app.json names', () => appendFileSync(join(app, 'plugins/native.js'), '\n// edit')],
      ['a patch added', () => write(join(app, 'patches/native-lib+1.0.0.patch'), '--- a/ios/Lib.m')],
      [
        'a lockfile entry change',
        () =>
          write(
            join(base, 'repo', layout === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml'),
            'packages:\n  native-lib@1.1.0: {}\n  js-lib@1.0.0: {}\n',
          ),
      ],
    ])('misses after %s', async (_change, change) => {
      change();
      expect((await lookup(app)).hit).toBe(false);
      expect(full).toBe(1);
    });

    test('misses when an environment variable the config reads changes', async () => {
      expect((await lookup(app, { PATH: process.env.PATH, APP_FLAG: 'on' })).hit).toBe(false);
    });

    test('misses when .env.development changes, whatever NODE_ENV the run has', async () => {
      const env = { PATH: process.env.PATH, NODE_ENV: 'production' };
      await lookup(app, env);
      write(join(app, '.env.development'), 'APP_FLAG=dev');
      expect((await lookup(app, env)).hit).toBe(false);
    });

    test('misses when a variable a .env file expands changes', async () => {
      write(join(app, '.env'), 'APP_FLAG=${BASE_FLAG}');
      await lookup(app, { PATH: process.env.PATH, BASE_FLAG: 'a' });
      expect((await lookup(app, { PATH: process.env.PATH, BASE_FLAG: 'a' })).hit).toBe(true);
      expect((await lookup(app, { PATH: process.env.PATH, BASE_FLAG: 'b' })).hit).toBe(false);
    });

    test('misses when the file an environment variable names changes', async () => {
      const env = { PATH: process.env.PATH, APP_FLAG: './google-services.json' };
      write(join(app, 'google-services.json'), '{"project":"a"}');
      await lookup(app, env);
      expect((await lookup(app, env)).hit).toBe(true);
      write(join(app, 'google-services.json'), '{"project":"b"}');
      expect((await lookup(app, env)).hit).toBe(false);
    });

    test.each<[string, () => void]>([
      ['a JavaScript edit', () => appendFileSync(join(app, 'src/App.js'), '\nexport const x = 2;')],
      ['a new JavaScript file', () => write(join(app, 'src/Other.js'))],
      [
        'a lockfile reorder with a comment',
        () =>
          write(
            join(base, 'repo', layout === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml'),
            '# regenerated\npackages:\n  js-lib@1.0.0: {}\n  native-lib@1.0.0: {}\n',
          ),
      ],
      [
        'a JavaScript edit inside an installed native package',
        () => appendFileSync(join(nm('native-lib'), 'index.js'), '\n//'),
      ],
      // The documented limit: an installed package counts by name and version, so a hand edit of its native code is not seen.
      [
        'a native edit inside an installed package',
        () => appendFileSync(join(nm('native-lib'), 'ios/Lib.m'), '\n// hand edit'),
      ],
    ])('hits after %s', async (_change, change) => {
      change();
      expect((await lookup(app)).hit).toBe(true);
      expect(full).toBe(0);
    });

    test('hits when an environment variable the config does not read changes', async () => {
      expect((await lookup(app, { PATH: process.env.PATH, CLAUDE_CODE_SESSION_ID: 'another' })).hit).toBe(true);
    });
  });

  test('a fresh worktree of a recorded commit hits without a full fingerprint', async () => {
    app = fixture('pnpm');
    expect((await lookup(app)).hit).toBe(false);
    const worktree = join(base, 'worktree');
    git(join(base, 'repo'), 'worktree', 'add', '--quiet', '--detach', worktree, 'HEAD');
    const copy = join(worktree, 'app');
    cpSync(join(app, 'node_modules'), join(copy, 'node_modules'), { recursive: true, verbatimSymlinks: true });
    full = 0;
    expect(await lookup(realpathSync(copy))).toMatchObject({ hit: true, hash: 'h1' });
    expect(full).toBe(0);
  });

  test('a real fingerprint recorded in one process is reused by the next lookup in the same process', async () => {
    app = fixture('pnpm');
    write(join(base, 'repo/patches/native-lib+1.0.0.patch'), '--- a/ios/Lib.m');
    write(
      join(app, 'fingerprint.config.js'),
      "module.exports = { extraSources: [{ type: 'dir', filePath: '../patches', reasons: ['patches'] }] };",
    );
    git(join(base, 'repo'), 'add', '.');
    git(join(base, 'repo'), 'commit', '--quiet', '-m', 'patches');
    const recorded = await memoizedFingerprint(
      app,
      { platform: 'ios' },
      { consult: true, record: true, operation: operation() },
    );
    expect(recorded.memoHit).toBe(false);
    expect(
      await memoizedFingerprint(app, { platform: 'ios' }, { consult: true, record: false, operation: operation() }),
    ).toMatchObject({ memoHit: true, fingerprint: { hash: recorded.fingerprint?.hash } });
  }, 60_000);

  test('a background check that disagrees drops the record and says so', async () => {
    app = fixture('npm');
    await lookup(app);
    const result = await memoizedFingerprint(
      app,
      { platform: 'ios' },
      {
        consult: true,
        record: true,
        operation: operation(),
        fingerprint: computed,
        background: async () => ({
          hash: 'h2',
          sources: [
            {
              type: 'package',
              name: 'unseen-lib',
              version: '1.0.0',
              filePath: 'node_modules/unseen-lib/package.json',
              reasons: ['expoAutolinkingIos'],
              hash: 'x',
            },
            {
              type: 'package',
              name: 'native-lib',
              version: '1.0.0',
              filePath: 'node_modules/native-lib/package.json',
              reasons: ['expoAutolinkingIos'],
              hash: 'y',
            },
          ],
        }),
      },
    );
    expect(result.memoHit).toBe(true);
    const lines: string[] = [];
    const records: Record<string, unknown>[] = [];
    await settleFingerprintCheck(
      result.check,
      'ios',
      (line) => lines.push(line),
      (record) => records.push(record),
    );
    expect(lines.join('\n')).toMatch(/no longer matches the tree/);
    expect(records[0]).toMatchObject({
      event: 'fingerprint_memo_stale',
      recorded: 'h1',
      current: 'h2',
      unmodeled: ['unseen-lib'],
    });
    full = 0;
    expect((await lookup(app)).hit).toBe(false);
    expect(full).toBe(1);
  });

  test('a file added to a directory the config names misses', async () => {
    app = fixture('npm');
    write(join(app, 'assets/fonts/A.ttf'), 'font a');
    write(
      join(app, 'app.json'),
      JSON.stringify({ expo: { name: 'App', plugins: [['expo-font', { fonts: ['./assets/fonts'] }]] } }),
    );
    await lookup(app);
    expect((await lookup(app)).hit).toBe(true);
    write(join(app, 'assets/fonts/B.ttf'), 'font b');
    expect((await lookup(app)).hit).toBe(false);
  });

  test('swapping a hoisted and a nested copy of a native package misses', async () => {
    app = fixture('npm');
    const nested = join(app, 'node_modules/js-lib/node_modules/native-lib');
    write(
      join(app, 'node_modules/js-lib/package.json'),
      JSON.stringify({ name: 'js-lib', version: '1.0.0', dependencies: { 'native-lib': '2.0.0' } }),
    );
    nativePackage(nested, 'native-lib', '2.0.0');
    await lookup(app);
    expect((await lookup(app)).hit).toBe(true);
    write(join(nested, 'package.json'), JSON.stringify({ name: 'native-lib', version: '1.0.0' }));
    write(join(app, 'node_modules/native-lib/package.json'), JSON.stringify({ name: 'native-lib', version: '2.0.0' }));
    expect((await lookup(app)).hit).toBe(false);
  });

  test.each([
    [
      'a local plugin that reads a file while the config is evaluated',
      "const fs = require('fs');\nmodule.exports = (config) => ({ ...config, extra: { key: fs.readFileSync('key.txt', 'utf8') } });\n",
    ],
    [
      'a named local plugin function that reads a file and applies no mods',
      "const fs = require('fs');\nfunction withKey(config) {\n  return { ...config, extra: { key: fs.readFileSync('key.txt', 'utf8') } };\n}\nmodule.exports = withKey;\n",
    ],
    [
      'a local plugin that builds an environment variable name',
      "module.exports = (config) => ({ ...config, extra: { a: process.env['EXPO_PUBLIC_' + 'A'] } });\n",
    ],
    [
      'a local plugin that runs a process',
      "const { execSync } = require('child_process');\nmodule.exports = (config) => ({ ...config, extra: { sha: String(execSync('git rev-parse HEAD')) } });\n",
    ],
    [
      'a local plugin that passes the environment on',
      'module.exports = (config) => ({ ...config, extra: Object.fromEntries(Object.entries(process.env)) });\n',
    ],
  ])('%s always takes the full fingerprint', async (_case, plugin) => {
    app = fixture('npm');
    write(join(app, 'plugins/native.js'), plugin);
    write(join(app, 'key.txt'), 'k');
    expect((await lookup(app)).hit).toBe(false);
    expect((await lookup(app)).hit).toBe(false);
    expect(full).toBe(2);
  });

  test('a local plugin that reads files only for its mods keeps the memo', async () => {
    app = fixture('npm');
    write(
      join(app, 'plugins/native.js'),
      "const { readFileSync } = require('fs');\nconst { withDangerousMod } = require('expo/config-plugins');\nfunction withNative(config) {\n  return withDangerousMod(config, ['ios', (mod) => { readFileSync('Podfile'); return mod; }]);\n}\nmodule.exports = withNative;\n",
    );
    await lookup(app);
    expect((await lookup(app)).hit).toBe(true);
  });

  test('a config the static check cannot follow always takes the full fingerprint', async () => {
    app = fixture('npm');
    write(join(app, 'app.config.js'), "const fs = require('fs');\nmodule.exports = ({ config }) => config;\n");
    expect((await lookup(app)).hit).toBe(false);
    expect((await lookup(app)).hit).toBe(false);
    expect(full).toBe(2);
    expect(existsSync(fingerprintMemoDir('ios')) ? readdirSync(fingerprintMemoDir('ios')) : []).toEqual([]);
  });

  test('an input that changes while the full fingerprint runs is not recorded', async () => {
    app = fixture('npm');
    const racing = async (): Promise<ProjectFingerprint> => {
      full++;
      appendFileSync(join(app, 'ios/App/AppDelegate.swift'), '\n// concurrent edit');
      return { hash: 'h1', sources: [] };
    };
    await memoizedFingerprint(
      app,
      { platform: 'ios' },
      { consult: true, record: true, operation: operation(), fingerprint: racing },
    );
    expect((await lookup(app)).hit).toBe(false);
  });

  test('without consult the memo is not read', async () => {
    app = fixture('npm');
    await lookup(app);
    full = 0;
    const result = await memoizedFingerprint(
      app,
      { platform: 'ios' },
      { consult: false, record: true, operation: operation(), fingerprint: computed },
    );
    expect(result.memoHit).toBe(false);
    expect(full).toBe(1);
  });
});

const mobile = join(import.meta.dirname, '../../../../apps/mobile');

describe.skipIf(process.platform === 'win32' || !existsSync(join(mobile, 'node_modules/expo/package.json')))(
  'native package detection',
  () => {
    test.each(['ios', 'android'] as const)(
      'on apps/mobile finds the packages %s autolinking links',
      async (platform) => {
        const [found, real] = await Promise.all([
          staticFingerprint(mobile, { platform }, { env: { PATH: process.env.PATH } }),
          fingerprintProject(mobile, { platform }),
        ]);
        const linked = new Set<string>();
        for (const source of real?.sources ?? []) {
          const autolinked = source.reasons.some((reason) => /^(expo|rncore)Autolinking(Ios|Android)$/.test(reason));
          if (source.type === 'package' && (autolinked || source.reasons.includes('package:react-native')))
            linked.add(source.name);
          if (source.type === 'dir' && autolinked) {
            const manifest: unknown = JSON.parse(readFileSync(join(mobile, source.filePath, 'package.json'), 'utf8'));
            linked.add(String(manifest && typeof manifest === 'object' && 'name' in manifest ? manifest.name : ''));
          }
        }
        expect(found.nativePackages).toEqual([...linked].toSorted());
      },
      60_000,
    );
  },
);
