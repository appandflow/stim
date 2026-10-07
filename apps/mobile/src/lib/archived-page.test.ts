import captured from '../../mock-server/fixtures/status.json';
import details from '../../mock-server/fixtures/archive-details.json';
import realArchive from '../../mock-server/fixtures/real-archive/archive.json';
import realDetail from '../../mock-server/fixtures/real-archive/detail.json';
import { archivedPage } from './archived-page';
import { mergeArchives } from './home';
import { homeSections } from './home-list';
import { historyDetail } from './format';
import type { ArchivedWorkspace } from './archived';
import type { ArchiveDetailResult, StatusPayload } from '@/protocol/types';

const archive = captured.payload.archived[0] as ArchivedWorkspace;
const detail = details[archive.id as keyof typeof details] as ArchiveDetailResult;
const now = Date.parse(archive.removedAt) + 2 * 60 * 60 * 1000;

test('adapts retained archive facts for shared cards without live state or resource measurements', () => {
  const page = archivedPage(archive, detail, now);
  expect(page).toMatchObject({
    title: 'feat/archived-workspaces',
    project: 'stim',
    inCheckout: 'apps/mobile',
    removedLabel: 'Removed 2h ago by worktree removal',
    size: '12 MB',
    logsExpired: false,
    recordingsExpired: false,
    totals: { builds: 3, cacheHits: 1, offloaded: 0, errors: 0 },
    env: { live: false, endedAgents: archive.agents },
  });
  expect(page.env.metro).toBeUndefined();
  expect(page.env.disk).toBeUndefined();
  expect(page.env.ios).toBeUndefined();
  expect(page.env.lastBuilds?.android?.durationMs).toBe(150000);
  expect(page.recordings.map((recording) => [recording.platform, recording.slot])).toEqual([
    ['ios', 'default'],
    ['android', 'tablet'],
  ]);
  expect(page.bytes).toEqual({ logs: 128000, recordings: 12000000, agentActions: 4000, record: 2048, total: 12134048 });
});

test.each(['logs', 'recordings', 'agentActions', 'record'] as const)(
  'expires %s only at a non-null elapsed deadline, including equality',
  (kind) => {
    const expired = (page: ReturnType<typeof archivedPage>) =>
      page.retention.find((part) => part.kind === kind)!.expired;
    expect(
      expired(
        archivedPage(
          { ...archive, bytes: { ...archive.bytes, [kind]: 0 }, expires: { ...archive.expires, [kind]: null } },
          detail,
          now,
        ),
      ),
    ).toBe(false);
    expect(expired(archivedPage({ ...archive, bytes: { ...archive.bytes, [kind]: 0 } }, detail, now))).toBe(false);
    expect(
      expired(
        archivedPage({ ...archive, expires: { ...archive.expires, [kind]: new Date(now).toISOString() } }, detail, now),
      ),
    ).toBe(true);
    const soon = archivedPage(
      { ...archive, expires: { ...archive.expires, [kind]: new Date(now + 3600000).toISOString() } },
      detail,
      now,
    );
    expect(expired(soon)).toBe(false);
    expect(soon.retention.find((part) => part.kind === kind)?.soon).toBe(true);
    expect(
      archivedPage(
        { ...archive, expires: { ...archive.expires, [kind]: new Date(now + 86400001).toISOString() } },
        detail,
        now,
      ).retention.find((part) => part.kind === kind)?.soon,
    ).toBe(false);
  },
);

test('keeps a workspace with no builds without inventing native runs', () => {
  const empty = { ...archive, builds: { count: 0, last: null, lastErrorCount: 0 } };
  const page = archivedPage(empty, { builds: {}, recordings: [] }, now);
  expect(page.env.lastBuilds).toEqual({});
  expect(page.env.builds).toEqual({});
  expect(page.totals).toEqual({ builds: 0, cacheHits: 0, offloaded: 0, errors: 0 });
});

test.each([
  { merged: true, state: 'draft' },
  { merged: false, state: 'merged' },
])('keeps the monotonic merged outcome despite a stale PR snapshot: %s', ({ merged, state }) => {
  const page = archivedPage(
    { ...archive, worktree: { ...archive.worktree, merged, pullRequest: { ...archive.worktree.pullRequest!, state } } },
    detail,
    now,
  );
  expect(page.prLabel).toBe('#2600 Merged');
  expect(page.git?.pr?.tone).toBe('brand');
});

test.each(['open', 'draft', 'closed', 'future-state'])(
  'shows only the PR number for a non-merged %s snapshot',
  (state) => {
    const page = archivedPage(
      {
        ...archive,
        worktree: { ...archive.worktree, merged: false, pullRequest: { ...archive.worktree.pullRequest!, state } },
      },
      detail,
      now,
    );
    expect(page.prLabel).toBe('#2600');
    expect(page.git?.label).toBe('feat/archived-workspaces, #2600');
  },
);

test('uses the project folder without guessing a checkout from an apps directory', () => {
  const page = archivedPage(
    {
      ...archive,
      project: 'mobile',
      projectRoot: '/Users/x/apps/myapp',
      worktree: { repository: null, branch: null, head: null, subject: null, merged: null, pullRequest: null },
    },
    null,
    now,
  );
  expect(page).toMatchObject({ title: 'myapp', project: 'myapp', inCheckout: null, git: null });
});

test('keeps the last-build summary and total when an older server has no archive detail', () => {
  const page = archivedPage(archive, null, now);
  expect(page.env.lastBuilds?.ios).toEqual(archive.builds.last);
  expect(page.env.builds).toEqual({});
  expect(page.totals).toEqual({ builds: 3, cacheHits: null, offloaded: null, errors: 0 });
  expect(page.recordings).toEqual([]);
});

test('preserves five real runs, their durations, failures and actual build machines plus all recording spans', () => {
  const page = archivedPage(
    realArchive as ArchivedWorkspace,
    realDetail as ArchiveDetailResult,
    Date.parse(realArchive.removedAt),
  );
  const history = page.env.builds!.ios!;
  expect(history.map((run) => [run.durationMs, run.result, run.builtOn, run.errorCode ?? null])).toEqual([
    [13140, 'failed', 'here', 'STIM_BUILD_FAILED'],
    [29746, 'succeeded', 'janics-mac-mini', null],
    [66197, 'succeeded', 'here', null],
    [9406, 'failed', 'here', 'STIM_BUILD_FAILED'],
    [129383, 'succeeded', 'janics-mac-mini', null],
  ]);
  expect(historyDetail(history[1], now)).toContain('on janics-mac-mini');
  expect(historyDetail(history[2], now)).toContain('this Mac');
  expect(page.totals).toEqual({ builds: 5, cacheHits: 0, offloaded: 2, errors: 3 });
  expect(page.recordings[0]).toEqual({
    platform: 'ios',
    slot: 'default',
    spans: [
      { start: 1791346346610, end: 1791346357977 },
      { start: 1791346446117, end: 1791346446586 },
      { start: 1791346655074, end: 1791346655625 },
    ],
  });
});

test('groups archived apps like live apps by repository and checkout while keeping Macs separate', () => {
  const desktop = {
    ...archive,
    id: 'desktop',
    project: 'desktop',
    projectRoot: archive.projectRoot.replace('/apps/mobile', '/apps/desktop'),
  };
  const entries = mergeArchives([
    { id: 'a', name: 'Mac', status: { ...captured.payload, archived: [archive, desktop] } as StatusPayload },
    { id: 'b', name: 'Other Mac', status: { ...captured.payload, archived: [archive] } as StatusPayload },
  ]);
  const sections = homeSections(entries);
  expect(sections.map((section) => [section.project, section.live, section.idle])).toEqual([['stim', 0, 0]]);
  expect(sections[0].data).toHaveLength(2);
  expect(sections[0].data[0]).toMatchObject({
    title: 'feat/archived-workspaces',
    apps: [
      { inCheckout: 'apps/desktop', project: 'stim' },
      { inCheckout: 'apps/mobile', project: 'stim' },
    ],
  });
});

test('uses a known repository for a nested app without a marked worktree', () => {
  const page = archivedPage(
    {
      ...archive,
      projectRoot: '/Users/x/apps/myapp',
      worktree: { ...archive.worktree, repository: '/Users/x/apps', branch: null },
    },
    null,
    now,
  );
  expect(page).toMatchObject({ title: 'apps', project: 'apps', inCheckout: 'myapp' });
});

test.each([{}, { ios: [] }, { android: detail.builds.android }])(
  'keeps the saved last build when detail lacks its platform history: %s',
  (builds) => {
    const page = archivedPage(archive, { ...detail, builds }, now);
    expect(page.env.lastBuilds?.ios).toEqual(archive.builds.last);
    expect(page.env.lastBuilds?.android).toEqual(builds.android?.[0]);
  },
);

test('separates removal events for a recreated checkout and keeps their own branch titles', () => {
  const newer = {
    ...archive,
    id: 'newer',
    removedAt: new Date(Date.parse(archive.removedAt) + 1000).toISOString(),
    worktree: { ...archive.worktree, branch: 'new-branch' },
  };
  const entries = mergeArchives([
    { id: 'mac', name: 'Mac', status: { ...captured.payload, archived: [archive, newer] } as StatusPayload },
  ]);
  const sections = homeSections(entries);
  expect(sections[0].data.map((group) => group.title)).toEqual(['new-branch', archive.worktree.branch]);
});
