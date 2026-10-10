import { readdirSync, readFileSync } from 'node:fs';
import { event, responses } from '../receive-validators.mjs';

type Validator = ((value: unknown) => boolean) & {
  errors?: { instancePath: string; keyword: string; message?: string }[] | null;
};

const desktopTests = new URL('../../../apps/desktop/Tests/', import.meta.url);
const stimKitFixtures = new URL('StimKitTests/Fixtures/', desktopTests);
const realArchive = new URL('VisualFixtureTests/Fixtures/real-archive/', desktopTests);
const read = (url: URL) => JSON.parse(readFileSync(url, 'utf8'));

function issues(validator: Validator, value: unknown, prefix = ''): string[] {
  if (validator(value)) return [];
  return (validator.errors ?? [])
    .filter((issue) => issue.keyword !== 'anyOf' && issue.instancePath.startsWith(prefix))
    .map((issue) => `${issue.instancePath} ${issue.message}`);
}

const statusEvent = (payload: unknown) => ({ event: 'status', subscription: 'desktop', payload });

const statusFixtures = readdirSync(stimKitFixtures).filter((name) => /status.*\.json$/.test(name));

test('finds the desktop status fixtures', () => {
  expect(statusFixtures).toContain('status.json');
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
