import captured from '../../mock-server/fixtures/status.json';
import { applyWorkspaces, EMPTY_VIEWS, viewsPayload, type StatusViews } from '@/lib/status-views';
import type { EnvironmentState, StatusPayload, WorkspacesEvent } from '@/protocol/types';
import { statusViews } from '@stim-cli/core/phone-protocol';

const captures = captured.payload as Parameters<typeof statusViews>[0];
const payload: StatusPayload = captures;
const views = statusViews(captures);
const snapshot: WorkspacesEvent = {
  event: 'workspaces',
  subscription: 's1',
  seq: 0,
  snapshot: { workspaces: views.workspaces, worktrees: views.worktrees, archived: views.archived },
};

function applied(current: StatusViews, event: WorkspacesEvent): StatusViews {
  const next = applyWorkspaces(current, event);
  if (next === 'gap') throw new Error('unexpected gap');
  return next;
}

it('has no payload until both the workspace list and the machine arrived', () => {
  const listed = applied(EMPTY_VIEWS, snapshot);
  expect(viewsPayload(listed)).toBeNull();
  expect(viewsPayload({ ...EMPTY_VIEWS, machine: views.machine })).toBeNull();
  const status = viewsPayload({ ...listed, machine: views.machine });
  expect(status?.environments.map((env) => env.path)).toEqual(payload.environments.map((env) => env.path));
  expect(status?.capacity).toEqual(payload.capacity);
});

it('applies deltas in order, keeps the server order and reports a missing event as a gap', () => {
  const [first, second] = views.workspaces;
  if (!first || !second) throw new Error('the captured status lists two workspaces');
  const changed: EnvironmentState = { ...first, memoryMb: 4321 };
  let current = applied(EMPTY_VIEWS, snapshot);
  current = applied(current, {
    event: 'workspaces',
    subscription: 's1',
    seq: 1,
    workspaces: { upsert: [changed], remove: [second.path] },
  });
  expect(current.workspaces[0]).toEqual(changed);
  expect(current.workspaces.some((env) => env.path === second.path)).toBe(false);
  expect(
    applyWorkspaces(current, {
      event: 'workspaces',
      subscription: 's1',
      seq: 3,
      workspaces: { upsert: [], remove: [] },
    }),
  ).toBe('gap');
});

it("shows a followed workspace's full environment and the archives read separately", () => {
  const listed = { ...applied(EMPTY_VIEWS, snapshot), machine: views.machine };
  const [full] = payload.environments;
  const usage = payload.archivedUsage;
  if (!full || !usage) throw new Error('the captured status has a workspace and archives');
  const status = viewsPayload({
    ...listed,
    details: { [full.path]: full },
    archives: { archived: payload.archived ?? [], usage },
  });
  expect(status?.environments[0]).toEqual(full);
  expect(status?.archived).toEqual(payload.archived);
});

it('keeps the archives shown before until the archives are read', () => {
  const listed = { ...applied(EMPTY_VIEWS, snapshot), machine: views.machine };
  const [kept] = payload.archived ?? [];
  if (!kept || !payload.archivedUsage) throw new Error('the captured status has archives');
  const shown = { ...payload, archived: [kept] };
  expect(viewsPayload(listed, shown)?.archived).toEqual([kept]);
  const read = { archived: [], usage: { ...payload.archivedUsage, count: 0 } };
  expect(viewsPayload({ ...listed, archives: read }, shown)?.archived).toEqual([]);
});
