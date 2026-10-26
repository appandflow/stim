import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONFIG_TIMEOUT_MS,
  EAS_PROVIDER_PACKAGE,
  LOCAL_PROVIDER_PACKAGE,
  WHOAMI_TIMEOUT_MS,
  checkEasAuth,
  dynamicConfigFile,
  easAuthNote,
  isEasAuthFailureText,
  loadProjectProvider,
  normalizeProvider,
  ownerFromConfig,
  parseWhoami,
  providerFromConfig,
  resolveEasCliBin,
  resetEasAuthCache,
  readProjectConfig,
  runOptionsFor,
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

function writeAppJson(config: unknown) {
  writeFileSync(join(root, 'app.json'), JSON.stringify(config, null, 2));
}

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
  test('reads the top-level key out of an app.json (nested under expo)', () => {
    expect(providerFromConfig({ expo: { buildCacheProvider: 'eas' } })).toBe('eas');
  });

  test('reads the same key out of `expo config --json` output, which is already unwrapped', () => {
    expect(providerFromConfig({ name: 'app', buildCacheProvider: 'eas' })).toBe('eas');
  });

  test('falls back to the SDK 53 experiments key', () => {
    const raw = providerFromConfig({ expo: { experiments: { buildCacheProvider: { plugin: './p.cjs' } } } });
    expect(raw).toEqual({ plugin: './p.cjs' });
  });

  test('the top-level key wins when both are present, as in the CLI', () => {
    expect(
      providerFromConfig({
        expo: { buildCacheProvider: 'eas', experiments: { buildCacheProvider: { plugin: './p.cjs' } } },
      }),
    ).toBe('eas');
  });

  test('no provider is null, and so is a config that is not an object', () => {
    expect(providerFromConfig({ expo: { name: 'app' } })).toBe(null);
    expect(providerFromConfig(null)).toBe(null);
  });
});

describe('normalizeProvider', () => {
  test("'eas' maps to the package the Expo CLI bundles for it", () => {
    expect(normalizeProvider('eas')).toEqual({ name: 'eas', reference: EAS_PROVIDER_PACKAGE });
  });

  test('recognizes the explicit EAS module reference', () => {
    expect(normalizeProvider({ plugin: EAS_PROVIDER_PACKAGE })).toEqual({
      name: EAS_PROVIDER_PACKAGE,
      reference: EAS_PROVIDER_PACKAGE,
    });
  });

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

describe('runOptionsFor', () => {
  test('describes the debug simulator/emulator build Stim actually makes', () => {
    expect(runOptionsFor('ios')).toEqual({ configuration: 'Debug' });
    expect(runOptionsFor('android')).toEqual({ variant: 'debug' });
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

describe('readProjectConfig', () => {
  test('a static app.json is parsed directly, with no child process at all', async () => {
    writeAppJson({ expo: { buildCacheProvider: 'eas' } });
    let ran = false;
    const read = await readProjectConfig(root, {
      run: () => {
        ran = true;
        return '{}';
      },
    });
    expect(ran).toBe(false);
    expect(read.source).toBe('app.json');
    expect(providerFromConfig(read.config)).toBe('eas');
  });

  test('no config at all is simply no config', async () => {
    expect(await readProjectConfig(root, { run: () => '{}' })).toEqual({ config: null, source: null });
  });

  test("a dynamic config is evaluated by the PROJECT's own expo binary, bounded", async () => {
    writeAppJson({ expo: { name: 'ignored' } });
    writeProviderModule('app.config.js', 'module.exports = {};');
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.bin', 'expo'), '#!/bin/sh\n');

    const calls: { file: string; args: string[]; opts?: { timeoutMs?: number } }[] = [];
    const read = await readProjectConfig(root, {
      run: (file, args, opts) => {
        calls.push({ file, args, opts });
        return JSON.stringify({ name: 'app', buildCacheProvider: { plugin: './p.cjs' } });
      },
    });
    expect(calls.length).toBe(1);
    const call = calls[0];
    assert(call);
    expect(call.file).toBe(join(root, 'node_modules', '.bin', 'expo'));
    expect(call.args).toEqual(['config', '--json', root]);
    expect(call.opts?.timeoutMs).toBe(CONFIG_TIMEOUT_MS);
    expect(read.source).toBe('app.config.js');
    expect(providerFromConfig(read.config)).toEqual({ plugin: './p.cjs' });
  });

  test('the config child runs with Expo telemetry off unless the user chose a value', async () => {
    writeDynamicConfigProject();
    const seen: (Record<string, string> | undefined)[] = [];
    const run = (_file: string, _args: string[], opts: { env?: Record<string, string> }) => {
      seen.push(opts.env);
      return '{}';
    };
    await readProjectConfig(root, { run });
    const original = process.env.EXPO_NO_TELEMETRY;
    process.env.EXPO_NO_TELEMETRY = '0';
    try {
      await readProjectConfig(root, { run });
    } finally {
      if (original === undefined) delete process.env.EXPO_NO_TELEMETRY;
      else process.env.EXPO_NO_TELEMETRY = original;
    }
    expect(seen).toEqual([{ EXPO_NO_TELEMETRY: '1' }, {}]);
  });

  test('a dynamic config with no installed expo is unavailable, never guessed from app.json', async () => {
    writeAppJson({ expo: { buildCacheProvider: 'eas' } });
    writeProviderModule('app.config.ts', 'export default {};');
    const read = await readProjectConfig(root, {
      run: () => {
        throw new Error('should not run');
      },
    });
    expect(read.unavailable).toMatch(/app\.config\.ts is code/);
    expect(read.unavailable).toMatch(/`expo` package is not resolvable/);
  });

  test('a HOISTED monorepo evaluates the config with the workspace-root expo', async () => {
    const app = join(root, 'apps', 'mobile');
    mkdirSync(join(app, 'node_modules'), { recursive: true });
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'mobile' }));
    writeFileSync(join(app, 'app.config.ts'), 'export default {};');
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.bin', 'expo'), '#!/bin/sh\n');
    mkdirSync(join(root, '.git'));

    const calls: { file: string; args: string[] }[] = [];
    const read = await readProjectConfig(app, {
      run: (file, args) => {
        calls.push({ file, args });
        return JSON.stringify({ name: 'app', buildCacheProvider: 'eas' });
      },
    });
    expect(read.unavailable).toBe(undefined);
    const call = calls[0];
    assert(call);
    expect(call.file).toBe(join(root, 'node_modules', '.bin', 'expo'));
    expect(call.args).toEqual(['config', '--json', app]);
    expect(providerFromConfig(read.config)).toBe('eas');
  });

  test('an expo config that fails (or times out) is unavailable with the reason', async () => {
    writeProviderModule('app.config.js', 'module.exports = {};');
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.bin', 'expo'), '#!/bin/sh\n');
    const read = await readProjectConfig(root, {
      run: () => {
        const e = new Error('ETIMEDOUT: expo config --json\nstack line');
        throw e;
      },
    });
    assert(read.unavailable);
    expect(read.unavailable).toMatch(/expo config --json` failed: ETIMEDOUT/);
    expect(!read.unavailable.includes('stack line')).toBeTruthy();
  });

  test('a malformed app.json is unavailable rather than a crash', async () => {
    writeFileSync(join(root, 'app.json'), '{ not json');
    expect((await readProjectConfig(root)).unavailable).toMatch(/app\.json could not be parsed/);
  });
});

describe('loadProjectProvider', () => {
  test('a bare RN project is never asked: no config read, no plugin load', async () => {
    writeAppJson({ expo: { buildCacheProvider: 'eas' } });
    let ran = false;
    const result = await loadProjectProvider(root, {
      isExpo: false,
      run: () => {
        ran = true;
        return '{}';
      },
      requireFrom: () => {
        throw new Error('should not resolve a plugin');
      },
    });
    expect(result).toEqual({ none: true });
    expect(ran).toBe(false);
  });

  test('an Expo project with no provider configured is `none`, which is not a problem', async () => {
    writeAppJson({ expo: { name: 'app' } });
    expect(await loadProjectProvider(root)).toEqual({ none: true });
  });

  test('custom Expo cache modules are refused without evaluating project code', async () => {
    const evaluated = join(root, 'evaluated');
    writeProviderModule(
      'fake-provider.cjs',
      `require('node:fs').writeFileSync(${JSON.stringify(evaluated)}, 'loaded'); module.exports = { resolveBuildCache() {}, uploadBuildCache() {} };`,
    );
    writeAppJson({ expo: { buildCacheProvider: { plugin: './fake-provider.cjs' } } });
    const result = await loadProjectProvider(root);
    expect(result.unavailable).toMatch(/Custom Expo buildCacheProvider plugins are not supported/);
    expect(result.provider).toBeUndefined();
    expect(existsSync(evaluated)).toBe(false);
  });

  test("'eas' without the package installed is a REASON, never an install", async () => {
    writeAppJson({ expo: { buildCacheProvider: 'eas' } });
    const result = await loadProjectProvider(root);
    expect(result.unavailable).toMatch(new RegExp(EAS_PROVIDER_PACKAGE));
    expect(result.unavailable).toMatch(/not installed/);
  });

  test("Stim's own provider package is treated as level one, not as a remote", async () => {
    writeAppJson({ expo: { buildCacheProvider: { plugin: LOCAL_PROVIDER_PACKAGE } } });
    expect(await loadProjectProvider(root)).toEqual({ none: true });
  });

  test('an invalid provider value is reported, not thrown', async () => {
    writeAppJson({ expo: { buildCacheProvider: 'my-bucket' } });
    const result = await loadProjectProvider(root);
    expect(result.unavailable).toMatch(/not "eas" or \{ plugin/);
  });
});

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

  test('a dynamic config the fingerprint evaluated is not evaluated again', async () => {
    writeDynamicConfigProject();
    const { calls, run } = countingRun();
    const result = await loadProjectProvider(root, { run, sources: expoConfigSource({ name: 'app' }) });
    expect(result).toEqual({ none: true });
    expect(calls).toEqual([]);
  });

  test("the fingerprint's buildCacheProvider is the one used", async () => {
    writeDynamicConfigProject();
    const { calls, run } = countingRun();
    const result = await loadProjectProvider(root, {
      run,
      sources: expoConfigSource({ buildCacheProvider: { plugin: './p.cjs' } }),
    });
    expect(result.unavailable).toMatch(/Custom Expo buildCacheProvider plugins are not supported/);
    expect(calls).toEqual([]);
  });

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

  test('a static app.json is read from the file, not from the fingerprint', async () => {
    writeAppJson({ expo: { buildCacheProvider: { plugin: LOCAL_PROVIDER_PACKAGE } } });
    const { calls, run } = countingRun();
    expect(await loadProjectProvider(root, { run, sources: expoConfigSource({ buildCacheProvider: 'eas' }) })).toEqual({
      none: true,
    });
    expect(calls).toEqual([]);
  });
});

describe('dynamicConfigFile', () => {
  test('finds each supported dynamic config, and nothing when there is none', () => {
    expect(dynamicConfigFile(root)).toBe(null);
    writeProviderModule('app.config.ts', '');
    expect(dynamicConfigFile(root)).toBe('app.config.ts');
  });
});

describe('parseWhoami', () => {
  const LOGGED_IN =
    'janic\n\nAccounts:\n\u2022 janic (Role: Owner)\n' +
    '\u2022 fin-tech (Role: Viewer)\n\u2022 th3rd-wave (Role: Owner)\n';

  test('reads the actor and every account out of a logged-in whoami', () => {
    const parsed = parseWhoami({ stdout: LOGGED_IN, exitCode: 0 });
    expect(parsed.loggedIn).toBe(true);
    expect(parsed.account).toBe('janic');
    expect(parsed.accounts).toEqual(['janic', 'fin-tech', 'th3rd-wave']);
    expect(parsed.viaToken).toBe(false);
  });

  test('a user with only a personal account still yields that account', () => {
    const parsed = parseWhoami({ stdout: 'janic\n', exitCode: 0 });
    expect(parsed.accounts).toEqual(['janic']);
  });

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

  test('"Not logged in" plus a non-zero exit is the definitive logged-out answer', () => {
    const parsed = parseWhoami({ stdout: 'Not logged in\n', exitCode: 1 });
    expect(parsed.loggedOut).toBe(true);
  });

  test('any other failure is unknown, never logged out', () => {
    const parsed = parseWhoami({
      stdout: '',
      stderr: 'request to https://api.expo.dev/graphql failed, reason: getaddrinfo ENOTFOUND api.expo.dev',
      exitCode: 1,
    });
    expect(parsed.loggedOut).toBe(undefined);
    expect(parsed.unknown).toMatch(/ENOTFOUND/);
  });

  test('a clean exit that printed nothing is unknown too', () => {
    expect(parseWhoami({ stdout: '   \n', exitCode: 0 }).unknown).toBeTruthy();
  });
});

describe('ownerFromConfig', () => {
  test('reads expo.owner out of either config shape', () => {
    expect(ownerFromConfig({ expo: { owner: 'th3rd-wave' } })).toBe('th3rd-wave');
    expect(ownerFromConfig({ owner: 'th3rd-wave' })).toBe('th3rd-wave');
    expect(ownerFromConfig({ expo: {} })).toBe(null);
    expect(ownerFromConfig(null)).toBe(null);
  });
});

describe('isEasAuthFailureText', () => {
  test('recognises what eas-cli says when a session is missing or rejected', () => {
    expect(isEasAuthFailureText('Not logged in')).toBe(true);
    expect(isEasAuthFailureText('Either log in with eas login or set the EXPO_TOKEN environment variable')).toBe(true);
    expect(isEasAuthFailureText('GraphQL request failed: Unauthorized')).toBe(true);
    expect(isEasAuthFailureText('Entity not authorized: Account')).toBe(true);
    expect(isEasAuthFailureText('ETIMEDOUT')).toBe(false);
    expect(isEasAuthFailureText('')).toBe(false);
    expect(isEasAuthFailureText(null)).toBe(false);
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

  test('a logged-in session whose accounts include the owner is ok', async () => {
    const status = await checkEasAuth({
      projectRoot: root,
      owner: 'th3rd-wave',
      resolveBin: () => ({ file: '/bin/eas', source: 'project' }),
      run: whoami('janic\n\nAccounts:\n\u2022 janic (Role: Owner)\n\u2022 th3rd-wave (Role: Owner)\n'),
    });
    expect(status.ok).toBe(true);
    expect(status.account).toBe('janic');
  });

  test('no eas binary anywhere is its own code, with an install remedy', async () => {
    const status = await checkEasAuth({ projectRoot: root, resolveBin: () => null, run: whoami('') });
    expect(status.code).toBe('no-cli');
    expect(status.remedy).toMatch(/eas-cli/);
  });

  test('a logged-out session is a definitive failure naming both ways back in', async () => {
    const status = await checkEasAuth({
      projectRoot: root,
      resolveBin: () => ({ file: 'eas', source: 'path' }),
      run: whoami('Not logged in\n', 1),
    });
    expect(status.code).toBe('logged-out');
    expect(status.remedy).toMatch(/eas login/);
    expect(status.remedy).toMatch(/EXPO_TOKEN/);
  });

  test('an owner no account covers is a wrong-account failure naming both', async () => {
    const status = await checkEasAuth({
      projectRoot: root,
      owner: 'th3rd-wave',
      resolveBin: () => ({ file: 'eas', source: 'path' }),
      run: whoami('janic\n'),
    });
    expect(status.code).toBe('wrong-account');
    expect(status.account).toBe('janic');
    expect(status.owner).toBe('th3rd-wave');
  });

  test('an owner is never contradicted by an account list that could not be read', async () => {
    const status = await checkEasAuth({
      projectRoot: root,
      owner: 'th3rd-wave',
      resolveBin: () => ({ file: 'eas', source: 'path' }),
      run: whoami('CI (robot) (authenticated using EXPO_TOKEN)\n'),
    });
    expect(status.ok).toBe(true);
  });

  test('a timeout is unknown, not an auth failure -- offline must not read as logged out', async () => {
    const status = await checkEasAuth({
      projectRoot: root,
      resolveBin: () => ({ file: 'eas', source: 'path' }),
      run: () => {
        throw makeError('Command failed', { code: 'ETIMEDOUT', killed: true });
      },
    });
    expect(status.failed).toBe(undefined);
    expect(status.unknown).toMatch(/timed out|ETIMEDOUT/);
  });

  test('whoami runs ONCE per command run, however many times it is asked', async () => {
    let runs = 0;
    const args = {
      projectRoot: root,
      owner: 'janic',
      resolveBin: () => ({ file: 'eas', source: 'path' as const }),
      run: () => {
        runs += 1;
        return 'janic\n';
      },
    };
    await checkEasAuth(args);
    await checkEasAuth(args);
    await checkEasAuth(args);
    expect(runs).toBe(1);
  });

  test('it is bounded, and it asks the binary it resolved', async () => {
    const seen: { file: string; args: string[]; opts?: { timeoutMs?: number } }[] = [];
    await checkEasAuth({
      projectRoot: root,
      resolveBin: () => ({ file: '/p/node_modules/.bin/eas', source: 'project' }),
      run: (file, args, opts) => {
        seen.push({ file, args, opts });
        return 'janic\n';
      },
    });
    const call = seen[0];
    assert(call);
    expect(call.file).toBe('/p/node_modules/.bin/eas');
    expect(call.args).toEqual(['whoami']);
    expect(call.opts?.timeoutMs).toBe(WHOAMI_TIMEOUT_MS);
  });
});

describe('resolveEasCliBin', () => {
  test('finds a hoisted eas shim by walking up, never by joining', () => {
    const app = join(root, 'apps', 'mobile');
    mkdirSync(join(app, 'node_modules'), { recursive: true });
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'mobile' }));
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.bin', 'eas'), '#!/bin/sh\n');
    mkdirSync(join(root, '.git'));

    const found = resolveEasCliBin(app, {
      lookupPath: () => {
        throw new Error('PATH must not be consulted');
      },
    });
    assert(found);
    expect(found.file).toBe(join(root, 'node_modules', '.bin', 'eas'));
    expect(found.source).toBe('project');
  });

  test('falls back to `eas` on PATH, which is where a session usually lives', () => {
    const found = resolveEasCliBin(root, { lookupPath: () => '/opt/homebrew/bin/eas\n' });
    expect(found).toEqual({ file: '/opt/homebrew/bin/eas', source: 'path' });
  });

  test('nothing anywhere is null, which is a finding rather than an npx', () => {
    expect(resolveEasCliBin(root, { lookupPath: () => null })).toBe(null);
  });
});

describe('easAuthNote', () => {
  test('the logged-out note names the two remedies and what the build will do', () => {
    const note = easAuthNote({ code: 'logged-out' });
    expect(note).toMatch(/eas is not authenticated/);
    expect(note).toMatch(/eas login/);
    expect(note).toMatch(/EXPO_TOKEN/);
    expect(note).toMatch(/local cache only/);
  });

  test('the wrong-account note names both accounts and says the run continues', () => {
    const note = easAuthNote({ code: 'wrong-account', account: 'janic', owner: 'th3rd-wave' });
    expect(note).toMatch(/janic/);
    expect(note).toMatch(/th3rd-wave/);
    expect(note).toMatch(/anyway/);
  });

  test('the same failure at upload time says what it cost instead', () => {
    const note = easAuthNote({ code: 'logged-out', reason: '403', phase: 'upload' });
    assert(note);
    expect(note).toMatch(/stayed in the local cache/);
    expect(!/building with/.test(note)).toBeTruthy();
  });

  test('anything else has no note of its own', () => {
    expect(easAuthNote({ code: 'unknown' })).toBe(null);
    expect(easAuthNote(null)).toBe(null);
  });
});
