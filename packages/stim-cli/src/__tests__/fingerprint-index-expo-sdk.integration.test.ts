import { MOBILE_MODULES, SLOW, base, write, expoApp, settled, env, key, ran } from './fingerprint-index-harness.ts';
import { existsSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { fingerprintPendingVerifyDir } from '@stim-cli/core/state';
import { getExecutor } from '../exec.ts';
import { fingerprint } from '../fingerprint/evaluate.ts';
import { fingerprintForBuild } from '../fingerprint/operation.ts';
import * as daemonClient from '../daemon/client.ts';
import { testContext } from './_context.ts';
import { isUncertain } from '../fingerprint/key.ts';

describe.skipIf(process.platform === 'win32' || !existsSync(MOBILE_MODULES))(
  'the index on the installed Expo SDK',
  () => {
    test(
      'a hit spawns nothing, and a react-native.config.js added re-runs the parts that list the app root, not resolve',
      SLOW,
      async () => {
        const root = expoApp('app');
        await settled();
        await key(root);
        ran();
        const hit = await key(root);
        expect(hit.from).toBe('index');
        expect(ran()).toEqual([]);
        write(join(root, 'react-native.config.js'), 'module.exports = { dependencies: {} };\n');
        const indexed = await key(root);
        expect(ran()).toEqual(['config', 'embed', 'react-native-config']);
        expect(indexed.hash).toBe((await key(root, 'skip')).hash);
        expect(indexed.hash).not.toBe(hit.hash);
      },
    );

    test('refresh computes every evaluator again and records a reusable result', SLOW, async () => {
      const root = expoApp('refresh');
      await settled();
      const first = await key(root);
      ran();
      const refreshed = await fingerprintForBuild(
        root,
        { platform: 'ios' },
        {
          operation: testContext({ projectRoot: root, env: env() }),
          embedMode: 'development',
          consult: false,
        },
      );
      if ('uncertain' in refreshed) throw new Error(refreshed.uncertain);
      expect(refreshed.fingerprint.hash).toBe(first.hash);
      expect(refreshed.fingerprint.from).toBe('evaluated');
      expect(refreshed.check).toBeNull();
      expect(ran()).toEqual(['config', 'embed', 'react-native-config', 'resolve']);
      const reused = await key(root);
      expect(reused.hash).toBe(refreshed.fingerprint.hash);
      expect(reused.from).toBe('index');
      expect(ran()).toEqual([]);
    });

    test('a queued index verification uses the operation home rather than the ambient home', SLOW, async () => {
      const root = expoApp('selected-home');
      const home = join(base, 'selected-home-state');
      const selectedEnv = { ...env(), STIM_HOME: home };
      const operation = testContext({ home, projectRoot: root, env: selectedEnv });
      const availability = vi.spyOn(daemonClient, 'backgroundPassesAvailable').mockResolvedValue(true);
      try {
        await settled();
        const first = await fingerprint(
          root,
          { platform: 'ios' },
          { env: selectedEnv, operation, embedMode: 'development' },
        );
        if (isUncertain(first)) throw new Error(first.uncertain);
        const hit = await fingerprintForBuild(root, { platform: 'ios' }, { operation, embedMode: 'development' });
        if ('uncertain' in hit) throw new Error(hit.uncertain);
        expect(hit.fingerprint.from).toBe('index');
        expect(hit.check).toBeNull();
        expect(readdirSync(join(home, 'fingerprint', 'pending-verify'))).toHaveLength(1);
        expect(existsSync(fingerprintPendingVerifyDir())).toBe(false);
      } finally {
        availability.mockRestore();
      }
    });

    test('an env value change re-runs the parts that read or enumerate the env, not resolve', SLOW, async () => {
      const root = expoApp('app');
      await settled();
      await key(root, 'use', { APP_FLAG: 'a' });
      ran();
      const indexed = await key(root, 'use', { APP_FLAG: 'b' });
      expect(ran()).toEqual(['config', 'embed', 'react-native-config']);
      expect(indexed.hash).toBe((await key(root, 'skip', { APP_FLAG: 'b' })).hash);
    });

    test(
      'a module that appears where the config tried to require or resolve one, or a file deep in a listed tree, moves the key',
      SLOW,
      async () => {
        const root = expoApp('app', {
          'app.config.js': [
            "const fs = require('fs');",
            'let local = {};',
            "try { local = require('./overrides/local.js'); } catch {}",
            "const fonts = fs.readdirSync('./fonts', { recursive: true }).map(String).sort();",
            'let has = false;',
            "try { require.resolve('./cfg/local.json'); has = true; } catch {}",
            'module.exports = ({ config }) => ({ ...config, extra: { local, fonts, has } });',
            '',
          ].join('\n'),
          'fonts/a.ttf': 'a',
          'overrides/keep.txt': 'keep',
          'cfg/keep.txt': 'keep',
        });
        await settled();
        await key(root);
        const hit = await key(root);
        write(join(root, 'overrides', 'local.js'), "module.exports = { flag: 'local' };\n");
        const required = await key(root);
        expect(required.hash).not.toBe(hit.hash);
        expect(required.hash).toBe((await key(root, 'skip')).hash);
        await settled();
        await key(root);
        write(join(root, 'fonts', 'sub', 'b.ttf'), 'b');
        const listed = await key(root);
        expect(listed.hash).not.toBe(required.hash);
        expect(listed.hash).toBe((await key(root, 'skip')).hash);
        await settled();
        await key(root);
        write(join(root, 'cfg', 'local.json'), '{}');
        const resolved = await key(root);
        expect(resolved.hash).not.toBe(listed.hash);
        expect(resolved.hash).toBe((await key(root, 'skip')).hash);
      },
    );

    test.each([
      { listed: "fs.readdirSync('./drop')", late: './drop/late.txt' },
      { listed: "fs.readdirSync('./drop', { recursive: true })", late: './drop/sub/late.txt' },
    ])(
      'a directory the config lists ($listed) and then writes into is not recorded from the later listing',
      SLOW,
      async ({ listed, late }) => {
        const root = expoApp('app', {
          'app.config.js': [
            "const fs = require('fs');",
            'let entries = null;',
            "if (!process.argv.includes('embed')) {",
            `  entries = ${listed}.map(String).sort();`,
            `  fs.writeFileSync('${late}', 'late');`,
            '}',
            'module.exports = ({ config }) => ({ ...config, extra: { entries } });',
            '',
          ].join('\n'),
          'drop/sub/a.txt': 'a',
        });
        await settled();
        await key(root);
        ran();
        const second = await key(root);
        expect(ran()).toContain('config');
        expect(second.hash).toBe((await key(root, 'skip')).hash);
      },
    );

    test('a local plugin directory switching its package.json main moves the key', SLOW, async () => {
      const root = expoApp('app', {
        'app.config.js': "module.exports = ({ config }) => ({ ...config, extra: { v: require('./plug') } });\n",
        'plug/package.json': JSON.stringify({ name: 'plug', main: 'a.js' }),
        'plug/a.js': "module.exports = 'A';\n",
        'plug/b.js': "module.exports = 'B';\n",
      });
      await settled();
      const before = await key(root);
      await key(root);
      write(join(root, 'plug', 'package.json'), JSON.stringify({ name: 'plug', main: 'b.js' }));
      const after = await key(root);
      expect(after.hash).not.toBe(before.hash);
      expect(after.hash).toBe((await key(root, 'skip')).hash);
    });

    test('a config that spawns a child is evaluated on every run', SLOW, async () => {
      const root = expoApp('app', {
        'app.config.js':
          "require('child_process').execFileSync(process.execPath, ['-e', '0']);\nmodule.exports = ({ config }) => config;\n",
      });
      await settled();
      expect((await key(root)).opaque).not.toEqual([]);
      ran();
      await key(root);
      expect(ran()).toEqual(['config', 'embed']);
    });

    test('a .env.local created after a hit moves the key as a full computation does', SLOW, async () => {
      const root = expoApp('app');
      await settled();
      const first = await key(root);
      await key(root);
      write(join(root, '.env.local'), 'APP_FLAG=local\n');
      const indexed = await key(root);
      expect(indexed.hash).not.toBe(first.hash);
      expect(indexed.hash).toBe((await key(root, 'skip')).hash);
    });

    test(
      'a sibling worktree reuses the first checkout autolinking by content and re-runs a config reading its own files',
      SLOW,
      async () => {
        const repo = join(base, 'repo');
        const app = expoApp('repo/app', {
          'app.config.js':
            "module.exports = ({ config }) => ({ ...config, extra: { shared: require('../shared/value.js') } });\n",
        });
        write(join(repo, 'shared', 'value.js'), "module.exports = 'one';\n");
        write(join(repo, '.gitignore'), 'node_modules\n');
        const git = (...args: string[]) =>
          getExecutor().runFile('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
            timeoutMs: 20_000,
          });
        await git('init', '--quiet');
        await git('add', '.');
        await git('commit', '--quiet', '-m', 'init');
        await git('worktree', 'add', '--quiet', join(base, 'sibling'));
        const sibling = realpathSync(join(base, 'sibling', 'app'));
        symlinkSync(MOBILE_MODULES, join(sibling, 'node_modules'));
        await settled();
        const first = await key(app);
        ran();
        const reused = await key(sibling);
        expect(reused.from).toBe('index');
        expect(ran()).toEqual(['config', 'embed']);
        expect(reused.hash).toBe((await key(sibling, 'skip')).hash);
        write(join(base, 'sibling', 'shared', 'value.js'), "module.exports = 'two';\n");
        const moved = await key(sibling);
        expect(moved.hash).not.toBe(first.hash);
        expect(moved.hash).toBe((await key(sibling, 'skip')).hash);
      },
    );
  },
);
