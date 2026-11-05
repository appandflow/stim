import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createdDevicesFile, readStimHomes } from '@stim-cli/core/state';
import { collectOtherHomes, forgetGoneHomes, otherHomeLines } from '../commands/gc/other-homes.ts';
import { gcReportSections } from '../commands/gc/report.ts';
import { recordStimHome } from '../engine/stim-home-registry.ts';
import { listMountedVolumes } from '../fs-util.ts';
import type { IosSimRecord } from '../devices/ios.ts';

vi.mock('../private-size.ts', () => ({
  measureTree: async () => ({ bytes: 5 * 1024 ** 3, privateBytes: 3 * 1024 ** 3 }),
}));

const NOW = Date.parse('2026-11-03T12:00:00Z');

function sim(udid: string, name: string): IosSimRecord {
  return { udid, name, state: 'Shutdown', runtime: 'iOS 27', deviceTypeIdentifier: 'iPhone-17', available: true };
}

describe('the other Stim homes of gc', () => {
  let dir: string;
  let homesRoot: string;
  let own: string;
  let mounted: string[];

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'stim-other-homes-')));
    homesRoot = join(dir, 'machine-homes');
    own = join(dir, 'own');
    mkdirSync(own);
    mounted = listMountedVolumes();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function scratchHome(name: string, { workspaceRoot, ios = [] }: { workspaceRoot?: string; ios?: string[] } = {}) {
    const home = join(dir, name);
    mkdirSync(join(home, 'workspaces', 'ws'), { recursive: true });
    if (workspaceRoot) {
      mkdirSync(workspaceRoot, { recursive: true });
      writeFileSync(join(home, 'workspaces', 'ws', 'workspace.json'), JSON.stringify({ projectRoot: workspaceRoot }));
    }
    writeFileSync(createdDevicesFile(home), JSON.stringify({ version: 1, ios, android: [], web: [] }));
    recordStimHome(home, { root: homesRoot, now: Date.parse('2026-11-03T09:00:00Z'), devices: { ios, android: [] } });
    return home;
  }

  function addWorkspace(home: string, name: string, projectRoot: string) {
    mkdirSync(join(home, 'workspaces', name), { recursive: true });
    writeFileSync(join(home, 'workspaces', name, 'workspace.json'), JSON.stringify({ projectRoot }));
  }

  const collect = (listing: { sims: IosSimRecord[] | null; avds: string[] | null }) =>
    collectOtherHomes(own, listing, mounted, { homesRoot });

  test('a home that still exists reports its workspaces, its own ledger devices and the commands that tear it down', async () => {
    const project = join(dir, 'project');
    const home = scratchHome('scratch', { workspaceRoot: project, ios: ['UDID-1'] });

    const { homes } = await collect({ sims: [sim('UDID-1', 'stim-scratch (iPhone 17 iOS 27)')], avds: [] });

    expect(homes).toEqual([
      expect.objectContaining({
        path: home,
        state: 'present',
        privateBytes: 3 * 1024 ** 3,
        workspaces: 1,
        forgettable: false,
        devices: [
          expect.objectContaining({
            kind: 'ios',
            id: 'UDID-1',
            name: 'stim-scratch (iPhone 17 iOS 27)',
            present: true,
            command: null,
          }),
        ],
        teardown: [
          `cd '${project}' && STIM_HOME='${home}' stim worktree remove`,
          `STIM_HOME='${home}' stim gc --delete`,
          `rm -rf '${home}'`,
        ],
      }),
    ]);
    const text = otherHomeLines(homes, NOW).join('\n');
    expect(text).toContain('3.0G private');
    expect(text).toContain('1 workspace');
    expect(text).toContain('last seen 3h ago');
  });

  test('a project inside a linked worktree is torn down from the worktree root, and a source checkout keeps the project folder', async () => {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync(
        'git',
        ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
        {
          stdio: 'ignore',
        },
      );
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, 'apps', 'mobile'), { recursive: true });
    mkdirSync(join(repo, 'apps', 'web'), { recursive: true });
    writeFileSync(join(repo, 'apps', 'mobile', 'a.txt'), 'a');
    writeFileSync(join(repo, 'apps', 'web', 'b.txt'), 'b');
    git(repo, 'init', '-q');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    const tree = join(dir, 'tree');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', tree);

    const linked = scratchHome('linked', { workspaceRoot: join(tree, 'apps', 'mobile') });
    addWorkspace(linked, 'ws2', join(tree, 'apps', 'web'));
    const source = scratchHome('source', { workspaceRoot: join(repo, 'apps', 'mobile') });

    const { homes } = await collect({ sims: [], avds: [] });
    const teardown = (path: string) => homes.find((home) => home.path === path)?.teardown;

    expect(teardown(linked)).toEqual([
      `cd '${tree}' && STIM_HOME='${linked}' stim worktree remove`,
      `STIM_HOME='${linked}' stim gc --delete`,
      `rm -rf '${linked}'`,
    ]);
    expect(teardown(source)?.[0]).toBe(
      `cd '${join(repo, 'apps', 'mobile')}' && STIM_HOME='${source}' stim worktree remove`,
    );
  });

  test('never lists this home or a home that is not in the list', async () => {
    recordStimHome(own, { root: homesRoot });
    const other = scratchHome('other');
    mkdirSync(join(dir, 'unlisted'));

    const { homes } = await collect({ sims: [], avds: [] });
    expect(homes.map((home) => home.path)).toEqual([other]);
  });

  test('a gone home keeps its devices that are still on this machine as orphans named after the home', async () => {
    const home = scratchHome('scratch', { ios: ['UDID-1'] });
    rmSync(home, { recursive: true });

    const { homes } = await collect({ sims: [sim('UDID-1', 'stim-scratch (iPhone 17 iOS 27)')], avds: [] });

    expect(homes).toEqual([
      expect.objectContaining({
        path: home,
        state: 'gone',
        forgettable: false,
        teardown: [],
        devices: [expect.objectContaining({ id: 'UDID-1', present: true, command: 'xcrun simctl delete UDID-1' })],
      }),
    ]);
    const text = otherHomeLines(homes, NOW).join('\n');
    expect(text).toContain(`orphaned from ${home}: ios stim-scratch (iPhone 17 iOS 27)`);
    expect(text).toContain('xcrun simctl delete UDID-1');
  });

  test('a gone home with no device left can be forgotten, and only when the listing was complete', async () => {
    const home = scratchHome('scratch', { ios: ['UDID-1'] });
    rmSync(home, { recursive: true });

    expect((await collect({ sims: [], avds: [] })).homes[0]).toMatchObject({ state: 'gone', forgettable: true });
    expect((await collect({ sims: null, avds: [] })).homes[0]).toMatchObject({
      forgettable: false,
      devices: [expect.objectContaining({ present: null })],
    });
  });

  test('a missing directory on a volume that is not mounted is kept, not called gone', async () => {
    const home = scratchHome('scratch');
    rmSync(home, { recursive: true });

    const { homes } = await collectOtherHomes(own, { sims: [], avds: [] }, [], { homesRoot });
    expect(homes[0]).toMatchObject({ path: home, state: 'unverified', forgettable: false });
  });

  test('an unmounted volume gets no orphan claim and no delete command for its mirrored devices', async () => {
    const home = scratchHome('scratch', { ios: ['UDID-1'] });
    rmSync(home, { recursive: true });

    const { homes } = await collectOtherHomes(
      own,
      { sims: [sim('UDID-1', 'stim-scratch (iPhone 17 iOS 27)')], avds: [] },
      [],
      {
        homesRoot,
      },
    );
    expect(homes[0]).toMatchObject({ state: 'unverified', devices: [expect.objectContaining({ command: null })] });
    expect(otherHomeLines(homes, NOW).join('\n')).not.toContain('orphaned from');
  });

  test('an unreadable list is a notice and no homes', async () => {
    mkdirSync(homesRoot, { recursive: true });
    writeFileSync(join(homesRoot, 'homes.json'), '[');
    const report = await collect({ sims: [], avds: [] });
    expect(report.homes).toEqual([]);
    expect(report.notice).toMatch(/unreadable/);
  });

  test('forgetting drops the forgettable entries only and keeps one that changed after the report', async () => {
    const gone = scratchHome('gone');
    const changed = scratchHome('changed');
    const live = scratchHome('live');
    rmSync(gone, { recursive: true });
    rmSync(changed, { recursive: true });
    const { homes } = await collect({ sims: [], avds: [] });
    expect(
      homes
        .filter((home) => home.forgettable)
        .map((home) => home.path)
        .toSorted(),
    ).toEqual([changed, gone].toSorted());

    recordStimHome(changed, { root: homesRoot, devices: { ios: ['UDID-NEW'], android: [] } });

    expect(
      forgetGoneHomes(
        homes,
        mounted,
        { homesRoot },
        { log: () => {}, error: () => {}, record: () => {}, fail: () => {} },
      ),
    ).toBe(0);
    expect([...readStimHomes(homesRoot).homes.keys()].toSorted()).toEqual([changed, live].toSorted());
  });

  test('the JSON payload carries every home with its devices and commands', async () => {
    const home = scratchHome('scratch', { workspaceRoot: join(dir, 'project'), ios: ['UDID-1'] });
    const { homes } = await collect({ sims: [sim('UDID-1', 'stim-scratch (iPhone 17 iOS 27)')], avds: [] });

    const sections = gcReportSections({ otherHomes: homes });
    expect(sections.otherHomes).toEqual([
      expect.objectContaining({ path: home, state: 'present', workspaces: 1, forgettable: false }),
    ]);
    expect(JSON.parse(JSON.stringify(sections.otherHomes))[0].teardown).toHaveLength(3);
    expect(gcReportSections({}).otherHomes).toEqual([]);
  });
});
