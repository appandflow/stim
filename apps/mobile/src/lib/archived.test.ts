import { archivedView, archiveError, removedByWords } from './archived';
import { RequestError } from './connection';
import { receiveStatus } from '../../mock-server/receive-fixtures';
import captured from '../../mock-server/fixtures/status.json';
import type { StatusPayload } from '@/protocol/types';
import { isRpcEvent } from '@stim-cli/core/receive-protocol';

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

test('accepts archive status and completion but refuses malformed archive storage fields', () => {
  const payload = receiveStatus(captured.payload as StatusPayload);
  expect(isRpcEvent({ event: 'status', subscription: 's', payload })).toBe(true);
  expect(isRpcEvent({ event: 'logs-ended', subscription: 's' })).toBe(true);
  expect(isRpcEvent({ event: 'logs-ended' })).toBe(false);
  expect(
    isRpcEvent({
      event: 'status',
      subscription: 's',
      payload: { ...payload, archivedUsage: { ...payload.archivedUsage, bytes: 'bad' } },
    }),
  ).toBe(false);
  expect(
    isRpcEvent({
      event: 'status',
      subscription: 's',
      payload: { ...payload, archived: [{ ...archive, removedAt: 12 }] },
    }),
  ).toBe(false);
});
