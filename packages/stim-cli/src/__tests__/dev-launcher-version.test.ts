import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { devClientTakesDevMenuParams } from '../commands/dev-client.ts';

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

  test('reads a hoisted launcher, and an older one keeps the preference writes', () => {
    pkg(join(root, 'node_modules', 'expo-dev-client'), '57.0.9');
    pkg(join(root, 'node_modules', 'expo-dev-launcher'), '57.0.4');
    expect(devClientTakesDevMenuParams(join(root, 'app'))).toBe(false);
    pkg(join(root, 'node_modules', 'expo-dev-launcher'), '58.0.0');
    expect(devClientTakesDevMenuParams(join(root, 'app'))).toBe(true);
  });
});
