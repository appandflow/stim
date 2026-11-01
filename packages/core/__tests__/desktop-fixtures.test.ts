import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { event, responses } from '../receive-validators.mjs';
import { statusViews } from '../state/index.ts';

type Validator = ((value: unknown) => boolean) & {
  errors?: { instancePath: string; keyword: string; message?: string }[] | null;
};

const desktopTests = new URL('../../../apps/desktop/Tests/', import.meta.url);
const stimKitFixtures = new URL('StimKitTests/Fixtures/', desktopTests);
const realArchive = new URL('VisualFixtureTests/Fixtures/real-archive/', desktopTests);
const read = (url: URL) => JSON.parse(readFileSync(url, 'utf8'));

function issues(validator: Validator, value: unknown, prefix = ''): string[] {
  if (validator(value)) return [];
  const found = (validator.errors ?? [])
    .filter((issue) => issue.keyword !== 'anyOf' && issue.instancePath.startsWith(prefix))
    .map((issue) => `${issue.instancePath} ${issue.message}`);
  return found.length > 0 ? found : ['rejected outside the fixture payload'];
}

const statusEvent = (payload: unknown) => ({ event: 'status', subscription: 'desktop', payload });

const statusFixtures = readdirSync(stimKitFixtures).filter((name) => /status.*\.json$/.test(name));

test('reports a status event the validator rejects even when no payload path explains it', () => {
  const { environments: _environments, ...payload } = read(new URL('status.json', stimKitFixtures));
  expect(issues(event as Validator, { event: 'status', payload }, '/payload')).not.toEqual([]);
});

test.each(statusFixtures)('desktop fixture %s is a status payload the producer contract accepts', (name) => {
  expect(issues(event as Validator, statusEvent(read(new URL(name, stimKitFixtures))), '/payload')).toEqual([]);
});

test('desktop replay range fixture matches the replay.range result contract', () => {
  expect(issues(responses['replay.range'] as Validator, read(new URL('replay-range.json', stimKitFixtures)))).toEqual(
    [],
  );
});

test('captured archive fixtures match the archived status entry and archive.detail contracts', () => {
  const archived = {
    ...read(new URL('status.json', stimKitFixtures)),
    archived: [read(new URL('archive.json', realArchive))],
  };
  expect(issues(event as Validator, statusEvent(archived), '/payload')).toEqual([]);
  expect(issues(responses['archive.detail'] as Validator, read(new URL('detail.json', realArchive)))).toEqual([]);
});

test.each(statusFixtures)('the live views of desktop fixture %s are events the phone accepts', (name) => {
  const views = statusViews({ unprovisionedWorktrees: [], ...read(new URL(name, stimKitFixtures)) });
  const [detail] = views.details.values();
  const { workspaces, worktrees, archived, machine } = views;
  const events = [
    { event: 'workspaces', subscription: 's1', seq: 0, snapshot: { workspaces, worktrees, archived } },
    { event: 'workspaces', subscription: 's1', seq: 1, workspaces: { upsert: workspaces, remove: ['/gone'] } },
    { event: 'workspace', subscription: 's2', seq: 0, environment: detail ?? null },
    { event: 'machine', subscription: 's3', seq: 0, machine },
  ];
  for (const message of events) expect(issues(event as Validator, message)).toEqual([]);
});

// Desktop decodes this fixture in StatusViewsTests. Regenerate it with WRITE_DESKTOP_FIXTURES=1 after changing the views.
test('the desktop live-views fixture is the workspace list and machine view of status.json', () => {
  const views = statusViews(read(new URL('status.json', stimKitFixtures)));
  const [detail] = views.details.values();
  const { workspaces, worktrees, archived, machine } = views;
  const fixture = `${JSON.stringify(
    {
      workspaces: { event: 'workspaces', subscription: 's1', seq: 0, snapshot: { workspaces, worktrees, archived } },
      workspace: { event: 'workspace', subscription: 's2', seq: 0, environment: detail ?? null },
      machine: { event: 'machine', subscription: 's3', seq: 0, machine },
    },
    null,
    2,
  )}\n`;
  const file = new URL('live-views.json', stimKitFixtures);
  if (process.env.WRITE_DESKTOP_FIXTURES) writeFileSync(file, fixture);
  expect(read(file)).toEqual(JSON.parse(fixture));
});
