import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { devClientTakesDevMenuParams, devLauncherReadsDevMenuParams } from '../commands/dev-client.ts';

describe('which expo-dev-launcher versions read the dev-menu launch params', () => {
  test.each([
    ['58.0.0', true],
    ['58.0.7', true],
    ['58.1.0', true],
    ['59.0.0-canary-20261001-abc1234', true],
    ['58.0.1-canary-20260915-abc1234', true],
    ['58.0.0-canary-20260909-ea7a89a', false],
    ['58.0.0-preview.3', false],
    ['57.0.12', false],
    ['6.0.20', false],
    ['not-a-version', false],
    [null, false],
  ])('%s -> %s', (version, expected) => {
    expect(devLauncherReadsDevMenuParams(version)).toBe(expected);
  });
});

describe("resolving the project's expo-dev-launcher", () => {
  let root: string;

  function pkg(path: string, version: string) {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name: path.split('/').at(-1), version }));
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'stim-dev-launcher-')));
    mkdirSync(join(root, 'app'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('finds the launcher next to expo-dev-client in a pnpm store, where the app cannot see it', () => {
    const store = join(root, 'node_modules', '.pnpm', 'expo-dev-client@58.0.7', 'node_modules');
    pkg(join(store, 'expo-dev-client'), '58.0.7');
    pkg(join(store, 'expo-dev-launcher'), '58.0.7');
    pkg(join(root, 'node_modules', '.pnpm', 'expo-dev-launcher@57.0.3', 'node_modules', 'expo-dev-launcher'), '57.0.3');
    mkdirSync(join(root, 'app', 'node_modules'), { recursive: true });
    symlinkSync(join(store, 'expo-dev-client'), join(root, 'app', 'node_modules', 'expo-dev-client'));
    expect(devClientTakesDevMenuParams(join(root, 'app'))).toBe(true);
  });

  test('reads a hoisted launcher, and an older one keeps the preference writes', () => {
    pkg(join(root, 'node_modules', 'expo-dev-client'), '57.0.9');
    pkg(join(root, 'node_modules', 'expo-dev-launcher'), '57.0.4');
    expect(devClientTakesDevMenuParams(join(root, 'app'))).toBe(false);
    pkg(join(root, 'node_modules', 'expo-dev-launcher'), '58.0.0');
    expect(devClientTakesDevMenuParams(join(root, 'app'))).toBe(true);
  });

  test('a project without the launcher installed keeps the preference writes', () => {
    pkg(join(root, 'node_modules', 'expo-dev-client'), '58.0.7');
    expect(devClientTakesDevMenuParams(join(root, 'app'))).toBe(false);
  });
});
