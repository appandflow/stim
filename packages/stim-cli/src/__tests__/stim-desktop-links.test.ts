import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { parseWorkspaceLink } from '@stim-cli/core/workspace-link';
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

test('share links identify a workspace without exposing its absolute path', async () => {
  const first = (await workspaceLinks(root, undefined, installed))?.desktop;
  const second = (await workspaceLinks(root, undefined, installed))?.desktop;
  expect(first).toBe(second);
  const parsed = parseWorkspaceLink(first ?? '');
  expect(parsed?.workspace).toMatch(/^[0-9a-f]{16}$/);
  expect(first).not.toContain(root);
  const other = join(home, 'other');
  mkdirSync(other);
  expect((await workspaceLinks(other, undefined, installed))?.desktop).not.toBe(first);
  expect([...new URL(first ?? '').searchParams.keys()]).toEqual(['v', 'machine', 'workspace']);
});

test.skipIf(process.platform === 'win32')('a symlinked workspace has the same shared destination', async () => {
  const alias = join(home, 'alias');
  symlinkSync(root, alias);
  expect(await workspaceLinks(alias, undefined, installed)).toEqual(await workspaceLinks(root, undefined, installed));
});

test('a device run names its platform and nondefault slot, including macOS', async () => {
  const ios = parseWorkspaceLink(
    (await workspaceLinks(root, { platform: 'ios', slot: 'default' }, installed))?.desktop ?? '',
  );
  expect(ios).toMatchObject({ platform: 'ios' });
  expect(ios?.slot).toBeUndefined();
  const macos = parseWorkspaceLink(
    (await workspaceLinks(root, { platform: 'macos', slot: 'tablet b' }, installed))?.desktop ?? '',
  );
  expect(macos).toMatchObject({ platform: 'macos', slot: 'tablet b' });
});

test('no link when no app on this Mac opens Stim links', async () => {
  expect(await workspaceLinks('/w', { platform: 'web' }, () => false)).toBeUndefined();
});
