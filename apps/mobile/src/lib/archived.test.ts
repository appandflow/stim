import { archivedDeviceRoute, archivedView, archiveError, removedByWords } from './archived';
import { RequestError } from './connection';
import { receiveStatus } from '../../mock-server/receive-fixtures';
import captured from '../../mock-server/fixtures/status.json';
import type { StatusPayload } from '@/protocol/types';

const archive = receiveStatus(captured.payload as StatusPayload).archived![0];

test('names the PR state, removal reason and size without exposing command names', () => {
  const view = archivedView(
    { ...archive, bytes: { ...archive.bytes, total: 12e6 } },
    Date.parse(archive.removedAt) + 120_000,
  );
  expect(view).toEqual({
    title: 'feature',
    pr: '#42 Merged',
    removed: 'Removed 2m ago',
    removedBy: 'Removed 2m ago by worktree removal',
    size: '12 MB',
  });
  expect(removedByWords('gc')).toBe('cleanup');
  expect(removedByWords('maintenance')).toBe('automatic maintenance');
  expect(removedByWords('future-remover')).toBe('future-remover');
  expect(
    archivedView({ ...archive, worktree: { ...archive.worktree, branch: null, pullRequest: null } }, Date.now()),
  ).toMatchObject({ title: 'app', pr: null });
  expect(
    archivedView(
      {
        ...archive,
        worktree: { ...archive.worktree, pullRequest: { ...archive.worktree.pullRequest!, state: 'open' } },
      },
      Date.now(),
    ).pr,
  ).toBe('#42 Open');
});

test('turns an older-server refusal into the relevant update hint and preserves other errors', () => {
  const refusal = new RequestError({ code: 'bad-request', message: 'workspace is required' });
  expect(archiveError(refusal, 'logs')).toBe('Update stim-server to view archived logs');
  expect(archiveError(refusal, 'replay')).toBe('Update stim-server to view archived replay');
  expect(archiveError(new RequestError({ code: 'unknown-archive', message: 'Archive expired' }), 'logs')).toBe(
    'Archive expired',
  );
});

const deviceTarget = {
  macId: 'mac',
  path: '/app',
  platform: 'ios' as const,
  slot: 'default',
  at: '1234',
  hasStatus: true,
  workspaceListed: false,
  archives: [archive],
};

test('opens the newest archive for the exact workspace path at the notification time', () => {
  const newer = { ...archive, id: 'newer', removedAt: '2026-09-28T12:00:00Z' };
  const other = { ...newer, id: 'other', projectRoot: '/other', removedAt: '2026-09-29T12:00:00Z' };
  for (const archives of [
    [newer, other, archive],
    [archive, other, newer],
  ]) {
    expect(archivedDeviceRoute({ ...deviceTarget, archives })).toEqual({
      pathname: '/mac/[id]/archived-replay',
      params: { id: 'mac', archive: 'newer', platform: 'ios', at: '1234' },
    });
  }
  expect(archivedDeviceRoute({ ...deviceTarget, at: undefined })).toEqual({
    pathname: '/mac/[id]/archived-replay',
    params: { id: 'mac', archive: archive.id, platform: 'ios' },
  });
});

test.each(['android', 'web'] as const)('opens archived %s footage', (platform) => {
  expect(archivedDeviceRoute({ ...deviceTarget, platform })).toEqual({
    pathname: '/mac/[id]/archived-replay',
    params: { id: 'mac', archive: archive.id, platform, at: '1234' },
  });
});

test.each([
  { archives: [{ ...archive, bytes: { ...archive.bytes, recordings: 0 } }] },
  { slot: 'secondary' },
  { platform: 'macos' as const },
  { physical: true },
])('opens archive details when device replay is unavailable: %s', (overrides) => {
  expect(archivedDeviceRoute({ ...deviceTarget, ...overrides })).toEqual({
    pathname: '/mac/[id]/archived',
    params: { id: 'mac', archive: archive.id },
  });
});

test.each([{ workspaceListed: true }, { hasStatus: false }, { path: '/missing' }])(
  'keeps the device route until an absent workspace has a matching archive: %s',
  (overrides) => {
    expect(archivedDeviceRoute({ ...deviceTarget, ...overrides })).toBeNull();
  },
);
