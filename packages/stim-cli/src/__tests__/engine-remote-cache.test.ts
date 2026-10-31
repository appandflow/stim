import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkEasAuth,
  loadProjectProvider,
  normalizeProvider,
  parseWhoami,
  providerFromConfig,
  resetEasAuthCache,
  readProjectConfig,
} from '../engine/remote-cache.ts';
import { makeError } from './_factories.ts';
import assert from 'node:assert';
import type { FingerprintSource } from '@expo/fingerprint';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stim-remote-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeProviderModule(file: string, body: string) {
  writeFileSync(join(root, file), body);
  return file;
}

describe.skipIf(process.platform === 'win32')('responsive project probes', () => {
  test.each(['config', 'auth'])(
    '%s discovery leaves the event loop responsive while its child is pending',
    async (kind) => {
      const binDir = join(root, 'node_modules', '.bin');
      mkdirSync(binDir, { recursive: true });
      const bin = join(binDir, kind === 'config' ? 'expo' : 'eas');
      const output = kind === 'config' ? JSON.stringify({ android: { package: 'com.example.dynamic' } }) : 'fixture';
      writeFileSync(bin, `#!/usr/bin/env node\nsetTimeout(() => console.log(${JSON.stringify(output)}), 100);\n`, {
        mode: 0o755,
      });
      if (kind === 'config') writeProviderModule('app.config.js', 'module.exports = {};');
      let finished = false;
      const pending = (
        kind === 'config'
          ? readProjectConfig(root)
          : checkEasAuth({ projectRoot: root, cache: null, resolveBin: () => ({ file: bin, source: 'project' }) })
      ).then((result) => {
        finished = true;
        return result;
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(finished).toBe(false);
      } finally {
        const result = await pending;
        expect(result).toMatchObject(
          kind === 'config'
            ? { config: { android: { package: 'com.example.dynamic' } } }
            : { ok: true, account: 'fixture' },
        );
      }
    },
  );
});

describe('providerFromConfig', () => {
  test('no provider is null, and so is a config that is not an object', () => {
    expect(providerFromConfig({ expo: { name: 'app' } })).toBe(null);
    expect(providerFromConfig(null)).toBe(null);
  });
});

describe('normalizeProvider', () => {
  test('nothing configured is null; a shape the CLI would throw on is invalid', () => {
    expect(normalizeProvider(undefined)).toBe(null);
    const typo = normalizeProvider({ pluginn: 'typo' });
    assert(typo);
    expect(typo.invalid).toBeTruthy();
    const bareString = normalizeProvider('s3');
    assert(bareString);
    expect(bareString.invalid).toBeTruthy();
  });
});

function writeDynamicConfigProject() {
  writeProviderModule('app.config.js', 'module.exports = {};');
  mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(root, 'node_modules', '.bin', 'expo'), '#!/bin/sh\n');
}

function expoConfigSource(config: Record<string, unknown>): FingerprintSource[] {
  return [{ type: 'contents', id: 'expoConfig', contents: JSON.stringify(config), reasons: ['expoConfig'], hash: 'h' }];
}

describe('loadProjectProvider with the fingerprint config', () => {
  const countingRun = () => {
    const calls: string[][] = [];
    return {
      calls,
      run: (_file: string, args: string[]) => {
        calls.push(args);
        return JSON.stringify({ name: 'app' });
      },
    };
  };

  test('without an expoConfig source the config is evaluated once', async () => {
    writeDynamicConfigProject();
    const { calls, run } = countingRun();
    const unrelated: FingerprintSource[] = [{ type: 'dir', filePath: 'ios', reasons: ['bareNativeDir'], hash: 'h' }];
    expect(await loadProjectProvider(root, { run, sources: unrelated })).toEqual({ none: true });
    expect(await loadProjectProvider(root, { run, sources: [] })).toEqual({ none: true });
    expect(calls).toEqual([
      ['config', '--json', root],
      ['config', '--json', root],
    ]);
  });

  test('the EAS provider keeps its owner from the fingerprint, and reads it when the fingerprint dropped it', async () => {
    writeDynamicConfigProject();
    const { calls, run } = countingRun();
    await loadProjectProvider(root, {
      run,
      sources: expoConfigSource({ buildCacheProvider: 'eas', owner: 'th3rd-wave' }),
    });
    expect(calls).toEqual([]);
    await loadProjectProvider(root, { run, sources: expoConfigSource({ buildCacheProvider: 'eas' }) });
    expect(calls).toEqual([['config', '--json', root]]);
  });
});

describe('parseWhoami', () => {
  test('the EXPO_TOKEN suffix is stripped off the actor and recorded', () => {
    const parsed = parseWhoami({ stdout: 'janic (authenticated using EXPO_TOKEN)\n', exitCode: 0 });
    expect(parsed.account).toBe('janic');
    expect(parsed.viaToken).toBe(true);
  });

  test('a robot actor with no Accounts block leaves the accounts unknown', () => {
    const parsed = parseWhoami({ stdout: 'CI (robot) (authenticated using EXPO_TOKEN)\n', exitCode: 0 });
    expect(parsed.loggedIn).toBe(true);
    expect(parsed.accounts).toBe(null);
  });
});

describe('checkEasAuth', () => {
  beforeEach(() => resetEasAuthCache());
  afterEach(() => resetEasAuthCache());

  const whoami =
    (stdout: string, exitCode = 0, stderr = '') =>
    () => {
      if (exitCode === 0) return stdout;
      throw makeError('Command failed', { status: exitCode, stdout, stderr });
    };

  test('no eas binary anywhere is its own code, with an install remedy', async () => {
    const status = await checkEasAuth({ projectRoot: root, resolveBin: () => null, run: whoami('') });
    expect(status.code).toBe('no-cli');
    expect(status.remedy).toMatch(/eas-cli/);
  });
});
