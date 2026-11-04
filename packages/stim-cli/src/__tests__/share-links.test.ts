import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLiveShareLinks, type SavedShare } from '@stim-cli/core/state';
import { pauseShareLinks, saveShareLink } from '../workspace/share-links.ts';
import { ensureWorkspaceStorage } from '../workspace/paths.ts';

const entry = (slot: string, state: SavedShare['state'], expiresAt: string): SavedShare => ({
  platform: 'ios',
  slot,
  physical: false,
  token: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
  control: false,
  password: 'generated-pw-1',
  auth: 'generated',
  viewAuth: null,
  state,
  createdAt: '2026-11-03T20:00:00.000Z',
  expiresAt,
});

describe('saved share state', () => {
  let home: string;
  const previous = process.env.STIM_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'stim-share-links-'));
    process.env.STIM_HOME = home;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.STIM_HOME;
    else process.env.STIM_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });

  it('lists the live, unexpired entries of every workspace in the home, and a pause stops only the named slot', () => {
    const later = new Date(Date.now() + 3_600_000).toISOString();
    const earlier = new Date(Date.now() - 1000).toISOString();
    const a = join(home, 'project-a');
    const b = join(home, 'project-b');
    ensureWorkspaceStorage(a);
    ensureWorkspaceStorage(b);
    saveShareLink(a, 'ios', entry('default', 'live', later));
    saveShareLink(a, 'ios@tablet', entry('tablet', 'live', later));
    saveShareLink(b, 'ios', entry('default', 'stopped', later));
    saveShareLink(b, 'ios@old', entry('old', 'live', earlier));

    const keys = () =>
      readLiveShareLinks()
        .map((link) => `${link.workspace}:${link.key}`)
        .toSorted();
    expect(keys()).toEqual([`${a}:ios`, `${a}:ios@tablet`]);

    pauseShareLinks(a, 'tablet');
    expect(keys()).toEqual([`${a}:ios`]);
    pauseShareLinks(a);
    expect(keys()).toEqual([]);
  });
});
