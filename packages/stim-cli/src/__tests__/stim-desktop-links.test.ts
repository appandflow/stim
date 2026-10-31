import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import { workspaceLinks } from '../devices/stim-desktop.ts';

const installed = () => true;
let home: string;
let root: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-links-'));
  root = join(home, 'My Apps', 'a&b #1+x');
  mkdirSync(root, { recursive: true });
  vi.stubEnv('STIM_HOME', home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

test.skipIf(process.platform === 'win32')('a symlinked workspace has the same shared destination', async () => {
  const alias = join(home, 'alias');
  symlinkSync(root, alias);
  expect(await workspaceLinks(alias, undefined, installed)).toEqual(await workspaceLinks(root, undefined, installed));
});
