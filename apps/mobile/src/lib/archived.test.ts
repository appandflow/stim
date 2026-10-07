import { archivedDeviceRoute, archiveError, newestArchive, removedByWords, workspaceArchiveDecision } from './archived';
import { RequestError } from './connection';
import { receiveStatus } from '../../mock-server/receive-fixtures';
import captured from '../../mock-server/fixtures/status.json';
import type { StatusPayload } from '@/protocol/types';

const archive = receiveStatus(captured.payload as StatusPayload).archived![0];

test('selects the newest removed run for the exact workspace path', () => {
  const newer = { ...archive, id: 'newer', removedAt: '2026-09-28T12:00:00Z' };
  const other = { ...newer, id: 'other', projectRoot: '/other', removedAt: '2026-09-29T12:00:00Z' };
  for (const archives of [
    [archive, other, newer],
    [newer, other, archive],
  ]) {
    expect(newestArchive('/app', archives)?.id).toBe('newer');
    for (const path of ['/missing', '/ap', '/app/', '/./app']) {
      expect(newestArchive(path, archives)).toBeNull();
    }
  }
  expect(newestArchive('/app', [])).toBeNull();
});

test('names the removal source including unknown future sources', () => {
  expect(removedByWords('worktree-remove')).toBe('worktree removal');
  expect(removedByWords('gc')).toBe('cleanup');
  expect(removedByWords('maintenance')).toBe('automatic maintenance');
  expect(removedByWords('future-remover')).toBe('future-remover');
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

test('opens archived device replay at the notification time when provided', () => {
  expect(archivedDeviceRoute(deviceTarget)).toEqual({
    pathname: '/mac/[id]/archived-replay',
    params: { id: 'mac', archive: archive.id, platform: 'ios', at: '1234' },
  });
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

const waiting = { path: '/app', archives: [archive], wasListed: false, refreshed: false, graceElapsed: false };

test('a workspace screen waits for the live workspace before opening an archive of the same path', () => {
  expect(workspaceArchiveDecision(waiting)).toEqual({ kind: 'wait' });
});

test.each([{ refreshed: true }, { graceElapsed: true }, { wasListed: true }])(
  'opens the newest archive once status refreshed, the grace passed or the live workspace is gone: %s',
  (overrides) => {
    expect(workspaceArchiveDecision({ ...waiting, ...overrides })).toEqual({ kind: 'open', archive });
  },
);

test('has nothing to wait for without an archive of the path', () => {
  expect(workspaceArchiveDecision({ ...waiting, path: '/missing' })).toEqual({ kind: 'none' });
});
